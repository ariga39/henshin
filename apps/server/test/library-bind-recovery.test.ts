import http from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  LibraryHttpClient,
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

const withLibraryClient = <A, E>(baseUrl: string, server: RunningServer, program: Effect.Effect<A, E, LibraryHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, LibraryHttpClient.layer({ baseUrl, bearerToken: server.bearerToken })))

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
  throw new Error("bind recovery fixture scan did not reach a terminal state")
}

const startDropProxy = async (server: RunningServer): Promise<{
  readonly baseUrl: string
  readonly dropNextBindResponse: () => void
  readonly close: () => Promise<void>
}> => {
  let dropNext = false
  const proxy = http.createServer((request, response) => {
    const upstream = http.request({
      host: "127.0.0.1",
      port: Number(new URL(server.baseUrl).port),
      method: request.method,
      path: request.url,
      headers: request.headers
    }, (upstreamResponse) => {
      const isBind = request.url?.includes("/commands") === true
      if (dropNext && isBind && upstreamResponse.statusCode === 200) {
        dropNext = false
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
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const address = proxy.address()
  if (address === null || typeof address === "string") throw new Error("bind recovery proxy did not bind")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dropNextBindResponse: () => { dropNext = true },
    close: () => new Promise<void>((resolve, reject) => proxy.close((error) => error === undefined ? resolve() : reject(error)))
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("library bind transport recovery", () => {
  it("replays a bind after the committed HTTP response is dropped and advances once", async () => {
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath)
    servers.push(server)
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-bind-recovery-"))
    fixturePaths.add(fixture)
    const book = path.join(fixture, "book")
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
          label: "Bind recovery",
          path: fixture,
          preview_identity: preview.data.preview_identity
        }
      })
    }))
    const scan = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
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

    const before = await withLibraryClient(server.baseUrl, server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    const entry = before.data.entries[0]
    if (entry === undefined) throw new Error("bind recovery fixture did not create an entry")
    const details = await withLibraryClient(server.baseUrl, server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entry({ params: { id: entry.entry_id } })
    }))

    const proxy = await startDropProxy(server)
    try {
      const operationId = randomUUID()
      proxy.dropNextBindResponse()
      await expect(withLibraryClient(proxy.baseUrl, server, Effect.gen(function*() {
        return yield* (yield* LibraryHttpClient).entryCommand({
          params: { id: entry.entry_id },
          payload: {
            operation_id: operationId,
            instance_id: server.instanceId,
            epoch: server.epoch,
            expected_decision_version: details.data.decision_version,
            command: { type: "bind", url: "https://e-hentai.org/g/12345/recover/" }
          }
        })
      }))).rejects.toBeDefined()

      const replayed = await withLibraryClient(proxy.baseUrl, server, Effect.gen(function*() {
        return yield* (yield* LibraryHttpClient).entryCommand({
          params: { id: entry.entry_id },
          payload: {
            operation_id: operationId,
            instance_id: server.instanceId,
            epoch: server.epoch,
            expected_decision_version: details.data.decision_version,
            command: { type: "bind", url: "https://e-hentai.org/g/12345/recover/" }
          }
        })
      }))
      const after = await withLibraryClient(server.baseUrl, server, Effect.gen(function*() {
        return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
      }))
      const rebound = await withLibraryClient(server.baseUrl, server, Effect.gen(function*() {
        return yield* (yield* LibraryHttpClient).entry({ params: { id: entry.entry_id } })
      }))

      expect(replayed.data.operation_id).toBe(operationId)
      expect(BigInt(after.data.library_change_revision) - BigInt(before.data.library_change_revision)).toBe(1n)
      expect(rebound.data.decision_version).toBe("2")
      expect(rebound.data.binding?.canonical_url).toBe("https://e-hentai.org/g/12345/recover/")
    } finally {
      await proxy.close()
    }
  })
})
