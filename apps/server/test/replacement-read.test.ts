import { chmod, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { BlobWriter, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js"
import { afterEach, describe, expect, it } from "vitest"
import {
  LibraryHttpClient,
  ServerHttpClient,
  TaskHttpClient,
  type LibraryEntryPage,
  type ScanTask,
  type ServerRoot
} from "@henshin/contracts"
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

type ReplacementScenario = {
  readonly dbPath: string
  readonly server: RunningServer
  readonly fixture: string
  readonly root: ServerRoot
}

const registerRoot = async (server: RunningServer, fixture: string, label: string): Promise<ServerRoot> => {
  const result = await withServerClient(server, Effect.gen(function*() {
    const client = yield* ServerHttpClient
    const preview = yield* client.preview({ payload: { path: fixture } })
    if (!("children" in preview.data)) throw new Error("expected setup preview")
    return yield* client.save({
      payload: {
        operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
        label, path: fixture, preview_identity: preview.data.preview_identity
      }
    })
  }))
  return result.data
}

const makeScenario = async (
  prefix: string,
  label: string,
  prepare: (fixture: string) => Promise<void>
): Promise<ReplacementScenario> => {
  const dbPath = await makeTempDbPath()
  dbPaths.add(dbPath)
  const server = await startServer(dbPath)
  servers.push(server)
  const fixture = await mkdtemp(path.join(os.tmpdir(), prefix))
  fixturePaths.add(fixture)
  await prepare(fixture)
  return { dbPath, server, fixture, root: await registerRoot(server, fixture, label) }
}

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

const scan = async (server: RunningServer, root: ServerRoot): Promise<ScanTask> => {
  const submitted = await withServerClient(server, Effect.gen(function*() {
    return yield* (yield* ServerHttpClient).command({
      params: { id: root.root_id },
      payload: {
        operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
        expected_mapping_revision: root.mapping_revision,
        expected_policy_revision: root.policy_revision,
        command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
      }
    })
  }))
  if (!("task" in submitted.data)) throw new Error("expected scan task")
  return waitForTerminal(server, submitted.data.task.task_id)
}

const listLibrary = (server: RunningServer): Promise<LibraryEntryPage> =>
  withLibraryClient(server, Effect.gen(function*() {
    return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
  })).then((result) => result.data)

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

      CREATE TABLE staged_discoveries_pre_summary (
        candidate_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES scan_tasks(task_id),
        root_id TEXT NOT NULL REFERENCES server_roots(root_id),
        relative_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('archive', 'image-directory')),
        candidate_version INTEGER NOT NULL,
        hold_state TEXT NOT NULL CHECK (hold_state IN ('held', 'eligible')),
        analysis_status TEXT NOT NULL CHECK (analysis_status IN ('ready', 'error')),
        manifest_json TEXT,
        analysis_error_json TEXT,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (root_id, relative_path)
      );
      INSERT INTO staged_discoveries_pre_summary
        SELECT candidate_id, task_id, root_id, relative_path, kind, candidate_version, hold_state,
          analysis_status, manifest_json, analysis_error_json, updated_at_ms
        FROM staged_discoveries;
      DROP TABLE staged_discoveries;
      ALTER TABLE staged_discoveries_pre_summary RENAME TO staged_discoveries;
    `)
    db.prepare("UPDATE server_state SET schema_version = 6 WHERE id = 1").run()
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  } finally {
    db.exec("PRAGMA foreign_keys = ON")
    db.close()
  }
}

const seedLegacyStagedError = (
  dbPath: string,
  taskId: string,
  rootId: string,
  code: string
): void => {
  const db = new DatabaseSync(dbPath)
  db.prepare(`
    INSERT INTO staged_discoveries(
      candidate_id, task_id, root_id, relative_path, kind, candidate_version,
      hold_state, analysis_status, manifest_json, analysis_error_json, updated_at_ms
    ) VALUES(?, ?, ?, ?, 'image-directory', 1, 'eligible', 'error', NULL, ?, ?)
  `).run(
    randomUUID(),
    taskId,
    rootId,
    "book",
    JSON.stringify({
      code,
      message: "seeded classification case",
      diagnostics: { supported_pages: 0, unsupported_pages: 0, ignored_entries: 0, directory_records: 0 }
    }),
    Date.now()
  )
  db.close()
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
    const { server, fixture, root } = await makeScenario(
      "henshin-replacement-read-",
      "Replacement read",
      async (fixture) => {
        const book = path.join(fixture, "book")
        await mkdir(book)
        await writeFile(path.join(book, "001.jpg"), "Book A")
      }
    )
    const book = path.join(fixture, "book")

    const first = await scan(server, root)
    expect(first.status).toBe("succeeded")

    await writeFile(path.join(book, "001.jpg"), "Book B")
    await writeFile(path.join(book, "002.jpg"), "Book B second page")
    const second = await scan(server, root)
    expect(second.readiness_error?.code).toBe("allocation_deferred")

    const listed = await listLibrary(server)
    expect(listed.entries).toHaveLength(1)
    const entry = listed.entries[0]
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
    const { dbPath, server, fixture, root } = await makeScenario(
      "henshin-replacement-migration-",
      "Replacement migration",
      async (fixture) => {
        await mkdir(path.join(fixture, "book-a"))
        await mkdir(path.join(fixture, "book-b"))
        await writeFile(path.join(fixture, "book-a", "001.jpg"), "Book A")
        await writeFile(path.join(fixture, "book-b", "001.jpg"), "Book B")
      }
    )
    const bookA = path.join(fixture, "book-a")
    const bookB = path.join(fixture, "book-b")

    const initialScan = await scan(server, root)
    expect(initialScan.status).toBe("succeeded")
    await writeFile(path.join(bookA, "002.jpg"), "changed page")
    const changedScan = await scan(server, root)
    expect(changedScan.readiness_error?.code).toBe("allocation_deferred")
    const beforeMigration = await listLibrary(server)
    expect(beforeMigration.entries.find((entry) => entry.relative_path === "book-a")?.state).toBe("replacement-pending")

    await server.stop()
    downgradeLibraryEntriesToPreReplacementSchema(dbPath)
    const legacy = new DatabaseSync(dbPath)
    expect((legacy.prepare("SELECT COUNT(*) AS count FROM staged_discoveries s JOIN library_entries e ON e.root_id = s.root_id AND e.relative_path = s.relative_path WHERE e.state = 'accepted'").get() as { count: number }).count).toBe(1)
    legacy.close()

    const migrated = await startServer(dbPath)
    servers.push(migrated)
    const afterMigration = await listLibrary(migrated)
    const migratedEntry = afterMigration.entries.find((entry) => entry.relative_path === "book-a")
    expect(migratedEntry).toMatchObject({ state: "replacement-pending" })
    expect(migratedEntry?.replacement).not.toBeNull()
    expect(afterMigration.library_change_revision).not.toBe(beforeMigration.library_change_revision)
    expect(afterMigration.entries.find((entry) => entry.relative_path === "book-b")).toMatchObject({
      state: "accepted",
      replacement: null
    })

    await migrated.stop()
    const compact = new DatabaseSync(dbPath)
    const compactRows = compact.prepare(`
      SELECT e.accepted_observation_json, s.candidate_observation_json
      FROM library_entries e
      JOIN staged_discoveries s ON s.root_id = e.root_id AND s.relative_path = e.relative_path
      WHERE e.relative_path = 'book-a'
    `).all() as unknown as ReadonlyArray<{
      accepted_observation_json: string | null
      candidate_observation_json: string | null
    }>
    expect(compactRows).toHaveLength(1)
    expect(compactRows[0]?.accepted_observation_json).toEqual(expect.any(String))
    expect(compactRows[0]?.candidate_observation_json).toEqual(expect.any(String))
    const originalManifests = compact.prepare(`
      SELECT e.entry_id, e.manifest_json, s.candidate_id, s.manifest_json AS candidate_manifest_json
      FROM library_entries e
      JOIN staged_discoveries s ON s.root_id = e.root_id AND s.relative_path = e.relative_path
      WHERE e.relative_path = 'book-a'
    `).get() as {
      entry_id: string
      manifest_json: string
      candidate_id: string
      candidate_manifest_json: string
    }
    compact.prepare("UPDATE library_entries SET manifest_json = ? WHERE entry_id = ?").run("not-json", originalManifests.entry_id)
    compact.prepare("UPDATE staged_discoveries SET manifest_json = ? WHERE candidate_id = ?").run("not-json", originalManifests.candidate_id)
    compact.close()

    const bounded = await startServer(dbPath)
    servers.push(bounded)
    const afterBoundedRead = await listLibrary(bounded)
    expect(afterBoundedRead.entries.find((entry) => entry.relative_path === "book-a")?.replacement).toEqual(migratedEntry?.replacement)
    await bounded.stop()

    const restored = new DatabaseSync(dbPath)
    restored.prepare("UPDATE library_entries SET manifest_json = ? WHERE entry_id = ?").run(originalManifests.manifest_json, originalManifests.entry_id)
    restored.prepare("UPDATE staged_discoveries SET manifest_json = ? WHERE candidate_id = ?").run(originalManifests.candidate_manifest_json, originalManifests.candidate_id)
    restored.close()

    const restarted = await startServer(dbPath)
    servers.push(restarted)
    const afterRestart = await listLibrary(restarted)
    expect(afterRestart.library_change_revision).toBe(afterMigration.library_change_revision)
    await mkdir(path.join(fixture, "book-c"))
    await writeFile(path.join(fixture, "book-c", "001.jpg"), "Book C")
    const thirdBookScan = await scan(restarted, root)
    expect(thirdBookScan.readiness_error?.code).toBe("allocation_deferred")
    const afterThirdBook = await listLibrary(restarted)
    expect(afterThirdBook.entries.map((entry) => entry.relative_path).sort()).toEqual(["book-a", "book-b"])
    expect(afterThirdBook.entries.find((entry) => entry.relative_path === "book-a")?.state).toBe("replacement-pending")
  })

  it.each([
    { code: "cancelled", state: "accepted", reason: "insufficient-evidence" },
    { code: "deadline-exceeded", state: "accepted", reason: "insufficient-evidence" },
    { code: "directory-limit", state: "accepted", reason: "insufficient-evidence" },
    { code: "future-scan-code", state: "accepted", reason: "insufficient-evidence" },
    { code: "read-failure", state: "accepted", reason: null },
    { code: "candidate-changed", state: "replacement-pending", reason: "known-change" },
    { code: "structural-corruption", state: "replacement-pending", reason: "known-change" }
  ] as const)("classifies legacy $code evidence without inventing replacement certainty", async ({ code, state, reason }) => {
    const { dbPath, server, fixture, root } = await makeScenario(
      `henshin-replacement-classification-${code}-`,
      `Replacement classification ${code}`,
      async (fixture) => {
        await mkdir(path.join(fixture, "book"))
        await writeFile(path.join(fixture, "book", "001.jpg"), "Book A")
      }
    )
    const initial = await scan(server, root)
    expect(initial.status).toBe("succeeded")
    const accepted = await listLibrary(server)
    const acceptedEntry = accepted.entries[0]
    if (acceptedEntry === undefined) throw new Error("expected accepted entry")

    await server.stop()
    downgradeLibraryEntriesToPreReplacementSchema(dbPath)
    seedLegacyStagedError(dbPath, initial.task_id, root.root_id, code)
    const migrated = await startServer(dbPath)
    servers.push(migrated)

    const listed = await listLibrary(migrated)
    expect(listed.entries[0]).toMatchObject({ entry_id: acceptedEntry.entry_id, state })
    const resolution = await withLibraryClient(migrated, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: acceptedEntry.entry_id }, query: {} })
    }))
    expect(resolution.data).toMatchObject({ status: reason === null ? "usable" : "unresolved", reason })
  })

  it("advances the library revision when an already-pending candidate is re-staged", async () => {
    const { server, fixture, root } = await makeScenario(
      "henshin-replacement-revision-",
      "Replacement revision",
      async (fixture) => {
        const book = path.join(fixture, "book")
        await mkdir(book)
        await writeFile(path.join(book, "001.jpg"), "Book A")
      }
    )
    const book = path.join(fixture, "book")

    const first = await scan(server, root)
    expect(first.status).toBe("succeeded")
    await writeFile(path.join(book, "002.jpg"), "candidate one")
    const changed = await scan(server, root)
    expect(changed.readiness_error?.code).toBe("allocation_deferred")
    const pending = await listLibrary(server)
    const firstCandidate = pending.entries[0]?.replacement?.candidate_version
    await writeFile(path.join(book, "003.jpg"), "candidate two")
    const restaged = await scan(server, root)
    expect(restaged.readiness_error?.code).toBe("allocation_deferred")
    const after = await listLibrary(server)
    expect(after.library_change_revision).not.toBe(pending.library_change_revision)
    expect(after.entries[0]?.replacement?.candidate_version).toBeGreaterThan(firstCandidate ?? 0)
    expect(after.entries[0]?.replacement?.candidate_observation.page_count).toBe(3)
  })

  it("keeps a transient accepted read failure openable across v6 migration and classifies corruption", async () => {
    const { dbPath, server, fixture, root } = await makeScenario(
      "henshin-replacement-transient-read-",
      "Replacement transient read",
      async (fixture) => {
        const writer = new ZipWriter(new BlobWriter("application/zip"))
        await writer.add("001.jpg", new Uint8ArrayReader(new Uint8Array(Buffer.from("Book A"))), { compressionMethod: 0 })
        const archive = await writer.close()
        await writeFile(path.join(fixture, "book.cbz"), Buffer.from(await archive.arrayBuffer()))
      }
    )
    const archivePath = path.join(fixture, "book.cbz")

    const first = await scan(server, root)
    expect(first.status).toBe("succeeded")
    const accepted = await listLibrary(server)
    const acceptedEntry = accepted.entries[0]
    if (acceptedEntry === undefined) throw new Error("expected accepted archive")

    await chmod(archivePath, 0o000)
    const transient = await scan(server, root)
    expect(transient.status).toBe("completed_with_errors")
    expect(transient.analysis_error_count).toBe(1)
    const transientEntries = await listLibrary(server)
    expect(transientEntries.entries[0]).toMatchObject({ entry_id: acceptedEntry.entry_id, state: "accepted", replacement: null })
    const transientResolution = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: acceptedEntry.entry_id }, query: {} })
    }))
    expect(transientResolution.data).toMatchObject({ status: "usable", reason: null })

    await server.stop()
    downgradeLibraryEntriesToPreReplacementSchema(dbPath)
    const migrated = await startServer(dbPath)
    servers.push(migrated)
    const afterMigration = await listLibrary(migrated)
    expect(afterMigration.entries[0]).toMatchObject({ entry_id: acceptedEntry.entry_id, state: "accepted", replacement: null })
    const migratedResolution = await withLibraryClient(migrated, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: acceptedEntry.entry_id }, query: {} })
    }))
    expect(migratedResolution.data).toMatchObject({ status: "usable", reason: null })

    await chmod(archivePath, 0o644)
    await writeFile(archivePath, "not a zip")
    const corrupt = await scan(migrated, root)
    expect(corrupt.status).toBe("completed_with_errors")
    const pending = await listLibrary(migrated)
    expect(pending.entries[0]).toMatchObject({ entry_id: acceptedEntry.entry_id, state: "replacement-pending" })
    expect(pending.entries[0]?.replacement?.candidate_observation.analysis_error).toMatchObject({
      code: "structural-corruption"
    })
    const blocked = await withLibraryClient(migrated, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: acceptedEntry.entry_id }, query: {} })
    }))
    expect(blocked.data).toMatchObject({ status: "unresolved", reason: "known-change" })
  })

  it("keeps a known replacement pending when same-sized content and apparent metadata return", async () => {
    const { server, fixture, root } = await makeScenario(
      "henshin-replacement-restore-",
      "Replacement restore",
      async (fixture) => {
        const book = path.join(fixture, "book")
        await mkdir(book)
        await writeFile(path.join(book, "001.jpg"), "Book A")
      }
    )
    const book = path.join(fixture, "book")
    const page = path.join(book, "001.jpg")

    const first = await scan(server, root)
    expect(first.status).toBe("succeeded")
    const accepted = await listLibrary(server)
    const initial = accepted.entries[0]
    if (initial === undefined) throw new Error("expected accepted entry")
    const originalStat = await stat(page)

    await writeFile(page, "Book B")
    const changed = await scan(server, root)
    expect(changed.readiness_error?.code).toBe("allocation_deferred")
    const pending = await listLibrary(server)
    const pendingEntry = pending.entries[0]
    expect(pending.library_change_revision).not.toBe(accepted.library_change_revision)
    expect(pendingEntry).toMatchObject({ entry_id: initial.entry_id, state: "replacement-pending" })
    expect(pendingEntry?.replacement).not.toBeNull()

    await writeFile(page, "Book A")
    await utimes(page, originalStat.atime, originalStat.mtime)
    const restored = await scan(server, root)
    expect(restored.status).toBe("completed_with_errors")
    const after = await listLibrary(server)
    expect(after.library_change_revision).not.toBe(pending.library_change_revision)
    expect(after.entries[0]).toMatchObject({ entry_id: initial.entry_id, state: "replacement-pending" })
    expect(after.entries[0]?.replacement).not.toBeNull()
  })

  it("keeps a failed replacement candidate pending with a bounded error observation", async () => {
    const { server, fixture, root } = await makeScenario(
      "henshin-replacement-failed-",
      "Replacement failure",
      async (fixture) => {
        const writer = new ZipWriter(new BlobWriter("application/zip"))
        await writer.add("001.jpg", new Uint8ArrayReader(new Uint8Array(Buffer.from("Book A"))), { compressionMethod: 0 })
        const archive = await writer.close()
        await writeFile(path.join(fixture, "book.cbz"), Buffer.from(await archive.arrayBuffer()))
      }
    )
    const archivePath = path.join(fixture, "book.cbz")

    const first = await scan(server, root)
    expect(first.status).toBe("succeeded")
    const accepted = await listLibrary(server)

    await writeFile(archivePath, "not a zip")
    const terminal = await scan(server, root)
    expect(terminal.status).toBe("completed_with_errors")
    expect(terminal.analysis_error_count).toBe(1)
    const listed = await listLibrary(server)
    const entry = listed.entries[0]
    expect(listed.library_change_revision).not.toBe(accepted.library_change_revision)
    expect(entry).toMatchObject({ entry_id: accepted.entries[0]?.entry_id, state: "replacement-pending" })
    expect(entry?.replacement?.candidate_observation).toMatchObject({
      kind: "archive",
      page_count: 0,
      format_evidence: [],
      size_bytes: null,
      analysis_status: "error"
    })
    expect(entry?.replacement?.candidate_observation.analysis_error).toMatchObject({ code: "structural-corruption" })
  })
})
