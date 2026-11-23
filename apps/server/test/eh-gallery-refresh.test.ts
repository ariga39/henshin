import { createServer, type Server } from "node:http"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { LibraryHttpClient, ServerHttpClient, TaskHttpClient, type LibraryEntry, type ScanTask } from "@henshin/contracts"
import { makeEhRefreshCoalescer } from "../src/api/library"
import { fetchEhMetadata, makeEhMetadataScheduler } from "../src/eh-metadata"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

type FixtureMode = "success" | "exact" | "numeric-exact" | "malformed" | "blocked" | "mismatched" | "bare-error" | "rate-limited" | "oversized"

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

const startFixture = async () => {
  let mode: FixtureMode = "success"
  let rateLimitRemaining = 0
  let retryAfterSeconds = "3"
  let releaseBlocked: (() => void) | null = null
  const rawBodies: string[] = []
  const requests: Array<{
    method: string
    namespace: number
    gidlist: ReadonlyArray<ReadonlyArray<number | string>>
  }> = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk.toString()
    rawBodies.push(body)
    const parsed = JSON.parse(body) as {
      readonly method: string
      readonly namespace: number
      readonly gidlist: ReadonlyArray<ReadonlyArray<number | string>>
    }
    requests.push(parsed)
    const [gid, token] = parsed.gidlist[0] ?? []
    const outboundGid = /"gidlist":\[\[([0-9]+)/u.exec(body)?.[1] ?? String(gid)
    if (mode === "blocked") await new Promise<void>((resolve) => { releaseBlocked = resolve })
    if (mode === "rate-limited" && rateLimitRemaining > 0) {
      rateLimitRemaining -= 1
      response.statusCode = 429
      response.setHeader("retry-after", retryAfterSeconds)
      response.end()
      return
    }
    response.setHeader("content-type", "application/json")
    const bodyForMode = mode === "oversized"
      ? { gmetadata: [{ gid, token, title: "x".repeat(256 * 1024), title_jpn: "", tags: [] }] }
      : mode === "malformed"
      ? { gmetadata: [{ gid, token, title: "stale replacement", title_jpn: "", error: "fixture failure" }] }
      : mode === "mismatched"
        ? { gmetadata: [{ gid: Number(gid) + 1, token, title: "wrong gallery", title_jpn: "", tags: [] }] }
        : mode === "bare-error"
          ? { gmetadata: [{ error: "fixture blocked" }] }
          : { gmetadata: [{
              gid: mode === "exact" ? outboundGid : Number(gid),
              token,
              title: `title-${outboundGid}`,
              title_jpn: `日本語-${outboundGid}`,
              tags: ["artist:fixture", "language:english"],
              unknown_upstream_field: { source: "fixture", value: 7 }
            }] }
    const responseBody = mode === "numeric-exact"
      ? `{"gmetadata":[{"gid":${outboundGid},"token":${JSON.stringify(token)},"title":"title-${outboundGid}","title_jpn":"日本語-${outboundGid}","tags":["artist:fixture","language:english"],"unknown_upstream_field":{"source":"fixture","value":7}}]}`
      : JSON.stringify(bodyForMode)
    response.end(responseBody)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("fixture did not bind")
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api.php`,
    requests,
    rawBodies,
    setMode: (next: FixtureMode) => { mode = next; rateLimitRemaining = next === "rate-limited" ? 1 : 0 },
    setRetryAfter: (seconds: string) => { retryAfterSeconds = seconds },
    release: () => { releaseBlocked?.(); releaseBlocked = null },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

const indexTwoEntries = async (server: RunningServer): Promise<ReadonlyArray<LibraryEntry>> => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-gallery-refresh-"))
  fixturePaths.add(fixture)
  for (const name of ["one", "two"]) {
    const directory = path.join(fixture, name)
    await mkdir(directory)
    await writeFile(path.join(directory, "001.jpg"), "page")
  }
  const root = await withServerClient(server, Effect.gen(function*() {
    const client = yield* ServerHttpClient
    const preview = yield* client.preview({ payload: { path: fixture } })
    if (!("children" in preview.data)) throw new Error("expected setup preview")
    return yield* client.save({
      payload: {
        operation_id: randomUUID(),
        instance_id: preview.data.instance_id,
        epoch: preview.data.epoch,
        label: "EH refresh",
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
  expect(page.data.entries).toHaveLength(2)
  return page.data.entries
}

const bind = (server: RunningServer, entryId: string, gid: string, expectedDecisionVersion: string) =>
  withLibraryClient(server, Effect.gen(function*() {
    return yield* (yield* LibraryHttpClient).entryCommand({
      params: { id: entryId },
      payload: {
        operation_id: randomUUID(),
        instance_id: server.instanceId,
        epoch: server.epoch,
        expected_decision_version: expectedDecisionVersion,
        command: { type: "bind", url: `https://e-hentai.org/g/${gid}/fixture-token/` }
      }
    })
  }))

