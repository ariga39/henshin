import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  LibraryHttpClient,
  OpenEventHttpClient,
  ServerHttpClient,
  TaskHttpClient,
  type ScanTask
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

const withOpenEventClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, OpenEventHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, OpenEventHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const waitForTerminal = async (server: RunningServer, taskId: string): Promise<ScanTask> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await withTaskClient(server, Effect.gen(function*() {
      return yield* (yield* TaskHttpClient).get({ params: { id: taskId } })
    }))
    if (task.data.status !== "queued" && task.data.status !== "running") return task.data
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("scan did not reach a terminal state")
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("accepted open event delivery", () => {
  it("acknowledges a partial batch idempotently across restart without double counting", async () => {
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-open-events-"))
    fixturePaths.add(fixture)
    const book = path.join(fixture, "scanned-book")
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "page")

    const server = await startServer(dbPath)
    servers.push(server)
    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected root selection preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          label: "Books",
          path: fixture,
          preview_identity: preview.data.preview_identity
        }
      })
    }))
    const scan = await withServerClient(server, Effect.gen(function*() {
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
    expect((await waitForTerminal(server, scan.data.task.task_id)).status).toBe("succeeded")

    const library = await withLibraryClient(server, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return {
        view: yield* client.get(),
        entries: yield* client.search({ payload: { page_size: 10 } })
      }
    }))
    const entry = library.entries.data.entries[0]
    if (entry === undefined) throw new Error("scan did not create an entry")
    const event = {
      event_id: randomUUID(),
      instance_id: server.instanceId,
      entry_id: entry.entry_id,
      device_id: randomUUID(),
      observed_location_revision: entry.location_revision,
      observed_content_version: entry.content_version,
      occurred_at_ms: 1_700_000_000_000
    }
    const missing = { ...event, event_id: randomUUID(), entry_id: randomUUID() }

    const firstBatch = await withOpenEventClient(server, Effect.gen(function*() {
      return yield* (yield* OpenEventHttpClient).batch({
        payload: { epoch: server.epoch, events: [event, missing] }
      })
    }))
    expect(firstBatch.data.results).toHaveLength(2)
    expect(firstBatch.data.results.map((result) => result.outcome)).toEqual(["accepted", "missing_entry"])
    const firstReceipt = firstBatch.data.results[0]
    if (firstReceipt?.outcome !== "accepted") throw new Error("expected accepted event receipt")
    expect(firstReceipt.receipt_at_ms).toBeGreaterThan(0)

    await server.stop()
    const restarted = await startServer(dbPath)
    servers.push(restarted)
    const afterRestart = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).get()
    }))
    expect(afterRestart.data.change_revision).toBe(String(BigInt(library.view.data.change_revision) + 1n))

    const changed = { ...event, occurred_at_ms: event.occurred_at_ms + 1 }
    const secondEvent = { ...event, event_id: randomUUID(), occurred_at_ms: event.occurred_at_ms + 2 }
    const retryBatch = await withOpenEventClient(restarted, Effect.gen(function*() {
      return yield* (yield* OpenEventHttpClient).batch({
        payload: { epoch: restarted.epoch, events: [event, changed, missing, secondEvent] }
      })
    }))
    expect(retryBatch.data.results.map((result) => result.outcome)).toEqual([
      "already_accepted",
      "conflict",
      "missing_entry",
      "accepted"
    ])
    const retryReceipt = retryBatch.data.results[0]
    if (retryReceipt?.outcome !== "already_accepted") throw new Error("expected duplicate acknowledgment")
    expect(retryReceipt.receipt_at_ms).toBe(firstReceipt.receipt_at_ms)

    const finalLibrary = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).get()
    }))
    expect(BigInt(finalLibrary.data.change_revision)).toBe(BigInt(library.view.data.change_revision) + 2n)

    await restarted.stop()
    const db = new DatabaseSync(dbPath)
    try {
      const events = db.prepare(
        "SELECT event_id, occurred_at_ms, receipt_at_ms FROM open_events ORDER BY event_id"
      ).all() as unknown as ReadonlyArray<{ event_id: string; occurred_at_ms: number; receipt_at_ms: number }>
      expect(events).toHaveLength(2)
      expect(events.find((row) => row.event_id === event.event_id)).toMatchObject({
        occurred_at_ms: event.occurred_at_ms,
        receipt_at_ms: firstReceipt.receipt_at_ms
      })
      expect(db.prepare("SELECT open_count, last_opened_at_ms FROM entry_statistics WHERE entry_id = ?").get(entry.entry_id)).toEqual({
        open_count: 2,
        last_opened_at_ms: secondEvent.occurred_at_ms
      })
    } finally {
      db.close()
    }
  })

  it("attributes a delayed accepted event to its retained replacement-pending entry", async () => {
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-open-events-pending-"))
    fixturePaths.add(fixture)
    const book = path.join(fixture, "scanned-book")
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "original")

    const server = await startServer(dbPath)
    servers.push(server)
    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected root selection preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          label: "Books",
          path: fixture,
          preview_identity: preview.data.preview_identity
        }
      })
    }))
    const scan = async (activeServer: RunningServer = server) => withServerClient(activeServer, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: activeServer.instanceId,
          epoch: activeServer.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))

    const firstScan = await scan()
    if (!("task" in firstScan.data)) throw new Error("expected initial scan task")
    expect((await waitForTerminal(server, firstScan.data.task.task_id)).status).toBe("succeeded")
    const entry = (await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 10 } })
    }))).data.entries[0]
    if (entry === undefined) throw new Error("scan did not create an entry")
    const event = {
      event_id: randomUUID(),
      instance_id: server.instanceId,
      entry_id: entry.entry_id,
      device_id: randomUUID(),
      observed_location_revision: entry.location_revision,
      observed_content_version: entry.content_version,
      occurred_at_ms: 1_700_000_000_000
    }

    await writeFile(path.join(book, "001.jpg"), "replacement")
    const replacementScan = await scan()
    if (!("task" in replacementScan.data)) throw new Error("expected replacement scan task")
    expect((await waitForTerminal(server, replacementScan.data.task.task_id)).status).toBe("completed_with_errors")
    const pending = await withLibraryClient(server, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return {
        entries: yield* client.search({ payload: { page_size: 10 } }),
        resolution: yield* client.resolution({ params: { id: entry.entry_id }, query: {} })
      }
    }))
    expect(pending.entries.data.entries[0]).toMatchObject({
      entry_id: entry.entry_id,
      state: "replacement-pending"
    })
    expect(pending.resolution.data).toMatchObject({
      entry_id: entry.entry_id,
      status: "unresolved",
      reason: "known-change"
    })

    await server.stop()
    const restarted = await startServer(dbPath)
    servers.push(restarted)
    const delivered = await withOpenEventClient(restarted, Effect.gen(function*() {
      return yield* (yield* OpenEventHttpClient).batch({
        payload: { epoch: restarted.epoch, events: [event] }
      })
    }))
    expect(delivered.data.results).toEqual([
      expect.objectContaining({ event_id: event.event_id, outcome: "accepted" })
    ])
    const retried = await withOpenEventClient(restarted, Effect.gen(function*() {
      return yield* (yield* OpenEventHttpClient).batch({
        payload: { epoch: restarted.epoch, events: [event] }
      })
    }))
    expect(retried.data.results).toEqual([
      expect.objectContaining({ event_id: event.event_id, outcome: "already_accepted" })
    ])

    await restarted.stop()
    const db = new DatabaseSync(dbPath)
    try {
      expect(db.prepare("SELECT state FROM library_entries WHERE entry_id = ?").get(entry.entry_id)).toEqual({
        state: "replacement-pending"
      })
      expect(db.prepare("SELECT entry_id, occurred_at_ms FROM open_events WHERE event_id = ?").get(event.event_id)).toEqual({
        entry_id: entry.entry_id,
        occurred_at_ms: event.occurred_at_ms
      })
      expect(db.prepare("SELECT open_count, last_opened_at_ms FROM entry_statistics WHERE entry_id = ?").get(entry.entry_id)).toEqual({
        open_count: 1,
        last_opened_at_ms: event.occurred_at_ms
      })
    } finally {
      db.close()
    }
  })
})
