import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import type { ScanTask } from "@henshin/contracts"
import { DatabaseWorkerError } from "../src/persistence/DatabaseWorker"
import { ScanStore, type FinishScanInput } from "../src/persistence/ScanStore"
import { runManualHeldScan } from "../src/scan/ManualScanCoordinator"
import type { ServerRootRow } from "../src/persistence/worker-protocol"

it("finishes a scan with an actionable failure while preserving progress", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-held-scan-failure-"))
  try {
    const book = path.join(fixture, "book")
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "source page")
    const canonicalPath = await realpath(fixture)
    const identity = await stat(canonicalPath)
    const rootId = randomUUID()
    const taskId = randomUUID()
    const root: ServerRootRow = {
      libraryId: randomUUID(),
      rootId,
      label: "Books",
      selectedPath: fixture,
      canonicalPath,
      device: String(identity.dev),
      inode: String(identity.ino),
      mappingRevision: "1",
      policyRevision: "0",
      exclusions: [],
      state: "active"
    }
    const task: ScanTask = {
      task_id: taskId,
      root_id: rootId,
      kind: "manual-scan",
      mode: "manual",
      hold_new_discoveries: true,
      mapping_revision: "1",
      status: "queued",
      directories_visited: 0,
      candidates_discovered: 0,
      candidates_analyzed: 0,
      analysis_error_count: 0,
      review_needed_count: 0,
      coverage: null,
      readiness_error: null,
      error: null,
      created_at_ms: Date.now(),
      updated_at_ms: Date.now()
    }

    let terminal: FinishScanInput | undefined
    const unused = () => Effect.die("unused test store operation")
    const store: ScanStore["Service"] = {
      start: unused,
      listTasks: unused,
      readTask: unused,
      listStaged: unused,
      recordDiscovery: () => Effect.succeed(undefined),
      markRunning: () => Effect.succeed(undefined),
      stage: () => Effect.fail(new DatabaseWorkerError({ message: "staging store unavailable" })),
      finish: (input) => Effect.sync(() => {
        terminal = input
      }),
      recoverInterrupted: () => Effect.succeed(undefined)
    }

    await Effect.runPromise(
      runManualHeldScan(task, root).pipe(Effect.provide(Layer.succeed(ScanStore, store)))
    )

    expect(terminal).toMatchObject({
      taskId,
      status: "failed",
      directoriesVisited: 2,
      candidatesDiscovered: 1,
      candidatesAnalyzed: 0,
      analysisErrorCount: 0,
      reviewNeededCount: 0,
      error: {
        code: "scan_failed",
        message: "scan failed unexpectedly; staged discoveries and progress were preserved. Check server diagnostics, resolve the underlying issue, and retry the scan."
      },
      readinessError: null
    })
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
