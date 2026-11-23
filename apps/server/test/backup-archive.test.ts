import { execFile as execFileCallback } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { afterEach, describe, expect, it } from "vitest"
import serverPackage from "../package.json"
import { createBackupArchive, type BackupArchiveContext } from "../src/maintenance/BackupArchive"
import { startServer } from "./support/server-process"

const execFile = promisify(execFileCallback)
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const workspaces: Array<string> = []

const run = async (args: ReadonlyArray<string>) => {
  const result = await execFile(process.execPath, [SERVER_PATH, ...args], {
    cwd: path.resolve(".")
  }).catch((error: unknown) => {
    const failure = error as { stderr?: string; code?: number }
    throw new Error(`${failure.code ?? "unknown"}: ${failure.stderr ?? ""}`, { cause: error })
  })
  return JSON.parse(result.stdout) as Record<string, unknown>
}

const directArchiveContext = async (options: {
  readonly dataDir: string
  readonly destination: string
  readonly destinationId: string
  readonly beforePublish?: () => Promise<void>
}): Promise<{ readonly context: BackupArchiveContext; readonly close: () => void }> => {
  const database = new DatabaseSync(path.join(options.dataDir, "server.sqlite"))
  const destinationStats = await stat(options.destination)
  const destinationRow = {
    destinationId: options.destinationId,
    name: "primary",
    selectedPath: options.destination,
    canonicalPath: await realpath(options.destination),
    device: String(destinationStats.dev),
    inode: String(destinationStats.ino),
    state: "active" as const
  }
  const context: BackupArchiveContext = {
    dbPath: path.join(options.dataDir, "server.sqlite"),
    destination: destinationRow,
    roots: [],
    label: null,
    beforePublish: options.beforePublish,
    reserve: async (request) => {
      const nextOrder = (database.prepare(
        "SELECT COALESCE(MAX(publication_order), 0) + 1 AS next_order FROM backup_artifacts WHERE destination_id = ?"
      ).get(request.destinationId) as { next_order: number }).next_order
      database.prepare(`
        INSERT INTO backup_artifacts(
          artifact_id, destination_id, operation_id, relative_path, publication_order,
          retention_class, label, status, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'archive', ?, 'reserved', ?)
      `).run(
        request.artifactId,
        request.destinationId,
        request.operationId,
        request.relativePath,
        nextOrder,
        request.label,
        request.createdAtMs
      )
      return {
        kind: "reserved" as const,
        artifact: {
          artifactId: request.artifactId,
          destinationId: request.destinationId,
          operationId: request.operationId,
          relativePath: request.relativePath,
          publicationOrder: nextOrder,
          retentionClass: "archive" as const,
          label: request.label,
          status: "reserved" as const,
          manifestDigest: null,
          sizeBytes: null,
          createdAtMs: request.createdAtMs,
          completedAtMs: null
        }
      }
    },
    complete: async (request) => {
      database.prepare(`
        UPDATE backup_artifacts
        SET status = 'completed', manifest_digest = ?, size_bytes = ?, completed_at_ms = ?
        WHERE artifact_id = ?
      `).run(request.manifestDigest, request.sizeBytes, request.completedAtMs, request.artifactId)
      const row = database.prepare(`
        SELECT artifact_id, destination_id, operation_id, relative_path, publication_order,
               retention_class, label, status, manifest_digest, size_bytes, created_at_ms, completed_at_ms
        FROM backup_artifacts WHERE artifact_id = ?
      `).get(request.artifactId) as {
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
      return {
        kind: "completed" as const,
        artifact: {
          artifactId: row.artifact_id,
          destinationId: row.destination_id,
          operationId: row.operation_id,
          relativePath: row.relative_path,
          publicationOrder: row.publication_order,
          retentionClass: row.retention_class,
          label: row.label,
          status: row.status,
          manifestDigest: row.manifest_digest,
          sizeBytes: row.size_bytes,
          createdAtMs: row.created_at_ms,
          completedAtMs: row.completed_at_ms
        }
      }
    }
  }
  return { context, close: () => database.close() }
}

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

describe("server backup archive", () => {
  it("creates, verifies, and preserves a snapshot through the shipped CLI", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-backup-archive-"))
    workspaces.push(workspace)
    const dataDir = path.join(workspace, "data")
    const collection = path.join(workspace, "collection")
    const destination = path.join(workspace, "destination")
    await Promise.all([mkdir(dataDir), mkdir(collection), mkdir(destination)])
    const sourceFile = path.join(collection, "Book.cbz")
    const sourceBytes = Buffer.from("collection bytes")
    await writeFile(sourceFile, sourceBytes)

    const registered = await run([
      "backup-destination", "register", "--data-dir", dataDir,
      "--name", "primary", "--path", destination
    ])
    const saved = registered.destination as { destination_id: string }
    await execFile(process.execPath, [SERVER_PATH, "--data-dir", dataDir, "--initialize-owner"], {
      cwd: path.resolve(".")
    })
    await stat(path.join(dataDir, ".henshin-server-auth.sqlite"))
    const database = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    const entryId = randomUUID()
    try {
      const library = database.prepare("SELECT library_id FROM server_library WHERE id = 1").get() as { library_id: string }
      const identity = await stat(collection)
      const canonicalCollection = await realpath(collection)
      const rootId = randomUUID()
      database.prepare(`
        INSERT INTO server_roots(
          library_id, root_id, label, selected_path, canonical_path, device, inode,
          mapping_revision, policy_revision, exclusions, state
        ) VALUES (?, ?, 'Books', ?, ?, ?, ?, 1, 0, '[]', 'active')
      `).run(library.library_id, rootId, collection, canonicalCollection, String(identity.dev), String(identity.ino))
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
      database.prepare("UPDATE server_state SET schema_version = 9 WHERE id = 1").run()
    } finally {
      database.close()
    }

    const recovered = await startServer(path.join(dataDir, "server.sqlite"))
    await recovered.stop()
    const recoveredDatabase = new DatabaseSync(path.join(dataDir, "server.sqlite"), { readOnly: true })
    try {
      expect((recoveredDatabase.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number }).schema_version)
        .toBe(10)
      expect((recoveredDatabase.prepare("SELECT title_search, basename_search FROM library_entries WHERE entry_id = ?").get(entryId) as {
        title_search: string
        basename_search: string
      })).toMatchObject({ title_search: "book", basename_search: "book.cbz" })
    } finally {
      recoveredDatabase.close()
    }

    const schema10 = await startServer(path.join(dataDir, "server.sqlite"))
    await schema10.stop()

    const created = await run([
      "backup", "create", "--data-dir", dataDir, "--destination-id", saved.destination_id,
      "--label", "test archive"
    ])
    const archivePath = created.archive_path as string
    expect((await stat(path.join(destination, "archives"))).mode & 0o777).toBe(0o700)
    expect((await stat(archivePath)).mode & 0o777).toBe(0o600)
    const archiveBytes = new Uint8Array(await readFile(archivePath))
    const reader = new ZipReader(new Uint8ArrayReader(archiveBytes))
    const entries = await reader.getEntries()
    const payloads = new Map<string, Uint8Array>()
    for (const entry of entries) {
      if (entry.directory) throw new Error(`unexpected directory: ${entry.filename}`)
      payloads.set(entry.filename, new Uint8Array(await entry.getData(new Uint8ArrayWriter())))
    }
    await reader.close()
    expect([...payloads.keys()].sort()).toEqual(["configuration.json", "manifest.json", "state.sqlite"])

    const manifest = JSON.parse(new TextDecoder().decode(payloads.get("manifest.json"))) as {
      payloads: Record<string, { size_bytes: number; sha256: string }>
      library_id: string
      application_version: string
      schema_version: number
    }
    expect(manifest.application_version).toBe(serverPackage.version)
    expect(manifest.schema_version).toBe(10)
    for (const name of ["state.sqlite", "configuration.json"]) {
      const payload = payloads.get(name)
      if (payload === undefined) throw new Error(`missing ${name}`)
      expect(manifest.payloads[name]).toEqual({
        size_bytes: payload.byteLength,
        sha256: createHash("sha256").update(payload).digest("hex")
      })
    }
    const unpacked = path.join(workspace, "unpacked.sqlite")
    await writeFile(unpacked, payloads.get("state.sqlite") as Uint8Array)
    const snapshot = new DatabaseSync(unpacked, { readOnly: true })
    expect((snapshot.prepare("SELECT library_id FROM server_library WHERE id = 1").get() as { library_id: string }).library_id)
      .toBe(manifest.library_id)
    expect((snapshot.prepare("SELECT COUNT(*) AS count FROM library_entries").get() as { count: number }).count).toBe(1)
    expect((snapshot.prepare("SELECT COUNT(*) AS count FROM open_events").get() as { count: number }).count).toBe(1)
    expect((snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok")
    expect(snapshot.prepare("PRAGMA foreign_key_check").all()).toEqual([])
    snapshot.close()
    expect(await readFile(sourceFile)).toEqual(sourceBytes)

    const interrupted = await directArchiveContext({
      dataDir,
      destination,
      destinationId: saved.destination_id,
      beforePublish: async () => {
        throw new Error("test publication interruption")
      }
    })
    await expect(createBackupArchive(interrupted.context)).rejects.toThrow("test publication interruption")
    interrupted.close()
    expect((await readdir(path.join(destination, "archives"))).filter((name) => name.endsWith(".henshin.zip"))).toHaveLength(1)

    const replacedPath = path.join(workspace, "destination-before-replacement")
    const replacement = await directArchiveContext({
      dataDir,
      destination,
      destinationId: saved.destination_id,
      beforePublish: async () => {
        await rename(destination, replacedPath)
        await mkdir(destination)
      }
    })
    await expect(createBackupArchive(replacement.context)).rejects.toThrow("backup destination changed and publication was blocked")
    replacement.close()
    expect((await readdir(path.join(replacedPath, "archives"))).filter((name) => name.endsWith(".henshin.zip"))).toHaveLength(1)
    await expect(stat(path.join(destination, "archives"))).rejects.toMatchObject({ code: "ENOENT" })

    const catalog = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    try {
      const artifacts = catalog.prepare(
        "SELECT status FROM backup_artifacts ORDER BY publication_order"
      ).all() as Array<{ status: string }>
      expect(artifacts.map((artifact) => artifact.status)).toEqual(["completed", "reserved", "reserved"])
    } finally {
      catalog.close()
    }
  })
})
