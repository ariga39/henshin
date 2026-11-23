import http from "node:http"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Layer, ManagedRuntime } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { LibraryHttpClient, OpenEventHttpClient, ServerHttpClient, TaskHttpClient, type ScanTask } from "@henshin/contracts"
import { deliverOpenEvents, drainOpenEvents } from "../../desktop/src/main/OpenEventDelivery"
import { ConnectionLifecycle } from "../../desktop/src/main/ConnectionLifecycle"
import { LocalDatabaseWorker } from "../../desktop/src/main/persistence/LocalDatabaseWorker"
import { OpenJournalStore } from "../../desktop/src/main/persistence/OpenJournalStore"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const workerUrl = new URL("../../desktop/dist/draft-worker.mjs", import.meta.url)
const servers: RunningServer[] = []
const databasePaths = new Set<string>()
const fixturePaths = new Set<string>()
const lifecycles: ConnectionLifecycle[] = []
const localRuntimes: Array<ManagedRuntime.ManagedRuntime<OpenJournalStore, never>> = []
const proxies: Array<{ readonly close: () => Promise<void> }> = []

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
  throw new Error("scan did not reach a terminal state")
}

const startResponseDroppingProxy = async (
  targetBaseUrl: string
): Promise<{ readonly baseUrl: string; readonly requestCount: () => number }> => {
  const target = new URL(targetBaseUrl)
  let dropped = false
  let requestCount = 0
  const proxy = http.createServer((request, response) => {
    const upstream = http.request({
      hostname: target.hostname,
      port: Number(target.port),
      method: request.method,
      path: request.url,
      headers: request.headers
    }, (upstreamResponse) => {
      const isOpenBatch = request.method === "POST" && request.url?.endsWith("/api/v1/open-events/batch")
      if (isOpenBatch) requestCount += 1
      if (!dropped && isOpenBatch && upstreamResponse.statusCode === 200) {
        dropped = true
        upstreamResponse.resume()
        response.destroy()
        return
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on("error", () => response.destroy())
    request.pipe(upstream)
  })
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject)
    proxy.listen(0, "127.0.0.1", () => resolve())
  })
  const address = proxy.address()
  if (address === null || typeof address === "string") throw new Error("proxy did not bind")
  proxies.push({ close: () => new Promise((resolve) => proxy.close(() => resolve())) })
  return { baseUrl: `http://127.0.0.1:${address.port}`, requestCount: () => requestCount }
}

afterEach(async () => {
  for (const lifecycle of lifecycles.splice(0)) await lifecycle.close()
  for (const runtime of localRuntimes.splice(0)) await runtime.dispose()
  for (const proxy of proxies.splice(0)) await proxy.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of databasePaths) await cleanupTempDb(dbPath)
  databasePaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("desktop open event delivery boundary", () => {
  it("reconnects after a dropped acknowledgment and durably clears one server-deduplicated event", async () => {
    const serverDbPath = await makeTempDbPath()
    databasePaths.add(serverDbPath)
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-open-delivery-boundary-"))
    fixturePaths.add(fixture)
    const book = path.join(fixture, "book")
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "page")

    const server = await startServer(serverDbPath)
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
    const entries = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 1 } })
    }))
    const entry = entries.data.entries[0]
    if (entry === undefined) throw new Error("scan did not create an entry")

    const localDbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-open-delivery-local-"))
    const localDbPath = path.join(localDbDirectory, "desktop.db")
    databasePaths.add(localDbPath)
    const localRuntime = ManagedRuntime.make(
      OpenJournalStore.layerFromWorker.pipe(
        Layer.provide(LocalDatabaseWorker.layer(localDbPath, { workerUrl }))
      )
    )
    localRuntimes.push(localRuntime)
    const store = await localRuntime.runPromise(Effect.gen(function*() {
      return yield* OpenJournalStore
    }))
    const eventIds: string[] = []
    for (let index = 0; index < 33; index += 1) {
      const actionId = randomUUID()
      const deviceId = randomUUID()
      const prepared = await localRuntime.runPromise(store.prepare({
        instanceId: server.instanceId,
        actionId,
        entryId: entry.entry_id,
        deviceId,
        observedLocationRevision: entry.location_revision,
        observedContentVersion: entry.content_version
      }))
      await localRuntime.runPromise(store.recordAccepted({ instanceId: server.instanceId, actionId }, {
        event_id: actionId,
        instance_id: server.instanceId,
        entry_id: prepared.entry.entryId,
        device_id: deviceId,
        observed_location_revision: entry.location_revision,
        observed_content_version: entry.content_version,
        occurred_at_ms: 1_700_000_000_000 + index
      }))
      eventIds.push(actionId)
    }

    const proxy = await startResponseDroppingProxy(server.baseUrl)
    const lifecycle = new ConnectionLifecycle({ baseUrl: proxy.baseUrl, bearerToken: server.bearerToken })
    lifecycles.push(lifecycle)
    await lifecycle.connect()
    const firstSession = lifecycle.getSession()
    if (firstSession === null) throw new Error("connection did not establish a session")
    const client: OpenEventHttpClient["Service"] = {
      batch: (request) => Effect.tryPromise({
        try: () => lifecycle.run(
          Effect.gen(function*() {
            const authenticatedClient = yield* OpenEventHttpClient
            return yield* authenticatedClient.batch(request)
          })
        ),
        catch: (error) => error as never
      })
    }
    await expect(Effect.runPromise(deliverOpenEvents(store, client, firstSession))).rejects.toThrow()
    await lifecycle.disconnect()
    await lifecycle.connect()
    const secondSession = lifecycle.getSession()
    if (secondSession === null) throw new Error("reconnect did not establish a session")
    const drain = await Effect.runPromise(drainOpenEvents(store, client, secondSession, { random: () => 0 }))
    expect(drain).toMatchObject({ attempted: 33, acknowledged: 33, alreadyAccepted: 32, held: 0 })
    expect(proxy.requestCount()).toBe(3)
    for (const actionId of eventIds) {
      await expect(localRuntime.runPromise(store.get({ instanceId: server.instanceId, actionId }))).resolves.toMatchObject({
        status: "accepted",
        deliveryStatus: "acknowledged"
      })
    }

    await server.stop()
    const db = new DatabaseSync(serverDbPath)
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM open_events WHERE entry_id = ?").get(entry.entry_id)).toEqual({ count: 33 })
      expect(db.prepare("SELECT open_count FROM entry_statistics WHERE entry_id = ?").get(entry.entry_id)).toEqual({ open_count: 33 })
    } finally {
      db.close()
    }
  })
})
