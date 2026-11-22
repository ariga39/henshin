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
      yield* roots.commitPolicy({ rootId, epoch, operationId: randomUUID(), expectedPolicyRevision: "0",
        command: { type: "exclude", exclusion: { path: "skip.zip", scope: "exact" } } })
      expect((yield* scans.start({ ...request, operationId: randomUUID(), expectedPolicyRevision: "1" })).kind)
        .toBe("policy_revision_conflict")
      yield* scans.recordDiscovery(taskId, {
        status: "complete", directories_visited: 1, entries_observed: 1, candidate_count: 1,
        candidate_sample_truncated: false, excluded_links: [], excluded_link_count: 0,
        unsupported_names: [], unsupported_name_count: 0, unsupported_directories: [],
        unsupported_directory_count: 0, issues: [], issue_count: 0
      }, 1)
      yield* scans.stage({ candidateId, rootId, taskId, relativePath: "unavailable.cbz", kind: "archive",
        analysisStatus: "error", manifest: null, analysisError: { code: "source-unavailable", message: "Book unavailable",
          diagnostics: { supported_pages: 0, unsupported_pages: 0, ignored_entries: 0, directory_records: 0 } } })
    }).pipe(Effect.provide(storage)))

    await Effect.runPromise(Effect.gen(function*() {
      const scans = yield* ScanStore
      yield* scans.recoverInterrupted()
      const task = yield* scans.readTask(taskId)
      expect(task).toMatchObject({ status: "interrupted", hold_new_discoveries: true, directories_visited: 1,
        candidates_discovered: 1, analysis_error_count: 1, review_needed_count: 1, coverage: { status: "complete" } })
      if (!task) throw new Error("expected the original scan")
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
