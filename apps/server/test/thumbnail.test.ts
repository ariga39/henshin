import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import sharp from "sharp"
import { Effect, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { BlobWriter, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js"
import { LibraryHttpClient, ServerHttpClient, TaskHttpClient, ThumbnailHttpClient, type ScanTask } from "@henshin/contracts"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const servers: Array<RunningServer> = []
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
      const client = yield* TaskHttpClient
      return yield* client.get({ params: { id: taskId } })
    }))
    if (task.data.status !== "queued" && task.data.status !== "running") return task.data
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("thumbnail fixture scan did not reach a terminal state")
}

const makePage = async (background: { readonly r: number; readonly g: number; readonly b: number }) =>
  sharp({ create: { width: 640, height: 800, channels: 3, background } }).png().toBuffer()

const makeArchive = async (archivePath: string, page: Uint8Array): Promise<void> => {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  await writer.add("chapter/001.png", new Uint8ArrayReader(page))
  const blob = await writer.close()
  await writeFile(archivePath, Buffer.from(await blob.arrayBuffer()))
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixture of fixturePaths) await rm(fixture, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("accepted default thumbnails", () => {
  it("starts without its optional cache, regenerates covers, then keeps a changed source on the placeholder", async () => {
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    await writeFile(path.join(path.dirname(dbPath), "thumbnail-cache"), Buffer.from("cache unavailable"))
    const server = await startServer(dbPath)
    servers.push(server)
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-thumbnail-"))
    fixturePaths.add(fixture)
    const direct = path.join(fixture, "direct-pages")
    await mkdir(direct)
    const directPage = await makePage({ r: 220, g: 30, b: 60 })
    await writeFile(path.join(direct, "001.png"), directPage)
    const archivePath = path.join(fixture, "archive.cbz")
    await makeArchive(archivePath, await makePage({ r: 30, g: 90, b: 220 }))

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected root preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.data.instance_id,
          epoch: preview.data.epoch,
          label: "Books",
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
    if (!("task" in scan.data)) throw new Error("expected scan task submission")
    expect((await waitForTerminal(server, scan.data.task.task_id)).status).toBe("succeeded")

    const page = await withLibraryClient(server, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return yield* client.search({ payload: { page_size: 200 } })
    }))
    expect(page.data.entries).toHaveLength(2)
    const coldKey = page.data.entries[0]?.cover?.key
    if (!coldKey) throw new Error("expected a cover reference")
    const simultaneous = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* ThumbnailHttpClient
      return yield* Effect.all(
        Array.from({ length: 4 }, () => Effect.result(client.get({ params: { key: coldKey } }))),
        { concurrency: "unbounded" }
      )
    }).pipe(Effect.provide(ThumbnailHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken }))))
    expect(simultaneous.some(Result.isSuccess)).toBe(true)
    expect(simultaneous.some((result) =>
      Result.isFailure(result) && result.failure._tag === "ThumbnailUpdating"
    )).toBe(true)
    for (const entry of page.data.entries) {
      expect(entry.cover).not.toBeNull()
      const key = entry.cover?.key
      expect(key).toBeDefined()
      const response = await fetch(`${server.baseUrl}/api/v1/thumbnails/${encodeURIComponent(key ?? "")}`, {
        headers: { authorization: `Bearer ${server.bearerToken}` }
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("image/webp")
      const bytes = Buffer.from(await response.arrayBuffer())
      const metadata = await sharp(bytes).metadata()
      expect(metadata.format).toBe("webp")
      expect(metadata.width).toBe(320)
      expect(metadata.height).toBe(480)
      expect(bytes.byteLength).toBeLessThanOrEqual(512 * 1024)
    }

    const directEntry = page.data.entries.find((entry) => entry.relative_path === "direct-pages")
    if (directEntry?.cover === null || directEntry === undefined) throw new Error("direct cover reference missing")
    await writeFile(path.join(direct, "001.png"), Buffer.from("not an image"))
    const stale = await fetch(`${server.baseUrl}/api/v1/thumbnails/${encodeURIComponent(directEntry.cover.key)}`, {
      headers: { authorization: `Bearer ${server.bearerToken}` }
    })
    expect(stale.status).toBe(404)
    await expect(stale.json()).resolves.toMatchObject({ code: "thumbnail_missing" })

    const unauthenticated = await fetch(`${server.baseUrl}/api/v1/thumbnails/${encodeURIComponent(directEntry.cover.key)}`)
    expect(unauthenticated.status).toBe(401)

    const malformed = await fetch(`${server.baseUrl}/api/v1/thumbnails/${encodeURIComponent("default-v1.000000000000000000000000000000000000.1")}`, {
      headers: { authorization: `Bearer ${server.bearerToken}` }
    })
    expect(malformed.status).toBe(400)

    const unknown = await fetch(`${server.baseUrl}/api/v1/thumbnails/${encodeURIComponent(`default-v1.${randomUUID()}.1`)}`, {
      headers: { authorization: `Bearer ${server.bearerToken}` }
    })
    expect(unknown.status).toBe(404)
    await expect(unknown.json()).resolves.toMatchObject({ code: "thumbnail_missing" })
  })

  it("serves only an existing accepted cover while a replacement is pending", async () => {
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath)
    servers.push(server)
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-thumbnail-pending-"))
    fixturePaths.add(fixture)
    const cached = path.join(fixture, "cached")
    const uncached = path.join(fixture, "uncached")
    await mkdir(cached)
    await mkdir(uncached)
    await writeFile(path.join(cached, "001.png"), await makePage({ r: 30, g: 90, b: 220 }))
    await writeFile(path.join(uncached, "001.png"), await makePage({ r: 30, g: 180, b: 90 }))

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected root preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.data.instance_id,
          epoch: preview.data.epoch,
          label: "Pending thumbnail",
          path: fixture,
          preview_identity: preview.data.preview_identity
        }
      })
    }))

    const scan = async () => withServerClient(server, Effect.gen(function*() {
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

    const first = await scan()
    if (!("task" in first.data)) throw new Error("expected initial scan task")
    expect((await waitForTerminal(server, first.data.task.task_id)).status).toBe("succeeded")
    const accepted = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    const cachedEntry = accepted.data.entries.find((entry) => entry.relative_path === "cached")
    const uncachedEntry = accepted.data.entries.find((entry) => entry.relative_path === "uncached")
    if (cachedEntry?.cover === null || cachedEntry === undefined || uncachedEntry?.cover === null || uncachedEntry === undefined) {
      throw new Error("expected accepted cover references")
    }

    const cachedBefore = await fetch(`${server.baseUrl}/api/v1/thumbnails/${encodeURIComponent(cachedEntry.cover.key)}`, {
      headers: { authorization: `Bearer ${server.bearerToken}` }
    })
    expect(cachedBefore.status).toBe(200)
    const acceptedBytes = Buffer.from(await cachedBefore.arrayBuffer())

    await writeFile(path.join(cached, "001.png"), await makePage({ r: 220, g: 30, b: 40 }))
    await writeFile(path.join(uncached, "001.png"), await makePage({ r: 220, g: 220, b: 30 }))
    const replacement = await scan()
    if (!("task" in replacement.data)) throw new Error("expected replacement scan task")
    expect((await waitForTerminal(server, replacement.data.task.task_id)).readiness_error?.code).toBe("allocation_deferred")

    const pending = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 20 } })
    }))
    expect(pending.data.entries.filter((entry) => entry.state === "replacement-pending")).toHaveLength(2)

    const cachedAfter = await fetch(`${server.baseUrl}/api/v1/thumbnails/${encodeURIComponent(cachedEntry.cover.key)}`, {
      headers: { authorization: `Bearer ${server.bearerToken}` }
    })
    expect(cachedAfter.status).toBe(200)
    expect(Buffer.from(await cachedAfter.arrayBuffer())).toEqual(acceptedBytes)

    const uncachedAfter = await fetch(`${server.baseUrl}/api/v1/thumbnails/${encodeURIComponent(uncachedEntry.cover.key)}`, {
      headers: { authorization: `Bearer ${server.bearerToken}` }
    })
    expect(uncachedAfter.status).toBe(404)
    await expect(uncachedAfter.json()).resolves.toMatchObject({ code: "thumbnail_missing" })
  })
})
