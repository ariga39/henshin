import { DatabaseSync } from "node:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { Option, Schema } from "effect"
import {
  BackupArchiveMemberSizeError,
  BackupArchiveSizeError,
  digestFile,
  inspectBackupArchive,
  MAX_CONFIGURATION_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_STATE_BYTES,
  readBackupArchiveMember,
  streamBackupArchiveEntry
} from "./BackupArchiveIO"
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
const CURRENT_SCHEMA_VERSION = 10
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const Digest = Schema.String.check(Schema.isMinLength(64), Schema.isMaxLength(64))
const ArchivePayload = Schema.Struct({ size_bytes: Schema.Natural, sha256: Digest })
const ArchiveManifest = Schema.Struct({
  format_version: Schema.Literal(1),
  artifact_id: Schema.String,
  operation_id: Schema.String,
  destination_id: Schema.String,
  relative_path: Schema.String,
  publication_order: Schema.Natural,
  store_kind: Schema.Literal("server"),
  instance_id: Schema.String,
  library_id: Schema.String,
  application_version: Schema.String,
  schema_version: Schema.Natural,
  snapshot_started_at: Schema.String,
  snapshot_completed_at: Schema.String,
  library_change_revision: Schema.Int,
  retention_class: Schema.Literal("archive"),
  label: Schema.NullOr(Schema.String),
  payloads: Schema.Struct({
    "state.sqlite": ArchivePayload,
    "configuration.json": ArchivePayload
  }),
  included_data_classes: Schema.Array(Schema.String),
  excluded_data_classes: Schema.Array(Schema.String),
  credential_reset_instructions: Schema.String
})
type ArchiveManifest = typeof ArchiveManifest.Type

const SnapshotConfiguration = Schema.Struct({
  format_version: Schema.Literal(1),
  instance_id: Schema.String,
  library_id: Schema.String,
  schema_version: Schema.Natural,
  library_change_revision: Schema.Int,
  roots: Schema.Array(Schema.Unknown),
  backup_destinations: Schema.Array(Schema.Unknown)
})
type SnapshotConfiguration = typeof SnapshotConfiguration.Type

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

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

