import { Effect, Layer } from "effect"
import type {
  RootCommandIpcRequest,
  RootPreviewResult,
  ScanTask,
  ServerRoot,
  StagedDiscovery
} from "@henshin/contracts"
import { afterEach, describe, expect, it } from "vitest"
import { LibraryClient, RootPreviewClient, ScanReviewClient, type Result } from "../../desktop/src/renderer/client"
import {
  loadRootWorkspace,
  loadLibrary,
  retryScanResults,
  startManualScan,
  startHeldScan,
  watchHeldScans
} from "../../desktop/src/renderer/workflows"
import { viewStore } from "../../desktop/src/renderer/store"

const instanceId = "11111111-1111-4111-8111-111111111111"
const epoch = "22222222-2222-4222-8222-222222222222"
const root: ServerRoot = {
  library_id: "33333333-3333-4333-8333-333333333333",
  root_id: "44444444-4444-4444-8444-444444444444",
  label: "Books",
  selected_server_path: "/collections/books",
  canonical_server_path: "/collections/books",
  mapping_revision: "3",
  policy_revision: "7",
  exclusions: [],
  state: "active"
}

const preview: Extract<RootPreviewResult, { kind: "saved-root-discovery" }> = {
  kind: "saved-root-discovery",
  root_id: root.root_id,
  selected_server_path: root.selected_server_path,
  instance_id: instanceId,
  epoch,
  policy_revision: "6",
  candidates: [],
  sample_limit: 32,
  unassigned_loose_images: [],
  unassigned_loose_image_count: 0,
  unsupported_loose_images: [],
  unsupported_loose_image_count: 0,
  coverage: {
    status: "complete",
    directories_visited: 1,
    entries_observed: 0,
    candidate_count: 0,
    candidate_sample_truncated: false,
    excluded_links: [],
    excluded_link_count: 0,
    unsupported_names: [],
    unsupported_name_count: 0,
    unsupported_directories: [],
    unsupported_directory_count: 0,
    issues: [],
    issue_count: 0
  }
}

const task = (status: ScanTask["status"]): ScanTask => ({
  task_id: "55555555-5555-4555-8555-555555555555",
  root_id: root.root_id,
  kind: "manual-scan",
  mode: "manual",
  hold_new_discoveries: true,
  mapping_revision: root.mapping_revision,
  status,
  directories_visited: 0,
  candidates_discovered: 0,
  candidates_analyzed: 0,
  analysis_error_count: 0,
  review_needed_count: 0,
  coverage: null,
  readiness_error: null,
  error: null,
  created_at_ms: 1,
  updated_at_ms: 1
})

const candidate: StagedDiscovery = {
  candidate_id: "66666666-6666-4666-8666-666666666666",
  task_id: task("succeeded").task_id,
  root_id: root.root_id,
  relative_path: "book",
  kind: "image-directory",
  candidate_version: 1,
  hold_state: "held",
  analysis_status: "ready",
  manifest: null,
  analysis_error: null,
  updated_at_ms: 1
}

const scanError = { ok: false as const, error: { code: "transport", message: "candidate reply lost", retryable: true } }

const resetView = () => {
  viewStore.set({
    root_preview_path: "",
    root_preview_selected_path: null,
    root_preview_status: "idle",
    root_preview: null,
    root_preview_request: null,
    root_preview_error: null,
    root_saved_roots: [],
    root_roots_status: "idle",
    root_roots_error: null,
    scan_tasks: [],
    staged_discoveries: [],
    scan_status: "idle",
    scan_error: null,
    scan_start_status: "idle",
    scan_start_error: null,
    scan_hold_new_discoveries: false,
    screen: "setup",
    library_entries: [],
    library_cursor: null,
    library_has_more: false,
    library_status: "idle",
    library_error: null,
    library_scan_status: "idle",
    library_scan_error: null,
    library_scan_task: null
  })
}

afterEach(resetView)

const run = <A>(
  effect: Effect.Effect<A, unknown, RootPreviewClient | ScanReviewClient | LibraryClient>,
  rootClient: RootPreviewClient["Service"],
  scanClient: ScanReviewClient["Service"],
  libraryClient: LibraryClient["Service"] = libraryClientWith()
) => Effect.runPromise(Effect.provide(
  effect,
  Layer.mergeAll(
    Layer.succeed(RootPreviewClient, rootClient),
    Layer.succeed(ScanReviewClient, scanClient),
    Layer.succeed(LibraryClient, libraryClient)
  )
))

const rootClientWith = (overrides: Partial<RootPreviewClient["Service"]> = {}): RootPreviewClient["Service"] => RootPreviewClient.of({
  preview: () => Effect.succeed({ ok: true, data: preview }),
  list: () => Effect.succeed({ ok: true, data: [root] }),
  save: () => Effect.succeed({ ok: true, data: root }),
  command: () => Effect.succeed({ ok: true, data: root }),
  ...overrides
})

