import { execFile as execFileCallback } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  LibraryHttpClient,
  MaintenanceHttpClient,
  ServerHttpClient,
  TaskHttpClient,
  type BackupTask
} from "@henshin/contracts"
import { requireScanTask, startServer, type RunningServer } from "./support/server-process"

const execFile = promisify(execFileCallback)
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const servers: Array<RunningServer> = []
const workspaces: Array<string> = []

const withClient = <A, E>(
  server: RunningServer,
  program: Effect.Effect<A, E, ServerHttpClient | LibraryHttpClient | MaintenanceHttpClient | TaskHttpClient>
): Promise<A> => Effect.runPromise(Effect.provide(program, Layer.mergeAll(
  ServerHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken }),
  LibraryHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken }),
  MaintenanceHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken }),
  TaskHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })
)))

const waitForBackup = async (server: RunningServer, taskId: string): Promise<BackupTask> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await withClient(server, Effect.gen(function*() {
      return yield* (yield* TaskHttpClient).get({ params: { id: taskId } })
    }))
    if (result.data.kind !== "backup") throw new Error("expected a backup task")
    if (result.data.status !== "queued" && result.data.status !== "running") return result.data
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("backup task did not reach a terminal state")
}

const registerDestination = async (dataDir: string, destination: string): Promise<string> => {
  const result = await execFile(process.execPath, [
    SERVER_PATH,
    "backup-destination",
    "register",
    "--data-dir",
    dataDir,
    "--name",
    "primary",
    "--path",
    destination
  ])
  return (JSON.parse(result.stdout) as { destination: { destination_id: string } }).destination.destination_id
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

describe("running-server manual archive", () => {
  it("submits an authenticated archive, preserves retry identity and concurrent edits, and verifies its bundle", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-running-archive-"))
    workspaces.push(workspace)
    const dataDir = path.join(workspace, "data")
    const collection = path.join(workspace, "collection")
    const destination = path.join(workspace, "destination")
    await Promise.all([mkdir(dataDir), mkdir(collection), mkdir(destination)])
    await mkdir(path.join(collection, "book"))
    await writeFile(path.join(collection, "book", "001.jpg"), "page")
    const dbPath = path.join(dataDir, "server.sqlite")
    const destinationId = await registerDestination(dataDir, destination)
    let server = await startServer(dbPath)
    servers.push(server)

    const preview = await withClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).preview({ payload: { path: collection } })
    }))
    if (!("preview_identity" in preview.data)) throw new Error("expected collection setup preview")
    const previewData = preview.data
    const root = await withClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).save({
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          label: "Archive test collection",
          path: collection,
          preview_identity: previewData.preview_identity
        }
      })
    }))
    const scan = await withClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    if (!("task" in scan.data)) throw new Error("expected scan task")
    const scanTask = scan.data.task
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await withClient(server, Effect.gen(function*() {
        return yield* (yield* TaskHttpClient).get({ params: { id: scanTask.task_id } })
      }))
      const currentScan = requireScanTask(current.data)
      if (currentScan.status !== "queued" && currentScan.status !== "running") break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    const entry = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 10 } })
    })).then((page) => page.data.entries[0])
    if (entry === undefined) throw new Error("expected scanned library entry")
    const entryDetails = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entry({ params: { id: entry.entry_id } })
    }))

    const operationId = randomUUID()
    const payload = { operation_id: operationId, destination_id: destinationId, retention_class: "archive" as const, label: "live archive" }
    const unauthenticated = await fetch(`${server.baseUrl}/api/v1/maintenance/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
    expect(unauthenticated.status).toBe(401)

    const callerPath = await fetch(`${server.baseUrl}/api/v1/maintenance/backups`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.bearerToken}` },
      body: JSON.stringify({ ...payload, output_path: path.join(workspace, "caller-chosen.zip") })
    })
    expect(callerPath.status).toBe(400)
    expect(await stat(path.join(workspace, "caller-chosen.zip")).catch(() => null)).toBeNull()

    const edit = withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: entry.entry_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          expected_decision_version: entryDetails.data.decision_version,
          command: { type: "set-note", text: "edit during archive" }
        }
      })
    }))
    const submitted = await withClient(server, Effect.gen(function*() {
      return yield* (yield* MaintenanceHttpClient).createBackup({ payload })
    }))
    const listed = await withClient(server, Effect.gen(function*() {
      return yield* (yield* TaskHttpClient).list()
    }))
    expect(listed.data.some((task) => task.kind === "backup" && task.task_id === submitted.data.task.task_id)).toBe(true)
    const edited = await edit
    const replay = await withClient(server, Effect.gen(function*() {
      return yield* (yield* MaintenanceHttpClient).createBackup({ payload })
    }))
    expect(replay.data.task.task_id).toBe(submitted.data.task.task_id)
    expect(replay.data.task.artifact_id).toBe(submitted.data.task.artifact_id)
    const completed = await waitForBackup(server, submitted.data.task.task_id)
    expect(completed.status).toBe("succeeded")
    expect(edited.data.entry.note?.text).toBe("edit during archive")

    const archivePath = path.join(destination, completed.relative_path)
    const archiveBytes = new Uint8Array(await readFile(archivePath))
    const archiveIdentity = await stat(archivePath)
    const archiveDigest = createHash("sha256").update(archiveBytes).digest("hex")
    const reader = new ZipReader(new Uint8ArrayReader(archiveBytes))
    const payloads = new Map<string, Uint8Array>()
    for (const member of await reader.getEntries()) {
      if (member.directory) throw new Error(`unexpected archive directory: ${member.filename}`)
      payloads.set(member.filename, new Uint8Array(await member.getData(new Uint8ArrayWriter())))
    }
    await reader.close()
    expect([...payloads.keys()].sort()).toEqual(["configuration.json", "manifest.json", "state.sqlite"])

    const manifest = JSON.parse(new TextDecoder().decode(payloads.get("manifest.json"))) as {
      artifact_id: string
      operation_id: string
      destination_id: string
      retention_class: string
      library_id: string
      library_change_revision: number
      payloads: Record<string, { size_bytes: number; sha256: string }>
    }
    expect(manifest).toMatchObject({
      artifact_id: completed.artifact_id,
      operation_id: operationId,
      destination_id: destinationId,
      retention_class: "archive"
    })
    for (const name of ["manifest.json", "state.sqlite", "configuration.json"]) {
      const bytes = payloads.get(name)
      if (bytes === undefined) throw new Error(`missing archive payload ${name}`)
      if (name !== "manifest.json") {
        expect(manifest.payloads[name]).toEqual({
          size_bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex")
        })
      }
    }

    const snapshotPath = path.join(workspace, "snapshot.sqlite")
    await writeFile(snapshotPath, payloads.get("state.sqlite") as Uint8Array)
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
    const live = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const snapshotIdentity = snapshot.prepare("SELECT instance_id FROM server_state WHERE id = 1").get() as { instance_id: string }
      const snapshotLibrary = snapshot.prepare("SELECT library_id, change_revision FROM server_library WHERE id = 1").get() as { library_id: string; change_revision: number }
      const snapshotEntry = snapshot.prepare("SELECT entry_id FROM library_entries WHERE entry_id = ?").get(entry.entry_id)
      const snapshotNote = snapshot.prepare("SELECT notes FROM entry_overrides WHERE entry_id = ?").get(entry.entry_id) as { notes: string | null } | undefined
      const configuration = JSON.parse(new TextDecoder().decode(payloads.get("configuration.json"))) as {
        instance_id: string
        library_id: string
        library_change_revision: number
      }
      expect(configuration).toMatchObject({
        instance_id: snapshotIdentity.instance_id,
        library_id: snapshotLibrary.library_id,
        library_change_revision: snapshotLibrary.change_revision
      })
      expect(manifest.library_id).toBe(snapshotLibrary.library_id)
      expect(manifest.library_change_revision).toBe(snapshotLibrary.change_revision)
      expect(snapshotEntry).toEqual({ entry_id: entry.entry_id })
      expect(snapshotNote?.notes === null || snapshotNote?.notes === "edit during archive").toBe(true)
      expect((live.prepare("SELECT notes FROM entry_overrides WHERE entry_id = ?").get(entry.entry_id) as { notes: string }).notes)
        .toBe("edit during archive")
    } finally {
      snapshot.close()
      live.close()
    }

    // Simulate a process stop after verified publication but before task
    // completion. Restart recovery must expose Interrupted, and retry must
    // reconcile the completed artifact without replacing its file.
    const persisted = new DatabaseSync(dbPath)
    try {
      persisted.prepare(
        "UPDATE backup_tasks SET status = 'running', error_code = NULL, error_message = NULL WHERE task_id = ?"
      ).run(completed.task_id)
    } finally {
      persisted.close()
    }
    await server.stop()
    server = await startServer(dbPath)
    servers.push(server)
    const recovered = await withClient(server, Effect.gen(function*() {
      return yield* (yield* TaskHttpClient).get({ params: { id: completed.task_id } })
    }))
    if (recovered.data.kind !== "backup") throw new Error("expected recovered backup task")
    expect(recovered.data.status).toBe("interrupted")
    const retried = await withClient(server, Effect.gen(function*() {
      return yield* (yield* MaintenanceHttpClient).createBackup({ payload })
    }))
    expect(retried.data.task.task_id).toBe(completed.task_id)
    expect((await waitForBackup(server, completed.task_id)).status).toBe("succeeded")
    expect(createHash("sha256").update(await readFile(archivePath)).digest("hex")).toBe(archiveDigest)
    expect((await stat(archivePath)).ino).toBe(archiveIdentity.ino)

    const movedDestination = path.join(workspace, "previous-destination")
    await rename(destination, movedDestination)
    await mkdir(destination)
    const changed = await withClient(server, Effect.gen(function*() {
      return yield* (yield* MaintenanceHttpClient).createBackup({
        payload: { ...payload, operation_id: randomUUID() }
      })
    }))
    expect((await waitForBackup(server, changed.data.task.task_id)).status).toBe("failed")
    expect((await readFile(path.join(movedDestination, completed.relative_path))).byteLength).toBeGreaterThan(0)
  })
})
