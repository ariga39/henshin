import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { DatabaseWorker } from "../src/persistence/DatabaseWorker"
import { RootStore } from "../src/persistence/RootStore"
import { ScanStore } from "../src/persistence/ScanStore"
import { cleanupTempDb, makeTempDbPath } from "./support/server-process"

it("restores an interrupted task with its staged discovery still held", async () => {
  const dbPath = await makeTempDbPath()
  const worker = DatabaseWorker.layer(dbPath, { workerUrl: new URL("../dist/worker.mjs", import.meta.url) })
  const storage = Layer.merge(RootStore.layer, ScanStore.layer).pipe(Layer.provideMerge(worker))
  const taskId = randomUUID()
  const candidateId = randomUUID()
  const aliasOperation = randomUUID()
  const epoch = randomUUID()
  try {
    await Effect.runPromise(Effect.gen(function*() {
      yield* (yield* DatabaseWorker).call({ op: "init" })
      const roots = yield* RootStore
      const registered = yield* roots.register({
        operationId: randomUUID(), label: "Books", selectedPath: "/books", canonicalPath: "/books",
        device: "1", inode: "1"
      })
      if (registered.kind !== "registered") throw new Error("expected a saved root")
      const scans = yield* ScanStore
      const rootId = registered.root.rootId
      const request = { taskId, rootId, operationId: randomUUID(), epoch,
        expectedMappingRevision: registered.root.mappingRevision, expectedPolicyRevision: registered.root.policyRevision }
      expect((yield* scans.start(request)).kind).toBe("created")
      expect((yield* scans.start(request)).kind).toBe("replayed")
      expect((yield* scans.start({ ...request, operationId: aliasOperation })).kind).toBe("active")
      yield* scans.markRunning(taskId)
      yield* scans.recordDiscovery(taskId, {
        status: "complete", directories_visited: 1, entries_observed: 1, candidate_count: 1,
        candidate_sample_truncated: false, excluded_links: [], excluded_link_count: 0,
        unsupported_names: [], unsupported_name_count: 0, unsupported_directories: [],
        unsupported_directory_count: 0, issues: [], issue_count: 0
      }, 1)
      yield* scans.stage({ candidateId, rootId, taskId, relativePath: "unavailable.cbz", kind: "archive",
        analysisStatus: "error", manifest: null, analysisError: { code: "source-unavailable", message: "Book unavailable",
          diagnostics: { supported_pages: 0, unsupported_pages: 0, ignored_entries: 0, directory_records: 0 } } })
      yield* roots.commitPolicy({ rootId, epoch, operationId: randomUUID(), expectedPolicyRevision: "0",
        command: { type: "exclude", exclusion: { path: "skip.zip", scope: "exact" } } })
      expect(yield* scans.start({ ...request, operationId: randomUUID(), expectedPolicyRevision: "1" }))
        .toEqual({ kind: "active_scan_conflict", taskId, policyRevision: "0" })
      expect((yield* Effect.result(scans.stage({ taskId, rootId, candidateId: randomUUID(),
        relativePath: "late.cbz", kind: "archive", analysisStatus: "error", manifest: null, analysisError: null })))._tag)
        .toBe("Failure")
      expect((yield* Effect.result(scans.finish({ taskId, status: "succeeded", directoriesVisited: 1,
        candidatesDiscovered: 1, candidatesAnalyzed: 1, analysisErrorCount: 1, reviewNeededCount: 1,
        coverage: null, error: null, readinessError: null })))._tag).toBe("Failure")
    }).pipe(Effect.provide(storage)))

    await Effect.runPromise(Effect.gen(function*() {
      const scans = yield* ScanStore
      const prior = yield* scans.readTask(taskId)
      if (!prior) throw new Error("expected the original scan")
      const nextEpoch = yield* scans.start({ taskId: randomUUID(), operationId: randomUUID(), epoch: randomUUID(),
        rootId: prior.root_id, expectedMappingRevision: prior.mapping_revision, expectedPolicyRevision: "1" })
      expect(nextEpoch.kind).toBe("created")
      if (nextEpoch.kind === "created") {
        expect((yield* Effect.result(scans.finish({ taskId: nextEpoch.task.task_id, status: "succeeded",
          directoriesVisited: 0, candidatesDiscovered: 0, candidatesAnalyzed: 0, analysisErrorCount: 0,
          reviewNeededCount: 0, coverage: null, error: null, readinessError: null })))._tag).toBe("Failure")
      }
      yield* scans.recoverInterrupted()
      expect(yield* scans.readTask(nextEpoch.kind === "created" ? nextEpoch.task.task_id : taskId))
        .toMatchObject({ status: "failed", error: { code: "server_restart" } })
      const task = yield* scans.readTask(taskId)
      expect(task).toMatchObject({ status: "interrupted", hold_new_discoveries: true, directories_visited: 1,
        candidates_discovered: 1, analysis_error_count: 1, review_needed_count: 1, coverage: { status: "complete" } })
      if (!task) throw new Error("expected the original scan")
      expect((yield* Effect.result(scans.finish({ taskId, status: "failed", directoriesVisited: 1,
        candidatesDiscovered: 1, candidatesAnalyzed: 1, analysisErrorCount: 1, reviewNeededCount: 1,
        coverage: null, error: { code: "late", message: "late" }, readinessError: null })))._tag).toBe("Failure")
      expect(yield* scans.start({ taskId: randomUUID(), rootId: task.root_id, epoch, operationId: aliasOperation,
        expectedMappingRevision: task.mapping_revision, expectedPolicyRevision: "0" }))
        .toMatchObject({ kind: "replayed", task: { task_id: taskId, status: "interrupted" } })
      expect(yield* scans.listStaged()).toMatchObject([{ candidate_id: candidateId, hold_state: "held",
        relative_path: "unavailable.cbz", analysis_error: { code: "source-unavailable" } }])
    }).pipe(Effect.provide(storage)))
  } finally {
    await cleanupTempDb(dbPath)
  }
})

