import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  ReviewHttpClient,
  ServerHttpClient,
  TaskHttpClient,
  type RootPreview,
  type ScanTask,
  type StagedDiscovery
} from "@henshin/contracts"
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

const withServerClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, ServerHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, ServerHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withTaskClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, TaskHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, TaskHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withReviewClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, ReviewHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, ReviewHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitForTerminal = async (server: RunningServer, taskId: string): Promise<ScanTask> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await withTaskClient(server, Effect.gen(function*() {
      const client = yield* TaskHttpClient
      return yield* client.get({ params: { id: taskId } })
    }))
    if (task.data.status !== "queued" && task.data.status !== "running") return task.data
    await sleep(25)
  }
  throw new Error("held scan did not reach a terminal state")
}

const listCandidates = (server: RunningServer): Promise<ReadonlyArray<StagedDiscovery>> =>
  withReviewClient(server, Effect.gen(function*() {
    const client = yield* ReviewHttpClient
    const result = yield* client.candidates()
    return result.data
  }))

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("durable held manual scan", () => {
  it("stages a healthy book and an invalid CBZ, preserves hold state across restart, and accepts nothing", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-held-scan-"))
    fixturePaths.add(fixture)
    const healthy = path.join(fixture, "healthy-book")
    await mkdir(healthy)
    await writeFile(path.join(healthy, "001.jpg"), "source page")
    await writeFile(path.join(fixture, "broken.cbz"), "not a zip archive")

    const preview = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const result = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in result.data)) throw new Error("expected setup preview")
      return result.data as RootPreview
    }))
    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.save({
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.instance_id,
          epoch: preview.epoch,
          label: "Held books",
          path: fixture,
          preview_identity: preview.preview_identity
        }
      })
    }))

    const submitted = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.instance_id,
          epoch: preview.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: true }
        }
      })
    }))
    const terminal = await waitForTerminal(server, submitted.data.task.task_id)
    expect(terminal.status).toBe("completed_with_errors")
    expect(terminal.hold_new_discoveries).toBe(true)
    expect(terminal.analysis_error_count).toBe(1)
    expect(terminal.review_needed_count).toBe(2)

    const staged = await listCandidates(server)
    expect(staged).toHaveLength(2)
    expect(staged.map((candidate) => [candidate.relative_path, candidate.hold_state])).toEqual([
      ["broken.cbz", "held"],
      ["healthy-book", "held"]
    ])
    expect(staged.find((candidate) => candidate.relative_path === "healthy-book")?.analysis_status).toBe("ready")
    expect(staged.find((candidate) => candidate.relative_path === "broken.cbz")?.analysis_error?.code).toBe("structural-corruption")

    await server.stop()
    const restarted = await startServer(server.dbPath)
    servers.push(restarted)
    const afterRestart = await waitForTerminal(restarted, submitted.data.task.task_id)
    expect(afterRestart.status).toBe("completed_with_errors")
    expect((await listCandidates(restarted)).every((candidate) => candidate.hold_state === "held")).toBe(true)
  })
})
