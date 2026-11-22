import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  ReviewHttpClient,
  ServerHttpClient,
  TaskHttpClient,
  type RootPreview,
  type ScanTask,
  type StagedDiscovery
} from "@henshin/contracts"
import { DatabaseWorker } from "../src/persistence/DatabaseWorker"
import { RootStore } from "../src/persistence/RootStore"
import { ScanStore } from "../src/persistence/ScanStore"
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
    const excluded = path.join(fixture, "excluded-sibling")
    await mkdir(healthy)
    await mkdir(excluded)
    await writeFile(path.join(healthy, "001.jpg"), "source page")
    await writeFile(path.join(excluded, "001.jpg"), "excluded page")
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

    const policy = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.instance_id,
          epoch: preview.epoch,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "exclude", exclusion: { path: "excluded-sibling", scope: "subtree" } }
        }
      })
    }))
    if ("task" in policy.data) throw new Error("expected persisted root policy")
    const policyRoot = policy.data
    expect(policyRoot.exclusions).toEqual([{ path: "excluded-sibling", scope: "subtree" }])

    const submitted = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.instance_id,
          epoch: preview.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: policyRoot.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: true }
        }
      })
    }))
    if (!("task" in submitted.data)) throw new Error("expected scan task submission")
    const submittedTask = submitted.data.task
    const terminal = await waitForTerminal(server, submittedTask.task_id)
    expect(terminal.status).toBe("completed_with_errors")
    expect(terminal.hold_new_discoveries).toBe(true)
    expect(terminal.analysis_error_count).toBe(1)
    expect(terminal.review_needed_count).toBe(2)

    const staged = await listCandidates(server)
    expect(staged).toHaveLength(2)
    expect(new Set(staged.map((candidate) => candidate.relative_path))).toEqual(new Set(["broken.cbz", "healthy-book"]))
    expect(staged.every((candidate) => candidate.hold_state === "held")).toBe(true)
    expect(staged.some((candidate) => candidate.relative_path === "excluded-sibling")).toBe(false)
    expect(staged.find((candidate) => candidate.relative_path === "healthy-book")?.analysis_status).toBe("ready")
    expect(staged.find((candidate) => candidate.relative_path === "broken.cbz")?.analysis_error?.code).toBe("structural-corruption")

    await server.stop()
    const restarted = await startServer(server.dbPath)
    servers.push(restarted)
    const afterRestart = await waitForTerminal(restarted, submittedTask.task_id)
    expect(afterRestart.status).toBe("completed_with_errors")
    expect((await listCandidates(restarted)).every((candidate) => candidate.hold_state === "held")).toBe(true)
  })

  it("recovers a persisted running task before readiness and allows a new scan after restart", async () => {
    const first = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-held-scan-restart-"))
    fixturePaths.add(fixture)
    const book = path.join(fixture, "book")
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "source page")

    const preview = await withServerClient(first, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const result = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in result.data)) throw new Error("expected setup preview")
      return result.data as RootPreview
    }))
    const saved = await withServerClient(first, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.save({
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.instance_id,
          epoch: preview.epoch,
          label: "Restart books",
          path: fixture,
          preview_identity: preview.preview_identity
        }
      })
    }))
    await first.stop()

    const oldTaskId = randomUUID()
    const oldCandidateId = randomUUID()
    const worker = DatabaseWorker.layer(first.dbPath, { workerUrl: new URL("../dist/worker.mjs", import.meta.url) })
    const storage = Layer.merge(RootStore.layer, ScanStore.layer).pipe(Layer.provideMerge(worker))
    await Effect.runPromise(Effect.gen(function*() {
      yield* (yield* DatabaseWorker).call({ op: "init" })
      const scans = yield* ScanStore
      const started = yield* scans.start({
        taskId: oldTaskId,
        operationId: randomUUID(),
        epoch: randomUUID(),
        rootId: saved.data.root_id,
        expectedMappingRevision: saved.data.mapping_revision,
        expectedPolicyRevision: saved.data.policy_revision
      })
      if (started.kind !== "created") throw new Error("expected a persisted running task")
      yield* scans.markRunning(oldTaskId)
      yield* scans.recordDiscovery(oldTaskId, {
        status: "complete",
        directories_visited: 2,
        entries_observed: 2,
        candidate_count: 1,
        candidate_sample_truncated: false,
        excluded_links: [],
        excluded_link_count: 0,
        unsupported_names: [],
        unsupported_name_count: 0,
        unsupported_directories: [],
        unsupported_directory_count: 0,
        issues: [],
        issue_count: 0
      }, 1)
      yield* scans.stage({
        candidateId: oldCandidateId,
        taskId: oldTaskId,
        rootId: saved.data.root_id,
        relativePath: "book",
        kind: "image-directory",
        analysisStatus: "error",
        manifest: null,
        analysisError: {
          code: "source-unavailable",
          message: "previous process stopped during analysis",
          diagnostics: { supported_pages: 0, unsupported_pages: 0, ignored_entries: 0, directory_records: 0 }
        }
      })
    }).pipe(Effect.provide(storage)))

    const restarted = await startServer(first.dbPath)
    servers.push(restarted)
    const recovered = await withTaskClient(restarted, Effect.gen(function*() {
      const client = yield* TaskHttpClient
      return yield* client.get({ params: { id: oldTaskId } })
    }))
    expect(recovered.data).toMatchObject({
      task_id: oldTaskId,
      status: "interrupted",
      directories_visited: 2,
      candidates_discovered: 1,
      analysis_error_count: 1,
      review_needed_count: 1,
      coverage: { status: "complete" },
      error: { code: "server_restart", message: "scan interrupted by server restart" }
    })
    expect((await listCandidates(restarted)).find((candidate) => candidate.candidate_id === oldCandidateId))
      .toMatchObject({ task_id: oldTaskId, hold_state: "held" })

    const submitted = await withServerClient(restarted, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: saved.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: restarted.instanceId,
          epoch: restarted.epoch,
          expected_mapping_revision: saved.data.mapping_revision,
          expected_policy_revision: saved.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: true }
        }
      })
    }))
    if (!("task" in submitted.data)) throw new Error("expected a new scan task")
    expect(submitted.data.task.task_id).not.toBe(oldTaskId)
    const newTask = await waitForTerminal(restarted, submitted.data.task.task_id)
    expect(newTask.status).toBe("succeeded")
  })
})