it("fences publication against a concurrent policy edit while preserving stale failure", async () => {
  const dbPath = await makeTempDbPath()
  const worker = DatabaseWorker.layer(dbPath, { workerUrl: new URL("../dist/worker.mjs", import.meta.url) })
  const storage = Layer.merge(RootStore.layer, ScanStore.layer).pipe(Layer.provideMerge(worker))
  try {
    await Effect.runPromise(Effect.gen(function*() {
      yield* (yield* DatabaseWorker).call({ op: "init" })
      const roots = yield* RootStore
      const registered = yield* roots.register({
        operationId: randomUUID(), label: "Books", selectedPath: "/books", canonicalPath: "/books",
        device: "1", inode: "1"
      })
      if (registered.kind !== "registered") throw new Error("expected a saved root")
      const scans = yield* ScanStore
      const taskId = randomUUID()
      yield* scans.start({ taskId, operationId: randomUUID(), epoch: randomUUID(), rootId: registered.root.rootId,
        expectedMappingRevision: registered.root.mappingRevision, expectedPolicyRevision: "0" })
      yield* scans.markRunning(taskId)

      const [policy, staged] = yield* Effect.promise(() => Promise.all([
        Effect.runPromise(roots.commitPolicy({ rootId: registered.root.rootId, epoch: randomUUID(),
          operationId: randomUUID(), expectedPolicyRevision: "0",
          command: { type: "exclude", exclusion: { path: "skip.cbz", scope: "exact" } } })),
        Effect.runPromise(Effect.result(scans.stage({ taskId, rootId: registered.root.rootId, candidateId: randomUUID(),
          relativePath: "book.cbz", kind: "archive", analysisStatus: "ready", manifest: null, analysisError: null })))
      ]))
      expect(policy.kind).toBe("committed")
      expect(staged._tag).toBe("Failure")
      expect((yield* Effect.result(scans.finish({ taskId, status: "succeeded", directoriesVisited: 1,
        candidatesDiscovered: 1, candidatesAnalyzed: 1, analysisErrorCount: 0, reviewNeededCount: 0,
        coverage: null, error: null, readinessError: null })))._tag).toBe("Failure")
      yield* scans.finish({ taskId, status: "failed", directoriesVisited: 1, candidatesDiscovered: 1,
        candidatesAnalyzed: 0, analysisErrorCount: 1, reviewNeededCount: 0, coverage: null,
        error: { code: "stale_scan", message: "root policy changed" }, readinessError: null })
      expect((yield* scans.readTask(taskId))?.status).toBe("failed")

      const interruptedTask = yield* scans.start({ taskId: randomUUID(), operationId: randomUUID(), epoch: randomUUID(),
        rootId: registered.root.rootId, expectedMappingRevision: registered.root.mappingRevision,
        expectedPolicyRevision: "1" })
      if (interruptedTask.kind !== "created") throw new Error("expected a fresh scan task")
      yield* scans.markRunning(interruptedTask.task.task_id)
      yield* roots.commitPolicy({ rootId: registered.root.rootId, epoch: randomUUID(), operationId: randomUUID(),
        expectedPolicyRevision: "1", command: { type: "exclude", exclusion: { path: "other.cbz", scope: "exact" } } })
      yield* scans.finish({ taskId: interruptedTask.task.task_id, status: "interrupted", directoriesVisited: 0,
        candidatesDiscovered: 0, candidatesAnalyzed: 0, analysisErrorCount: 0, reviewNeededCount: 0,
        coverage: null, error: { code: "stale_scan", message: "root policy changed" }, readinessError: null })
      expect((yield* scans.readTask(interruptedTask.task.task_id))?.status).toBe("interrupted")
    }).pipe(Effect.provide(storage)))
  } finally {
    await cleanupTempDb(dbPath)
  }
})
