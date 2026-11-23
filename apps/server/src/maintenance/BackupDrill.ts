import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { BackupRestoreFailure, currentIdentity, loadArchive, validateSnapshot, type RestoreInputs } from "./BackupRestoreArchive"
import {
  revalidateWritableLocation,
  validateWritableLocationSeparation,
  type SourceRootObservation,
  type WritableLocationObservation
} from "../analysis/NativeSourceBoundary"
import type {
  BackupArtifactRow,
  BackupDestinationRow,
  BackupDrillCompletionOutcome,
  BackupDrillRunRow,
  BackupDrillStartOutcome,
  ServerRootRow
} from "../persistence/worker-protocol"

const ARCHIVE_DIRECTORY = "archives"
const ARCHIVE_SUFFIX = ".henshin.zip"

export class BackupDrillFailure extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "BackupDrillFailure"
    this.code = code
  }
}

export class BackupDrillInterrupted extends Error {
  constructor() {
    super("backup drill interrupted before verification completed")
    this.name = "BackupDrillInterrupted"
  }
}

export interface BackupDrillContext {
  readonly dbPath: string
  readonly destination: BackupDestinationRow
  readonly artifact: BackupArtifactRow
  readonly roots: ReadonlyArray<ServerRootRow>
  readonly start: (request: {
    readonly runId: string
    readonly artifactId: string
    readonly manifestDigest: string
    readonly startedAtMs: number
  }) => Promise<BackupDrillStartOutcome>
  readonly complete: (request: {
    readonly runId: string
    readonly status: "passed" | "failed" | "interrupted"
    readonly completedAtMs: number
    readonly diagnosticCode: string | null
    readonly diagnosticMessage: string | null
    readonly checksJson: string | null
  }) => Promise<BackupDrillCompletionOutcome>
  /** Test-only interruption seam; production callers leave this unset. */
  readonly beforeVerification?: () => Promise<"interrupt" | void>
}

export interface BackupDrillResult {
  readonly run: BackupDrillRunRow
  readonly checks: unknown | null
}

const sourceRootObservation = (root: ServerRootRow): SourceRootObservation => ({
  selectedPath: root.selectedPath,
  canonicalPath: root.canonicalPath,
  identity: { device: root.device, inode: root.inode }
})

const destinationObservation = (destination: BackupDestinationRow): WritableLocationObservation => ({
  selectedPath: destination.selectedPath,
  canonicalPath: destination.canonicalPath,
  identity: { device: destination.device, inode: destination.inode }
})

const ensureArchivePath = async (
  destination: BackupDestinationRow,
  relativePath: string
): Promise<string> => {
  if (
    !relativePath.startsWith(`${ARCHIVE_DIRECTORY}/`) ||
    relativePath.includes("\\") ||
    relativePath.includes("\u0000")
  ) throw new BackupDrillFailure("unsafe-artifact-path", "backup artifact path is invalid")
  const archiveDirectory = join(destination.canonicalPath, ARCHIVE_DIRECTORY)
  try {
    if (await realpath(archiveDirectory) !== archiveDirectory) {
      throw new BackupDrillFailure("unsafe-artifact-path", "backup archive directory is unsafe")
    }
  } catch (error) {
    if (error instanceof BackupDrillFailure) throw error
    throw new BackupDrillFailure("artifact-unavailable", "backup archive directory is unavailable")
  }
  const archivePath = resolve(destination.canonicalPath, relativePath)
  const child = relative(archiveDirectory, archivePath)
  if (child.length === 0 || child.startsWith("..") || child.includes("/") || child.includes("\\")) {
    throw new BackupDrillFailure("unsafe-artifact-path", "backup artifact path is invalid")
  }
  if (!child.endsWith(ARCHIVE_SUFFIX)) throw new BackupDrillFailure("unsafe-artifact-path", "backup artifact path is invalid")
  try {
    const entry = await lstat(archivePath)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new BackupDrillFailure("artifact-unavailable", "backup artifact is unavailable")
  } catch (error) {
    if (error instanceof BackupDrillFailure) throw error
    throw new BackupDrillFailure("artifact-unavailable", "backup artifact is unavailable")
  }
  return archivePath
}

