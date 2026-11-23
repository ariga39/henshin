import { execFile as execFileCallback } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { runBackupDrill, type BackupDrillContext } from "../src/maintenance/BackupDrill"
import type { BackupArtifactRow, BackupDestinationRow } from "../src/persistence/worker-protocol"

const execFile = promisify(execFileCallback)
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const workspaces: Array<string> = []

const runJson = async (args: ReadonlyArray<string>) => {
  const result = await execFile(process.execPath, [SERVER_PATH, ...args], { cwd: path.resolve(".") })
  return JSON.parse(result.stdout) as Record<string, any>
}

const runFailure = async (args: ReadonlyArray<string>) => {
  try {
    await execFile(process.execPath, [SERVER_PATH, ...args], { cwd: path.resolve(".") })
    throw new Error("expected command failure")
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number }
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" }
  }
}

const directInterruptedDrillContext = async (options: {
  readonly dataDir: string
  readonly destination: string
  readonly artifactId: string
}): Promise<{ readonly context: BackupDrillContext; readonly close: () => void }> => {
  const database = new DatabaseSync(path.join(options.dataDir, "server.sqlite"))
  const artifactRow = database.prepare(`
    SELECT artifact_id, destination_id, operation_id, relative_path, publication_order,
           retention_class, label, status, manifest_digest, size_bytes, created_at_ms, completed_at_ms
    FROM backup_artifacts WHERE artifact_id = ?
  `).get(options.artifactId) as {
    artifact_id: string
    destination_id: string
    operation_id: string
    relative_path: string
    publication_order: number
    retention_class: "archive"
    label: string | null
    status: "completed"
    manifest_digest: string
    size_bytes: number
    created_at_ms: number
    completed_at_ms: number
  }
  const destinationStats = await stat(options.destination)
  const destination: BackupDestinationRow = {
    destinationId: artifactRow.destination_id,
    name: "primary",
    selectedPath: options.destination,
    canonicalPath: await realpath(options.destination),
    device: String(destinationStats.dev),
    inode: String(destinationStats.ino),
    state: "active"
  }
  const artifact: BackupArtifactRow = {
    artifactId: artifactRow.artifact_id,
    destinationId: artifactRow.destination_id,
    operationId: artifactRow.operation_id,
    relativePath: artifactRow.relative_path,
    publicationOrder: artifactRow.publication_order,
    retentionClass: artifactRow.retention_class,
    label: artifactRow.label,
    status: artifactRow.status,
    manifestDigest: artifactRow.manifest_digest,
    sizeBytes: artifactRow.size_bytes,
    createdAtMs: artifactRow.created_at_ms,
    completedAtMs: artifactRow.completed_at_ms
  }
  const context: BackupDrillContext = {
    dbPath: path.join(options.dataDir, "server.sqlite"),
    destination,
    artifact,
    roots: [],
    beforeVerification: async () => "interrupt",
    start: async (request) => {
      database.prepare(`
        INSERT INTO backup_drill_runs(
          run_id, artifact_id, manifest_digest, status, started_at_ms,
          completed_at_ms, duration_ms, diagnostic_code, diagnostic_message, checks_json
        ) VALUES (?, ?, ?, 'running', ?, NULL, NULL, NULL, NULL, NULL)
      `).run(request.runId, request.artifactId, request.manifestDigest, request.startedAtMs)
      return {
        kind: "started" as const,
        run: {
          runId: request.runId,
          artifactId: request.artifactId,
          manifestDigest: request.manifestDigest,
          status: "running" as const,
          startedAtMs: request.startedAtMs,
          completedAtMs: null,
          durationMs: null,
          diagnosticCode: null,
          diagnosticMessage: null,
          checksJson: null
        }
      }
    },
    complete: async () => {
      throw new Error("completion is not expected during interruption")
    }
  }
  return { context, close: () => database.close() }
}

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