const scanClientWith = (overrides: Partial<ScanReviewClient["Service"]> = {}): ScanReviewClient["Service"] => ScanReviewClient.of({
  listTasks: () => Effect.succeed({ ok: true, data: [] }),
  candidates: () => Effect.succeed({ ok: true, data: [] }),
  ...overrides
})

function libraryClientWith(overrides: Partial<LibraryClient["Service"]> = {}): LibraryClient["Service"] {
  return LibraryClient.of({
    search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "0" } }),
    ...overrides
  })
}

describe("held scan renderer workflows", () => {
  it("starts from the policy revision observed by the saved-root preview", async () => {
    let commandInput: RootCommandIpcRequest | undefined
    const submitted = task("succeeded")
    const rootClient = rootClientWith({
      command: (input) => {
        commandInput = input
        return Effect.succeed({ ok: true, data: { task: submitted } })
      }
    })
    viewStore.set({
      root_preview_status: "ready",
      root_preview: preview,
      root_saved_roots: [root],
      scan_hold_new_discoveries: true
    })

    await run(startHeldScan(root.root_id), rootClient, scanClientWith({ listTasks: () => Effect.succeed({ ok: true, data: [submitted] }) }))

    expect(commandInput).toMatchObject({
      expected_mapping_revision: root.mapping_revision,
      expected_policy_revision: preview.policy_revision
    })
  })

  it("refreshes roots only for a revision conflict and leaves active-scan context selected", async () => {
    const currentRoot = { ...root, policy_revision: "8" }
    let listCalls = 0
    const revisionClient = rootClientWith({
      list: () => {
        listCalls += 1
        return Effect.succeed({ ok: true, data: [currentRoot] })
      },
      command: () => Effect.succeed({
        ok: false,
        error: { code: "revision_conflict", message: "saved root policy changed", retryable: false, current_revision: "8" }
      })
    })
    viewStore.set({
      root_preview_status: "ready",
      root_preview: preview,
      root_saved_roots: [root],
      scan_hold_new_discoveries: true
    })
    await run(startHeldScan(root.root_id), revisionClient, scanClientWith())

    expect(listCalls).toBe(1)
    expect(viewStore.getState().root_saved_roots).toEqual([currentRoot])
    expect(viewStore.getState().root_preview).toBe(preview)

    listCalls = 0
    const activeClient = rootClientWith({
      list: () => {
        listCalls += 1
        return Effect.succeed({ ok: true, data: [currentRoot] })
      },
      command: () => Effect.succeed({
        ok: false,
        error: { code: "active_scan_conflict", message: "A scan with different settings is already running. Retry when it finishes.", retryable: true }
      })
    })
    viewStore.set({ root_saved_roots: [root], scan_start_status: "idle", scan_hold_new_discoveries: true })
    await run(startHeldScan(root.root_id), activeClient, scanClientWith())

    expect(listCalls).toBe(0)
    expect(viewStore.getState().root_preview).toBe(preview)
    expect(viewStore.getState().scan_start_error).toContain("Retry when it finishes")
  })

  it("publishes fetched tasks, stops after candidate failure, and retries from startup", async () => {
    let taskCalls = 0
    let candidateCalls = 0
    const active = task("running")
    const completed = task("succeeded")
    const scanClient = scanClientWith({
      listTasks: () => {
        taskCalls += 1
        return Effect.succeed({ ok: true, data: taskCalls === 1 ? [active] : [completed] })
      },
      candidates: () => {
        candidateCalls += 1
        return candidateCalls === 1
          ? Effect.succeed(scanError)
          : Effect.succeed({ ok: true, data: [candidate] })
      }
    })

    await run(loadRootWorkspace, rootClientWith(), scanClient)
    expect(viewStore.getState()).toMatchObject({
      scan_tasks: [active],
      scan_status: "error",
      scan_error: "candidate reply lost"
    })
    expect(taskCalls).toBe(1)

    await run(retryScanResults, rootClientWith(), scanClient)
    expect(viewStore.getState()).toMatchObject({
      scan_tasks: [completed],
      staged_discoveries: [candidate],
      scan_status: "ready",
      scan_error: null
    })
    expect(taskCalls).toBe(2)
  })

  it("shares one watcher when startup and scan admission observe the same active task", async () => {
    let taskCalls = 0
    const active = task("running")
    const completed = task("succeeded")
    const scanClient = scanClientWith({
      listTasks: () => {
        taskCalls += 1
        return Effect.succeed({ ok: true, data: taskCalls === 1 ? [active] : [completed] })
      }
    })
    const first = run(watchHeldScans, rootClientWith(), scanClient)
    const second = run(watchHeldScans, rootClientWith(), scanClient)
    await Promise.all([first, second])

    expect(taskCalls).toBe(2)
    expect(viewStore.getState().scan_tasks).toEqual([completed])
  })

  it("surfaces normal scan result-load failure instead of waiting forever", async () => {
    const submitted = { ...task("running"), hold_new_discoveries: false }
    const rootClient = rootClientWith({
      command: () => Effect.succeed({ ok: true, data: { task: submitted } })
    })
    viewStore.set({
      root_preview_status: "ready",
      root_preview: preview,
      root_saved_roots: [root],
      scan_hold_new_discoveries: false
    })

    await run(startManualScan(root.root_id), rootClient, scanClientWith({ listTasks: () => Effect.succeed(scanError) }))

    expect(viewStore.getState()).toMatchObject({
      screen: "library",
      scan_start_status: "error",
      library_scan_status: "error",
      library_scan_error: "candidate reply lost",
      library_status: "ready"
    })
  })

  it("clears the Library loading state when normal scan admission fails", async () => {
    const rootClient = rootClientWith({
      command: () => Effect.succeed({
        ok: false as const,
        error: { code: "active_scan_conflict", message: "scan is already running", retryable: true }
      })
    })
    viewStore.set({
      root_preview_status: "ready",
      root_preview: preview,
      root_saved_roots: [root],
      scan_hold_new_discoveries: false
    })

    await run(startManualScan(root.root_id), rootClient, scanClientWith())

    expect(viewStore.getState()).toMatchObject({
      scan_start_status: "error",
      library_scan_status: "error",
      library_scan_error: "scan is already running",
      library_status: "ready"
    })
  })

  it("reports a submitted normal task that disappears from scan results", async () => {
    const submitted = { ...task("running"), hold_new_discoveries: false }
    const rootClient = rootClientWith({
      command: () => Effect.succeed({ ok: true, data: { task: submitted } })
    })
    viewStore.set({
      root_preview_status: "ready",
      root_preview: preview,
      root_saved_roots: [root],
      scan_hold_new_discoveries: false
    })

    await run(startManualScan(root.root_id), rootClient, scanClientWith())

    expect(viewStore.getState()).toMatchObject({
      scan_start_status: "error",
      library_scan_status: "error",
      library_scan_error: "submitted scan task was not found in scan results",
      library_status: "ready"
    })
  })

  it("keeps partial normal completion successful while preserving library fetch errors", async () => {
    const partial = {
      ...task("completed_with_errors"),
      hold_new_discoveries: false,
      error: { code: "analysis_error", message: "one discovery could not be analyzed" }
    }
    const rootClient = rootClientWith({
      command: () => Effect.succeed({ ok: true, data: { task: partial } })
    })
    viewStore.set({
      root_preview_status: "ready",
      root_preview: preview,
      root_saved_roots: [root],
      scan_hold_new_discoveries: false
    })

    await run(
      startManualScan(root.root_id),
      rootClient,
      scanClientWith({ listTasks: () => Effect.succeed({ ok: true, data: [partial] }) }),
      libraryClientWith({ search: () => Effect.succeed({ ok: false, error: { code: "library_unavailable", message: "library read failed", retryable: true } }) })
    )

    expect(viewStore.getState()).toMatchObject({
      scan_start_status: "idle",
      scan_start_error: null,
      library_scan_status: "started",
      library_scan_error: null,
      library_status: "error",
      library_error: "library read failed"
    })
  })

  it("surfaces a terminal normal scan failure separately from Library loading", async () => {
    const failed = {
      ...task("failed"),
      hold_new_discoveries: false,
      readiness_error: { code: "policy_changed", message: "saved root policy changed during scan" }
    }
    const rootClient = rootClientWith({
      command: () => Effect.succeed({ ok: true, data: { task: failed } })
    })
    viewStore.set({
      root_preview_status: "ready",
      root_preview: preview,
      root_saved_roots: [root],
      scan_hold_new_discoveries: false
    })

    await run(
      startManualScan(root.root_id),
      rootClient,
      scanClientWith({ listTasks: () => Effect.succeed({ ok: true, data: [failed] }) })
    )

    expect(viewStore.getState()).toMatchObject({
      scan_start_status: "error",
      scan_start_error: "saved root policy changed during scan",
      library_scan_status: "error",
      library_scan_error: "saved root policy changed during scan",
      library_status: "ready"
    })
  })

  it("does not navigate when loading Library data", async () => {
    viewStore.set({ screen: "setup" })
    await run(loadLibrary(), rootClientWith(), scanClientWith())
    expect(viewStore.getState().screen).toBe("setup")
  })
})