const verifySnapshot = (snapshotPath: string, inputs: RestoreInputs): unknown => {
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
  try {
    const entries = (snapshot.prepare("SELECT COUNT(*) AS count FROM library_entries").get() as { count: number }).count
    const events = (snapshot.prepare("SELECT COUNT(*) AS count FROM open_events").get() as { count: number }).count
    const aggregates = (snapshot.prepare("SELECT COUNT(*) AS count FROM entry_statistics").get() as { count: number }).count
    const missingAggregates = (snapshot.prepare(`
      SELECT COUNT(*) AS count
      FROM library_entries e
      LEFT JOIN entry_statistics s ON s.entry_id = e.entry_id
      WHERE s.entry_id IS NULL
    `).get() as { count: number }).count
    const inconsistentAggregates = (snapshot.prepare(`
      SELECT COUNT(*) AS count
      FROM entry_statistics s
      LEFT JOIN (
        SELECT entry_id, COUNT(*) AS open_count, MAX(occurred_at_ms) AS last_opened_at_ms
        FROM open_events
        GROUP BY entry_id
      ) e ON e.entry_id = s.entry_id
      WHERE s.open_count != COALESCE(e.open_count, 0)
         OR s.last_opened_at_ms IS NOT e.last_opened_at_ms
    `).get() as { count: number }).count
    if (missingAggregates !== 0 || inconsistentAggregates !== 0) {
      throw new BackupDrillFailure("aggregate-mismatch", "backup snapshot aggregates do not match open events")
    }
    const overrideTables = (snapshot.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%override%' ORDER BY name"
    ).all() as unknown as ReadonlyArray<{ name: string }>).map((row) => row.name)
    return {
      container: "verified",
      identity: { instance_id: inputs.manifest.instance_id, library_id: inputs.manifest.library_id },
      schema_version: inputs.manifest.schema_version,
      sqlite_integrity: "ok",
      foreign_keys: "ok",
      records: { library_entries: entries, open_events: events },
      aggregates: { entry_statistics: aggregates, consistent: true },
      overrides: { tables: overrideTables, verified: false, status: "unavailable" },
      derived_covers: { status: "not-in-archive", placeholders: true }
    }
  } finally {
    snapshot.close()
  }
}

export const runBackupDrill = async (context: BackupDrillContext): Promise<BackupDrillResult> => {
  const runId = randomUUID()
  const startedAtMs = Date.now()
  const started = await context.start({
    runId,
    artifactId: context.artifact.artifactId,
    manifestDigest: context.artifact.manifestDigest ?? "",
    startedAtMs
  })
  if (started.kind !== "started" && started.kind !== "replayed") throw new BackupDrillFailure("run-not-started", `backup drill could not start: ${started.kind}`)
  let stagingDirectory: string | undefined
  try {
    const currentDestination = await revalidateWritableLocation(destinationObservation(context.destination))
    if (!currentDestination.ok) throw new BackupDrillFailure("destination-changed", "backup destination changed and requires replacement")
    const separation = await validateWritableLocationSeparation({
      sourceRoots: context.roots.map(sourceRootObservation),
      writableLocations: [dirname(context.dbPath), currentDestination.value]
    })
    if (!separation.ok) throw new BackupDrillFailure("location-overlap", "backup destination overlaps a collection root or server data directory")
    const archivePath = await ensureArchivePath(context.destination, context.artifact.relativePath)
    stagingDirectory = await mkdtemp(join(dirname(context.dbPath), ".backup-drill-"))
    if (context.beforeVerification !== undefined && await context.beforeVerification() === "interrupt") {
      throw new BackupDrillInterrupted()
    }
    const target = currentIdentity(context.dbPath)
    let inputs: RestoreInputs
    try {
      inputs = await loadArchive(archivePath, stagingDirectory, {
        artifactId: context.artifact.artifactId,
        destinationId: context.artifact.destinationId,
        relativePath: context.artifact.relativePath,
        manifestDigest: context.artifact.manifestDigest ?? ""
      }, target.changeRevision)
      validateSnapshot(inputs, target)
    } catch (error) {
      if (error instanceof BackupRestoreFailure) throw new BackupDrillFailure(error.code, error.message)
      throw error
    }
    const checks = verifySnapshot(inputs.statePath, inputs)
    const completed = await context.complete({
      runId,
      status: "passed",
      completedAtMs: Date.now(),
      diagnosticCode: null,
      diagnosticMessage: null,
      checksJson: JSON.stringify(checks)
    })
    if (completed.kind !== "completed" && completed.kind !== "replayed") throw new BackupDrillFailure("run-not-recorded", "backup drill result was not recorded")
    return { run: completed.run, checks }
  } catch (error) {
    if (error instanceof BackupDrillInterrupted) throw error
    if (error instanceof BackupDrillFailure) {
      const completed = await context.complete({
        runId,
        status: "failed",
        completedAtMs: Date.now(),
        diagnosticCode: error.code,
        diagnosticMessage: error.message,
        checksJson: null
      })
      if (completed.kind !== "completed" && completed.kind !== "replayed") throw new Error("backup drill failure result was not recorded")
      return { run: completed.run, checks: null }
    }
    const completed = await context.complete({
      runId,
      status: "failed",
      completedAtMs: Date.now(),
      diagnosticCode: "drill-failed",
      diagnosticMessage: "backup drill failed",
      checksJson: null
    })
    if (completed.kind !== "completed" && completed.kind !== "replayed") throw new Error("backup drill failure result was not recorded")
    return { run: completed.run, checks: null }
  } finally {
    if (stagingDirectory !== undefined) await rm(stagingDirectory, { recursive: true, force: true })
  }
}
