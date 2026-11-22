import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  ReviewHttpClient,
  LibraryHttpClient,
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
  it("conditionally releases one held discovery, survives restart, and accepts it only on a later normal scan", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-release-held-"))
    fixturePaths.add(fixture)
    for (const name of ["book-a", "book-b"]) {
      const book = path.join(fixture, name)
      await mkdir(book)
      await writeFile(path.join(book, "001.jpg"), `${name} page`)
    }

    const preview = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const result = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in result.data)) throw new Error("expected setup preview")
      return result.data
    }))
    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.save({
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.instance_id,
          epoch: preview.epoch,
          label: "Release books",
          path: fixture,
          preview_identity: preview.preview_identity
        }
      })
    }))

    const held = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: true }
        }
      })
    }))
    if (!("task" in held.data)) throw new Error("expected held scan task submission")
    expect((await waitForTerminal(server, held.data.task.task_id)).status).toBe("succeeded")

    const initialCandidates = await listCandidates(server)
    expect(initialCandidates).toHaveLength(2)
    const released = initialCandidates.find((candidate) => candidate.relative_path === "book-a")
    const retained = initialCandidates.find((candidate) => candidate.relative_path === "book-b")
    if (released === undefined || retained === undefined) throw new Error("expected two held discoveries")
    const releasePayload = {
      root_id: root.data.root_id,
      operation_id: randomUUID(),
      instance_id: server.instanceId,
      epoch: server.epoch,
      expected_candidate_version: released.candidate_version,
      expected_mapping_revision: root.data.mapping_revision,
      expected_policy_revision: root.data.policy_revision,
      command: { type: "release-hold" as const }
    }
    const release = await withReviewClient(server, Effect.gen(function*() {
      const client = yield* ReviewHttpClient
      return yield* client.command({ params: { id: released.candidate_id }, payload: releasePayload })
    }))
    expect(release.data.candidate).toMatchObject({ relative_path: "book-a", hold_state: "eligible", candidate_version: 2 })
    const replay = await withReviewClient(server, Effect.gen(function*() {
      const client = yield* ReviewHttpClient
      return yield* client.command({ params: { id: released.candidate_id }, payload: releasePayload })
    }))
    expect(replay.data).toEqual(release.data)
    expect((await listCandidates(server)).find((candidate) => candidate.relative_path === "book-b")?.hold_state).toBe("held")

    const heldAgain = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: true }
        }
      })
    }))
    if (!("task" in heldAgain.data)) throw new Error("expected re-hold scan task submission")
    expect((await waitForTerminal(server, heldAgain.data.task.task_id)).status).toBe("succeeded")

    const reheldCandidates = await listCandidates(server)
    const reheld = reheldCandidates.find((candidate) => candidate.relative_path === "book-a")
    if (reheld === undefined) throw new Error("expected released discovery to be held again")
    expect(reheld).toMatchObject({ hold_state: "held", candidate_version: 3 })
    const secondReleasePayload = {
      ...releasePayload,
      operation_id: randomUUID(),
      expected_candidate_version: reheld.candidate_version
    }
    expect(secondReleasePayload.operation_id).not.toBe(releasePayload.operation_id)
    const secondRelease = await withReviewClient(server, Effect.gen(function*() {
      const client = yield* ReviewHttpClient
      return yield* client.command({ params: { id: reheld.candidate_id }, payload: secondReleasePayload })
    }))
    expect(secondRelease.data.candidate).toMatchObject({
      relative_path: "book-a",
      hold_state: "eligible",
      candidate_version: 4
    })
    expect((await listCandidates(server)).find((candidate) => candidate.relative_path === "book-b")?.hold_state).toBe("held")

    await server.stop()
    const restarted = await startServer(server.dbPath)
    servers.push(restarted)
    const afterRestart = await listCandidates(restarted)
    expect(afterRestart.find((candidate) => candidate.relative_path === "book-a")?.hold_state).toBe("eligible")
    expect(afterRestart.find((candidate) => candidate.relative_path === "book-b")?.hold_state).toBe("held")

    const normal = await withServerClient(restarted, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: restarted.instanceId,
          epoch: restarted.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    if (!("task" in normal.data)) throw new Error("expected normal scan task submission")
    expect((await waitForTerminal(restarted, normal.data.task.task_id)).status).toBe("succeeded")

    const library = await withLibraryClient(restarted, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return yield* client.search({ payload: { page_size: 200 } })
    }))
    expect(library.data.entries.map((entry) => entry.relative_path)).toEqual(["book-a"])
    const remaining = await listCandidates(restarted)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ relative_path: "book-b", hold_state: "held" })
  })

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

  it("scans all books beyond the bounded saved-root preview sample", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-held-scan-many-books-"))
    fixturePaths.add(fixture)
    const bookCount = 65
    for (let index = 1; index <= bookCount; index += 1) {
      const book = path.join(fixture, `book-${String(index).padStart(3, "0")}`)
      await mkdir(book)
      await writeFile(path.join(book, "001.jpg"), "source page")
    }

    const preview = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const result = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in result.data)) throw new Error("expected setup preview")
      return result.data as RootPreview
    }))
    expect(preview).toMatchObject({ outcome: "truncated", sample_limit: 32 })
    expect(preview.children).toHaveLength(32)

    const saved = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.save({
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.instance_id,
          epoch: preview.epoch,
          label: "Many held books",
          path: fixture,
          preview_identity: preview.preview_identity
        }
      })
    }))

    const savedPreview = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.preview({ payload: { kind: "saved-root", root_id: saved.data.root_id } })
    }))
    if (!("kind" in savedPreview.data) || savedPreview.data.kind !== "saved-root-discovery") {
      throw new Error("expected saved-root discovery")
    }
    const savedRootPreview = savedPreview.data
    expect(savedRootPreview).toMatchObject({
      sample_limit: 32,
      candidates: expect.any(Array),
      coverage: { candidate_sample_truncated: true }
    })
    expect(savedRootPreview.candidates).toHaveLength(32)
    expect(savedRootPreview.coverage.candidate_count).toBeGreaterThan(32)
    expect(savedRootPreview.coverage.candidate_count).toBeLessThan(bookCount)

    const submitted = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: saved.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.instance_id,
          epoch: preview.epoch,
          expected_mapping_revision: saved.data.mapping_revision,
          expected_policy_revision: saved.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: true }
        }
      })
    }))
    if (!("task" in submitted.data)) throw new Error("expected scan task submission")

    const terminal = await waitForTerminal(server, submitted.data.task.task_id)
    expect(terminal).toMatchObject({
      status: "succeeded",
      candidates_discovered: bookCount,
      candidates_analyzed: bookCount,
      review_needed_count: bookCount,
      coverage: {
        status: "complete",
        candidate_count: bookCount,
        candidate_sample_truncated: false
      },
      error: null
    })
    expect(await listCandidates(server)).toHaveLength(bookCount)
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
        expectedPolicyRevision: saved.data.policy_revision,
        holdNewDiscoveries: true
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
        holdState: "held",
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
