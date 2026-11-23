import { Effect, Layer } from "effect"
import type {
  LibraryEntry,
  LibraryEntryPage,
  RootCommandIpcRequest,
  RootPreviewResult,
  ScanTask,
  ServerRoot,
  StagedDiscovery
} from "@henshin/contracts"
import { afterEach, describe, expect, it } from "vitest"
import { LibraryClient, LocalMappingClient, RootPreviewClient, ScanReviewClient, type Result } from "../../desktop/src/renderer/client"
import {
  loadRootWorkspace,
  loadLibrary,
  loadPendingReplacements,
  refreshReplacementReview,
  retryScanResults,
  releaseHeldDiscovery,
  resolveReplacement,
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

const task = (status: ScanTask["status"], taskId = "55555555-5555-4555-8555-555555555555"): ScanTask => ({
  task_id: taskId,
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

const replacementManifest = {
  source_kind: "directory" as const,
  pages: [{ name: "001.jpg", format: "jpeg", declared_bytes: 1 }],
  diagnostics: { supported_pages: 1, unsupported_pages: 0, ignored_entries: 0, directory_records: 1 },
  before: { kind: "directory" as const, bytes: 1, mtime_ms: 1, entry_count: 1 },
  after: { kind: "directory" as const, bytes: 1, mtime_ms: 1, entry_count: 1 }
}

const pendingEntry = (candidateVersion: number): LibraryEntry => ({
  entry_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  library_id: root.library_id,
  root_id: root.root_id,
  relative_path: candidate.relative_path,
  source_path: "/collections/books/book",
  kind: "image-directory",
  title: "book",
  page_count: 1,
  state: "replacement-pending",
  content_version: "1",
  location_revision: "1",
  match_fields: [],
  cover: null,
  replacement: {
    candidate_id: candidate.candidate_id,
    candidate_version: candidateVersion,
    decision_version: "1",
    old_observation: {
      kind: "image-directory",
      page_count: 1,
      format_evidence: ["jpeg"],
      size_bytes: 1,
      entry_count: 1,
      diagnostics: replacementManifest.diagnostics
    },
    candidate_observation: {
      kind: "image-directory",
      page_count: 1,
      format_evidence: ["jpeg"],
      size_bytes: 1,
      entry_count: 1,
      diagnostics: replacementManifest.diagnostics,
      analysis_status: "ready",
      analysis_error: null
    }
  }
})

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
    scan_release_status: "idle",
    scan_release_candidate_id: null,
    scan_release_root_id: null,
    scan_release_operation_id: null,
    scan_release_candidate_version: null,
    scan_release_mapping_revision: null,
    scan_release_policy_revision: null,
    scan_release_error: null,
    scan_hold_new_discoveries: false,
    screen: "setup",
    library_entries: [],
    library_cursor: null,
    library_has_more: false,
    library_status: "idle",
    library_error: null,
    library_cover_generation: 0,
    pending_replacement_entries: [],
    pending_replacement_cursor: null,
    pending_replacement_has_more: false,
    pending_replacement_status: "idle",
    pending_replacement_error: null,
    library_scan_status: "idle",
    library_scan_error: null,
    library_scan_task: null
  })
}

afterEach(resetView)

const run = <A>(
  effect: Effect.Effect<A, unknown, RootPreviewClient | ScanReviewClient | LibraryClient | LocalMappingClient>,
  rootClient: RootPreviewClient["Service"],
  scanClient: ScanReviewClient["Service"],
  libraryClient: LibraryClient["Service"] = libraryClientWith(),
  localMappingClient: LocalMappingClient["Service"] = localMappingClientWith()
) => Effect.runPromise(Effect.provide(
  effect,
  Layer.mergeAll(
    Layer.succeed(RootPreviewClient, rootClient),
    Layer.succeed(ScanReviewClient, scanClient),
    Layer.succeed(LibraryClient, libraryClient),
    Layer.succeed(LocalMappingClient, localMappingClient)
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
  release: () => Effect.succeed({ ok: true, data: {
    operation_id: "77777777-7777-4777-8777-777777777777",
    candidate: { ...candidate, candidate_version: 2, hold_state: "eligible" }
  } }),
  resolve: () => Effect.succeed({ ok: false as const, error: {
    code: "not_found", message: "replacement not found", retryable: false
  } }),
  ...overrides
})

function libraryClientWith(overrides: Partial<LibraryClient["Service"]> = {}): LibraryClient["Service"] {
  return LibraryClient.of({
    search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "0" } }),
    getThumbnail: () => Effect.succeed({ ok: false as const, error: { code: "thumbnail_missing", message: "not used", retryable: false } }),
    ...overrides
  })
}

