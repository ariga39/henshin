import { execFile as execFileCallback } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { LibraryHttpClient } from "@henshin/contracts"
import { hashBearerToken, readOwnerCredential } from "../src/owner-credential"
import { recoverInterruptedRestore, restoreExistingAuthority, type RestoreArtifact } from "../src/maintenance/BackupRestore"
import { DatabaseWorker } from "../src/persistence/DatabaseWorker"
import { startServer, type RunningServer } from "./support/server-process"

const execFile = promisify(execFileCallback)
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const workspaces: Array<string> = []
const servers: Array<RunningServer> = []

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

const seedLibrary = async (dataDir: string, collection: string): Promise<{
  readonly instanceId: string
  readonly libraryId: string
  readonly entryId: string
  readonly rootId: string
}> => {
  const database = new DatabaseSync(path.join(dataDir, "server.sqlite"))
  try {
    const state = database.prepare("SELECT instance_id FROM server_state WHERE id = 1").get() as { instance_id: string }
    const library = database.prepare("SELECT library_id FROM server_library WHERE id = 1").get() as { library_id: string }
    const rootId = randomUUID()
    const entryId = randomUUID()
    const sourcePath = path.join(collection, "Book.cbz")
    const identity = await stat(collection)
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
    `).run(entryId, library.library_id, rootId, sourcePath, manifest, Date.now(), Date.now(), "{}")
    database.prepare("INSERT INTO entry_statistics(entry_id, open_count, last_opened_at_ms) VALUES (?, 1, ?)").run(entryId, Date.now())
    database.prepare("UPDATE prototype_note SET text = 'seed' WHERE note_id = 'note-1'").run()
    database.prepare(`
      INSERT INTO open_events(
        event_id, instance_id, entry_id, device_id, observed_location_revision,
        observed_content_version, occurred_at_ms, receipt_at_ms
      ) VALUES (?, ?, ?, 'fixture', 1, 1, ?, ?)
    `).run(randomUUID(), state.instance_id, entryId, Date.now(), Date.now())
    database.prepare("UPDATE server_library SET change_revision = change_revision + 1 WHERE id = 1").run()
    return { instanceId: state.instance_id, libraryId: library.library_id, entryId, rootId }
  } finally {
    database.close()
  }
}

const mutateAfterArchive = (dataDir: string, entryId: string, instanceId: string): void => {
  const database = new DatabaseSync(path.join(dataDir, "server.sqlite"))
  try {
    database.prepare("UPDATE prototype_note SET text = 'newer state' WHERE note_id = 'note-1'").run()
    database.prepare(`
      INSERT INTO open_events(
        event_id, instance_id, entry_id, device_id, observed_location_revision,
        observed_content_version, occurred_at_ms, receipt_at_ms
      ) VALUES (?, ?, ?, 'later-device', 1, 1, ?, ?)
    `).run(randomUUID(), instanceId, entryId, Date.now(), Date.now())
    database.prepare("UPDATE entry_statistics SET open_count = 2 WHERE entry_id = ?").run(entryId)
    database.prepare("UPDATE server_library SET change_revision = change_revision + 1 WHERE id = 1").run()
  } finally {
    database.close()
  }
}

const readState = (dataDir: string) => {
  const database = new DatabaseSync(path.join(dataDir, "server.sqlite"))
  try {
    return {
      note: (database.prepare("SELECT text FROM prototype_note WHERE note_id = 'note-1'").get() as { text: string }).text,
      entries: (database.prepare("SELECT COUNT(*) AS count FROM library_entries").get() as { count: number }).count,
      openEvents: (database.prepare("SELECT COUNT(*) AS count FROM open_events").get() as { count: number }).count,
      restoreStatus: (database.prepare("SELECT status FROM server_restore_state WHERE id = 1").get() as { status: string }).status,
      rootVerification: (database.prepare("SELECT status FROM server_root_verification").get() as { status: string }).status
    }
  } finally {
    database.close()
  }
}

const withLibraryClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, LibraryHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, LibraryHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})
describe("ordinary server backup restore", () => {
  it("previews and restores a same-authority point through a restarted service", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-backup-restore-"))
    workspaces.push(workspace)
    const dataDir = path.join(workspace, "data")
    const collection = path.join(workspace, "collection")
    const destination = path.join(workspace, "destination")
    await Promise.all([mkdir(dataDir), mkdir(collection), mkdir(destination)])
    const sourceFile = path.join(collection, "Book.cbz")
    const sourceBytes = Buffer.from("collection bytes remain unchanged")
    await writeFile(sourceFile, sourceBytes)

    const registered = await runJson(["backup-destination", "register", "--data-dir", dataDir, "--name", "primary", "--path", destination])
    const destinationId = registered.destination.destination_id as string
    const ownerOutput = await execFile(process.execPath, [SERVER_PATH, "--data-dir", dataDir, "--initialize-owner"], { cwd: path.resolve(".") })
    const oldOwnerToken = ownerOutput.stdout.trim().slice("owner_token=".length)
    const identity = await seedLibrary(dataDir, collection)
    const created = await runJson(["backup", "create", "--data-dir", dataDir, "--destination-id", destinationId])
    const artifactId = created.artifact_id as string
    const archivePath = created.archive_path as string
    const archiveDigest = createHash("sha256").update(await readFile(archivePath)).digest("hex")
    mutateAfterArchive(dataDir, identity.entryId, identity.instanceId)

    const running = await startServer(path.join(dataDir, "server.sqlite"))
    servers.push(running)
    const locked = await runFailure(["backup", "restore", "apply", "--data-dir", dataDir, "--artifact-id", artifactId, "--confirm"])
    expect(locked.code).toBe(1)
    expect(locked.stderr).toContain("already owned")
    await running.stop()
    servers.splice(servers.indexOf(running), 1)

    const preview = await runJson(["backup", "restore", "preview", "--data-dir", dataDir, "--artifact-id", artifactId])
    expect(preview.requiresConfirmation).toBe(true)
    expect(preview.affectedInterval.libraryChangeRevisions).toMatchObject({ from: 1, to: 2, estimatedLost: 1 })
    const restored = await runJson(["backup", "restore", "apply", "--data-dir", dataDir, "--artifact-id", artifactId, "--confirm"])
    expect(restored.post_restore).toMatchObject({ status: "needs-reconciliation", scans: "suspended", backup_publication: "suspended", mappings: "needs-verification" })
    expect(restored.owner_token).not.toBe(oldOwnerToken)
    expect(await readOwnerCredential(path.join(dataDir, "server.sqlite"))).toMatchObject({ verifier: hashBearerToken(restored.owner_token) })
    expect(await stat(restored.rollbackPath)).toBeTruthy()
    expect(createHash("sha256").update(await readFile(archivePath)).digest("hex")).toBe(archiveDigest)
    expect(await readFile(sourceFile)).toEqual(sourceBytes)
    expect(readState(dataDir)).toMatchObject({ note: "seed", entries: 1, openEvents: 1, restoreStatus: "needs-reconciliation", rootVerification: "needs-verification" })

    const restarted = await startServer(path.join(dataDir, "server.sqlite"))
    servers.push(restarted)
    expect(restarted.instanceId).toBe(identity.instanceId)
    expect(restarted.epoch).not.toBe(running.epoch)
    const library = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    expect(library.data.entries).toHaveLength(1)
    expect(library.data.entries[0]?.relative_path).toBe("Book.cbz")
    await restarted.stop()
    servers.splice(servers.indexOf(restarted), 1)

    const blockedPublication = await runFailure(["backup", "create", "--data-dir", dataDir, "--destination-id", destinationId])
    expect(blockedPublication.code).toBe(1)
    expect(blockedPublication.stderr).toContain("reconciliation")

    expect(await runJson(["backup", "restore", "reconcile", "--data-dir", dataDir])).toMatchObject({ status: "normal", roots: 1, destinations: 1 })
    const afterReconcile = await runJson(["backup", "create", "--data-dir", dataDir, "--destination-id", destinationId])
    expect(afterReconcile.status).toBe("completed")
  })

  it("rejects mismatched and damaged recovery points without replacing the target", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-backup-restore-reject-"))
    workspaces.push(workspace)
    const dataDir = path.join(workspace, "data")
    const collection = path.join(workspace, "collection")
    const destination = path.join(workspace, "destination")
    await Promise.all([mkdir(dataDir), mkdir(collection), mkdir(destination)])
    await writeFile(path.join(collection, "Book.cbz"), "source")
    const registered = await runJson(["backup-destination", "register", "--data-dir", dataDir, "--name", "primary", "--path", destination])
    const destinationId = registered.destination.destination_id as string
    await execFile(process.execPath, [SERVER_PATH, "--data-dir", dataDir, "--initialize-owner"], { cwd: path.resolve(".") })
    const identity = await seedLibrary(dataDir, collection)
    const created = await runJson(["backup", "create", "--data-dir", dataDir, "--destination-id", destinationId])
    const artifactId = created.artifact_id as string
    const archivePath = created.archive_path as string
    const originalTarget = await readFile(path.join(dataDir, "server.sqlite"))
    const database = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    database.prepare("UPDATE server_state SET instance_id = ? WHERE id = 1").run(randomUUID())
    database.close()
    const mismatch = await runFailure(["backup", "restore", "apply", "--data-dir", dataDir, "--artifact-id", artifactId, "--confirm"])
    expect(mismatch.code).toBe(1)
    expect(mismatch.stderr).toContain("another server instance")
    expect(await readFile(path.join(dataDir, "server.sqlite"))).not.toEqual(originalTarget)

    const restoreIdentity = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    restoreIdentity.prepare("UPDATE server_state SET instance_id = ? WHERE id = 1").run(identity.instanceId)
    restoreIdentity.close()
    const damaged = await readFile(archivePath)
    damaged[0] = (damaged[0] ?? 0) ^ 0xff
    await writeFile(archivePath, damaged)
    const damagedResult = await runFailure(["backup", "restore", "apply", "--data-dir", dataDir, "--artifact-id", artifactId, "--confirm"])
    expect(damagedResult.code).toBe(1)
    expect(damagedResult.stderr).toContain("backup artifact")
  })

  it("recovers the original target after an interrupted replacement marker", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-backup-restore-interrupt-"))
    workspaces.push(workspace)
    const dataDir = path.join(workspace, "data")
    const destination = path.join(workspace, "destination")
    await Promise.all([mkdir(dataDir), mkdir(destination)])
    const registered = await runJson(["backup-destination", "register", "--data-dir", dataDir, "--name", "primary", "--path", destination])
    const destinationId = registered.destination.destination_id as string
    const ownerOutput = await execFile(process.execPath, [SERVER_PATH, "--data-dir", dataDir, "--initialize-owner"], { cwd: path.resolve(".") })
    const ownerToken = ownerOutput.stdout.trim().slice("owner_token=".length)
    const created = await runJson(["backup", "create", "--data-dir", dataDir, "--destination-id", destinationId])
    const artifactRow = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    const row = artifactRow.prepare(`
      SELECT a.artifact_id, a.destination_id, a.operation_id, a.relative_path, a.publication_order,
             a.label, a.manifest_digest, a.size_bytes, a.created_at_ms, a.completed_at_ms,
             d.selected_path, d.canonical_path, d.device, d.inode
      FROM backup_artifacts a JOIN backup_destinations d ON d.destination_id = a.destination_id
      WHERE a.artifact_id = ?
    `).get(created.artifact_id) as any
    artifactRow.close()
    const artifact: RestoreArtifact = {
      artifactId: row.artifact_id,
      destinationId: row.destination_id,
      operationId: row.operation_id,
      relativePath: row.relative_path,
      publicationOrder: row.publication_order,
      label: row.label,
      manifestDigest: row.manifest_digest,
      sizeBytes: row.size_bytes,
      createdAtMs: row.created_at_ms,
      completedAtMs: row.completed_at_ms,
      destination: { selectedPath: row.selected_path, canonicalPath: row.canonical_path, device: row.device, inode: row.inode }
    }
    const before = await readFile(path.join(dataDir, "server.sqlite"))
    await expect(restoreExistingAuthority({
      dbPath: path.join(dataDir, "server.sqlite"),
      artifact,
      confirm: true,
      beforeInstall: async () => { throw new Error("simulated interruption") }
    })).rejects.toThrow("simulated interruption")
    await recoverInterruptedRestore(path.join(dataDir, "server.sqlite"))
    expect(await readFile(path.join(dataDir, "server.sqlite"))).toEqual(before)

    await expect(restoreExistingAuthority({
      dbPath: path.join(dataDir, "server.sqlite"),
      artifact,
      confirm: true,
      beforeSidecarMove: async () => { throw new Error("simulated sidecar interruption") }
    })).rejects.toThrow("simulated sidecar interruption")
    const marker = JSON.parse(await readFile(path.join(dataDir, ".henshin-restore.json"), "utf8")) as Record<string, string>
    expect(marker.rollbackWalPath).toBe(`${marker.rollbackPath}-wal`)
    expect(marker.rollbackShmPath).toBe(`${marker.rollbackPath}-shm`)
    const recoveredByMaintenance = await runJson(["backup", "create", "--data-dir", dataDir, "--destination-id", destinationId])
    expect(recoveredByMaintenance.status).toBe("completed")
    await expect(stat(path.join(dataDir, ".henshin-restore.json"))).rejects.toMatchObject({ code: "ENOENT" })

    await expect(restoreExistingAuthority({
      dbPath: path.join(dataDir, "server.sqlite"),
      artifact,
      confirm: true,
      afterInstall: async () => { throw new Error("simulated post-install interruption") }
    })).rejects.toThrow("simulated post-install interruption")
    await expect(recoverInterruptedRestore(path.join(dataDir, "unrelated.sqlite"))).rejects.toThrow("original database path")
    const blocked = await execFile(process.execPath, [SERVER_PATH, "--data-dir", dataDir], { timeout: 8000 })
      .then(() => { throw new Error("expected restored startup to refuse the old credential") }, (error) => error)
    expect(blocked).toMatchObject({ code: 1, stderr: expect.stringContaining("--rotate-owner") })
    const rotated = await execFile(process.execPath, [SERVER_PATH, "--data-dir", dataDir, "--rotate-owner"])
    const newToken = /^owner_token=(\S+)$/mu.exec(rotated.stdout)?.[1]
    if (newToken === undefined) throw new Error("rotation did not return the recovery credential")
    expect(newToken).not.toBe(ownerToken)
    expect(await readOwnerCredential(path.join(dataDir, "server.sqlite"))).toMatchObject({ verifier: hashBearerToken(newToken) })
    await expect(stat(path.join(dataDir, ".henshin-restore.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps restore-pending scan and EH diagnostics after the worker transaction aborts", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-backup-restore-gates-"))
    workspaces.push(workspace)
    const dataDir = path.join(workspace, "data")
    const collection = path.join(workspace, "collection")
    const destination = path.join(workspace, "destination")
    await Promise.all([mkdir(dataDir), mkdir(collection), mkdir(destination)])
    await writeFile(path.join(collection, "Book.cbz"), "source")
    await runJson(["backup-destination", "register", "--data-dir", dataDir, "--name", "primary", "--path", destination])
    await seedLibrary(dataDir, collection)
    const database = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    database.prepare("UPDATE server_restore_state SET status = 'needs-reconciliation' WHERE id = 1").run()
    database.close()

    const identity = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    const root = identity.prepare("SELECT root_id FROM server_roots LIMIT 1").get() as { root_id: string }
    const entry = identity.prepare("SELECT entry_id FROM library_entries LIMIT 1").get() as { entry_id: string }
    identity.close()
    const results = await Effect.runPromise(Effect.gen(function*() {
      const worker = yield* DatabaseWorker
      yield* worker.call({ op: "init" })
      const scan = yield* Effect.result(worker.call({
        op: "startManualScan", taskId: randomUUID(), operationId: randomUUID(), epoch: randomUUID(),
        rootId: root.root_id, expectedMappingRevision: "1", expectedPolicyRevision: "0", holdNewDiscoveries: false
      }))
      const bind = yield* Effect.result(worker.call({
        op: "bindEntry", entryId: entry.entry_id, operationId: randomUUID(), epoch: randomUUID(),
        expectedDecisionVersion: "1", source: "EH", gid: "1", token: "token",
        preferredDomain: "e-hentai.org", canonicalUrl: "https://e-hentai.org/g/1/token/"
      }))
      return { scan, bind }
    }).pipe(Effect.provide(DatabaseWorker.layer(path.join(dataDir, "server.sqlite"), {
      workerUrl: new URL("../dist/worker.mjs", import.meta.url)
    }))))
    expect(results.scan).toMatchObject({ _tag: "Failure", failure: { message: "server restore requires root and destination reconciliation before scanning" } })
    expect(results.bind).toMatchObject({ _tag: "Failure", failure: { message: "server restore requires root and destination reconciliation before EH work" } })
  })
})