describe("server backup restore drill", () => {
  it("records pass, damage, and interruption against immutable archive identity", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-backup-drill-"))
    workspaces.push(workspace)
    const dataDir = path.join(workspace, "data")
    const collection = path.join(workspace, "collection")
    const destination = path.join(workspace, "destination")
    await Promise.all([mkdir(dataDir), mkdir(collection), mkdir(destination)])
    const sourceFile = path.join(collection, "Book.cbz")
    const sourceBytes = Buffer.from("source bytes remain unchanged")
    await writeFile(sourceFile, sourceBytes)

    const registered = await runJson([
      "backup-destination", "register", "--data-dir", dataDir,
      "--name", "primary", "--path", destination
    ])
    const destinationId = registered.destination.destination_id as string
    await execFile(process.execPath, [SERVER_PATH, "--data-dir", dataDir, "--initialize-owner"], { cwd: path.resolve(".") })

    const database = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    try {
      const library = database.prepare("SELECT library_id FROM server_library WHERE id = 1").get() as { library_id: string }
      const identity = await stat(collection)
      const rootId = randomUUID()
      const entryId = randomUUID()
      database.prepare(`
        INSERT INTO server_roots(
          library_id, root_id, label, selected_path, canonical_path, device, inode,
          mapping_revision, policy_revision, exclusions, state
        ) VALUES (?, ?, 'Books', ?, ?, ?, ?, 1, 0, '[]', 'active')
      `).run(library.library_id, rootId, collection, await realpath(collection), String(identity.dev), String(identity.ino))
      const manifest = JSON.stringify({ version: 1, pages: [], before: { bytes: 0, entry_count: 0 }, after: { bytes: 0, entry_count: 0 } })
      database.prepare(`
        INSERT INTO library_entries(
          entry_id, library_id, root_id, relative_path, source_path, kind, title, page_count,
          state, content_version, location_revision, decision_version, manifest_json,
          created_at_ms, updated_at_ms, accepted_observation_json
        ) VALUES (?, ?, ?, 'Book.cbz', ?, 'archive', 'Book', 0, 'accepted', 1, 1, 1, ?, ?, ?, ?)
      `).run(entryId, library.library_id, rootId, sourceFile, manifest, Date.now(), Date.now(), "{}")
      database.prepare("INSERT INTO entry_statistics(entry_id, open_count, last_opened_at_ms) VALUES (?, 1, ?)").run(entryId, Date.now())
      database.prepare(`
        INSERT INTO open_events(
          event_id, instance_id, entry_id, device_id, observed_location_revision,
          observed_content_version, occurred_at_ms, receipt_at_ms
        ) VALUES (?, (SELECT instance_id FROM server_state WHERE id = 1), ?, 'fixture', 1, 1, ?, ?)
      `).run(randomUUID(), entryId, Date.now(), Date.now())
      database.prepare("UPDATE server_library SET change_revision = change_revision + 1 WHERE id = 1").run()
    } finally {
      database.close()
    }

    const first = await runJson(["backup", "create", "--data-dir", dataDir, "--destination-id", destinationId])
    const firstArtifactId = first.artifact_id as string
    const firstArchivePath = first.archive_path as string
    const firstArchive = await readFile(firstArchivePath)
    const firstArchiveDigest = createHash("sha256").update(firstArchive).digest("hex")
    const passed = await runJson(["backup", "drill", "--data-dir", dataDir, "--artifact-id", firstArtifactId])
    expect(passed.run.status).toBe("passed")
    expect(passed.run.artifactId).toBe(firstArtifactId)
    expect(passed.checks.records.open_events).toBe(1)
    expect(passed.checks.derived_covers.placeholders).toBe(true)
    expect(passed.last_successful.artifactId).toBe(firstArtifactId)

    await runJson(["backup", "create", "--data-dir", dataDir, "--destination-id", destinationId, "--label", "newer archive"])
    const damaged = Buffer.from(firstArchive)
    damaged[0] = (damaged[0] ?? 0) ^ 0xff
    await writeFile(firstArchivePath, damaged)
    const failed = await runFailure(["backup", "drill", "--data-dir", dataDir, "--artifact-id", firstArtifactId])
    expect(failed.code).toBe(1)
    const failedResult = JSON.parse(failed.stdout) as Record<string, any>
    expect(failedResult.run.status).toBe("failed")
    expect(failedResult.run.artifactId).toBe(firstArtifactId)
    await writeFile(firstArchivePath, firstArchive)
    expect(createHash("sha256").update(await readFile(firstArchivePath)).digest("hex")).toBe(firstArchiveDigest)

    const interrupted = await directInterruptedDrillContext({ dataDir, destination, artifactId: firstArtifactId })
    await expect(runBackupDrill(interrupted.context)).rejects.toMatchObject({ name: "BackupDrillInterrupted" })
    interrupted.close()
    const listed = await runJson(["backup", "drill", "list", "--data-dir", dataDir])
    expect(listed.latest_attempt.status).toBe("interrupted")
    expect(listed.latest_attempt.artifactId).toBe(firstArtifactId)
    expect(listed.last_successful.status).toBe("passed")
    expect(listed.last_successful.artifactId).toBe(firstArtifactId)
    expect(listed.runs.some((run: Record<string, any>) => run.status === "failed" && run.artifactId === firstArtifactId)).toBe(true)
    expect(await readFile(sourceFile)).toEqual(sourceBytes)
    expect(createHash("sha256").update(await readFile(firstArchivePath)).digest("hex")).toBe(firstArchiveDigest)
  })
})
