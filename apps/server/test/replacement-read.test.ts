import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { BlobWriter, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js"
import { afterEach, describe, expect, it } from "vitest"
import { LibraryHttpClient, ServerHttpClient, TaskHttpClient, type ScanTask } from "@henshin/contracts"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const servers: RunningServer[] = []
const dbPaths = new Set<string>()
const fixturePaths = new Set<string>()

const withServerClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, ServerHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, ServerHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withLibraryClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, LibraryHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, LibraryHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withTaskClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, TaskHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, TaskHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const waitForTerminal = async (server: RunningServer, taskId: string): Promise<ScanTask> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await withTaskClient(server, Effect.gen(function*() {
      return yield* (yield* TaskHttpClient).get({ params: { id: taskId } })
    }))
    if (task.data.status !== "queued" && task.data.status !== "running") return task.data
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("replacement scan did not reach a terminal state")
}

const downgradeLibraryEntriesToPreReplacementSchema = (dbPath: string): void => {
  const db = new DatabaseSync(dbPath)
  db.exec("PRAGMA foreign_keys = OFF")
  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec(`
      CREATE TABLE library_entries_pre_replacement (
        entry_id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES server_library(library_id),
        root_id TEXT NOT NULL REFERENCES server_roots(root_id),
        relative_path TEXT NOT NULL,
        source_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('archive', 'image-directory')),
        title TEXT NOT NULL,
        page_count INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted')),
        content_version INTEGER NOT NULL,
        location_revision INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (root_id, relative_path)
      );
      INSERT INTO library_entries_pre_replacement
        SELECT entry_id, library_id, root_id, relative_path, source_path, kind, title, page_count,
          'accepted', content_version, location_revision, manifest_json, created_at_ms, updated_at_ms
        FROM library_entries;
      DROP TABLE library_entries;
      ALTER TABLE library_entries_pre_replacement RENAME TO library_entries;
    `)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  } finally {
    db.exec("PRAGMA foreign_keys = ON")
    db.close()
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("replacement comparison read model", () => {
  it("presents pending state and old/candidate observations after rescanning one path", async () => {
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath)
    servers.push(server)
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-replacement-read-"))
    fixturePaths.add(fixture)
    const book = path.join(fixture, "book")
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "Book A")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Replacement read", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))
    const scan = async () => withServerClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))

    const first = await scan()
    if (!("task" in first.data)) throw new Error("expected initial scan task")
    expect((await waitForTerminal(server, first.data.task.task_id)).status).toBe("succeeded")

    await writeFile(path.join(book, "001.jpg"), "Book B")
    await writeFile(path.join(book, "002.jpg"), "Book B second page")
    const second = await scan()
    if (!("task" in second.data)) throw new Error("expected replacement scan task")
    expect((await waitForTerminal(server, second.data.task.task_id)).readiness_error?.code).toBe("allocation_deferred")

    const listed = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    expect(listed.data.entries).toHaveLength(1)
    const entry = listed.data.entries[0]
    if (entry === undefined || entry.replacement === null) throw new Error("expected replacement comparison")
    expect(entry.state).toBe("replacement-pending")
    expect(entry.replacement.old_observation).toMatchObject({ kind: "image-directory", page_count: 1 })
    expect(entry.replacement.old_observation.format_evidence).toEqual(["jpeg"])
    expect(entry.replacement.old_observation.size_bytes).toBe(6)
    expect(entry.replacement.candidate_observation).toMatchObject({
      kind: "image-directory",
      analysis_status: "ready",
      page_count: 2
    })
    expect(entry.replacement.candidate_observation.format_evidence).toEqual(["jpeg"])
    expect(entry.replacement.candidate_observation.size_bytes).toBe(24)
  })

  it("migrates occupied candidates from a pre-replacement database and preserves them on a later rescan", async () => {
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath)
    servers.push(server)
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-replacement-migration-"))
    fixturePaths.add(fixture)
    const bookA = path.join(fixture, "book-a")
    const bookB = path.join(fixture, "book-b")
    await mkdir(bookA)
    await mkdir(bookB)
    await writeFile(path.join(bookA, "001.jpg"), "Book A")
    await writeFile(path.join(bookB, "001.jpg"), "Book B")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Replacement migration", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))
    const scan = async (active: RunningServer) => withServerClient(active, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: active.instanceId, epoch: active.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))

    const initialScan = await scan(server)
    if (!("task" in initialScan.data)) throw new Error("expected initial scan task")
    expect((await waitForTerminal(server, initialScan.data.task.task_id)).status).toBe("succeeded")
    await writeFile(path.join(bookA, "002.jpg"), "changed page")
    const changedScan = await scan(server)
    if (!("task" in changedScan.data)) throw new Error("expected changed scan task")
    expect((await waitForTerminal(server, changedScan.data.task.task_id)).readiness_error?.code).toBe("allocation_deferred")
    const beforeMigration = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    expect(beforeMigration.data.entries.find((entry) => entry.relative_path === "book-a")?.state).toBe("replacement-pending")

    await server.stop()
    downgradeLibraryEntriesToPreReplacementSchema(dbPath)
    const legacy = new DatabaseSync(dbPath)
    expect((legacy.prepare("SELECT COUNT(*) AS count FROM staged_discoveries s JOIN library_entries e ON e.root_id = s.root_id AND e.relative_path = s.relative_path WHERE e.state = 'accepted'").get() as { count: number }).count).toBe(1)
    legacy.close()

    const migrated = await startServer(dbPath)
    servers.push(migrated)
    const afterMigration = await withLibraryClient(migrated, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    const migratedEntry = afterMigration.data.entries.find((entry) => entry.relative_path === "book-a")
    expect(migratedEntry).toMatchObject({ state: "replacement-pending" })
    expect(migratedEntry?.replacement).not.toBeNull()
    expect(afterMigration.data.library_change_revision).not.toBe(beforeMigration.data.library_change_revision)
    expect(afterMigration.data.entries.find((entry) => entry.relative_path === "book-b")).toMatchObject({
      state: "accepted",
      replacement: null
    })

    await migrated.stop()
    const restarted = await startServer(dbPath)
    servers.push(restarted)
    const afterRestart = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    expect(afterRestart.data.library_change_revision).toBe(afterMigration.data.library_change_revision)
    await mkdir(path.join(fixture, "book-c"))
    await writeFile(path.join(fixture, "book-c", "001.jpg"), "Book C")
    const thirdBookScan = await scan(restarted)
    if (!("task" in thirdBookScan.data)) throw new Error("expected third-book scan task")
    expect((await waitForTerminal(restarted, thirdBookScan.data.task.task_id)).readiness_error?.code).toBe("allocation_deferred")
    const afterThirdBook = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    expect(afterThirdBook.data.entries.map((entry) => entry.relative_path).sort()).toEqual(["book-a", "book-b"])
    expect(afterThirdBook.data.entries.find((entry) => entry.relative_path === "book-a")?.state).toBe("replacement-pending")
  })

  it("advances the library revision when an already-pending candidate is re-staged", async () => {
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath)
    servers.push(server)
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-replacement-revision-"))
    fixturePaths.add(fixture)
    const book = path.join(fixture, "book")
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "Book A")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Replacement revision", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))
    const scan = async () => withServerClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    const first = await scan()
    if (!("task" in first.data)) throw new Error("expected initial scan task")
    expect((await waitForTerminal(server, first.data.task.task_id)).status).toBe("succeeded")
    await writeFile(path.join(book, "002.jpg"), "candidate one")
    const changed = await scan()
    if (!("task" in changed.data)) throw new Error("expected changed scan task")
    expect((await waitForTerminal(server, changed.data.task.task_id)).readiness_error?.code).toBe("allocation_deferred")
    const pending = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    const firstCandidate = pending.data.entries[0]?.replacement?.candidate_version
    await writeFile(path.join(book, "003.jpg"), "candidate two")
    const restaged = await scan()
    if (!("task" in restaged.data)) throw new Error("expected re-staged scan task")
    expect((await waitForTerminal(server, restaged.data.task.task_id)).readiness_error?.code).toBe("allocation_deferred")
    const after = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    expect(after.data.library_change_revision).not.toBe(pending.data.library_change_revision)
    expect(after.data.entries[0]?.replacement?.candidate_version).toBeGreaterThan(firstCandidate ?? 0)
    expect(after.data.entries[0]?.replacement?.candidate_observation.page_count).toBe(3)
  })

  it("keeps a known replacement pending when same-sized content and apparent metadata return", async () => {
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath)
    servers.push(server)
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-replacement-restore-"))
    fixturePaths.add(fixture)
    const book = path.join(fixture, "book")
    await mkdir(book)
    const page = path.join(book, "001.jpg")
    await writeFile(page, "Book A")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Replacement restore", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))
    const scan = async () => withServerClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    const first = await scan()
    if (!("task" in first.data)) throw new Error("expected initial scan task")
    expect((await waitForTerminal(server, first.data.task.task_id)).status).toBe("succeeded")
    const accepted = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    const initial = accepted.data.entries[0]
    if (initial === undefined) throw new Error("expected accepted entry")
    const originalStat = await stat(page)

    await writeFile(page, "Book B")
    const changed = await scan()
    if (!("task" in changed.data)) throw new Error("expected changed scan task")
    expect((await waitForTerminal(server, changed.data.task.task_id)).readiness_error?.code).toBe("allocation_deferred")
    const pending = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    const pendingEntry = pending.data.entries[0]
    expect(pending.data.library_change_revision).not.toBe(accepted.data.library_change_revision)
    expect(pendingEntry).toMatchObject({ entry_id: initial.entry_id, state: "replacement-pending" })
    expect(pendingEntry?.replacement).not.toBeNull()

    await writeFile(page, "Book A")
    await utimes(page, originalStat.atime, originalStat.mtime)
    const restored = await scan()
    if (!("task" in restored.data)) throw new Error("expected restore scan task")
    expect((await waitForTerminal(server, restored.data.task.task_id)).status).toBe("completed_with_errors")
    const after = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    expect(after.data.library_change_revision).not.toBe(pending.data.library_change_revision)
    expect(after.data.entries[0]).toMatchObject({ entry_id: initial.entry_id, state: "replacement-pending" })
    expect(after.data.entries[0]?.replacement).not.toBeNull()
  })

  it("keeps a failed replacement candidate pending with a bounded error observation", async () => {
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath)
    servers.push(server)
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-replacement-failed-"))
    fixturePaths.add(fixture)
    const archivePath = path.join(fixture, "book.cbz")
    const writer = new ZipWriter(new BlobWriter("application/zip"))
    await writer.add("001.jpg", new Uint8ArrayReader(new Uint8Array(Buffer.from("Book A"))), { compressionMethod: 0 })
    const archive = await writer.close()
    await writeFile(archivePath, Buffer.from(await archive.arrayBuffer()))

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Replacement failure", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))
    const scan = async () => withServerClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    const first = await scan()
    if (!("task" in first.data)) throw new Error("expected initial scan task")
    expect((await waitForTerminal(server, first.data.task.task_id)).status).toBe("succeeded")
    const accepted = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))

    await writeFile(archivePath, "not a zip")
    const failed = await scan()
    if (!("task" in failed.data)) throw new Error("expected failed scan task")
    const terminal = await waitForTerminal(server, failed.data.task.task_id)
    expect(terminal.status).toBe("completed_with_errors")
    expect(terminal.analysis_error_count).toBe(1)
    const listed = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    const entry = listed.data.entries[0]
    expect(listed.data.library_change_revision).not.toBe(accepted.data.library_change_revision)
    expect(entry).toMatchObject({ entry_id: accepted.data.entries[0]?.entry_id, state: "replacement-pending" })
    expect(entry?.replacement?.candidate_observation).toMatchObject({
      kind: "archive",
      page_count: 0,
      format_evidence: [],
      size_bytes: null,
      analysis_status: "error"
    })
    expect(entry?.replacement?.candidate_observation.analysis_error).not.toBeNull()
  })
})
