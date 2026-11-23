import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
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
    const result = await withTaskClient(server, Effect.gen(function*() {
      return yield* (yield* TaskHttpClient).get({ params: { id: taskId } })
    }))
    if (result.data.status !== "queued" && result.data.status !== "running") return result.data
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("scan did not reach a terminal state")
}

const start = async (): Promise<RunningServer> => {
  const dbPath = await makeTempDbPath()
  dbPaths.add(dbPath)
  const server = await startServer(dbPath)
  servers.push(server)
  return server
}

const indexEntries = async (server: RunningServer): Promise<ReadonlyArray<{ readonly entry_id: string }>> => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-eh-binding-multi-"))
  fixturePaths.add(fixture)
  for (const name of ["book-a", "book-b"]) {
    const book = path.join(fixture, name)
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "page")
  }
  const root = await withServerClient(server, Effect.gen(function*() {
    const client = yield* ServerHttpClient
    const preview = yield* client.preview({ payload: { path: fixture } })
    if (!("children" in preview.data)) throw new Error("expected setup preview")
    return yield* client.save({
      payload: {
        operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
        label: "EH binding multi", path: fixture, preview_identity: preview.data.preview_identity
      }
    })
  }))
  const submitted = await withServerClient(server, Effect.gen(function*() {
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
  if (!("task" in submitted.data)) throw new Error("expected scan task")
  expect((await waitForTerminal(server, submitted.data.task.task_id)).status).toBe("succeeded")
  const page = await withLibraryClient(server, Effect.gen(function*() {
    return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 10 } })
  }))
  expect(page.data.entries).toHaveLength(2)
  return page.data.entries
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("durable EH binding", () => {
  it("binds an indexed entry without upstream traffic, fences revisions, and survives restart", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-eh-binding-"))
    fixturePaths.add(fixture)
    const book = path.join(fixture, "indexed-book")
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "page")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.data.instance_id,
          epoch: preview.data.epoch,
          label: "EH binding",
          path: fixture,
          preview_identity: preview.data.preview_identity
        }
      })
    }))
    const submitted = await withServerClient(server, Effect.gen(function*() {
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
    if (!("task" in submitted.data)) throw new Error("expected scan task")
    expect((await waitForTerminal(server, submitted.data.task.task_id)).status).toBe("succeeded")

    const page = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 10 } })
    }))
    const indexed = page.data.entries[0]
    if (indexed === undefined) throw new Error("expected indexed entry")
    const initial = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entry({ params: { id: indexed.entry_id } })
    }))
    expect(initial.data.decision_version).toBe("1")
    expect(initial.data.binding).toBeNull()

    const operationId = randomUUID()
    const bindPayload = {
      operation_id: operationId,
      instance_id: server.instanceId,
      epoch: server.epoch,
      expected_decision_version: "1",
      command: { type: "bind" as const, url: "http://exhentai.org/g/12345/AbC_9/?from=test#ignored" }
    }
    const bound = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: indexed.entry_id },
        payload: bindPayload
      })
    }))
    expect(bound.data.entry.binding).toEqual({
      source: "EH",
      gid: "12345",
      canonical_url: "https://exhentai.org/g/12345/AbC_9/",
      preferred_domain: "exhentai.org"
    })
    expect(bound.data.entry.decision_version).toBe("2")

    const persistedBindResult = new DatabaseSync(server.dbPath)
    const storedBind = persistedBindResult.prepare(
      "SELECT result FROM entry_operations WHERE epoch = ? AND operation_id = ?"
    ).get(server.epoch, operationId) as { result: string } | undefined
    if (storedBind === undefined) throw new Error("expected persisted bind result")
    const legacyBindResult = JSON.parse(storedBind.result) as { entry: { title_override?: unknown } }
    delete legacyBindResult.entry.title_override
    persistedBindResult.prepare(
      "UPDATE entry_operations SET result = ? WHERE epoch = ? AND operation_id = ?"
    ).run(JSON.stringify(legacyBindResult), server.epoch, operationId)
    persistedBindResult.close()

    const replay = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: indexed.entry_id },
        payload: bindPayload
      })
    }))
    expect(replay.data).toEqual(bound.data)

    const legacyDb = new DatabaseSync(server.dbPath)
    const persisted = legacyDb.prepare(
      "SELECT result FROM entry_operations WHERE epoch = ? AND operation_id = ?"
    ).get(server.epoch, operationId) as { result: string }
    const legacyResult = JSON.parse(persisted.result) as { entry: Record<string, unknown> }
    delete legacyResult.entry.metadata
    legacyDb.prepare(
      "UPDATE entry_operations SET result = ? WHERE epoch = ? AND operation_id = ?"
    ).run(JSON.stringify(legacyResult), server.epoch, operationId)
    legacyDb.close()

    const rebound = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: indexed.entry_id },
        payload: {
          ...bindPayload,
          operation_id: randomUUID(),
          expected_decision_version: "2",
          command: { type: "bind" as const, url: "https://e-hentai.org/g/67890/rebound-token/" }
        }
      })
    }))
    expect(rebound.data.entry.binding?.gid).toBe("67890")
    expect(rebound.data.entry.decision_version).toBe("3")

    const legacyReplay = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: indexed.entry_id },
        payload: bindPayload
      })
    }))
    expect(legacyReplay.data).toEqual({
      ...bound.data,
      entry: { ...bound.data.entry, metadata: null }
    })

    const stale = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: indexed.entry_id },
        payload: { ...bindPayload, operation_id: randomUUID() }
      }).pipe(Effect.flip)
    }))
    expect(stale._tag).toBe("RevisionConflict")
    if (stale._tag === "RevisionConflict") expect(stale.details.current_revision).toBe("3")

    const statsBeforeDb = new DatabaseSync(server.dbPath)
    const readingStatsBefore = statsBeforeDb.prepare("SELECT entry_id, open_count FROM entry_statistics WHERE entry_id = ?").get(indexed.entry_id)
    statsBeforeDb.close()
    const identity = {
      relative_path: bound.data.entry.relative_path,
      source_path: bound.data.entry.source_path,
      content_version: bound.data.entry.content_version,
      location_revision: bound.data.entry.location_revision
    }
    const setTitlePayload = {
      operation_id: randomUUID(),
      instance_id: server.instanceId,
      epoch: server.epoch,
      expected_decision_version: "3",
      command: { type: "set-personal-title" as const, title: "Personal title" }
    }
    const titled = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: indexed.entry_id },
        payload: setTitlePayload
      })
    }))
    expect(titled.data.entry.title).toBe("Personal title")
    expect(titled.data.entry.title_override).toBe("Personal title")
    expect(titled.data.entry.decision_version).toBe("4")
    expect(titled.data.entry).toMatchObject(identity)

    const titleReplay = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: indexed.entry_id },
        payload: setTitlePayload
      })
    }))
    expect(titleReplay.data).toEqual(titled.data)

    const emptyTitle = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: indexed.entry_id },
        payload: {
          ...setTitlePayload,
          operation_id: randomUUID(),
          expected_decision_version: "4",
          command: { type: "set-personal-title" as const, title: "" }
        }
      })
    }))
    expect(emptyTitle.data.entry.title).toBe("")
    expect(emptyTitle.data.entry.title_override).toBe("")
    expect(emptyTitle.data.entry.decision_version).toBe("5")
    expect(emptyTitle.data.entry).toMatchObject(identity)
    const emptyPage = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 10 } })
    }))
    expect(emptyPage.data.entries.find((entry) => entry.entry_id === indexed.entry_id)).toMatchObject({
      title: "",
      title_override: ""
    })

    const removedTitle = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: indexed.entry_id },
        payload: {
          ...setTitlePayload,
          operation_id: randomUUID(),
          expected_decision_version: "5",
          command: { type: "remove-personal-title" as const }
        }
      })
    }))
    expect(removedTitle.data.entry.title).toBe(bound.data.entry.title)
    expect(removedTitle.data.entry.title_override).toBeNull()
    expect(removedTitle.data.entry.decision_version).toBe("6")
    expect(removedTitle.data.entry).toMatchObject(identity)

    const staleTitle = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: indexed.entry_id },
        payload: {
          ...setTitlePayload,
          operation_id: randomUUID(),
          expected_decision_version: "5",
          command: { type: "set-personal-title" as const, title: "stale" }
        }
      }).pipe(Effect.flip)
    }))
    expect(staleTitle._tag).toBe("RevisionConflict")
    if (staleTitle._tag === "RevisionConflict") expect(staleTitle.details.current_revision).toBe("6")

    const crossCommandCollision = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: indexed.entry_id },
        payload: {
          ...setTitlePayload,
          expected_decision_version: "6",
          command: { type: "set-personal-title" as const, title: "collision" }
        }
      }).pipe(Effect.flip)
    }))
    expect(crossCommandCollision._tag).toBe("OperationConflict")

    const db = new DatabaseSync(server.dbPath)
    expect(db.prepare("SELECT source, gid, token, preferred_domain FROM galleries").all()).toEqual(expect.arrayContaining([
      { source: "EH", gid: "12345", token: "AbC_9", preferred_domain: "exhentai.org" },
      { source: "EH", gid: "67890", token: "rebound-token", preferred_domain: "e-hentai.org" }
    ]))
    expect(db.prepare("SELECT entry_id FROM bindings").get()).toEqual({ entry_id: indexed.entry_id })
    expect(db.prepare("SELECT entry_id, open_count FROM entry_statistics WHERE entry_id = ?").get(indexed.entry_id)).toEqual(readingStatsBefore)
    expect(db.prepare("SELECT entry_id FROM entry_overrides WHERE entry_id = ?").get(indexed.entry_id)).toBeUndefined()
    db.close()

    await server.stop()
    const restarted = await startServer(server.dbPath)
    servers.push(restarted)
    const afterRestart = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entry({ params: { id: indexed.entry_id } })
    }))
    expect(afterRestart.data.binding).toEqual(rebound.data.entry.binding)
    expect(afterRestart.data.title).toBe(bound.data.entry.title)
    expect(afterRestart.data.title_override).toBeNull()
    expect(afterRestart.data.decision_version).toBe("6")
    expect(afterRestart.data).toMatchObject(identity)
  })

  it("expires retained bind results, isolates preferred domains, and reports conflicts", async () => {
    const server = await start()
    const entries = await indexEntries(server)
    const first = entries[0]
    const second = entries[1]
    if (first === undefined || second === undefined) throw new Error("expected two indexed entries")

    const operationId = randomUUID()
    const bindFirst = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: first.entry_id },
        payload: {
          operation_id: operationId, instance_id: server.instanceId, epoch: server.epoch,
          expected_decision_version: "1",
          command: { type: "bind", url: "https://e-hentai.org/g/12345/shared-token/" }
        }
      })
    }))
    expect(bindFirst.data.entry.decision_version).toBe("2")

    const operationConflict = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: first.entry_id },
        payload: {
          operation_id: operationId, instance_id: server.instanceId, epoch: server.epoch,
          expected_decision_version: "2",
          command: { type: "bind", url: "https://exhentai.org/g/12345/shared-token/" }
        }
      }).pipe(Effect.flip)
    }))
    expect(operationConflict._tag).toBe("OperationConflict")

    const db = new DatabaseSync(server.dbPath)
    db.prepare("UPDATE entry_operations SET created_at_ms = 0 WHERE epoch = ? AND operation_id = ?").run(server.epoch, operationId)
    db.close()
    const expired = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: first.entry_id },
        payload: {
          operation_id: operationId, instance_id: server.instanceId, epoch: server.epoch,
          expected_decision_version: "1",
          command: { type: "bind", url: "https://e-hentai.org/g/12345/shared-token/" }
        }
      }).pipe(Effect.flip)
    }))
    expect(expired._tag).toBe("OperationExpired")

    const bindSecond = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: second.entry_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_decision_version: "1",
          command: { type: "bind", url: "https://exhentai.org/g/12345/shared-token/" }
        }
      })
    }))
    expect(bindSecond.data.entry.decision_version).toBe("2")
    expect(bindSecond.data.entry.binding?.canonical_url).toBe("https://exhentai.org/g/12345/shared-token/")

    const firstAfterDomainChange = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entry({ params: { id: first.entry_id } })
    }))
    expect(firstAfterDomainChange.data.binding?.canonical_url).toBe("https://e-hentai.org/g/12345/shared-token/")
    expect(firstAfterDomainChange.data.decision_version).toBe("2")

    const invalidUrl = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: second.entry_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_decision_version: "2", command: { type: "bind", url: "https://example.com/g/12345/shared-token/" }
        }
      }).pipe(Effect.flip)
    }))
    expect(invalidUrl._tag).toBe("InvalidRequest")

    const locatorConflict = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: second.entry_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_decision_version: "2", command: { type: "bind", url: "https://exhentai.org/g/12345/different-token/" }
        }
      }).pipe(Effect.flip)
    }))
    expect(locatorConflict._tag).toBe("InvalidRequest")
  })

  it("migrates legacy personal title search data", async () => {
    const server = await start()
    const entries = await indexEntries(server)
    const entry = entries[0]
    if (entry === undefined) throw new Error("expected an indexed entry")

    await server.stop()
    const legacy = new DatabaseSync(server.dbPath)
    legacy.exec("DROP TABLE entry_overrides")
    legacy.exec(`
      CREATE TABLE entry_overrides (
        entry_id TEXT PRIMARY KEY REFERENCES library_entries(entry_id) ON DELETE CASCADE,
        title_present INTEGER NOT NULL CHECK (title_present IN (0, 1)),
        title TEXT,
        CHECK ((title_present = 0 AND title IS NULL) OR (title_present = 1 AND title IS NOT NULL))
      )
    `)
    legacy.prepare("INSERT INTO entry_overrides(entry_id, title_present, title) VALUES(?, 1, ?)")
      .run(entry.entry_id, "Legacy Straße")
    legacy.close()

    const migrated = await startServer(server.dbPath)
    servers.push(migrated)
    const columns = new DatabaseSync(server.dbPath)
    expect(columns.prepare("PRAGMA table_info(entry_overrides)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "title_search" })])
    )
    expect(columns.prepare("SELECT title_search FROM entry_overrides WHERE entry_id = ?").get(entry.entry_id))
      .toEqual({ title_search: "legacy straße" })
    columns.close()

    const search = await withLibraryClient(migrated, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { query: "legacy straße" } })
    }))
    expect(search.data.entries).toEqual([
      expect.objectContaining({ entry_id: entry.entry_id, title: "Legacy Straße", title_override: "Legacy Straße", match_fields: ["title"] })
    ])
  })

  it("repairs a personal title search backfill left after the column was added", async () => {
    const server = await start()
    const entries = await indexEntries(server)
    const entry = entries[0]
    if (entry === undefined) throw new Error("expected an indexed entry")

    await server.stop()
    const interrupted = new DatabaseSync(server.dbPath)
    interrupted.exec("DROP TABLE entry_overrides")
    interrupted.exec(`
      CREATE TABLE entry_overrides (
        entry_id TEXT PRIMARY KEY REFERENCES library_entries(entry_id) ON DELETE CASCADE,
        title_present INTEGER NOT NULL CHECK (title_present IN (0, 1)),
        title TEXT,
        CHECK ((title_present = 0 AND title IS NULL) OR (title_present = 1 AND title IS NOT NULL))
      )
    `)
    interrupted.prepare("INSERT INTO entry_overrides(entry_id, title_present, title) VALUES(?, 1, ?)")
      .run(entry.entry_id, "Interrupted Title")
    interrupted.exec("ALTER TABLE entry_overrides ADD COLUMN title_search TEXT")
    interrupted.close()

    const repaired = await startServer(server.dbPath)
    servers.push(repaired)
    const columns = new DatabaseSync(server.dbPath)
    expect(columns.prepare("SELECT title_search FROM entry_overrides WHERE entry_id = ?").get(entry.entry_id))
      .toEqual({ title_search: "interrupted title" })
    columns.close()

    const search = await withLibraryClient(repaired, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { query: "interrupted title" } })
    }))
    expect(search.data.entries).toEqual([
      expect.objectContaining({ entry_id: entry.entry_id, title: "Interrupted Title", title_override: "Interrupted Title", match_fields: ["title"] })
    ])
  })
})
