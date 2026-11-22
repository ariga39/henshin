import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import type { ScanTask, StagedDiscovery } from "@henshin/contracts"
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
      stage: () => Effect.fail(new DatabaseWorkerError({
        message: "scan task no longer matches the current root mapping or policy"
      })),
      publishNormal: () => Effect.die("unused test store operation"),
      releaseHeld: () => Effect.die("unused test store operation"),
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
        code: "root_policy_changed",
        message: "scan stopped because the saved root mapping or policy changed while it was running. Retry the scan to continue with the current root settings."
      },
      readinessError: null
    })
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

it("requires matching observations across the quiet interval before normal publication", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-normal-scan-quiet-"))
  try {
    const book = path.join(fixture, "book")
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "source page")
    const canonicalPath = await realpath(fixture)
    const identity = await stat(canonicalPath)
    const rootId = randomUUID()
    const taskId = randomUUID()
    const root: ServerRootRow = {
      libraryId: randomUUID(), rootId, label: "Books", selectedPath: fixture, canonicalPath,
      device: String(identity.dev), inode: String(identity.ino), mappingRevision: "1", policyRevision: "0",
      exclusions: [], state: "active"
    }
    const task: ScanTask = {
      task_id: taskId, root_id: rootId, kind: "manual-scan", mode: "manual", hold_new_discoveries: false,
      mapping_revision: "1", status: "queued", directories_visited: 0, candidates_discovered: 0,
      candidates_analyzed: 0, analysis_error_count: 0, review_needed_count: 0, coverage: null,
      readiness_error: null, error: null, created_at_ms: Date.now(), updated_at_ms: Date.now()
    }

    let terminal: FinishScanInput | undefined
    let stageCount = 0
    const staged = new Map<string, StagedDiscovery>()
    let publishedPaths: ReadonlyArray<string> | undefined
    const unused = () => Effect.die("unused test store operation")
    const store: ScanStore["Service"] = {
      start: unused,
      listTasks: unused,
      readTask: unused,
      listStaged: () => Effect.succeed([...staged.values()]),
      recordDiscovery: () => Effect.succeed(undefined),
      markRunning: () => Effect.succeed(undefined),
      stage: (input) => Effect.sync(() => {
        stageCount += 1
        staged.set(input.relativePath, {
          candidate_id: randomUUID(), task_id: input.taskId, root_id: input.rootId,
          relative_path: input.relativePath, kind: input.kind, candidate_version: stageCount,
          hold_state: input.holdState, analysis_status: input.analysisStatus, manifest: input.manifest,
          analysis_error: input.analysisError, updated_at_ms: Date.now()
        })
        if (stageCount === 1) void writeFile(path.join(book, "002.jpg"), "new page")
      }),
      publishNormal: (input) => Effect.sync(() => {
        publishedPaths = input.observedCandidatePaths
        return { kind: "published" as const }
      }),
      releaseHeld: () => Effect.die("unused test store operation"),
      finish: (input) => Effect.sync(() => {
        terminal = input
      }),
      recoverInterrupted: () => Effect.succeed(undefined)
    }

    await Effect.runPromise(
      runManualHeldScan(task, root).pipe(Effect.provide(Layer.succeed(ScanStore, store)))
    )

    expect(publishedPaths).toEqual([])
    expect(terminal).toMatchObject({
      status: "completed_with_errors",
      reviewNeededCount: 1,
      error: { code: "unstable_observation" },
      readinessError: null
    })
    expect(staged.get("book")?.manifest?.pages).toHaveLength(2)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
