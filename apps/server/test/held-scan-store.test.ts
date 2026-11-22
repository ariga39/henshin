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
      const request = { taskId, rootId, operationId: randomUUID(), epoch: randomUUID(),
        expectedMappingRevision: registered.root.mappingRevision, expectedPolicyRevision: registered.root.policyRevision }
      expect((yield* scans.start(request)).kind).toBe("created")
      expect((yield* scans.start(request)).kind).toBe("replayed")
      yield* scans.markRunning(taskId)
      yield* scans.stage({ candidateId, rootId, taskId, relativePath: "unavailable.cbz", kind: "archive",
        analysisStatus: "error", manifest: null, analysisError: { code: "source-unavailable", message: "Book unavailable",
          diagnostics: { supported_pages: 0, unsupported_pages: 0, ignored_entries: 0, directory_records: 0 } } })
    }).pipe(Effect.provide(storage)))

    await Effect.runPromise(Effect.gen(function*() {
      const scans = yield* ScanStore
      yield* scans.recoverInterrupted()
      expect(yield* scans.readTask(taskId)).toMatchObject({ status: "interrupted", hold_new_discoveries: true })
      expect(yield* scans.listStaged()).toMatchObject([{ candidate_id: candidateId, hold_state: "held",
        relative_path: "unavailable.cbz", analysis_error: { code: "source-unavailable" } }])
    }).pipe(Effect.provide(storage)))
  } finally {
    await cleanupTempDb(dbPath)
  }
})
