import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  LibraryHttpClient,
  ServerHttpClient,
  TaskHttpClient,
  type RootPreview,
  type ScanTask
} from "@henshin/contracts"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const servers: RunningServer[] = []
const dbPaths = new Set<string>()
const fixturePaths = new Set<string>()

const withServerClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, ServerHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, ServerHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withTaskClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, TaskHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, TaskHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withLibraryClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, LibraryHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, LibraryHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitForTerminal = async (server: RunningServer, taskId: string): Promise<ScanTask> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await withTaskClient(server, Effect.gen(function*() {
      const client = yield* TaskHttpClient
      return yield* client.get({ params: { id: taskId } })
    }))
    if (task.data.status !== "queued" && task.data.status !== "running") return task.data
    await sleep(20)
  }
  throw new Error("scheduled scan did not reach a terminal state")
}

const saveRoot = async (server: RunningServer, rootPath: string, label: string) => {
  const preview = await withServerClient(server, Effect.gen(function*() {
    const client = yield* ServerHttpClient
    const result = yield* client.preview({ payload: { path: rootPath } })
    if (!("children" in result.data)) throw new Error("expected setup preview")
    return result.data as RootPreview
  }))
  return withServerClient(server, Effect.gen(function*() {
    const client = yield* ServerHttpClient
    return yield* client.save({
      payload: {
        operation_id: randomUUID(),
        instance_id: preview.instance_id,
        epoch: preview.epoch,
        label,
        path: rootPath,
        preview_identity: preview.preview_identity
      }
    })
  }))
}

const listEntries = (server: RunningServer) => withLibraryClient(server, Effect.gen(function*() {
  const client = yield* LibraryHttpClient
  return yield* client.search({ payload: { page_size: 200 } })
}))

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("scheduled root discovery", () => {
  it("persists one enabled root across restart, disables future work, and keeps manual scans available", async () => {
    const previousInterval = process.env.HENSHIN_SCHEDULE_INTERVAL_MS
    const previousPoll = process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
    process.env.HENSHIN_SCHEDULE_INTERVAL_MS = "100"
    process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = "20"
    try {
      const dbPath = await makeTempDbPath()
      dbPaths.add(dbPath)
      const server = await startServer(dbPath)
      servers.push(server)
      const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-scheduled-roots-"))
      fixturePaths.add(fixture)
      const rootAPath = path.join(fixture, "books-a")
      const rootBPath = path.join(fixture, "books-b")
      await mkdir(rootAPath)
      await mkdir(rootBPath)

      const rootA = await saveRoot(server, rootAPath, "Books A")
      const rootB = await saveRoot(server, rootBPath, "Books B")
      expect(rootA.data.schedule_enabled).toBe(false)
      expect(rootB.data.schedule_enabled).toBe(false)

      const enabled = await withServerClient(server, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: rootA.data.root_id },
          payload: {
            operation_id: randomUUID(),
            instance_id: server.instanceId,
            epoch: server.epoch,
            expected_policy_revision: rootA.data.policy_revision,
            command: { type: "set-schedule", enabled: true }
          }
        })
      }))
      if ("task" in enabled.data) throw new Error("expected a root settings response")
      expect(enabled.data.schedule_enabled).toBe(true)
      expect(enabled.data.policy_revision).toBe("1")

      await server.stop()
      const restarted = await startServer(dbPath)
      servers.push(restarted)
      const listed = await withServerClient(restarted, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.list()
      }))
      expect(listed.data.find((root) => root.root_id === rootA.data.root_id)?.schedule_enabled).toBe(true)
      expect(listed.data.find((root) => root.root_id === rootB.data.root_id)?.schedule_enabled).toBe(false)

      const aBook = path.join(rootAPath, "scheduled-book")
      const bBook = path.join(rootBPath, "unscheduled-book")
      await mkdir(aBook)
      await mkdir(bBook)
      const aPage = Buffer.from("scheduled page")
      const bPage = Buffer.from("unscheduled page")
      await writeFile(path.join(aBook, "001.jpg"), aPage)
      await writeFile(path.join(bBook, "001.jpg"), bPage)

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const entries = await listEntries(restarted)
        if (entries.data.entries.some((entry) => entry.relative_path === "scheduled-book")) break
        await sleep(20)
      }
      const afterScheduled = await listEntries(restarted)
      expect(afterScheduled.data.entries.map((entry) => entry.relative_path)).toEqual(["scheduled-book"])
      const tasks = await withTaskClient(restarted, Effect.gen(function*() {
        const client = yield* TaskHttpClient
        return yield* client.list()
      }))
      expect(tasks.data.some((task) => task.root_id === rootA.data.root_id && task.mode === "scheduled")).toBe(true)
      expect(await readFile(path.join(aBook, "001.jpg"))).toEqual(aPage)
      expect(await readFile(path.join(bBook, "001.jpg"))).toEqual(bPage)

      const currentRootA = listed.data.find((root) => root.root_id === rootA.data.root_id)
      if (currentRootA === undefined) throw new Error("enabled root was not retained")
      const disabled = await withServerClient(restarted, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: currentRootA.root_id },
          payload: {
            operation_id: randomUUID(),
            instance_id: restarted.instanceId,
            epoch: restarted.epoch,
            expected_policy_revision: currentRootA.policy_revision,
            command: { type: "set-schedule", enabled: false }
          }
        })
      }))
      if ("task" in disabled.data) throw new Error("expected a root settings response")
      const disabledRoot = disabled.data
      expect(disabledRoot.schedule_enabled).toBe(false)

      const laterBook = path.join(rootAPath, "manual-book")
      await mkdir(laterBook)
      const laterPage = Buffer.from("manual page")
      await writeFile(path.join(laterBook, "001.jpg"), laterPage)
      await sleep(220)
      expect((await listEntries(restarted)).data.entries.map((entry) => entry.relative_path)).toEqual(["scheduled-book"])

      const manual = await withServerClient(restarted, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: disabledRoot.root_id },
          payload: {
            operation_id: randomUUID(),
            instance_id: restarted.instanceId,
            epoch: restarted.epoch,
            expected_mapping_revision: disabledRoot.mapping_revision,
            expected_policy_revision: disabledRoot.policy_revision,
            command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
          }
        })
      }))
      if (!("task" in manual.data)) throw new Error("expected a manual scan task")
      expect((await waitForTerminal(restarted, manual.data.task.task_id)).status).toBe("succeeded")
      expect((await listEntries(restarted)).data.entries.map((entry) => entry.relative_path).sort()).toEqual([
        "manual-book",
        "scheduled-book"
      ])
      expect(await readFile(path.join(laterBook, "001.jpg"))).toEqual(laterPage)
      expect(await readFile(path.join(bBook, "001.jpg"))).toEqual(bPage)
    } finally {
      if (previousInterval === undefined) delete process.env.HENSHIN_SCHEDULE_INTERVAL_MS
      else process.env.HENSHIN_SCHEDULE_INTERVAL_MS = previousInterval
      if (previousPoll === undefined) delete process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
      else process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = previousPoll
    }
  })
})