const decodeJson = (
  schema: typeof ArchiveManifest | typeof SnapshotConfiguration,
  bytes: Uint8Array,
  label: string
): ArchiveManifest | SnapshotConfiguration => {
  try {
    const value = JSON.parse(textDecoder.decode(bytes))
    if (schema === ArchiveManifest) {
      const decoded = Schema.decodeUnknownOption(ArchiveManifest)(value)
      if (Option.isSome(decoded)) return decoded.value
    } else {
      const decoded = Schema.decodeUnknownOption(SnapshotConfiguration)(value)
      if (Option.isSome(decoded)) return decoded.value
    }
  } catch {
    // Report one bounded diagnostic for malformed archive members.
  }
  throw new BackupDrillFailure("invalid-json", `backup ${label} is invalid`)
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

const writeFileChunk = async (file: FileHandle, chunk: Uint8Array): Promise<void> => {
  let offset = 0
  while (offset < chunk.length) {
    const result = await file.write(chunk, offset, chunk.length - offset, null)
    if (result.bytesWritten === 0) throw new Error("backup drill output made no progress")
    offset += result.bytesWritten
  }
}

const readArchiveMembers = async (
  archivePath: string,
  stagingDirectory: string
): Promise<{
  readonly manifestBytes: Uint8Array
  readonly configurationBytes: Uint8Array
  readonly statePath: string
  readonly stateSize: number
}> => {
  const statePath = join(stagingDirectory, "state.sqlite")
  let stateFile: FileHandle | undefined
  try {
    const members = await inspectBackupArchive(archivePath, async (entries) => {
      if (entries.length !== 3) throw new BackupDrillFailure("archive-members", "backup artifact has unexpected members")
      const expected = new Set(["manifest.json", "state.sqlite", "configuration.json"])
      const buffered = new Map<string, Uint8Array>()
      let stateSize: number | undefined
      for (const entry of entries) {
        if (entry.directory || entry.symlink || !expected.has(entry.filename) || buffered.has(entry.filename) || (entry.filename === "state.sqlite" && stateSize !== undefined)) {
          throw new BackupDrillFailure("archive-members", "backup artifact has unsafe members")
        }
        const limit = entry.filename === "state.sqlite"
          ? MAX_STATE_BYTES
          : entry.filename === "configuration.json" ? MAX_CONFIGURATION_BYTES : MAX_MANIFEST_BYTES
        if (entry.uncompressedSize !== undefined && entry.uncompressedSize > limit) {
          throw new BackupArchiveMemberSizeError()
        }
        if (entry.filename === "state.sqlite") {
          stateFile = await open(statePath, "wx", 0o600)
          try {
            stateSize = await streamBackupArchiveEntry(entry, limit, (chunk) => writeFileChunk(stateFile as FileHandle, chunk))
            await stateFile.sync()
          } finally {
            await stateFile.close()
            stateFile = undefined
          }
        } else {
          buffered.set(entry.filename, await readBackupArchiveMember(entry, limit))
        }
      }
      const manifestBytes = buffered.get("manifest.json")
      const configurationBytes = buffered.get("configuration.json")
      if (manifestBytes === undefined || configurationBytes === undefined || stateSize === undefined) {
        throw new BackupDrillFailure("archive-members", "backup artifact is incomplete")
      }
      return { manifestBytes, configurationBytes, stateSize }
    })
    return { ...members, statePath }
  } catch (error) {
    if (error instanceof BackupDrillFailure) throw error
    if (error instanceof BackupArchiveSizeError) {
      throw new BackupDrillFailure("archive-too-large", "backup artifact exceeds the size limit")
    }
    if (error instanceof BackupArchiveMemberSizeError) {
      throw new BackupDrillFailure("member-too-large", "backup artifact member exceeds the size limit")
    }
    throw new BackupDrillFailure("archive-invalid", "backup artifact cannot be read")
  } finally {
    if (stateFile !== undefined) await stateFile.close()
  }
}

const verifySnapshot = (
  snapshotPath: string,
  manifest: ArchiveManifest,
  configuration: SnapshotConfiguration,
  dbPath: string
): unknown => {
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
  try {
    const integrity = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
    if (integrity.integrity_check !== "ok") throw new BackupDrillFailure("sqlite-integrity", "backup snapshot failed integrity validation")
    const foreignKeys = snapshot.prepare("PRAGMA foreign_key_check").all()
    if (foreignKeys.length !== 0) throw new BackupDrillFailure("sqlite-foreign-keys", "backup snapshot failed foreign-key validation")
    const state = snapshot.prepare("SELECT instance_id, schema_version FROM server_state WHERE id = 1").get() as
      | { instance_id: string; schema_version: number }
      | undefined
    const library = snapshot.prepare("SELECT library_id, change_revision FROM server_library WHERE id = 1").get() as
      | { library_id: string; change_revision: number }
      | undefined
    if (state === undefined || library === undefined) throw new BackupDrillFailure("snapshot-identity", "backup snapshot is missing server identity")
    if (state.instance_id !== manifest.instance_id || state.instance_id !== configuration.instance_id ||
      library.library_id !== manifest.library_id || library.library_id !== configuration.library_id ||
      library.change_revision !== manifest.library_change_revision ||
      library.change_revision !== configuration.library_change_revision ||
      state.schema_version !== manifest.schema_version || state.schema_version !== configuration.schema_version) {
      throw new BackupDrillFailure("identity-mismatch", "backup manifest, configuration, and snapshot disagree")
    }

    const live = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const liveState = live.prepare("SELECT instance_id, schema_version FROM server_state WHERE id = 1").get() as
        | { instance_id: string; schema_version: number }
        | undefined
      const liveLibrary = live.prepare("SELECT library_id FROM server_library WHERE id = 1").get() as
        | { library_id: string }
        | undefined
      if (liveState === undefined || liveLibrary === undefined || liveState.instance_id !== state.instance_id || liveLibrary.library_id !== library.library_id) {
        throw new BackupDrillFailure("live-identity", "backup snapshot belongs to another server identity")
      }
      if (state.schema_version > Math.max(CURRENT_SCHEMA_VERSION, liveState.schema_version)) {
        throw new BackupDrillFailure("schema-unsupported", "backup snapshot schema is newer than this server")
      }
    } finally {
      live.close()
    }

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
      identity: { instance_id: state.instance_id, library_id: library.library_id },
      schema_version: state.schema_version,
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
    const members = await readArchiveMembers(archivePath, stagingDirectory)
    const { manifestBytes, configurationBytes, statePath, stateSize } = members
    if (sha256(manifestBytes) !== context.artifact.manifestDigest) throw new BackupDrillFailure("manifest-digest", "backup manifest digest does not match the catalog")
    const manifest = decodeJson(ArchiveManifest, manifestBytes, "manifest") as ArchiveManifest
    const configuration = decodeJson(SnapshotConfiguration, configurationBytes, "configuration") as SnapshotConfiguration
    if (manifest.artifact_id !== context.artifact.artifactId || manifest.destination_id !== context.artifact.destinationId ||
      manifest.relative_path !== context.artifact.relativePath || manifest.retention_class !== "archive") {
      throw new BackupDrillFailure("artifact-mismatch", "backup manifest is not bound to the catalog artifact")
    }
    const stateDigest = await digestFile(statePath, stateSize)
    for (const [name, size, digest] of [
      ["state.sqlite", stateSize, stateDigest],
      ["configuration.json", configurationBytes.byteLength, sha256(configurationBytes)]
    ] as const) {
      const payload = manifest.payloads[name]
      if (payload.size_bytes !== size || payload.sha256 !== digest) {
        throw new BackupDrillFailure("payload-digest", `backup ${name} digest does not match the manifest`)
      }
    }
    const checks = verifySnapshot(statePath, manifest, configuration, context.dbPath)
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
