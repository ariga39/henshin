import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { LibraryHttpClient, ServerHttpClient, TaskHttpClient, type ScanTask } from "@henshin/contracts"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const servers: RunningServer[] = []
const dbPaths = new Set<string>()
const fixturePaths = new Set<string>()

const withClient = <A, E>(
  server: RunningServer,
  program: Effect.Effect<A, E, ServerHttpClient | LibraryHttpClient | TaskHttpClient>
): Promise<A> => Effect.runPromise(Effect.provide(program, Layer.mergeAll(
  ServerHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken }),
  LibraryHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken }),
  TaskHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })
)))

const start = async (): Promise<RunningServer> => {
  const dbPath = await makeTempDbPath()
  dbPaths.add(dbPath)
  const server = await startServer(dbPath)
  servers.push(server)
  return server
}

const waitForTerminal = async (server: RunningServer, taskId: string): Promise<ScanTask> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await withClient(server, Effect.gen(function*() {
      return yield* (yield* TaskHttpClient).get({ params: { id: taskId } })
    }))
    if (task.data.status !== "queued" && task.data.status !== "running") return task.data
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("scan did not reach a terminal state")
}

const scanTwoBooks = async (server: RunningServer) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-entry-notes-"))
  fixturePaths.add(fixture)
  for (const name of ["book-a", "book-b"]) {
    const book = path.join(fixture, name)
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), name)
  }
  const root = await withClient(server, Effect.gen(function*() {
    const client = yield* ServerHttpClient
    const preview = yield* client.preview({ payload: { path: fixture } })
    if (!("children" in preview.data)) throw new Error("expected setup preview")
    return yield* client.save({
      payload: {
        operation_id: randomUUID(),
        instance_id: preview.data.instance_id,
        epoch: preview.data.epoch,
        label: "Entry notes",
        path: fixture,
        preview_identity: preview.data.preview_identity
      }
    })
  }))
  const submitted = await withClient(server, Effect.gen(function*() {
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
  const page = await withClient(server, Effect.gen(function*() {
    return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 10 } })
  }))
  expect(page.data.entries).toHaveLength(2)
  return [...page.data.entries].sort((left, right) => left.relative_path.localeCompare(right.relative_path))
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("private Library entry notes", () => {
  it("keeps notes independent across a shared gallery, persists through restart, and fences stale writes", async () => {
    const server = await start()
    const entries = await scanTwoBooks(server)
    const first = entries[0]
    const second = entries[1]
    if (first === undefined || second === undefined) throw new Error("expected two entries")

    const bind = (entryId: string, expectedDecisionVersion: string, operationId = randomUUID()) => withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: entryId },
        payload: {
          operation_id: operationId,
          instance_id: server.instanceId,
          epoch: server.epoch,
          expected_decision_version: expectedDecisionVersion,
          command: { type: "bind", url: "https://e-hentai.org/g/24680/shared-token/" }
        }
      })
    }))
    await bind(first.entry_id, "1")
    await bind(second.entry_id, "1")

    const setTitlePayload = {
      operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
      expected_decision_version: "2",
      command: { type: "set-personal-title" as const, title: "Title survives note clearing" }
    }
    const titled = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: first.entry_id },
        payload: setTitlePayload
      })
    }))
    expect(titled.data.entry.title_override).toBe("Title survives note clearing")

    const setFirstPayload = {
      operation_id: randomUUID(),
      instance_id: server.instanceId,
      epoch: server.epoch,
      expected_decision_version: "3",
      command: { type: "set-note" as const, text: "first book note" }
    }
    const setFirst = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({ params: { id: first.entry_id }, payload: setFirstPayload })
    }))
    const setFirstReplay = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({ params: { id: first.entry_id }, payload: setFirstPayload })
    }))
    expect(setFirstReplay.data).toEqual(setFirst.data)
    const setSecond = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: second.entry_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_decision_version: "2", command: { type: "set-note", text: "second book note" }
        }
      })
    }))
    expect(setFirst.data.entry.note).toMatchObject({ text: "first book note", revision: "1" })
    expect(setSecond.data.entry.note).toMatchObject({ text: "second book note", revision: "1" })

    const eraseMetadataFromRecordedResult = (operationId: string) => {
      const legacyDb = new DatabaseSync(server.dbPath)
      const row = legacyDb.prepare(
        "SELECT result FROM entry_operations WHERE epoch = ? AND operation_id = ?"
      ).get(server.epoch, operationId) as { result: string } | undefined
      if (row === undefined) throw new Error("expected recorded entry command result")
      const result = JSON.parse(row.result) as { entry: Record<string, unknown> }
      delete result.entry.metadata
      legacyDb.prepare(
        "UPDATE entry_operations SET result = ? WHERE epoch = ? AND operation_id = ?"
      ).run(JSON.stringify(result), server.epoch, operationId)
      legacyDb.close()
    }
    eraseMetadataFromRecordedResult(setTitlePayload.operation_id)
    const legacyTitleReplay = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: first.entry_id }, payload: setTitlePayload
      })
    }))
    expect(legacyTitleReplay.data).toEqual({
      ...titled.data,
      entry: { ...titled.data.entry, metadata: null }
    })
    eraseMetadataFromRecordedResult(setFirstPayload.operation_id)
    const legacyNoteReplay = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: first.entry_id }, payload: setFirstPayload
      })
    }))
    expect(legacyNoteReplay.data).toEqual({
      ...setFirst.data,
      entry: { ...setFirst.data.entry, metadata: null }
    })

    const staleRead = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entry({ params: { id: second.entry_id } })
    }))
    const fresh = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: second.entry_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_decision_version: staleRead.data.decision_version,
          command: { type: "set-note", text: "current server note" }
        }
      })
    }))
    const stale = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: second.entry_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_decision_version: staleRead.data.decision_version,
          command: { type: "set-note", text: "stale editor text" }
        }
      }).pipe(Effect.flip)
    }))
    expect(stale._tag).toBe("RevisionConflict")
    expect(fresh.data.entry.note?.text).toBe("current server note")

    const clearPayload = {
      operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
      expected_decision_version: setFirst.data.entry.decision_version,
      command: { type: "clear-note" as const }
    }
    const clear = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: first.entry_id },
        payload: clearPayload
      })
    }))
    const clearReplay = await withClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({ params: { id: first.entry_id }, payload: clearPayload })
    }))
    expect(clearReplay.data).toEqual(clear.data)
    expect(clear.data.entry.note).toBeNull()
    expect(clear.data.entry.decision_version).toBe("5")
    expect(clear.data.entry.title_override).toBe("Title survives note clearing")

    const clearedDb = new DatabaseSync(server.dbPath)
    expect(clearedDb.prepare("SELECT notes, notes_revision FROM entry_overrides WHERE entry_id = ?").get(first.entry_id))
      .toEqual({ notes: null, notes_revision: 2 })
    expect(clearedDb.prepare("SELECT title_present, title FROM entry_overrides WHERE entry_id = ?").get(first.entry_id))
      .toEqual({ title_present: 1, title: "Title survives note clearing" })
    clearedDb.close()

    await server.stop()
    const restarted = await startServer(server.dbPath)
    servers.push(restarted)
    const staleEpochRetry = await withClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({ params: { id: first.entry_id }, payload: clearPayload }).pipe(Effect.flip)
    }))
    expect(staleEpochRetry._tag).toBe("EpochChanged")
    const reopened = await withClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: first.entry_id },
        payload: {
          operation_id: randomUUID(), instance_id: restarted.instanceId, epoch: restarted.epoch,
          expected_decision_version: clear.data.entry.decision_version,
          command: { type: "set-note", text: "first book note" }
        }
      })
    }))
    expect(reopened.data.entry.note?.text).toBe("first book note")
    expect(reopened.data.entry.note?.revision).toBe("3")
    expect(reopened.data.entry.title_override).toBe("Title survives note clearing")

    const rebound = await withClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: first.entry_id },
        payload: {
          operation_id: randomUUID(), instance_id: restarted.instanceId, epoch: restarted.epoch,
          expected_decision_version: reopened.data.entry.decision_version,
          command: { type: "bind", url: "https://exhentai.org/g/24680/shared-token/" }
        }
      })
    }))
    expect(rebound.data.entry.binding?.preferred_domain).toBe("exhentai.org")
    expect(rebound.data.entry.note?.text).toBe("first book note")

    const persisted = await withClient(restarted, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      const firstDetails = yield* client.entry({ params: { id: first.entry_id } })
      const secondDetails = yield* client.entry({ params: { id: second.entry_id } })
      return { first: firstDetails.data, second: secondDetails.data }
    }))
    expect(persisted.first.note?.text).toBe("first book note")
    expect(persisted.second.note?.text).toBe("current server note")
    expect(persisted.first.content_version).toBe("1")
    expect(persisted.first.location_revision).toBe("1")

    const db = new DatabaseSync(restarted.dbPath)
    expect((db.prepare("PRAGMA table_info(entry_overrides)").all() as Array<{ name: string }>).map((column) => column.name))
      .toEqual(expect.arrayContaining(["title_present", "notes"]))
    expect(db.prepare("SELECT notes, title FROM entry_overrides WHERE entry_id = ?").get(first.entry_id)).toEqual({ notes: "first book note", title: "Title survives note clearing" })
    expect(db.prepare("SELECT notes FROM entry_overrides WHERE entry_id = ?").get(second.entry_id)).toEqual({ notes: "current server note" })
    db.close()
  })
})