const readEntry = (server: RunningServer, entryId: string) =>
  withLibraryClient(server, Effect.gen(function*() {
    return yield* (yield* LibraryHttpClient).entry({ params: { id: entryId } })
  }))

const readLibrary = (server: RunningServer) =>
  withLibraryClient(server, Effect.gen(function*() {
    return yield* (yield* LibraryHttpClient).get()
  }))

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
  delete process.env.HENSHIN_EH_GDATA_URL
})

describe("durable EH metadata refresh", () => {
  it("coalesces refresh work before the first promise starts", async () => {
    const coalesce = makeEhRefreshCoalescer<number>()
    let starts = 0
    let release!: (value: number) => void
    const start = () => {
      starts += 1
      return new Promise<number>((resolve) => { release = resolve })
    }

    const first = coalesce("EH:12345", start)
    const second = coalesce("EH:12345", start)
    expect(second).toBe(first)
    expect(starts).toBe(0)
    await Promise.resolve()
    expect(starts).toBe(1)
    release(7)
    await expect(Promise.all([first, second])).resolves.toEqual([7, 7])
  })

  it("serializes distinct galleries and honors bounded 429 timing", async () => {
    const upstream = await startFixture()
    process.env.HENSHIN_EH_GDATA_URL = upstream.baseUrl
    upstream.setMode("rate-limited")
    let clock = 0
    const startTimes: number[] = []
    const scheduler = makeEhMetadataScheduler(
      (locator) => {
        startTimes.push(clock)
        return fetchEhMetadata(locator)
      },
      {
        now: () => clock,
        sleep: async (milliseconds) => { clock += milliseconds }
      }
    )

    const results = await Promise.all([
      scheduler.fetch({ gid: "12345", token: "fixture-token" }),
      scheduler.fetch({ gid: "67890", token: "fixture-token" })
    ])

    expect(results.every((result) => result.kind === "success")).toBe(true)
    expect(startTimes).toEqual([0, 5_000, 10_000])
    expect(upstream.requests).toHaveLength(3)
    expect(upstream.rawBodies[0]).toContain('"gidlist":[[12345,"fixture-token"]]')
    await upstream.close()
  })

  it("does not retry early on a long Retry-After and gates independent requests", async () => {
    const upstream = await startFixture()
    process.env.HENSHIN_EH_GDATA_URL = upstream.baseUrl
    upstream.setRetryAfter("60")
    upstream.setMode("rate-limited")
    let clock = 0
    const startTimes: number[] = []
    const scheduler = makeEhMetadataScheduler(
      (locator) => {
        startTimes.push(clock)
        return fetchEhMetadata(locator)
      },
      {
        now: () => clock,
        sleep: async (milliseconds) => { clock += milliseconds }
      }
    )

    const [first, second] = await Promise.all([
      scheduler.fetch({ gid: "12345", token: "fixture-token" }),
      scheduler.fetch({ gid: "67890", token: "fixture-token" })
    ])

    expect(first).toMatchObject({ kind: "failure", retryAfterMs: 60_000 })
    expect(second.kind).toBe("success")
    expect(startTimes).toEqual([0, 60_000])
    expect(upstream.requests).toHaveLength(2)
    await upstream.close()
  })

  it("defers a cooldown beyond Node's timer range without retrying early", async () => {
    let clock = 0
    let calls = 0
    const sleeps: number[] = []
    const retryAfterMs = 2_147_483_648
    const scheduler = makeEhMetadataScheduler(
      async () => {
        calls += 1
        return {
          kind: "failure" as const,
          error: "rate limited",
          retryable: true,
          retryAfterMs
        }
      },
      {
        now: () => clock,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
          clock += milliseconds
        }
      }
    )

    const first = await scheduler.fetch({ gid: "12345", token: "fixture-token" })
    const deferred = await scheduler.fetch({ gid: "67890", token: "fixture-token" })

    expect(first).toMatchObject({ kind: "failure", retryAfterMs })
    expect(deferred).toMatchObject({
      kind: "failure",
      error: "metadata refresh deferred until the upstream retry window expires",
      retryable: true,
      retryAfterMs
    })
    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
  })

  it("defers a one-day cooldown without waiting in the interactive tail", async () => {
    let clock = 0
    let calls = 0
    const sleeps: number[] = []
    const retryAfterMs = 24 * 60 * 60 * 1_000
    const scheduler = makeEhMetadataScheduler(
      async () => {
        calls += 1
        return {
          kind: "failure" as const,
          error: "rate limited",
          retryable: true,
          retryAfterMs
        }
      },
      {
        now: () => clock,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
          clock += milliseconds
        }
      }
    )

    const first = await scheduler.fetch({ gid: "12345", token: "fixture-token" })
    const deferred = await scheduler.fetch({ gid: "67890", token: "fixture-token" })

    expect(first).toMatchObject({ kind: "failure", retryAfterMs })
    expect(deferred).toMatchObject({
      kind: "failure",
      error: "metadata refresh deferred until the upstream retry window expires",
      retryable: true,
      retryAfterMs
    })
    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
  })

  it("bounds successful metadata response bodies", async () => {
    const upstream = await startFixture()
    process.env.HENSHIN_EH_GDATA_URL = upstream.baseUrl
    upstream.setMode("oversized")

    const result = await fetchEhMetadata({ gid: "12345", token: "fixture-token" })

    expect(result).toMatchObject({ kind: "failure", error: "metadata upstream request failed", retryable: true })
    await upstream.close()
  })

  it("refreshes zero-padded and large decimal GIDs without changing entry identity", async () => {
    const upstream = await startFixture()
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    process.env.HENSHIN_EH_GDATA_URL = upstream.baseUrl
    const server = await startServer(dbPath)
    servers.push(server)
    const [entry] = await indexTwoEntries(server)
    if (entry === undefined) throw new Error("expected indexed entry")

    await bind(server, entry.entry_id, "000123", "1")
    const padded = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).ehRefresh({ payload: { source: "EH", gid: "000123" } })
    }))
    expect(padded.data.metadata.status).toBe("ready")
    expect(upstream.rawBodies[0]).toContain('"gidlist":[[123,"fixture-token"]]')
    expect((await readEntry(server, entry.entry_id)).data.binding?.gid).toBe("000123")

    const rebound = await bind(server, entry.entry_id, "9007199254740993", "2")
    expect(rebound.data.entry.binding?.gid).toBe("9007199254740993")
    upstream.setMode("exact")
    const large = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).ehRefresh({ payload: { source: "EH", gid: "9007199254740993" } })
    }))
    expect(large.data.metadata.status).toBe("ready")
    expect(upstream.rawBodies[1]).toContain('"gidlist":[[9007199254740993,"fixture-token"]]')
    expect((await readEntry(server, entry.entry_id)).data.binding?.gid).toBe("9007199254740993")
    await upstream.close()
  })

  it("accepts an exact large numeric GID from the fixture HTTP response", async () => {
    const upstream = await startFixture()
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    process.env.HENSHIN_EH_GDATA_URL = upstream.baseUrl
    const server = await startServer(dbPath)
    servers.push(server)
    const [entry] = await indexTwoEntries(server)
    if (entry === undefined) throw new Error("expected indexed entry")

    await bind(server, entry.entry_id, "9007199254740993", "1")
    upstream.setMode("numeric-exact")
    const refreshed = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).ehRefresh({ payload: { source: "EH", gid: "9007199254740993" } })
    }))

    expect(refreshed.data.metadata.status).toBe("ready")
    expect(upstream.rawBodies[0]).toContain('"gidlist":[[9007199254740993,"fixture-token"]]')
    expect((await readEntry(server, entry.entry_id)).data.binding?.gid).toBe("9007199254740993")
  })

  it("rejects refresh for an orphan gallery before contacting fixture HTTP", async () => {
    const upstream = await startFixture()
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    process.env.HENSHIN_EH_GDATA_URL = upstream.baseUrl
    const server = await startServer(dbPath)
    servers.push(server)
    const [entry] = await indexTwoEntries(server)
    if (entry === undefined) throw new Error("expected indexed entry")
    await bind(server, entry.entry_id, "12345", "1")

    const db = new DatabaseSync(server.dbPath)
    db.prepare("DELETE FROM bindings WHERE entry_id = ?").run(entry.entry_id)
    db.close()

    const error = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).ehRefresh({ payload: { source: "EH", gid: "12345" } }).pipe(Effect.flip)
    }))
    expect(error._tag).toBe("InvalidRequest")
    expect(error.message).toBe("the gallery is not currently bound")
    expect(upstream.requests).toHaveLength(0)
  })

  it("publishes shared metadata, preserves it on failure, and survives restart", async () => {
    const upstream = await startFixture()
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    process.env.HENSHIN_EH_GDATA_URL = upstream.baseUrl
    const server = await startServer(dbPath)
    servers.push(server)
    const [first, second] = await indexTwoEntries(server)
    await bind(server, first.entry_id, "12345", "1")
    await bind(server, second.entry_id, "12345", "1")
    const beforeRefresh = await readLibrary(server)

    const refreshed = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).ehRefresh({ payload: { source: "EH", gid: "12345" } })
    }))
    expect(refreshed.data.metadata.status).toBe("ready")
    expect(refreshed.data.metadata.tags).toEqual(["artist:fixture", "language:english"])
    const afterRefresh = await readLibrary(server)
    expect(BigInt(afterRefresh.data.change_revision)).toBe(BigInt(beforeRefresh.data.change_revision) + 1n)
    expect(upstream.requests[0]).toEqual({
      method: "gdata",
      namespace: 1,
      gidlist: [[12345, "fixture-token"]]
    })
    expect((await readEntry(server, first.entry_id)).data.metadata).toEqual(refreshed.data.metadata)
    expect((await readEntry(server, second.entry_id)).data.metadata).toEqual(refreshed.data.metadata)

    upstream.setMode("blocked")
    const blockedRefresh = withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).ehRefresh({ payload: { source: "EH", gid: "12345" } })
    }))
    for (let attempt = 0; attempt < 700 && upstream.requests.length === 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(upstream.requests).toHaveLength(2)
    upstream.release()
    const blockedResult = await blockedRefresh
    expect(blockedResult.data.metadata.status).toBe("ready")

    upstream.setMode("malformed")
    const failed = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).ehRefresh({ payload: { source: "EH", gid: "12345" } })
    }))
    expect(failed.data.metadata.status).toBe("error")
    expect(failed.data.metadata.title).toBe("title-12345")
    expect(failed.data.metadata.tags).toEqual(refreshed.data.metadata.tags)
    const afterFailure = await readLibrary(server)
    expect(BigInt(afterFailure.data.change_revision)).toBeGreaterThan(BigInt(afterRefresh.data.change_revision))
    upstream.setMode("mismatched")
    const mismatched = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).ehRefresh({ payload: { source: "EH", gid: "12345" } })
    }))
    expect(mismatched.data.metadata.latest_error).toBe("metadata upstream identity did not match the gallery")
    upstream.setMode("bare-error")
    const bareError = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).ehRefresh({ payload: { source: "EH", gid: "12345" } })
    }))
    expect(bareError.data.metadata.latest_error).toBe("metadata upstream rejected the gallery: fixture blocked")
    await server.stop()
    servers.splice(servers.indexOf(server), 1)
    const restarted = await startServer(dbPath)
    servers.push(restarted)
    expect((await readEntry(restarted, first.entry_id)).data.metadata).toMatchObject({
      status: "error",
      title: "title-12345",
      tags: refreshed.data.metadata.tags,
      latest_error: "metadata upstream rejected the gallery: fixture blocked"
    })
    await upstream.close()
  })

  it("does not leak an outstanding old-gallery response after rebind", async () => {
    const upstream = await startFixture()
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    process.env.HENSHIN_EH_GDATA_URL = upstream.baseUrl
    const server = await startServer(dbPath)
    servers.push(server)
    const [entry] = await indexTwoEntries(server)
    await bind(server, entry.entry_id, "12345", "1")
    upstream.setMode("blocked")
    const pending = withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).ehRefresh({ payload: { source: "EH", gid: "12345" } })
    }))
    for (let attempt = 0; attempt < 50 && upstream.requests.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    await bind(server, entry.entry_id, "67890", "2")
    expect((await readEntry(server, entry.entry_id)).data.metadata).toMatchObject({ status: "pending", title: null, tags: [] })
    upstream.release()
    await pending
    expect((await readEntry(server, entry.entry_id)).data.binding?.gid).toBe("67890")
    expect((await readEntry(server, entry.entry_id)).data.metadata).toMatchObject({ status: "pending", title: null, tags: [] })
    await upstream.close()
  })

  it("keeps initial and coalesced worker failures as typed internal errors", async () => {
    const upstream = await startFixture()
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    process.env.HENSHIN_EH_GDATA_URL = upstream.baseUrl
    const server = await startServer(dbPath)
    servers.push(server)
    const [entry] = await indexTwoEntries(server)
    await bind(server, entry.entry_id, "12345", "1")
    upstream.setMode("blocked")

    const first = withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).ehRefresh({ payload: { source: "EH", gid: "12345" } })
    }))
    for (let attempt = 0; attempt < 50 && upstream.requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const second = withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).ehRefresh({ payload: { source: "EH", gid: "12345" } })
    }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const db = new DatabaseSync(server.dbPath)
    db.exec("PRAGMA foreign_keys = OFF")
    db.exec("DROP TABLE galleries")
    db.close()
    upstream.release()

    const outcomes = await Promise.allSettled([first, second])
    expect(outcomes).toHaveLength(2)
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected")
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({ _tag: "InternalError", code: "internal_error" })
      }
    }
    await upstream.close()
  })

  it("publishes an interrupted refresh error after restart", async () => {
    const upstream = await startFixture()
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    process.env.HENSHIN_EH_GDATA_URL = upstream.baseUrl
    const server = await startServer(dbPath)
    servers.push(server)
    const [entry] = await indexTwoEntries(server)
    await bind(server, entry.entry_id, "12345", "1")

    const db = new DatabaseSync(server.dbPath)
    db.prepare(
      "UPDATE galleries SET metadata_status = 'pending', metadata_error = NULL, metadata_last_attempt_at_ms = ?, updated_at_ms = ? WHERE source = 'EH' AND gid = ?"
    ).run(Date.now(), Date.now(), "12345")
    const beforeRestartRecovery = await readLibrary(server)
    db.close()
    await server.stop()
    servers.splice(servers.indexOf(server), 1)

    const restarted = await startServer(dbPath)
    servers.push(restarted)
    const recovered = await readEntry(restarted, entry.entry_id)
    expect(recovered.data.metadata).toMatchObject({
      status: "error",
      title: null,
      tags: [],
      latest_error: "metadata refresh interrupted by server restart"
    })
    expect(BigInt((await readLibrary(restarted)).data.change_revision)).toBeGreaterThan(
      BigInt(beforeRestartRecovery.data.change_revision)
    )
    await upstream.close()
  })
})
