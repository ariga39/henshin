import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { EhHttpClient, LibraryHttpClient, ServerHttpClient, TaskHttpClient } from "@henshin/contracts"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const servers: RunningServer[] = []
const dbPaths = new Set<string>()
const fixturePaths = new Set<string>()
const upstreams: Server[] = []

const withEhClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, EhHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, EhHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withServerClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, ServerHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, ServerHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withLibraryClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, LibraryHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, LibraryHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withTaskClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, TaskHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, TaskHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const upstreamHtml = `
<div class="itg">
  <div class="gl1t" data-gid="12345" data-token="Alpha_9">
    <div class="glink"><a href="https://e-hentai.org/g/12345/Alpha_9/">Synthetic Public Fixture — Alpha</a></div>
    <div class="glsub">English, translated</div><div class="glpage">42 pages</div><div class="glrating">4.75</div>
  </div>
  <div class="gl1t" data-gid="67890" data-token="Beta-7">
    <div class="glink"><a href="https://exhentai.org/g/67890/Beta-7/">Synthetic Public Fixture — Beta</a></div>
    <div class="glsub">English</div><div class="glpage">84 pages</div><div class="glrating">4.25</div>
  </div>
</div>`

const listenUpstream = async (response: () => { readonly status: number; readonly body: string }): Promise<string> => {
  const server = createServer((request, reply) => {
    const result = response()
    expect(request.url).toMatch(/^\/\?f_search=/u)
    reply.writeHead(result.status, { "content-type": "text/html; charset=utf-8" })
    reply.end(result.body)
  })
  upstreams.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("upstream did not expose a port")
  return `http://127.0.0.1:${address.port}/`
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const upstream of upstreams.splice(0)) await new Promise<void>((resolve) => upstream.close(() => resolve()))
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("authenticated EH candidate search", () => {
  it("returns two reviewable candidates from only the explicit synthetic query", async () => {
    const seen: string[] = []
    const upstreamUrl = await listenUpstream(() => ({ status: 200, body: upstreamHtml }))
    upstreams[upstreams.length - 1]?.on("request", (request) => seen.push(request.url ?? ""))
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath, { env: { HENSHIN_EH_SEARCH_URL: upstreamUrl } })
    servers.push(server)

    const result = await withEhClient(server, Effect.gen(function*() {
      return yield* (yield* EhHttpClient).candidates({
        payload: { title: "Synthetic Public Fixture", author: "Fixture Author", language: "English" }
      })
    }))

    expect(result.data.status).toBe("results")
    expect(result.data.candidates.map((candidate) => candidate.canonical_url)).toEqual([
      "https://e-hentai.org/g/12345/Alpha_9/",
      "https://exhentai.org/g/67890/Beta-7/"
    ])
    expect(result.data.candidates.map((candidate) => candidate.title)).toEqual([
      "Synthetic Public Fixture — Alpha",
      "Synthetic Public Fixture — Beta"
    ])
    expect(result.data.candidates[0]?.page_count).toBe(42)
    expect(result.data.candidates[0]?.language_evidence).toEqual(["English", "translated"])
    expect(result.data.candidates[0]?.rating).toBe(4.75)
    expect(result.data.candidates[1]?.language_evidence).toEqual(["English"])
    expect(result.data.candidates[1]?.rating).toBe(4.25)
    expect(seen).toEqual(["/?f_search=Synthetic+Public+Fixture+Fixture+Author+English"])
    expect(seen.join(" ")).not.toContain("source_path")
    expect(seen.join(" ")).not.toContain("collection")
  })

  it("parses sanitized compact-list markup with relative gallery anchors", async () => {
    const compactListHtml = await readFile(new URL("./fixtures/eh-gallery-list-gltc.html", import.meta.url), "utf8")
    const upstreamUrl = await listenUpstream(() => ({ status: 200, body: compactListHtml }))
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath, { env: { HENSHIN_EH_SEARCH_URL: upstreamUrl } })
    servers.push(server)

    const result = await withEhClient(server, Effect.gen(function*() {
      return yield* (yield* EhHttpClient).candidates({
        payload: { title: "Sanitized Gallery", author: "Artist", language: "English" }
      })
    }))

    expect(result.data.status).toBe("results")
    expect(result.data.candidates.map((candidate) => candidate.canonical_url)).toEqual([
      "https://e-hentai.org/g/1005/0a1b2c3d4e/",
      "https://e-hentai.org/g/1004/5f6a7b8c9d/"
    ])
    expect(result.data.candidates.map((candidate) => candidate.page_count)).toEqual([3, 1])
    expect(result.data.candidates.every((candidate) => candidate.rating === null)).toBe(true)
    expect(result.data.candidates.every((candidate) => candidate.language_evidence.length === 0)).toBe(true)
  })

  it("distinguishes empty results, upstream access failure, and an unrecognized layout", async () => {
    let mode: "empty" | "restricted" | "failure" | "layout" | "unknown_list" | "invalid_row" | "noise" = "empty"
    const upstreamUrl = await listenUpstream(() => {
      if (mode === "empty") return { status: 200, body: `<div class="itg"><div class="searchtext">No hits found</div></div>` }
      if (mode === "restricted") return { status: 403, body: "restricted" }
      if (mode === "failure") return { status: 500, body: "upstream failed" }
      if (mode === "unknown_list") return { status: 200, body: `<div class="itg"><div class="changed-row"><a href="/g/99999/changed/">Changed markup</a></div></div>` }
      if (mode === "invalid_row") return { status: 200, body: `<table class="itg"><tr><td><a href="/g/99999/changed/">Changed markup</a></td></tr></table>` }
      if (mode === "noise") return { status: 200, body: `<aside class="sidebar">No results</aside>` }
      return { status: 200, body: "<html><body>layout changed</body></html>" }
    })
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath, { env: { HENSHIN_EH_SEARCH_URL: upstreamUrl } })
    servers.push(server)

    const search = () => withEhClient(server, Effect.gen(function*() {
      return yield* (yield* EhHttpClient).candidates({ payload: { title: "Synthetic Public Fixture" } })
    }))
    expect((await search()).data).toEqual({ status: "empty", candidates: [] })
    mode = "restricted"
    expect((await search()).data).toEqual({ status: "restricted", candidates: [] })
    mode = "failure"
    expect((await search()).data).toEqual({ status: "access_failed", candidates: [] })
    mode = "layout"
    expect((await search()).data).toEqual({ status: "unrecognized_layout", candidates: [] })
    mode = "unknown_list"
    expect((await search()).data).toEqual({ status: "unrecognized_layout", candidates: [] })
    mode = "invalid_row"
    expect((await search()).data).toEqual({ status: "unrecognized_layout", candidates: [] })
    mode = "noise"
    expect((await search()).data).toEqual({ status: "unrecognized_layout", candidates: [] })
  })

  it("shares one upstream scheduler and honors a retry-after backoff", async () => {
    const starts: number[] = []
    let calls = 0
    const upstream = createServer((_request, reply) => {
      starts.push(Date.now())
      calls += 1
      if (calls === 1) {
        reply.writeHead(429, { "content-type": "text/html", "retry-after": "6" })
        reply.end("slow down")
        return
      }
      reply.writeHead(200, { "content-type": "text/html" })
      reply.end(upstreamHtml)
    })
    upstreams.push(upstream)
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject)
      upstream.listen(0, "127.0.0.1", () => resolve())
    })
    const address = upstream.address()
    if (address === null || typeof address === "string") throw new Error("upstream did not expose a port")
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath, { env: { HENSHIN_EH_SEARCH_URL: `http://127.0.0.1:${address.port}/` } })
    servers.push(server)

    const first = withEhClient(server, Effect.gen(function*() {
      return yield* (yield* EhHttpClient).candidates({ payload: { title: "first" } })
    }))
    const second = withEhClient(server, Effect.gen(function*() {
      return yield* (yield* EhHttpClient).candidates({ payload: { title: "second" } })
    }))
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.data.status).toBe("rate_limited")
    expect(firstResult.data.retry_after_ms).toBe(6_000)
    expect(secondResult.data.status).toBe("results")
    expect(starts).toHaveLength(2)
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(5_500)
  })

  it("leaves a book unbound until the selected candidate is submitted through the binding API", async () => {
    const upstreamUrl = await listenUpstream(() => ({ status: 200, body: upstreamHtml }))
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath, { env: { HENSHIN_EH_SEARCH_URL: upstreamUrl } })
    servers.push(server)
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-eh-candidate-book-"))
    fixturePaths.add(fixture)
    const book = path.join(fixture, "synthetic-book")
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "page")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          label: "Synthetic fixture", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))
    const scan = await withServerClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision, expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    if (!("task" in scan.data)) throw new Error("expected scan task")
    const taskId = scan.data.task.task_id
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const task = await withTaskClient(server, Effect.gen(function*() {
        return yield* (yield* TaskHttpClient).get({ params: { id: taskId } })
      }))
      if (task.data.status !== "queued" && task.data.status !== "running") break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const entry = (await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 10 } })
    }))).data.entries[0]
    if (entry === undefined) throw new Error("expected indexed book")
    const before = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entry({ params: { id: entry.entry_id } })
    }))
    expect(before.data.binding).toBeNull()

    const candidate = (await withEhClient(server, Effect.gen(function*() {
      return yield* (yield* EhHttpClient).candidates({ payload: { title: "Synthetic Public Fixture" } })
    }))).data.candidates[1]
    if (candidate === undefined) throw new Error("expected candidate")
    const afterSearch = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entry({ params: { id: entry.entry_id } })
    }))
    expect(afterSearch.data.binding).toBeNull()
    expect(afterSearch.data.decision_version).toBe(before.data.decision_version)
    const bound = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).entryCommand({
        params: { id: entry.entry_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_decision_version: afterSearch.data.decision_version,
          command: { type: "bind", url: candidate.canonical_url }
        }
      })
    }))
    expect(bound.data.entry.binding?.canonical_url).toBe(candidate.canonical_url)
  })

  it("keeps a queued search rate-limited when retry-after exceeds its bounded wait", async () => {
    let calls = 0
    const upstream = createServer((_request, reply) => {
      calls += 1
      reply.writeHead(429, { "retry-after": "60" })
      reply.end("slow down")
    })
    upstreams.push(upstream)
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject)
      upstream.listen(0, "127.0.0.1", () => resolve())
    })
    const address = upstream.address()
    if (address === null || typeof address === "string") throw new Error("upstream did not expose a port")
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath, { env: { HENSHIN_EH_SEARCH_URL: `http://127.0.0.1:${address.port}/` } })
    servers.push(server)

    const first = withEhClient(server, Effect.gen(function*() {
      return yield* (yield* EhHttpClient).candidates({ payload: { title: "first" } })
    }))
    const second = withEhClient(server, Effect.gen(function*() {
      return yield* (yield* EhHttpClient).candidates({ payload: { title: "second" } })
    }))
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.data.status).toBe("rate_limited")
    expect(secondResult.data.status).toBe("rate_limited")
    expect(secondResult.data.retry_after_ms).toBeGreaterThan(0)
    expect(calls).toBe(1)
  })
})