const localMappingClientWith = (overrides: Partial<LocalMappingClient["Service"]> = {}): LocalMappingClient["Service"] =>
  LocalMappingClient.of({
    preview: () => Effect.succeed({ ok: true as const, data: null }),
    list: () => Effect.succeed({ ok: true as const, data: [] }),
    activate: () => Effect.succeed({ ok: false as const, error: { code: "not_used", message: "not used", retryable: false } }),
    ...overrides
  })

describe("held scan renderer workflows", () => {
  it("releases one held discovery using the current candidate and root fences", async () => {
    let releaseInput: Parameters<ScanReviewClient["Service"]["release"]>[0] | undefined
    const released = { ...candidate, candidate_version: 2, hold_state: "eligible" as const }
    const scanClient = scanClientWith({
      release: (input) => {
        releaseInput = input
        return Effect.succeed({ ok: true, data: {
          operation_id: input.operation_id,
          candidate: released
        } })
      }
    })
    viewStore.set({ root_saved_roots: [root], staged_discoveries: [candidate], scan_status: "ready" })

    await run(releaseHeldDiscovery(candidate.candidate_id), rootClientWith(), scanClient)

    expect(releaseInput).toMatchObject({
      candidate_id: candidate.candidate_id,
      root_id: root.root_id,
      expected_candidate_version: candidate.candidate_version,
      expected_mapping_revision: root.mapping_revision,
      expected_policy_revision: root.policy_revision,
      command: { type: "release-hold" }
    })
    expect(viewStore.getState().staged_discoveries).toEqual([released])
    expect(viewStore.getState().scan_release_status).toBe("idle")
    expect(viewStore.getState().scan_release_operation_id).toBeNull()
  })

  it("uses a fresh operation after a released candidate is held again", async () => {
    const releaseInputs: Array<Parameters<ScanReviewClient["Service"]["release"]>[0]> = []
    const scanClient = scanClientWith({
      release: (input) => {
        releaseInputs.push(input)
        return Effect.succeed({ ok: true, data: {
          operation_id: input.operation_id,
          candidate: {
            ...candidate,
            candidate_version: 2,
            hold_state: "eligible" as const
          }
        } })
      }
    })
    viewStore.set({ root_saved_roots: [root], staged_discoveries: [candidate], scan_status: "ready" })

    await run(releaseHeldDiscovery(candidate.candidate_id), rootClientWith(), scanClient)
    const reheld = { ...candidate, candidate_version: 3, hold_state: "held" as const }
    viewStore.set({ staged_discoveries: [reheld] })
    await run(releaseHeldDiscovery(candidate.candidate_id), rootClientWith(), scanClient)

    expect(releaseInputs).toHaveLength(2)
    expect(releaseInputs[1]).toMatchObject({
      expected_candidate_version: reheld.candidate_version,
      expected_mapping_revision: root.mapping_revision,
      expected_policy_revision: root.policy_revision
    })
    expect(releaseInputs[1]?.operation_id).not.toBe(releaseInputs[0]?.operation_id)
  })

  it("retries an unknown release outcome only while the command is identical", async () => {
    const releaseInputs: Array<Parameters<ScanReviewClient["Service"]["release"]>[0]> = []
    let calls = 0
    const scanClient = scanClientWith({
      release: (input) => {
        releaseInputs.push(input)
        calls += 1
        return calls <= 2
          ? Effect.succeed(scanError)
          : Effect.succeed({ ok: true, data: {
              operation_id: input.operation_id,
              candidate: { ...candidate, candidate_version: 2, hold_state: "eligible" as const }
            } })
      }
    })
    viewStore.set({ root_saved_roots: [root], staged_discoveries: [candidate], scan_status: "ready" })

    await run(releaseHeldDiscovery(candidate.candidate_id), rootClientWith(), scanClient)
    await run(releaseHeldDiscovery(candidate.candidate_id), rootClientWith(), scanClient)

    expect(releaseInputs[1]).toEqual(releaseInputs[0])

    const changedCandidate = { ...candidate, candidate_version: 2, hold_state: "held" as const }
    viewStore.set({ staged_discoveries: [changedCandidate] })
    await run(releaseHeldDiscovery(candidate.candidate_id), rootClientWith(), scanClient)

    expect(releaseInputs[2]?.operation_id).not.toBe(releaseInputs[0]?.operation_id)
    expect(releaseInputs[2]?.expected_candidate_version).toBe(changedCandidate.candidate_version)
  })

  it("retains a definite release failure after refresh removes the candidate", async () => {
    const scanClient = scanClientWith({
      candidates: () => Effect.succeed({ ok: true, data: [] }),
      release: () => Effect.succeed({
        ok: false,
        error: {
          code: "revision_conflict",
          message: "discovery changed; refresh Review before releasing it",
          retryable: false,
          current_revision: "2"
        }
      })
    })
    viewStore.set({ root_saved_roots: [root], staged_discoveries: [candidate], scan_status: "ready" })

    await run(releaseHeldDiscovery(candidate.candidate_id), rootClientWith(), scanClient)

    expect(viewStore.getState()).toMatchObject({
      scan_release_status: "error",
      scan_release_candidate_id: candidate.candidate_id,
      scan_release_error: "discovery changed; refresh Review before releasing it",
      staged_discoveries: []
    })
  })

  it("stores reconnect guidance and permits a successful second release", async () => {
    const releaseInputs: Array<Parameters<ScanReviewClient["Service"]["release"]>[0]> = []
    let calls = 0
    const released = { ...candidate, candidate_version: 2, hold_state: "eligible" as const }
    const scanClient = scanClientWith({
      release: (input) => {
        releaseInputs.push(input)
        calls += 1
        return calls === 1
          ? Effect.succeed({
              ok: false,
              error: { code: "epoch_changed", message: "authority epoch changed", retryable: true }
            })
          : Effect.succeed({ ok: true, data: { operation_id: input.operation_id, candidate: released } })
      }
    })
    viewStore.set({ root_saved_roots: [root], staged_discoveries: [candidate], scan_status: "ready" })

    await run(releaseHeldDiscovery(candidate.candidate_id), rootClientWith(), scanClient)
    expect(viewStore.getState().scan_release_error).toBe("authority epoch changed. Reconnect before retrying the release.")

    await run(releaseHeldDiscovery(candidate.candidate_id), rootClientWith(), scanClient)

    expect(releaseInputs[1]?.operation_id).not.toBe(releaseInputs[0]?.operation_id)
    expect(viewStore.getState()).toMatchObject({
      scan_release_status: "idle",
      scan_release_error: null,
      staged_discoveries: [released]
    })
  })

  it("clears unknown release feedback when fresh results show the target released", async () => {
    const scanClient = scanClientWith({ release: () => Effect.succeed(scanError) })
    viewStore.set({ root_saved_roots: [root], staged_discoveries: [candidate], scan_status: "ready" })

    await run(releaseHeldDiscovery(candidate.candidate_id), rootClientWith(), scanClient)
    const released = { ...candidate, candidate_version: 2, hold_state: "eligible" as const }
    const refreshedScanClient = scanClientWith({
      candidates: () => Effect.succeed({ ok: true, data: [released] })
    })
    await run(retryScanResults, rootClientWith(), refreshedScanClient)

    expect(viewStore.getState()).toMatchObject({
      scan_release_status: "idle",
      scan_release_candidate_id: null,
      scan_release_operation_id: null,
      scan_release_error: null,
      staged_discoveries: [released]
    })
  })

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

  it("lets a normal scan finish while the shared watcher tracks another task", async () => {
    const heldActive = task("running", "77777777-7777-4777-8777-777777777777")
    const heldCompleted = { ...heldActive, status: "succeeded" as const }
    const normalSubmitted = {
      ...task("queued", "88888888-8888-4888-8888-888888888888"),
      hold_new_discoveries: false
    }
    const normalCompleted = { ...normalSubmitted, status: "succeeded" as const }
    let taskCalls = 0
    let releaseHeld!: () => void
    const heldRelease = new Promise<void>((resolve) => { releaseHeld = resolve })
    let firstPoll!: () => void
    const firstPollStarted = new Promise<void>((resolve) => { firstPoll = resolve })
    const scanClient = scanClientWith({
      listTasks: () => Effect.promise(async () => {
        taskCalls += 1
        if (taskCalls === 1) {
          firstPoll()
          return { ok: true as const, data: [heldActive] }
        }
        if (taskCalls === 2) return { ok: true as const, data: [heldActive, normalCompleted] }
        await heldRelease
        return { ok: true as const, data: [heldCompleted, normalCompleted] }
      })
    })
    viewStore.set({
      root_preview_status: "ready",
      root_preview: preview,
      root_saved_roots: [root],
      scan_hold_new_discoveries: false
    })

    const heldRun = run(watchHeldScans, rootClientWith(), scanClient)
    await firstPollStarted
    const normalRun = run(
      startManualScan(root.root_id),
      rootClientWith({ command: () => Effect.succeed({ ok: true, data: { task: normalSubmitted } }) }),
      scanClient
    )

    await normalRun
    expect(viewStore.getState()).toMatchObject({
      library_scan_status: "started",
      library_scan_task: normalCompleted
    })
    releaseHeld()
    await heldRun
    expect(taskCalls).toBe(3)
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
      library_scan_error: "one discovery could not be analyzed",
      library_scan_task: partial,
      library_status: "error",
      library_error: "library read failed"
    })
  })

  it("surfaces interrupted normal completion after refreshing accepted results", async () => {
    const interrupted = {
      ...task("interrupted"),
      hold_new_discoveries: false,
      error: { code: "scan_interrupted", message: "scan interrupted by server restart" }
    }
    const rootClient = rootClientWith({
      command: () => Effect.succeed({ ok: true, data: { task: interrupted } })
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
      scanClientWith({ listTasks: () => Effect.succeed({ ok: true, data: [interrupted] }) })
    )

    expect(viewStore.getState()).toMatchObject({
      scan_start_status: "error",
      scan_start_error: "scan interrupted by server restart",
      library_scan_status: "error",
      library_scan_error: "scan interrupted by server restart",
      library_scan_task: interrupted
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

  it("keeps visible Library entries when a refresh fails and appends pages without duplicates", async () => {
    const existing = {
      entry_id: "99999999-9999-4999-8999-999999999999",
      library_id: root.library_id,
      root_id: root.root_id,
      relative_path: "existing",
      title: "Existing",
      cover: null,
      source_path: "/collections/existing",
      kind: "image-directory" as const,
      page_count: 1,
      state: "accepted" as const,
      content_version: "1",
      location_revision: "1",
      match_fields: [],
      replacement: null
    }
    const appended = {
      ...existing,
      entry_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Appended",
      source_path: "/collections/appended"
    }
    let calls = 0
    const libraryClient = libraryClientWith({
      search: () => {
        calls += 1
        if (calls === 1) return Effect.succeed({ ok: true as const, data: { entries: [existing], has_more: true, next_cursor: "next", library_change_revision: "1" } })
        if (calls === 2) return Effect.succeed({ ok: false as const, error: { code: "library_unavailable", message: "refresh failed", retryable: true } })
        return Effect.succeed({ ok: true as const, data: { entries: [existing, appended], has_more: false, next_cursor: null, library_change_revision: "2" } })
      }
    })

    await run(loadLibrary(), rootClientWith(), scanClientWith(), libraryClient)
    expect(viewStore.getState().library_cover_generation).toBe(1)
    await run(loadLibrary(), rootClientWith(), scanClientWith(), libraryClient)
    expect(viewStore.getState()).toMatchObject({
      library_status: "error",
      library_error: "refresh failed",
      library_entries: [existing],
      library_cover_generation: 1
    })

    await run(loadLibrary(true), rootClientWith(), scanClientWith(), libraryClient)
    expect(viewStore.getState()).toMatchObject({
      library_status: "ready",
      library_entries: [existing, appended],
      library_has_more: false,
      library_cursor: null,
      library_cover_generation: 1
    })
  })

  it("refreshes stale replacement evidence without retrying the decision and clears the obsolete error", async () => {
    const staleCandidate = { ...candidate, manifest: replacementManifest }
    const freshCandidate = { ...staleCandidate, candidate_version: 2 }
    const staleEntry = pendingEntry(0)
    const freshEntry = pendingEntry(2)
    let resolveCalls = 0
    const scanClient = scanClientWith({
      candidates: () => Effect.succeed({ ok: true, data: [freshCandidate] }),
      resolve: () => {
        resolveCalls += 1
        return Effect.succeed({ ok: false as const, error: { code: "unexpected", message: "must not retry", retryable: false } })
      }
    })
    const libraryClient = libraryClientWith({
      search: (input) => {
        expect(input.state).toBe("replacement-pending")
        return Effect.succeed({ ok: true as const, data: {
          entries: [freshEntry], has_more: false, next_cursor: null, library_change_revision: "2"
        } })
      }
    })
    viewStore.set({
      root_saved_roots: [root],
      staged_discoveries: [staleCandidate],
      pending_replacement_entries: [staleEntry],
      pending_replacement_status: "ready",
      scan_status: "ready"
    })

    await run(resolveReplacement(candidate.candidate_id, staleEntry.entry_id, "keep"), rootClientWith(), scanClient, libraryClient)

    expect(resolveCalls).toBe(0)
    expect(viewStore.getState()).toMatchObject({
      staged_discoveries: [freshCandidate],
      pending_replacement_entries: [freshEntry],
      scan_resolution_status: "idle",
      scan_resolution_error: null,
      scan_resolution_entry_id: null
    })
  })

  it("keeps rescan guidance after an unchanged fresh-observation conflict", async () => {
    const reviewCandidate = { ...candidate, manifest: replacementManifest }
    const conflictMessage = "replacement source changed since Review; rescan and refresh Review before resolving it"
    let resolveCalls = 0
    const scanClient = scanClientWith({
      candidates: () => Effect.succeed({ ok: true, data: [reviewCandidate] }),
      resolve: () => {
        resolveCalls += 1
        return Effect.succeed({ ok: false as const, error: {
          code: "revision_conflict", message: conflictMessage, retryable: false
        } })
      }
    })
    viewStore.set({
      root_saved_roots: [root],
      staged_discoveries: [reviewCandidate],
      pending_replacement_entries: [pendingEntry(1)],
      pending_replacement_status: "ready",
      scan_status: "ready"
    })

    await run(resolveReplacement(candidate.candidate_id, pendingEntry(1).entry_id, "keep"), rootClientWith(), scanClient, libraryClientWith({
      search: () => Effect.succeed({ ok: true as const, data: {
        entries: [pendingEntry(1)], has_more: false, next_cursor: null, library_change_revision: "1"
      } })
    }))

    expect(resolveCalls).toBe(1)
    expect(viewStore.getState()).toMatchObject({
      scan_resolution_status: "error",
      scan_resolution_error: conflictMessage,
      scan_resolution_entry_id: pendingEntry(1).entry_id
    })
  })

  it("keeps refresh guidance after an unchanged policy conflict", async () => {
    const reviewCandidate = { ...candidate, manifest: replacementManifest }
    const currentRoot = { ...root, policy_revision: "8" }
    const conflictMessage = "saved root policy changed; refresh the root and Review"
    const scanClient = scanClientWith({
      candidates: () => Effect.succeed({ ok: true, data: [reviewCandidate] }),
      resolve: () => Effect.succeed({ ok: false as const, error: {
        code: "revision_conflict", message: conflictMessage, retryable: false
      } })
    })
    viewStore.set({
      root_saved_roots: [root],
      staged_discoveries: [reviewCandidate],
      pending_replacement_entries: [pendingEntry(1)],
      pending_replacement_status: "ready",
      scan_status: "ready"
    })

    await run(resolveReplacement(candidate.candidate_id, pendingEntry(1).entry_id, "replace"), rootClientWith({
      list: () => Effect.succeed({ ok: true, data: [currentRoot] })
    }), scanClient, libraryClientWith({
      search: () => Effect.succeed({ ok: true as const, data: {
        entries: [pendingEntry(1)], has_more: false, next_cursor: null, library_change_revision: "1"
      } })
    }))

    expect(viewStore.getState()).toMatchObject({
      root_saved_roots: [currentRoot],
      scan_resolution_status: "error",
      scan_resolution_error: conflictMessage
    })
  })

  it("clears conflict guidance for new evidence and allows the successful decision", async () => {
    const staleCandidate = { ...candidate, manifest: replacementManifest }
    const freshCandidate = { ...staleCandidate, candidate_version: 2 }
    const staleEntry = pendingEntry(1)
    const freshEntry = pendingEntry(2)
    let phase = "stale"
    let resolveCalls = 0
    const scanClient = scanClientWith({
      candidates: () => Effect.succeed({ ok: true, data: [phase === "stale" ? staleCandidate : freshCandidate] }),
      resolve: (input) => {
        resolveCalls += 1
        return resolveCalls === 1
          ? Effect.succeed({ ok: false as const, error: {
              code: "revision_conflict", message: "replacement source changed since Review; rescan and refresh Review before resolving it", retryable: false
            } })
          : Effect.succeed({ ok: true as const, data: {
              operation_id: input.operation_id,
              candidate: { ...freshCandidate, hold_state: "eligible" as const }
            } })
      }
    })
    const libraryClient = libraryClientWith({
      search: () => Effect.succeed({ ok: true as const, data: {
        entries: [phase === "stale" ? staleEntry : freshEntry], has_more: false, next_cursor: null, library_change_revision: phase
      } })
    })
    viewStore.set({
      root_saved_roots: [root],
      staged_discoveries: [staleCandidate],
      pending_replacement_entries: [staleEntry],
      pending_replacement_status: "ready",
      scan_status: "ready"
    })

    await run(resolveReplacement(candidate.candidate_id, staleEntry.entry_id, "keep"), rootClientWith(), scanClient, libraryClient)
    expect(viewStore.getState().scan_resolution_error).toContain("rescan and refresh Review")

    phase = "fresh"
    await run(refreshReplacementReview, rootClientWith(), scanClient, libraryClient)
    expect(viewStore.getState()).toMatchObject({
      scan_resolution_status: "idle",
      scan_resolution_error: null,
      staged_discoveries: [freshCandidate]
    })

    await run(resolveReplacement(candidate.candidate_id, freshEntry.entry_id, "keep"), rootClientWith(), scanClient, libraryClient)
    expect(resolveCalls).toBe(2)
    expect(viewStore.getState()).toMatchObject({
      scan_resolution_status: "idle",
      scan_resolution_error: null
    })
  })

  it("replays loaded pending pages while retaining page-two entries after conflict and success refreshes", async () => {
    const reviewCandidate = { ...candidate, manifest: replacementManifest }
    const target = pendingEntry(1)
    const fillers = Array.from({ length: 50 }, (_, index) => ({
      ...target,
      entry_id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`,
      relative_path: `filler-${index}`
    }))
    const loadedEntries = [...fillers, target]
    const pageOne = { entries: fillers, has_more: true, next_cursor: "page-2", library_change_revision: "1" }
    const pageTwo = { entries: [target], has_more: false, next_cursor: null, library_change_revision: "1" }
    const searchInputs: Array<{ readonly cursor?: string; readonly state?: "replacement-pending" }> = []
    let resolveCalls = 0
    const scanClient = scanClientWith({
      candidates: () => Effect.succeed({ ok: true, data: [reviewCandidate] }),
      resolve: (input) => {
        resolveCalls += 1
        return resolveCalls === 1
          ? Effect.succeed({ ok: false as const, error: {
              code: "revision_conflict", message: "replacement source changed since Review; rescan and refresh Review before resolving it", retryable: false
            } })
          : Effect.succeed({ ok: true as const, data: {
              operation_id: input.operation_id,
              candidate: { ...reviewCandidate, hold_state: "eligible" as const }
            } })
      }
    })
    const libraryClient = libraryClientWith({
      search: (input) => {
        searchInputs.push(input)
        return Effect.succeed({ ok: true as const, data: input.cursor === undefined ? pageOne : pageTwo })
      }
    })
    viewStore.set({
      root_saved_roots: [root],
      staged_discoveries: [reviewCandidate],
      pending_replacement_entries: loadedEntries,
      pending_replacement_cursor: "page-2",
      pending_replacement_has_more: true,
      pending_replacement_status: "ready",
      scan_status: "ready"
    })

    await run(resolveReplacement(candidate.candidate_id, target.entry_id, "keep"), rootClientWith(), scanClient, libraryClient)
    expect(searchInputs).toEqual([
      { page_size: 50, state: "replacement-pending" },
      { page_size: 50, cursor: "page-2", state: "replacement-pending" }
    ])
    expect(viewStore.getState()).toMatchObject({
      scan_resolution_status: "error",
      pending_replacement_entries: loadedEntries
    })

    await run(resolveReplacement(candidate.candidate_id, target.entry_id, "keep"), rootClientWith(), scanClient, libraryClient)
    expect(searchInputs).toHaveLength(4)
    expect(searchInputs.slice(2)).toEqual([
      { page_size: 50, state: "replacement-pending" },
      { page_size: 50, cursor: "page-2", state: "replacement-pending" }
    ])
    expect(viewStore.getState().pending_replacement_entries).toHaveLength(51)
  })

  it("refreshes pending replacements after terminal scan-result loading failure", async () => {
    const submitted = { ...task("succeeded"), hold_new_discoveries: false }
    const searchInputs: Array<{ readonly query?: string; readonly state?: "replacement-pending" }> = []
    const libraryClient = libraryClientWith({
      search: (input) => {
        searchInputs.push(input)
        return Effect.succeed({ ok: true as const, data: input.state === "replacement-pending"
          ? { entries: [pendingEntry(1)], has_more: false, next_cursor: null, library_change_revision: "2" }
          : { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } })
      }
    })
    const rootClient = rootClientWith({
      command: () => Effect.succeed({ ok: true, data: { task: submitted } })
    })
    const scanClient = scanClientWith({
      listTasks: () => Effect.succeed({ ok: true, data: [submitted] }),
      candidates: () => Effect.succeed(scanError)
    })
    viewStore.set({
      root_preview_status: "ready",
      root_preview: preview,
      root_saved_roots: [root],
      scan_hold_new_discoveries: false
    })

    await run(startManualScan(root.root_id), rootClient, scanClient, libraryClient)

    expect(searchInputs).toEqual([
      { query: "", page_size: 50 },
      { page_size: 50, state: "replacement-pending" }
    ])
    expect(viewStore.getState()).toMatchObject({
      scan_status: "error",
      pending_replacement_entries: [pendingEntry(1)],
      pending_replacement_status: "ready"
    })
  })

  it("publishes only the newest pending refresh and preserves normal Library pages", async () => {
    const normalEntry = {
      entry_id: "99999999-9999-4999-8999-999999999999",
      library_id: root.library_id,
      root_id: root.root_id,
      relative_path: "normal",
      title: "Normal",
      cover: null,
      source_path: "/collections/normal",
      kind: "image-directory" as const,
      page_count: 1,
      state: "accepted" as const,
      content_version: "1",
      location_revision: "1",
      match_fields: [],
      replacement: null
    }
    const oldPending = {
      ...normalEntry,
      entry_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      relative_path: "old-pending",
      state: "replacement-pending" as const
    }
    const freshPending = {
      ...oldPending,
      entry_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      relative_path: "fresh-pending"
    }
    let firstResolve!: (value: Result<LibraryEntryPage>) => void
    let secondResolve!: (value: Result<LibraryEntryPage>) => void
    let calls = 0
    const libraryClient = libraryClientWith({
      search: (input) => {
        expect(input.state).toBe("replacement-pending")
        calls += 1
        return Effect.promise(() => new Promise<Result<LibraryEntryPage>>((resolve) => {
          if (calls === 1) firstResolve = resolve
          else secondResolve = resolve
        }))
      }
    })
    viewStore.set({
      library_entries: [normalEntry],
      pending_replacement_entries: [oldPending],
      pending_replacement_cursor: "next",
      pending_replacement_has_more: true,
      pending_replacement_status: "ready",
      connection: { state: "connected", instance_id: instanceId, epoch, reason: null }
    })

    const first = run(loadPendingReplacements(true), rootClientWith(), scanClientWith(), libraryClient)
    await Promise.resolve()
    const second = run(loadPendingReplacements(), rootClientWith(), scanClientWith(), libraryClient)
    await Promise.resolve()
    secondResolve({ ok: true, data: { entries: [freshPending], has_more: false, next_cursor: null, library_change_revision: "2" } })
    await second
    firstResolve({ ok: true, data: { entries: [oldPending], has_more: true, next_cursor: "stale", library_change_revision: "1" } })
    await first

    expect(viewStore.getState()).toMatchObject({
      library_entries: [normalEntry],
      pending_replacement_entries: [freshPending],
      pending_replacement_has_more: false,
      pending_replacement_cursor: null,
      pending_replacement_status: "ready"
    })
  })
})
