import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { ServerHttpClient, type RootPreview } from "@henshin/contracts"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const servers: RunningServer[] = []
const dbPaths = new Set<string>()
const fixturePaths = new Set<string>()

const start = async (): Promise<RunningServer> => {
  const dbPath = await makeTempDbPath()
  dbPaths.add(dbPath)
  const server = await startServer(dbPath)
  servers.push(server)
  return server
}

const withClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, ServerHttpClient>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, ServerHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken }))
  )

const asSetupPreview = <A extends { readonly data: unknown }>(result: A): A & { readonly data: RootPreview } => {
  if (typeof result.data !== "object" || result.data === null || !("children" in result.data)) {
    throw new Error("expected setup preview")
  }
  return result as A & { readonly data: RootPreview }
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("server root preview", () => {
  it("requires authentication before reading a submitted server path", async () => {
    const server = await start()
    const response = await fetch(`${server.baseUrl}/api/v1/roots/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/private/collection" })
    })

    expect(response.status).toBe(401)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.code).toBe("authentication_required")
    expect(JSON.stringify(body)).not.toContain("/private/collection")
  })

  it("returns bounded complete, empty, and unavailable outcomes through the typed client", async () => {
    const server = await start()
    const fixturePath = await mkdtemp(path.join(os.tmpdir(), "henshin-root-preview-http-"))
    fixturePaths.add(fixturePath)
    for (let index = 0; index < 40; index += 1) {
      await writeFile(path.join(fixturePath, `child-${index.toString().padStart(2, "0")}.txt`), "sample")
    }

    const truncated = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.preview({ payload: { path: fixturePath } })
      })
    )
    const truncatedSetup = asSetupPreview(truncated)
    expect(truncatedSetup.data.selected_server_path).toBe(fixturePath)
    expect(truncatedSetup.data.outcome).toBe("truncated")
    expect(truncatedSetup.data.children).toHaveLength(32)

    const emptyPath = path.join(fixturePath, "empty")
    await mkdir(emptyPath)
    const empty = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.preview({ payload: { path: emptyPath } })
      })
    )
    const emptySetup = asSetupPreview(empty)
    expect(emptySetup.data).toMatchObject({ selected_server_path: emptyPath, outcome: "empty", children: [] })

    const unavailable = await fetch(`${server.baseUrl}/api/v1/roots/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${server.bearerToken}`
      },
      body: JSON.stringify({ path: path.join(fixturePath, "missing") })
    })
    expect(unavailable.status).toBe(503)
    expect((await unavailable.json() as Record<string, unknown>).code).toBe("root_preview_inaccessible")
  })

  it("discovers bounded book candidates only through the tagged saved-root request", async () => {
    const server = await start()
    const fixturePath = await mkdtemp(path.join(os.tmpdir(), "henshin-root-discovery-http-"))
    fixturePaths.add(fixturePath)
    const bookPath = path.join(fixturePath, "nested-book")
    await mkdir(bookPath)
    await writeFile(path.join(bookPath, "001.jpg"), "sample")
    await writeFile(path.join(fixturePath, "loose.jpg"), "sample")
    await writeFile(path.join(fixturePath, "book.cbz"), "sample")

    const setupPreview = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.preview({ payload: { path: fixturePath } })
      })
    )
    const setupResult = asSetupPreview(setupPreview)
    const saved = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.save({
          payload: {
            operation_id: crypto.randomUUID(),
            instance_id: setupResult.data.instance_id,
            epoch: setupResult.data.epoch,
            label: "Test books",
            path: fixturePath,
            preview_identity: setupResult.data.preview_identity
          }
        })
      })
    )

    const discovery = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.preview({ payload: { kind: "saved-root", root_id: saved.data.root_id } })
      })
    )
    expect(discovery.data).toMatchObject({
      kind: "saved-root-discovery",
      root_id: saved.data.root_id,
      candidates: [
        { relative_path: "book.cbz", kind: "archive" },
        { relative_path: "nested-book", kind: "image-directory", direct_image_count: 1 }
      ],
      unassigned_loose_image_count: 1
    })
    expect("children" in discovery.data).toBe(false)

    await Promise.all(Array.from({ length: 35 }, (_, i) => writeFile(path.join(fixturePath, `sample-${i}.zip`), "")))
    const capped = await withClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.preview({ payload: { kind: "saved-root", root_id: saved.data.root_id } })
    }))
    expect(capped.data).toMatchObject({ coverage: {
      candidate_sample_truncated: true,
      issues: expect.arrayContaining([{ code: "directory-limit", relative_path: expect.any(String) }])
    } })

  })
})
