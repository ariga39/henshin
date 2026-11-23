import { Deferred, Effect, Fiber, Option } from "effect"
import { localMappingPreviewCanActivate } from "@henshin/contracts"
import type {
  ConnectionStatusView,
  RootPreviewRequest,
  RootPreviewResult,
  ScanTask,
  ReaderProfileSaveIpcRequest,
  ReaderProfile,
  ReaderProfileTestIpcRequest,
  ReaderProfileTestTargetSelectIpcRequest
} from "@henshin/contracts"
import {
  LibraryClient,
  ConnectionClient,
  OpenJournalClient,
  LocalMappingClient,
  PrototypeClient,
  ReaderProfileClient,
  RootPreviewClient,
  ScanReviewClient
} from "./client"
import type { OpenJournalView } from "./client"
import { viewStore, type LibraryOpenState, type ViewState } from "./store"

export const NOTE_ID = "note-1"
export const FORM_ID = "synthetic-note"

const newOperationId = (): string => crypto.randomUUID()

export const previewRoot = (selection: RootPreviewRequest | string) =>
  Effect.gen(function*() {
    const client = yield* RootPreviewClient
    const input: RootPreviewRequest = typeof selection === "string" ? { path: selection } : selection
    const requestedPath = "path" in input ? input.path : null
    const generation = viewStore.getState().root_preview_generation + 1
    yield* Effect.sync(() =>
      viewStore.set({
        ...(requestedPath === null ? { root_preview_selected_path: null } : {
          root_preview_path: requestedPath,
          root_preview_selected_path: requestedPath
        }),
        root_preview_status: "loading",
        root_preview: null,
        root_preview_request: input,
        root_preview_generation: generation,
        root_preview_error: null,
        root_save_operation_id: null,
        root_save_status: "idle",
        root_save_error: null,
        root_policy_status: "idle",
        root_policy_error: null,
        scan_hold_new_discoveries: false
      })
    )

    const result = yield* client.preview(input)
    if (viewStore.getState().root_preview_generation !== generation) return
    if (result.ok) {
      yield* Effect.sync(() =>
        viewStore.set({
          root_preview_status: "ready",
          root_preview_selected_path: result.data.selected_server_path,
          root_preview: result.data,
          root_preview_error: null
        })
      )
    } else {
      yield* Effect.sync(() =>
        viewStore.set({
          root_preview_status: "error",
          ...(requestedPath === null ? {} : { root_preview_selected_path: requestedPath }),
          root_preview: null,
          root_preview_error: result.error.message
        })
      )
    }
  })

export const previewLocalMapping = (rootId: string) =>
  Effect.gen(function*() {
    const client = yield* LocalMappingClient
    yield* Effect.sync(() => viewStore.set({
      local_mapping_root_id: rootId,
      local_mapping_status: "loading",
      local_mapping_error: null,
      local_mapping_activation_status: "idle",
      local_mapping_activation_error: null
    }))
    const result = yield* client.preview(rootId)
    if (!result.ok) {
      yield* Effect.sync(() => viewStore.set({
        local_mapping_status: "error",
        local_mapping_preview: null,
        local_mapping_preview_token: null,
        local_mapping_error: result.error.message
      }))
      return
    }
    if (result.data === null) {
      const retainedPreview = viewStore.getState().local_mapping_preview
      yield* Effect.sync(() => viewStore.set({
        local_mapping_status: retainedPreview === null ? "idle" : "ready",
        local_mapping_error: null,
        local_mapping_activation_status: "idle",
        local_mapping_activation_error: null
      }))
      return
    }
    const previewResult = result.data
    yield* Effect.sync(() => viewStore.set({
      local_mapping_root_id: rootId,
      local_mapping_status: "ready",
      local_mapping_preview: previewResult.preview,
      local_mapping_preview_token: previewResult.preview_token,
      local_mapping_error: null,
      local_mapping_activation_status: "idle",
      local_mapping_activation_error: null
    }))
  })

export const loadLocalMappings = Effect.gen(function*() {
  const client = yield* LocalMappingClient
  yield* Effect.sync(() => viewStore.set({
    local_mapping_list_status: "loading",
    local_mapping_list_error: null
  }))
  const result = yield* client.list()
  if (result.ok) {
    yield* Effect.sync(() => viewStore.set({
      local_mappings: result.data,
      local_mapping_list_status: "ready",
      local_mapping_list_error: null
    }))
    return true
  }
  yield* Effect.sync(() => viewStore.set({
    local_mapping_list_status: "error",
    local_mapping_list_error: result.error.message
  }))
  return false
})

const localMappingEvidenceCanActivate = (rootId: string): boolean => {
  const state = viewStore.getState()
  const preview = state.local_mapping_preview
  return state.local_mapping_status === "ready" &&
    state.local_mapping_list_status === "ready" &&
    state.local_mapping_preview_token !== null &&
    preview !== null &&
    preview.root_id === rootId &&
    localMappingPreviewCanActivate(preview)
}

export const activateLocalMapping = (rootId: string) =>
  Effect.gen(function*() {
    const client = yield* LocalMappingClient
    if (viewStore.getState().local_mapping_list_status !== "ready") {
      const loaded = yield* loadLocalMappings
      if (!loaded) {
        yield* Effect.sync(() => viewStore.set({
          local_mapping_activation_status: "error",
          local_mapping_activation_error: "Current device mappings could not be loaded; retry before activating."
        }))
        return
      }
    }
    const state = viewStore.getState()
    const preview = state.local_mapping_preview
    if (!localMappingEvidenceCanActivate(rootId) || preview === null || state.local_mapping_preview_token === null) return
    const current = state.local_mappings.find((mapping) => mapping.root_id === rootId)
    yield* Effect.sync(() => viewStore.set({
      local_mapping_activation_status: "loading",
      local_mapping_activation_error: null
    }))
    const result = yield* client.activate({
      root_id: rootId,
      expected_mapping_revision: current?.mapping_revision ?? "0",
      preview_token: state.local_mapping_preview_token
    })
    if (result.ok) {
      yield* Effect.sync(() => {
        const mappings = viewStore.getState().local_mappings
        viewStore.set({
          local_mappings: mappings.some((mapping) => mapping.root_id === rootId)
            ? mappings.map((mapping) => mapping.root_id === rootId ? result.data : mapping)
            : [...mappings, result.data],
          local_mapping_activation_status: "idle",
          local_mapping_activation_error: null
        })
      })
      return
    }
    yield* Effect.sync(() => viewStore.set({
      local_mapping_activation_status: "error",
      local_mapping_activation_error: result.error.message
    }))
    if (result.error.code === "local_mapping_revision_conflict") yield* loadLocalMappings
  })

export const loadReaderProfiles = Effect.gen(function*() {
  const client = yield* ReaderProfileClient
  yield* Effect.sync(() => viewStore.set({ reader_profiles_status: "loading", reader_profiles_error: null }))
  const result = yield* client.list()
  if (result.ok) {
    yield* Effect.sync(() => viewStore.set({
      reader_profiles: result.data,
      reader_profiles_status: "ready",
      reader_profiles_error: null
    }))
  } else {
    yield* Effect.sync(() => viewStore.set({ reader_profiles_status: "error", reader_profiles_error: result.error.message }))
  }
})

export const selectReaderExecutable = Effect.gen(function*() {
  const client = yield* ReaderProfileClient
  yield* Effect.sync(() => viewStore.set({ reader_profile_selection_error: null }))
  const result = yield* client.selectExecutable()
  if (!result.ok) {
    yield* Effect.sync(() => viewStore.set({ reader_profile_selection_error: result.error.message }))
    return null
  }
  const selection = result.data
  if (selection === null) return null
  yield* Effect.sync(() => viewStore.set({
    reader_profile_selection_handle: selection.selection_handle,
    reader_profile_selection_name: selection.executable_name,
    reader_profile_selection_error: null
  }))
  return result.data
})

export const clearReaderExecutableSelection = (): void => {
  viewStore.set({
    reader_profile_selection_handle: null,
    reader_profile_selection_name: null,
    reader_profile_selection_error: null
  })
}

export const selectReaderTestTarget = (input: ReaderProfileTestTargetSelectIpcRequest) =>
  Effect.gen(function*() {
    const client = yield* ReaderProfileClient
    yield* Effect.sync(() => viewStore.set({
      reader_profile_test_status: "selecting",
      reader_profile_test_error: null,
      reader_profile_test_result: null
    }))
    const result = yield* client.selectTestTarget(input)
    if (!result.ok) {
      if (result.error.code === "reader_profile_conflict") yield* refreshReaderProfilesAfterConflict()
      yield* Effect.sync(() => viewStore.set({
        reader_profile_test_status: "error",
        reader_profile_test_error: result.error.message,
        reader_profile_test_target: null
      }))
      return null
    }
    if (result.data === null) {
      yield* Effect.sync(() => viewStore.set({ reader_profile_test_status: "idle" }))
      return null
    }
    yield* Effect.sync(() => viewStore.set({
      reader_profile_test_target: result.data,
      reader_profile_test_status: "ready",
      reader_profile_test_error: null,
      reader_profile_test_result: null
    }))
    return result.data
  })

export const clearReaderTestTarget = (): void => {
  viewStore.set({
    reader_profile_test_target: null,
    reader_profile_test_status: "idle",
    reader_profile_test_result: null,
    reader_profile_test_error: null
  })
}

const refreshReaderProfilesAfterConflict = () =>
  Effect.gen(function*() {
    yield* Effect.sync(() => {
      clearReaderExecutableSelection()
      clearReaderTestTarget()
    })
    yield* loadReaderProfiles
  })

export const testReaderProfile = (input: ReaderProfileTestIpcRequest) =>
  Effect.gen(function*() {
    const client = yield* ReaderProfileClient
    yield* Effect.sync(() => viewStore.set({
      reader_profile_test_status: "launching",
      reader_profile_test_error: null,
      reader_profile_test_result: null
    }))
    const result = yield* client.test(input)
    if (!result.ok) {
      if (result.error.code === "reader_profile_conflict") yield* refreshReaderProfilesAfterConflict()
      if (result.error.code === "reader_test_target_selection_expired") {
        yield* Effect.sync(clearReaderTestTarget)
      }
      yield* Effect.sync(() => viewStore.set({
        reader_profile_test_status: "error",
        reader_profile_test_error: result.error.message
      }))
      return null
    }
    yield* Effect.sync(() => viewStore.set({
      reader_profile_test_status: "accepted",
      reader_profile_test_error: null,
      reader_profile_test_result: result.data
    }))
    return result.data
  })

export const saveReaderProfile = (input: ReaderProfileSaveIpcRequest) =>
  Effect.gen(function*() {
    const client = yield* ReaderProfileClient
    yield* Effect.sync(() => viewStore.set({ reader_profile_save_status: "loading", reader_profile_save_error: null }))
    const result = yield* client.save(input)
    if (!result.ok) {
      if (result.error.code === "reader_profile_conflict") {
        yield* refreshReaderProfilesAfterConflict()
      } else if (result.error.code === "reader_profile_not_found") {
        yield* loadReaderProfiles
      }
      if (result.error.code === "reader_executable_invalid") {
        yield* Effect.sync(clearReaderExecutableSelection)
      }
      yield* Effect.sync(() => viewStore.set({
        reader_profile_save_status: "error",
        reader_profile_save_error: result.error.message
      }))
      return undefined
    }
    yield* Effect.sync(() => {
      const current = viewStore.getState().reader_profiles
      viewStore.set({
        reader_profiles: current.some((profile) => profile.profile_id === result.data.profile_id)
          ? current.map((profile) => profile.profile_id === result.data.profile_id ? result.data : profile)
          : [...current, result.data],
        reader_profile_save_status: "ready",
        reader_profile_save_error: null,
        reader_profile_selection_handle: null,
        reader_profile_selection_name: null,
        reader_profile_selection_error: null,
        reader_profile_test_target: null,
        reader_profile_test_status: "idle",
        reader_profile_test_result: null,
        reader_profile_test_error: null
      })
    })
    return result.data
  })

export const loadRoots = Effect.gen(function*() {
  const client = yield* RootPreviewClient
  yield* Effect.sync(() => viewStore.set({ root_roots_status: "loading", root_roots_error: null }))
  const result = yield* client.list()
  if (result.ok) {
    yield* Effect.sync(() => viewStore.set({ root_saved_roots: result.data, root_roots_status: "ready" }))
  } else {
    yield* Effect.sync(() =>
      viewStore.set({ root_roots_status: "error", root_roots_error: result.error.message })
    )
  }
})

const scanIsActive = (task: ScanTask): boolean => task.status === "queued" || task.status === "running"

const releaseErrorMessage = (error: { readonly code: string; readonly message: string }): string =>
  error.code === "epoch_changed" || error.code === "instance_mismatch"
    ? `${error.message}${error.message.endsWith(".") ? "" : "."} Reconnect before retrying the release.`
    : error.message

const loadScanResultsFor = (client: ScanReviewClient["Service"]) => Effect.gen(function*() {
  yield* Effect.sync(() => viewStore.set({ scan_status: "loading", scan_error: null }))
  const tasks = yield* client.listTasks()
  if (!tasks.ok) {
    yield* Effect.sync(() => viewStore.set({ scan_status: "error", scan_error: tasks.error.message }))
    return false
  }
  yield* Effect.sync(() => viewStore.set({ scan_tasks: tasks.data }))

  const candidates = yield* client.candidates()
  if (!candidates.ok) {
    yield* Effect.sync(() => viewStore.set({ scan_status: "error", scan_error: candidates.error.message }))
    return false
  }
  const current = viewStore.getState()
  const releaseTarget = current.scan_release_candidate_id === null
    ? undefined
    : candidates.data.find((candidate) =>
        candidate.candidate_id === current.scan_release_candidate_id &&
        candidate.root_id === current.scan_release_root_id)
  const releaseResolved = releaseTarget !== undefined && releaseTarget.hold_state !== "held"
  yield* Effect.sync(() => viewStore.set({
    staged_discoveries: candidates.data,
    scan_status: "ready",
    scan_error: null,
    ...(releaseResolved
      ? {
          scan_release_status: "idle" as const,
          scan_release_candidate_id: null,
          scan_release_root_id: null,
          scan_release_operation_id: null,
          scan_release_candidate_version: null,
          scan_release_mapping_revision: null,
          scan_release_policy_revision: null,
          scan_release_error: null
        }
      : {})
  }))
  return true
})

let pendingReplacementRequestGeneration = 0

const pendingReplacementPageSize = 50

export const loadPendingReplacements = (append = false, preserveLoadedDepth = false) =>
  Effect.gen(function*() {
    const requestGeneration = pendingReplacementRequestGeneration + 1
    pendingReplacementRequestGeneration = requestGeneration
    const client = yield* LibraryClient
    const current = viewStore.getState()
    const connectionGeneration = current.connection_generation
    const ownerInstanceId = verifiedInstanceId(current)
    const ownerEpoch = current.connection.epoch ?? current.epoch
    const pagesToLoad = append
      ? 1
      : preserveLoadedDepth
        ? Math.max(1, Math.ceil(current.pending_replacement_entries.length / pendingReplacementPageSize))
        : 1
    let cursor = append ? current.pending_replacement_cursor : null
    let entries = append ? [...current.pending_replacement_entries] : []
    let hasMore = false
    yield* Effect.sync(() => viewStore.set({
      pending_replacement_status: "loading",
      pending_replacement_error: null
    }))
    const isCurrentRequest = (): boolean => {
      const state = viewStore.getState()
      return requestGeneration === pendingReplacementRequestGeneration &&
        state.connection_generation === connectionGeneration &&
        verifiedInstanceId(state) === ownerInstanceId &&
        (state.connection.epoch ?? state.epoch) === ownerEpoch
    }
    for (let page = 0; page < pagesToLoad; page += 1) {
      const result = yield* client.search(cursor === null
        ? { page_size: pendingReplacementPageSize, state: "replacement-pending" as const }
        : { page_size: pendingReplacementPageSize, cursor, state: "replacement-pending" as const })
      if (!isCurrentRequest()) return false
      if (!result.ok) {
        yield* Effect.sync(() => viewStore.set({
          pending_replacement_status: "error",
          pending_replacement_error: result.error.message
        }))
        return false
      }

      const pendingPage = "page" in result.data ? result.data.page : result.data
      const ids = new Set(entries.map((entry) => entry.entry_id))
      for (const entry of pendingPage.entries) {
        if (!ids.has(entry.entry_id)) entries.push(entry)
      }
      cursor = pendingPage.next_cursor
      hasMore = pendingPage.has_more
      if (!hasMore || cursor === null) break
    }
    if (!isCurrentRequest()) return false
    yield* Effect.sync(() => viewStore.set({
      pending_replacement_entries: entries,
      pending_replacement_cursor: cursor,
      pending_replacement_has_more: hasMore,
      pending_replacement_status: "ready",
      pending_replacement_error: null
    }))
    return true
  })

export const replacementEvidenceMatches = (
  entry: ViewState["pending_replacement_entries"][number] | undefined,
  candidate: ViewState["staged_discoveries"][number] | undefined
): boolean => entry !== undefined && candidate !== undefined &&
  entry.state === "replacement-pending" &&
  entry.root_id === candidate.root_id &&
  entry.relative_path === candidate.relative_path &&
  entry.replacement !== null &&
  entry.replacement.candidate_id === candidate.candidate_id &&
  entry.replacement.candidate_version === candidate.candidate_version

const clearReplacementResolutionFeedback = (): void => {
  viewStore.set({
    scan_resolution_status: "idle",
    scan_resolution_candidate_id: null,
    scan_resolution_entry_id: null,
    scan_resolution_operation_id: null,
    scan_resolution_candidate_version: null,
    scan_resolution_decision_version: null,
    scan_resolution_location_revision: null,
    scan_resolution_mapping_revision: null,
    scan_resolution_policy_revision: null,
    scan_resolution_decision: null,
    scan_resolution_error: null
  })
}

const replacementEvidenceKey = (
  state: ReturnType<typeof viewStore.getState>,
  entryId: string
): string | null => {
  const entry = state.pending_replacement_entries.find((item) => item.entry_id === entryId)
  if (entry === undefined) return null
  const candidate = state.staged_discoveries.find((item) =>
    item.root_id === entry.root_id && item.relative_path === entry.relative_path)
  return JSON.stringify({
    entry_id: entry.entry_id,
    root_id: entry.root_id,
    relative_path: entry.relative_path,
    entry_state: entry.state,
    location_revision: entry.location_revision,
    replacement: entry.replacement === null
      ? null
      : {
          candidate_id: entry.replacement.candidate_id,
          candidate_version: entry.replacement.candidate_version,
          decision_version: entry.replacement.decision_version
        },
    candidate: candidate === undefined
      ? null
      : {
          candidate_id: candidate.candidate_id,
          root_id: candidate.root_id,
          relative_path: candidate.relative_path,
          candidate_version: candidate.candidate_version,
          analysis_status: candidate.analysis_status
        }
  })
}

export const refreshReplacementReview = Effect.gen(function*() {
  const initialState = viewStore.getState()
  const entryId = initialState.scan_resolution_entry_id
  const beforeEvidence = entryId === null ? null : replacementEvidenceKey(initialState, entryId)
  const stagedLoaded = yield* loadScanResults
  const pendingLoaded = yield* loadPendingReplacements(false, true)
  const state = viewStore.getState()
  const refreshedEntryId = state.scan_resolution_entry_id === null
    ? undefined
    : state.pending_replacement_entries.find((item) => item.entry_id === state.scan_resolution_entry_id)
  const candidate = refreshedEntryId === undefined
    ? undefined
    : state.staged_discoveries.find((item) => item.root_id === refreshedEntryId.root_id && item.relative_path === refreshedEntryId.relative_path)
  const matched = stagedLoaded && pendingLoaded && replacementEvidenceMatches(refreshedEntryId, candidate)
  const changed = entryId !== null && beforeEvidence !== replacementEvidenceKey(state, entryId)
  if (matched && changed) clearReplacementResolutionFeedback()
  return { matched, changed }
})

export const loadScanResults = Effect.gen(function*() {
  const client = yield* ScanReviewClient
  return yield* loadScanResultsFor(client)
})

export const releaseHeldDiscovery = (candidateId: string) =>
  Effect.gen(function*() {
    const client = yield* ScanReviewClient
    const state = viewStore.getState()
    const candidate = state.staged_discoveries.find((item) => item.candidate_id === candidateId)
    const root = candidate === undefined
      ? undefined
      : state.root_saved_roots.find((item) => item.root_id === candidate.root_id)
    if (candidate === undefined || root === undefined || candidate.hold_state !== "held") return

    const sameCommand = state.scan_release_candidate_id === candidate.candidate_id &&
      state.scan_release_root_id === candidate.root_id &&
      state.scan_release_operation_id !== null &&
      state.scan_release_candidate_version === candidate.candidate_version &&
      state.scan_release_mapping_revision === root.mapping_revision &&
      state.scan_release_policy_revision === root.policy_revision
    const operationId = sameCommand ? state.scan_release_operation_id : newOperationId()
    yield* Effect.sync(() => viewStore.set({
      scan_release_status: "loading",
      scan_release_candidate_id: candidate.candidate_id,
      scan_release_root_id: candidate.root_id,
      scan_release_operation_id: operationId,
      scan_release_candidate_version: candidate.candidate_version,
      scan_release_mapping_revision: root.mapping_revision,
      scan_release_policy_revision: root.policy_revision,
      scan_release_error: null
    }))

    const result = yield* client.release({
      candidate_id: candidate.candidate_id,
      root_id: candidate.root_id,
      operation_id: operationId,
      expected_candidate_version: candidate.candidate_version,
      expected_mapping_revision: root.mapping_revision,
      expected_policy_revision: root.policy_revision,
      command: { type: "release-hold" }
    })
    if (!result.ok) {
      if (result.error.code === "revision_conflict" || result.error.code === "not_found") {
        yield* loadRoots
        yield* loadScanResults
      }
      const definiteFailure = result.error.code === "invalid_request" ||
        result.error.code === "not_found" ||
        result.error.code === "revision_conflict" ||
        result.error.code === "operation_conflict" ||
        result.error.code === "operation_expired" ||
        result.error.code === "epoch_changed" ||
        result.error.code === "instance_mismatch"
      yield* Effect.sync(() => viewStore.set({
        scan_release_status: "error",
        ...(definiteFailure
          ? {
              scan_release_root_id: candidate.root_id,
              scan_release_operation_id: null,
              scan_release_candidate_version: null,
              scan_release_mapping_revision: null,
              scan_release_policy_revision: null
            }
          : {}),
        scan_release_error: releaseErrorMessage(result.error)
      }))
      return
    }

    yield* Effect.sync(() => {
      const current = viewStore.getState()
      viewStore.set({
        staged_discoveries: current.staged_discoveries.map((item) =>
          item.candidate_id === result.data.candidate.candidate_id ? result.data.candidate : item
        ),
        scan_release_status: "idle",
        scan_release_candidate_id: null,
        scan_release_root_id: null,
        scan_release_operation_id: null,
        scan_release_candidate_version: null,
        scan_release_mapping_revision: null,
        scan_release_policy_revision: null,
        scan_release_error: null
      })
    })
  })

const replacementResolutionErrorMessage = (error: { readonly code: string; readonly message: string }): string =>
  error.code === "epoch_changed" || error.code === "instance_mismatch"
    ? `${error.message}${error.message.endsWith(".") ? "" : "."} Reconnect before retrying the resolution.`
    : error.message

export const resolveReplacement = (candidateId: string, entryId: string, decision: "keep" | "replace") =>
  Effect.gen(function*() {
    const client = yield* ScanReviewClient
    const state = viewStore.getState()
    const candidate = state.staged_discoveries.find((item) => item.candidate_id === candidateId)
    const entry = state.pending_replacement_entries.find((item) => item.entry_id === entryId)
    const root = candidate === undefined
      ? undefined
      : state.root_saved_roots.find((item) => item.root_id === candidate.root_id)
    if (
      candidate === undefined || entry === undefined || root === undefined ||
      candidate.root_id !== entry.root_id || candidate.relative_path !== entry.relative_path ||
      entry.state !== "replacement-pending" || candidate.analysis_status !== "ready" || candidate.manifest === null
    ) return

    if (!replacementEvidenceMatches(entry, candidate)) {
      yield* Effect.sync(() => viewStore.set({
        scan_resolution_status: "error",
        scan_resolution_entry_id: entry.entry_id,
        scan_resolution_operation_id: null,
        scan_resolution_candidate_version: null,
        scan_resolution_decision_version: null,
        scan_resolution_mapping_revision: null,
        scan_resolution_policy_revision: null,
        scan_resolution_decision: decision,
        scan_resolution_error: "replacement comparison is stale; refresh Review before deciding"
      }))
      yield* refreshReplacementReview
      return
    }
    const comparison = entry.replacement
    if (comparison === null) return
    const decisionVersion = comparison.decision_version

    const sameCommand = state.scan_resolution_candidate_id === candidate.candidate_id &&
      state.scan_resolution_entry_id === entry.entry_id &&
      state.scan_resolution_operation_id !== null &&
      state.scan_resolution_candidate_version === candidate.candidate_version &&
      state.scan_resolution_decision_version === decisionVersion &&
      state.scan_resolution_location_revision === entry.location_revision &&
      state.scan_resolution_mapping_revision === root.mapping_revision &&
      state.scan_resolution_policy_revision === root.policy_revision &&
      state.scan_resolution_decision === decision
    const operationId = sameCommand ? state.scan_resolution_operation_id : newOperationId()
    yield* Effect.sync(() => viewStore.set({
      scan_resolution_status: "loading",
      scan_resolution_candidate_id: candidate.candidate_id,
      scan_resolution_entry_id: entry.entry_id,
      scan_resolution_operation_id: operationId,
      scan_resolution_candidate_version: candidate.candidate_version,
      scan_resolution_decision_version: decisionVersion,
      scan_resolution_location_revision: entry.location_revision,
      scan_resolution_mapping_revision: root.mapping_revision,
      scan_resolution_policy_revision: root.policy_revision,
      scan_resolution_decision: decision,
      scan_resolution_error: null
    }))

    const result = yield* client.resolve({
      candidate_id: candidate.candidate_id,
      root_id: candidate.root_id,
      operation_id: operationId,
      expected_candidate_version: candidate.candidate_version,
      expected_mapping_revision: root.mapping_revision,
      expected_policy_revision: root.policy_revision,
      expected_decision_version: decisionVersion,
      expected_location_revision: entry.location_revision,
      command: { type: "resolve-replacement", entry_id: entry.entry_id, decision }
    })
    if (!result.ok) {
      let refreshed = false
      if (result.error.code === "revision_conflict" || result.error.code === "not_found") {
        yield* loadRoots
        const refreshedReview = yield* refreshReplacementReview
        refreshed = refreshedReview.matched && refreshedReview.changed
      }
      if (refreshed) return
      const definiteFailure = result.error.code === "invalid_request" ||
        result.error.code === "not_found" ||
        result.error.code === "revision_conflict" ||
        result.error.code === "operation_conflict" ||
        result.error.code === "operation_expired" ||
        result.error.code === "epoch_changed" ||
        result.error.code === "instance_mismatch"
      yield* Effect.sync(() => viewStore.set({
        scan_resolution_status: "error",
        ...(definiteFailure
          ? {
              scan_resolution_entry_id: entry.entry_id,
              scan_resolution_operation_id: null,
              scan_resolution_candidate_version: null,
              scan_resolution_decision_version: null,
              scan_resolution_location_revision: null,
              scan_resolution_mapping_revision: null,
              scan_resolution_policy_revision: null,
              scan_resolution_decision: decision
            }
          : {}),
        scan_resolution_error: replacementResolutionErrorMessage(result.error)
      }))
      return
    }

    yield* loadScanResults
    yield* loadPendingReplacements(false, true)
    const resolution = result.data.resolution
    if (resolution !== undefined) {
      yield* Effect.sync(() => {
        const current = viewStore.getState()
        if (!current.library_entries.some((item) => item.entry_id === entry.entry_id)) return
        viewStore.set({
          library_entries: current.library_entries.map((item) =>
            item.entry_id === entry.entry_id ? resolution.entry : item
          )
        })
      })
    }
    yield* Effect.sync(() => viewStore.set({
      scan_resolution_status: "idle",
      scan_resolution_candidate_id: null,
      scan_resolution_entry_id: null,
      scan_resolution_operation_id: null,
      scan_resolution_candidate_version: null,
      scan_resolution_decision_version: null,
      scan_resolution_location_revision: null,
      scan_resolution_mapping_revision: null,
      scan_resolution_policy_revision: null,
      scan_resolution_decision: null,
      scan_resolution_error: null
    }))
  })
type ScanWaitResult =
  | { readonly ok: true; readonly task: ScanTask }
  | { readonly ok: false; readonly message: string }

type ScanWaiter = {
  readonly registeredAtPoll: number
  readonly deferred: Deferred.Deferred<ScanWaitResult>
}

const scanWaiters = new Map<string, Set<ScanWaiter>>()
let scanResultsWatcher: Fiber.Fiber<void, never> | null = null
let scanWatcherStarting: Deferred.Deferred<Fiber.Fiber<void, never>> | null = null
let scanPollSequence = 0

const completeScanWaiters = (taskId: string, result: ScanWaitResult) => Effect.gen(function*() {
  const waiters = scanWaiters.get(taskId)
  if (waiters === undefined) return
  scanWaiters.delete(taskId)
  yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter.deferred, result), { discard: true })
})

const failScanWaiters = (message: string) => Effect.gen(function*() {
  const waiters = Array.from(scanWaiters.values()).flatMap((entries) => Array.from(entries))
  scanWaiters.clear()
  yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter.deferred, { ok: false, message }), { discard: true })
})

const watchScanResultsFor = (client: ScanReviewClient["Service"]) => Effect.gen(function*() {
  while (true) {
    const poll = scanPollSequence + 1
    scanPollSequence = poll
    const loaded = yield* loadScanResultsFor(client)
    if (!loaded) {
      yield* failScanWaiters(viewStore.getState().scan_error ?? "could not load scan results")
      return
    }

    const tasks = viewStore.getState().scan_tasks
    for (const [taskId, waiters] of Array.from(scanWaiters.entries())) {
      if (!Array.from(waiters).some((waiter) => waiter.registeredAtPoll < poll)) continue
      const task = tasks.find((candidate) => candidate.task_id === taskId)
      if (task === undefined) {
        yield* completeScanWaiters(taskId, { ok: false, message: "submitted scan task was not found in scan results" })
      } else if (!scanIsActive(task)) {
        yield* completeScanWaiters(taskId, { ok: true, task })
      }
    }

    if (!tasks.some(scanIsActive) && scanWaiters.size === 0) return
    yield* Effect.sleep("250 millis")
  }
})

const ensureScanResultsWatcher = Effect.gen(function*() {
  const existing = scanResultsWatcher
  if (existing !== null) return existing
  const starting = scanWatcherStarting
  if (starting !== null) return yield* Deferred.await(starting)

  const ready = Deferred.makeUnsafe<Fiber.Fiber<void, never>>()
  scanWatcherStarting = ready
  const client = yield* ScanReviewClient
  const watcherRef: { current: Fiber.Fiber<void, never> | null } = { current: null }
  const watcher = yield* Effect.forkDetach(
    watchScanResultsFor(client).pipe(
      Effect.ensuring(Effect.sync(() => {
        if (scanResultsWatcher === watcherRef.current) scanResultsWatcher = null
      }))
    ),
    { startImmediately: false }
  )
  watcherRef.current = watcher
  scanResultsWatcher = watcher
  scanWatcherStarting = null
  yield* Deferred.succeed(ready, watcher)
  return watcher
})

const waitForScanTask = (taskId: string) => Effect.gen(function*() {
  const deferred = Deferred.makeUnsafe<ScanWaitResult>()
  const waiter = { registeredAtPoll: scanPollSequence, deferred }
  const waiters = scanWaiters.get(taskId) ?? new Set<ScanWaiter>()
  waiters.add(waiter)
  scanWaiters.set(taskId, waiters)
  yield* ensureScanResultsWatcher
  return yield* Deferred.await(deferred).pipe(
    Effect.ensuring(Effect.sync(() => {
      const current = scanWaiters.get(taskId)
      if (current === undefined) return
      current.delete(waiter)
      if (current.size === 0) scanWaiters.delete(taskId)
    }))
  )
})

export const watchHeldScans = Effect.gen(function*() {
  const watcher = yield* ensureScanResultsWatcher
  yield* Fiber.join(watcher)
})

export const retryScanResults = Effect.gen(function*() {
  const loaded = yield* loadScanResults
  if (!loaded) {
    yield* loadPendingReplacements()
    return
  }
  if (viewStore.getState().scan_tasks.some(scanIsActive)) {
    yield* watchHeldScans
    yield* loadPendingReplacements()
  }
})

export const loadRootWorkspace = Effect.gen(function*() {
  yield* loadRoots
  yield* loadLocalMappings
  const loaded = yield* loadScanResults
  yield* loadLibrary()
  yield* loadPendingReplacements()
  if (loaded && viewStore.getState().scan_tasks.some(scanIsActive)) {
    yield* watchHeldScans
    yield* loadPendingReplacements()
  }
})

const watchScanTask = (taskId: string) =>
  Effect.gen(function*() {
    const result = yield* waitForScanTask(taskId)
    if (!result.ok) return
  })

export const refreshRootPolicy = Effect.gen(function*() {
  const initialState = viewStore.getState()
  const request = initialState.root_preview_request
  const expectedGeneration = request === null
    ? initialState.root_preview_generation
    : initialState.root_preview_generation + 1
  yield* Effect.sync(() => viewStore.set({ root_policy_status: "loading", root_policy_error: null }))
  if (request !== null) yield* previewRoot(request)
  yield* loadRoots
  const current = viewStore.getState()
  if (
    current.root_preview_generation === expectedGeneration &&
    (current.root_policy_status === "loading" || current.root_policy_status === "error")
  ) {
    yield* Effect.sync(() => viewStore.set({ root_policy_status: "idle", root_policy_error: null }))
  }
})

const isSavedDiscovery = (preview: RootPreviewResult | null): preview is Extract<RootPreviewResult, { kind: "saved-root-discovery" }> =>
  preview !== null && "kind" in preview

const updateRootExclusion = (input: {
  readonly rootId: string
  readonly path: string
  readonly scope: "exact" | "subtree"
  readonly expectedPolicyRevision: string
}, type: "exclude" | "remove-exclusion") =>
  Effect.gen(function*() {
    const client = yield* RootPreviewClient
    const initialState = viewStore.getState()
    const previewGeneration = initialState.root_preview_generation
    const currentPreview = initialState.root_preview
    let preview = isSavedDiscovery(currentPreview) && currentPreview.root_id === input.rootId
      ? currentPreview
      : null

    yield* Effect.sync(() => viewStore.set({ root_policy_status: "loading", root_policy_error: null }))
    if (preview === null) {
      const fresh = yield* client.preview({ kind: "saved-root", root_id: input.rootId })
      if (!fresh.ok || !isSavedDiscovery(fresh.data) || fresh.data.root_id !== input.rootId) {
        if (viewStore.getState().root_preview_generation === previewGeneration) {
          yield* Effect.sync(() => viewStore.set({
            root_policy_status: "error",
            root_policy_error: fresh.ok ? "saved root preview was not available" : fresh.error.message
          }))
        }
        return
      }
      preview = fresh.data
    }

    const result = yield* client.command({
      root_id: preview.root_id,
      operation_id: newOperationId(),
      instance_id: preview.instance_id,
      epoch: preview.epoch,
      expected_policy_revision: input.expectedPolicyRevision,
      command: { type, exclusion: { path: input.path, scope: input.scope } }
    })
    if (!result.ok) {
      if (viewStore.getState().root_preview_generation === previewGeneration) {
        yield* Effect.sync(() => viewStore.set({ root_policy_status: "error", root_policy_error: result.error.message }))
      }
      return
    }
    if ("task" in result.data) {
      yield* Effect.sync(() => viewStore.set({ root_policy_status: "error", root_policy_error: "server returned a scan task for a policy change" }))
      return
    }

    const updatedRoot = result.data
    yield* Effect.sync(() => {
      const current = viewStore.getState()
      viewStore.set({
        root_saved_roots: current.root_saved_roots.map((root) => root.root_id === updatedRoot.root_id ? updatedRoot : root),
        ...(current.root_preview_generation === previewGeneration
          ? { root_policy_status: "idle" as const, root_policy_error: null }
          : {})
      })
    })
    if (viewStore.getState().root_preview_generation === previewGeneration) {
      yield* previewRoot({ kind: "saved-root", root_id: result.data.root_id })
    }
  })

export const excludeRootPath = (input: {
  readonly rootId: string
  readonly path: string
  readonly scope: "exact" | "subtree"
  readonly expectedPolicyRevision: string
}) => updateRootExclusion(input, "exclude")

export const removeRootExclusion = (input: {
  readonly rootId: string
  readonly path: string
  readonly scope: "exact" | "subtree"
  readonly expectedPolicyRevision: string
}) => updateRootExclusion(input, "remove-exclusion")

const taskError = (task: ScanTask): string | null => {
  if (task.readiness_error !== null) return task.readiness_error.message
  if (task.error !== null) return task.error.message
  switch (task.status) {
    case "completed_with_errors":
      return "one or more discoveries could not be analyzed"
    case "interrupted":
      return "scan was interrupted before it completed"
    case "failed":
      return "normal scan failed"
    default:
      return null
  }
}

const finishNormalScanFailure = (message: string) =>
  Effect.gen(function*() {
    yield* loadLibrary()
    yield* loadPendingReplacements()
    yield* Effect.sync(() => viewStore.set({
      scan_start_status: "error",
      scan_start_error: message,
      library_scan_status: "error",
      library_scan_error: message,
      library_scan_task: null
    }))
  })

const startManualScanFor = (rootId: string, holdNewDiscoveries: boolean) =>
  Effect.gen(function*() {
    const client = yield* RootPreviewClient
    const state = viewStore.getState()
    const root = state.root_saved_roots.find((candidate) => candidate.root_id === rootId)
    const preview = state.root_preview
    if (root === undefined || !isSavedDiscovery(preview) || preview.root_id !== rootId) return

    yield* Effect.sync(() => viewStore.set({
      scan_start_status: "loading",
      scan_start_error: null,
      library_scan_status: holdNewDiscoveries ? viewStore.getState().library_scan_status : "starting",
      library_scan_error: holdNewDiscoveries ? viewStore.getState().library_scan_error : null,
      library_scan_task: null,
      ...(!holdNewDiscoveries ? { screen: "library" as const, library_status: "loading" as const, library_error: null } : {})
    }))
    const result = yield* client.command({
      root_id: rootId,
      operation_id: newOperationId(),
      instance_id: preview.instance_id,
      epoch: preview.epoch,
      expected_mapping_revision: root.mapping_revision,
      expected_policy_revision: preview.policy_revision,
      command: { type: "start-scan", mode: "manual", hold_new_discoveries: holdNewDiscoveries }
    })
    if (!result.ok) {
      if (result.error.code === "revision_conflict") yield* loadRoots
      if (holdNewDiscoveries) {
        yield* Effect.sync(() => viewStore.set({ scan_start_status: "error", scan_start_error: result.error.message }))
      } else {
        yield* finishNormalScanFailure(result.error.message)
      }
      return
    }
    if (!("task" in result.data)) {
      const message = "server returned a root policy result instead of a scan task"
      if (holdNewDiscoveries) {
        yield* Effect.sync(() => viewStore.set({ scan_start_status: "error", scan_start_error: message }))
      } else {
        yield* finishNormalScanFailure(message)
      }
      return
    }
    const submittedTask = result.data.task
    yield* Effect.sync(() => {
      const tasks = viewStore.getState().scan_tasks
      viewStore.set({
        scan_tasks: tasks.some((task) => task.task_id === submittedTask.task_id)
          ? tasks.map((task) => task.task_id === submittedTask.task_id ? submittedTask : task)
          : [...tasks, submittedTask],
        scan_start_error: null,
        ...(holdNewDiscoveries ? {} : { library_scan_task: submittedTask })
      })
    })
    yield* watchScanTask(submittedTask.task_id)

    const watchedState = viewStore.getState()
    const terminal = watchedState.scan_tasks.find((task) => task.task_id === submittedTask.task_id)
    if (holdNewDiscoveries) {
      yield* loadPendingReplacements()
      yield* Effect.sync(() => viewStore.set({ scan_start_status: "idle" }))
      return
    }

    if (watchedState.scan_status === "error") {
      yield* finishNormalScanFailure(watchedState.scan_error ?? "could not load normal scan results")
      return
    }
    if (terminal === undefined) {
      yield* finishNormalScanFailure("submitted scan task was not found in scan results")
      return
    }
    if (scanIsActive(terminal)) {
      yield* finishNormalScanFailure("normal scan did not reach a terminal state")
      return
    }

    yield* loadLibrary()
    yield* loadPendingReplacements()
    const error = taskError(terminal)
    yield* Effect.sync(() => viewStore.set({
      scan_start_status: terminal.status === "completed_with_errors" ? "idle" : error === null ? "idle" : "error",
      scan_start_error: terminal.status === "completed_with_errors" ? null : error,
      library_scan_status: terminal.status === "failed" || terminal.status === "interrupted" ? "error" : "started",
      library_scan_error: error,
      library_scan_task: terminal
    }))
  })

export const startHeldScan = (rootId: string) =>
  Effect.gen(function*() {
    if (!viewStore.getState().scan_hold_new_discoveries) return
    yield* startManualScanFor(rootId, true)
  })

export const startManualScan = (rootId: string) =>
  startManualScanFor(rootId, viewStore.getState().scan_hold_new_discoveries)

export const canSaveRoot = (state: ViewState): boolean => {
  const preview = state.root_preview
  return preview !== null && "children" in preview &&
    state.root_preview_status === "ready" &&
    state.root_save_status !== "loading" &&
    state.root_preview_path === preview.selected_server_path &&
    state.root_label.length > 0 &&
    !state.root_saved_roots.some((root) => root.canonical_server_path === preview.preview_identity.canonical_server_path)
}

export const showLibrary = Effect.sync(() => viewStore.set({ screen: "library" }))
export const showSetup = Effect.sync(() => viewStore.set({ screen: "setup" }))

const libraryEntry = (state: ViewState, entryId: string) =>
  state.library_entries.find((entry) => entry.entry_id === entryId)

const libraryNamespace = (state: ViewState, entryId: string): string | null => {
  const entry = libraryEntry(state, entryId)
  const connectedNamespace = state.connection.state === "connected" ? state.connection.instance_id : null
  return connectedNamespace ?? entry?.library_id ?? null
}

const sameLibraryOpenState = (left: LibraryOpenState, namespaceId: string, entryId: string): boolean =>
  left.namespace_id === namespaceId && left.entry_id === entryId

export const libraryOpenStateFor = (state: ViewState, entryId: string): LibraryOpenState | null => {
  const namespaceId = libraryNamespace(state, entryId)
  return namespaceId === null
    ? null
    : state.library_open_states.find((openState) =>
        openState.connection_generation === state.connection_generation &&
        sameLibraryOpenState(openState, namespaceId, entryId)
      ) ?? null
}

export const loadActiveLibraryOpenState = (entryId: string, retryActionId?: string) => Effect.gen(function*() {
  const client = yield* LibraryClient
  const initial = viewStore.getState()
  const initialGeneration = initial.connection_generation
  const namespaceId = libraryNamespace(initial, entryId)
  if (namespaceId === null || initial.library_selected_entry_id !== entryId) return
  const observed = libraryOpenStateFor(initial, entryId)
  if (retryActionId !== undefined && observed?.result?.action_id !== retryActionId) return
  const request = retryActionId !== undefined
    ? { action_id: retryActionId }
    : observed?.status === "loading" && observed.result?.status === "in-flight"
      ? { action_id: observed.result.action_id }
      : { entry_id: entryId }
  const result = yield* client.status(request)
  const current = viewStore.getState()
  const currentObserved = libraryOpenStateFor(current, entryId)
  if (
    current.connection_generation !== initialGeneration ||
    current.library_selected_entry_id !== entryId ||
    libraryNamespace(current, entryId) !== namespaceId ||
    currentObserved?.status !== observed?.status ||
    currentObserved?.profile_id !== observed?.profile_id ||
    currentObserved?.result?.action_id !== observed?.result?.action_id
  ) return
  const activeResult = observed?.status === "loading" && observed.result?.status === "in-flight" && observed.result.profile_id !== null
    ? observed.result
    : null
  const activeProfileId = activeResult?.profile_id ?? null
  const publishUnknown = (message: string) => Effect.sync(() => {
    if (activeResult === null || activeProfileId === null) return
    viewStore.set({
      library_open_states: replaceLibraryOpenState(viewStore.getState().library_open_states, {
        namespace_id: namespaceId,
        entry_id: entryId,
        profile_id: activeProfileId,
        connection_generation: initialGeneration,
        status: "unknown",
        result: {
          action_id: activeResult.action_id,
          entry_id: entryId,
          profile_id: activeProfileId,
          status: "unknown",
          message,
          event_durable: false
        }
      })
    })
  })
  if (!result.ok) {
    yield* publishUnknown("The reader handoff outcome is temporarily unavailable. Retry status before opening again.")
    return
  }
  if (result.data === null) {
    yield* publishUnknown("The reader handoff has no available terminal result; it may have opened. Retry status or open again deliberately.")
    return
  }
  const data = result.data
  if (data.profile_id === null) return
  const profileId: string = data.profile_id
  yield* Effect.sync(() => viewStore.set({
    library_open_states: replaceLibraryOpenState(viewStore.getState().library_open_states, {
      namespace_id: namespaceId,
      entry_id: entryId,
      profile_id: profileId,
      connection_generation: initialGeneration,
      status: data.status === "in-flight" ? "loading" : data.status,
      result: data
    })
  }))
})

const replaceLibraryOpenState = (
  states: ReadonlyArray<LibraryOpenState>,
  next: LibraryOpenState
): ReadonlyArray<LibraryOpenState> => [
  ...states.filter((openState) => !sameLibraryOpenState(openState, next.namespace_id, next.entry_id)),
  next
]

export const loadLibraryEntry = (entryId: string) =>
  Effect.gen(function*() {
    const client = yield* LibraryClient
    yield* Effect.sync(() => viewStore.set({
      library_entry_status: "loading",
      library_entry_error: null,
      library_note_status: "loading",
      library_note_error: null,
      library_note_server_text: null
    }))
    const result = yield* client.entry({ entry_id: entryId })
    if (viewStore.getState().library_selected_entry_id !== entryId) return
    if (!result.ok) {
      yield* Effect.sync(() => viewStore.set({
        library_entry_status: "error",
        library_entry_error: result.error.message,
        library_note_status: "error",
        library_note_error: result.error.message
      }))
      return
    }
    yield* Effect.sync(() => viewStore.set({
      library_entry: result.data,
      library_entry_status: "ready",
      library_entry_error: null,
      library_note_text: result.data.note?.text ?? "",
      library_note_status: "idle",
      library_note_error: null,
      library_note_server_text: null
    }))
  })

export const selectLibraryEntry = (entryId: string) =>
  Effect.gen(function*() {
    const state = viewStore.getState()
    const openState = libraryOpenStateFor(state, entryId)
    const preserveManualProfile = state.library_selected_entry_id === entryId
      ? state.library_open_profile_id
      : null
    yield* Effect.sync(() => viewStore.set({
      library_selected_entry_id: entryId,
      library_open_profile_id: preserveManualProfile ?? openState?.profile_id ?? null,
      library_entry: null,
      library_entry_status: "loading",
      library_entry_error: null,
      library_note_text: "",
      library_note_status: "idle",
      library_note_error: null,
      library_note_server_text: null
    }))
    yield* loadLibraryEntry(entryId)
  })

export const updateLibraryNote = (text: string) =>
  Effect.gen(function*() {
    const client = yield* LibraryClient
    const state = viewStore.getState()
    const entry = state.library_entry
    const entryId = state.library_selected_entry_id
    if (entry === null || entryId === null) return
    const expectedDecisionVersion = entry.decision_version
    yield* Effect.sync(() => viewStore.set({ library_note_status: "loading", library_note_error: null }))
    const result = yield* client.note({
      entry_id: entryId,
      text,
      expected_decision_version: expectedDecisionVersion
    })
    const current = viewStore.getState()
    if (current.library_selected_entry_id !== entryId || current.library_entry?.decision_version !== expectedDecisionVersion) return
    if (!result.ok) {
      if (result.error.code === "revision_conflict") {
        const refreshed = yield* client.entry({ entry_id: entryId })
        if (refreshed.ok && viewStore.getState().library_selected_entry_id === entryId) {
          yield* Effect.sync(() => viewStore.set({
            library_entry: refreshed.data,
            library_note_status: "error",
            library_note_error: "This note changed on another desktop. Your text is retained below for comparison.",
            library_note_server_text: refreshed.data.note?.text ?? ""
          }))
          return
        }
      }
      yield* Effect.sync(() => viewStore.set({
        library_note_status: "error",
        library_note_error: result.error.message
      }))
      return
    }
    yield* Effect.sync(() => viewStore.set({
      library_entry: result.data.entry,
      library_note_text: result.data.entry.note?.text ?? "",
      library_note_status: "idle",
      library_note_error: null,
      library_note_server_text: null
    }))
  })

export const chooseLibraryOpenProfile = (profileId: string) => Effect.sync(() => {
  const state = viewStore.getState()
  const entryId = state.library_selected_entry_id
  if (entryId === null) return
  const openState = libraryOpenStateFor(state, entryId)
  if (openState?.status === "loading") return
  viewStore.set({
    library_open_profile_id: profileId
  })
})

export const openSelectedLibraryEntry = Effect.gen(function*() {
  const state = viewStore.getState()
  const entryId = state.library_selected_entry_id
  const entry = entryId === null
    ? undefined
    : state.library_entries.find((candidate) => candidate.entry_id === entryId)
  if (entry === undefined || entry.state !== "accepted") return

  const client = yield* LibraryClient
  const profileId = state.library_open_profile_id
  const namespaceId = entryId === null ? null : libraryNamespace(state, entryId)
  const openState = entryId === null ? null : libraryOpenStateFor(state, entryId)
  if (entryId === null || profileId === null || namespaceId === null || openState?.status === "loading") return
  const actionId = newOperationId()
  const connectionGeneration = state.connection_generation
  yield* Effect.sync(() => viewStore.set({
    library_open_states: replaceLibraryOpenState(viewStore.getState().library_open_states, {
      namespace_id: namespaceId,
      entry_id: entryId,
      profile_id: profileId,
      connection_generation: connectionGeneration,
      status: "loading",
      result: null
    })
  }))
  let requestProfileId = profileId
  let result = yield* client.open({ entry_id: entryId, profile_id: requestProfileId, action_id: actionId })
  let resultActionId = actionId
  let current = viewStore.getState()
  let currentOpenState = current.library_open_states.find((item) => sameLibraryOpenState(item, namespaceId, entryId))
  if (
    current.connection_generation !== connectionGeneration ||
    libraryNamespace(current, entryId) !== namespaceId ||
    currentOpenState?.status !== "loading" ||
    currentOpenState.profile_id !== profileId
  ) return
  if (currentOpenState === undefined) return
  const initialOpenState = currentOpenState
  if (result.ok && result.data.entry_id === entryId && result.data.status === "in-flight") {
    const activeResult = result.data
    if (activeResult.profile_id === null) return
    requestProfileId = activeResult.profile_id
    resultActionId = activeResult.action_id
    yield* Effect.sync(() => viewStore.set({
      library_open_states: replaceLibraryOpenState(viewStore.getState().library_open_states, {
        ...initialOpenState,
        profile_id: requestProfileId,
        status: "loading",
        result: activeResult
      })
    }))
    const statusResult = yield* client.status({ action_id: activeResult.action_id })
    current = viewStore.getState()
    currentOpenState = current.library_open_states.find((item) => sameLibraryOpenState(item, namespaceId, entryId))
    if (
      current.connection_generation !== connectionGeneration ||
      libraryNamespace(current, entryId) !== namespaceId ||
      currentOpenState?.status !== "loading" ||
      currentOpenState.profile_id !== requestProfileId ||
      currentOpenState.result?.action_id !== activeResult.action_id
    ) return
    if (currentOpenState === undefined) return
    if (!statusResult.ok || statusResult.data === null) {
      const followOpenState = currentOpenState
      const message = statusResult.ok
        ? "The reader handoff has no available terminal result; it may have opened. Retry status or open again deliberately."
        : "The reader handoff outcome is temporarily unavailable. Retry status before opening again."
      yield* Effect.sync(() => viewStore.set({
        library_open_states: replaceLibraryOpenState(viewStore.getState().library_open_states, {
          ...followOpenState,
          status: "unknown",
          result: {
            action_id: activeResult.action_id,
            entry_id: entryId,
            profile_id: requestProfileId,
            status: "unknown",
            message,
            event_durable: false
          }
        })
      }))
      return
    }
    const terminalResult = statusResult.data
    result = { ok: true, data: terminalResult }
  }
  if (
    current.connection_generation !== connectionGeneration ||
    libraryNamespace(current, entryId) !== namespaceId ||
    currentOpenState?.status !== "loading" ||
    currentOpenState.profile_id !== requestProfileId
  ) return
  if (currentOpenState === undefined) return
  if (!result.ok) {
    yield* Effect.sync(() => viewStore.set({
      library_open_states: replaceLibraryOpenState(viewStore.getState().library_open_states, {
        ...currentOpenState,
        status: "failed",
        result: {
          action_id: resultActionId,
          entry_id: entryId,
          profile_id: requestProfileId,
          status: "failed",
          message: result.error.message,
          event_durable: false
        }
      })
    }))
    return
  }
  if (result.data.entry_id !== entryId) return
  yield* Effect.sync(() => viewStore.set({
    library_open_states: replaceLibraryOpenState(viewStore.getState().library_open_states, {
      ...currentOpenState,
      status: result.data.status === "in-flight" ? "loading" : result.data.status,
      result: result.data
    })
  }))
})

export const loadLibrary = (append = false, query = viewStore.getState().library_query) =>
  Effect.gen(function*() {
    const client = yield* LibraryClient
    const current = viewStore.getState()
    const cursor = append ? current.library_cursor : null
    const connectionGeneration = current.connection_generation
    const ownerInstanceId = verifiedInstanceId(current)
    const ownerEpoch = current.connection.epoch ?? current.epoch
    const requestGeneration = current.library_request_generation + 1
    yield* Effect.sync(() => viewStore.set({
      library_status: "loading",
      library_error: null,
      library_request_generation: requestGeneration,
      ...(append ? {} : { library_cursor: null, library_has_more: false })
    }))
    const result = yield* client.search(cursor === null
      ? { query, page_size: 50 }
      : { query, page_size: 50, cursor })
    const isCurrentRequest = (): boolean => {
      const state = viewStore.getState()
      return state.library_request_generation === requestGeneration &&
        state.connection_generation === connectionGeneration &&
        verifiedInstanceId(state) === ownerInstanceId &&
        (state.connection.epoch ?? state.epoch) === ownerEpoch
    }
    if (!isCurrentRequest()) {
      yield* Effect.sync(() => {
        const state = viewStore.getState()
        if (state.library_status === "loading" && state.library_request_generation === requestGeneration) {
          viewStore.set({ library_status: "idle" })
        }
      })
      return
    }
    if (!result.ok) {
      yield* Effect.sync(() => {
        const state = viewStore.getState()
        const filtered = state.library_query.trim() !== ""
        viewStore.set(filtered
          ? {
              library_entries: [],
              library_cursor: null,
              library_has_more: false,
              library_freshness: null,
              library_status: "error",
              library_error: result.error.message
            }
          : {
              library_status: state.connection.state !== "connected" && state.library_freshness?.source === "cached"
                ? "ready"
                : "error",
              library_error: result.error.message,
              ...(state.connection.state !== "connected" && state.library_freshness !== null
                ? { library_freshness: { ...state.library_freshness, source: "cached", stale: true, partial: true } }
                : {})
            })
      })
      return
    }
    yield* Effect.sync(() => {
      if (!isCurrentRequest()) return
      const state = viewStore.getState()
      const existing = append ? state.library_entries : []
      const ids = new Set(existing.map((entry) => entry.entry_id))
      const entries = [...existing]
      const page = "page" in result.data ? result.data.page : result.data
      const freshness = "freshness" in result.data ? result.data.freshness : null
      for (const entry of page.entries) {
        if (!ids.has(entry.entry_id)) entries.push(entry)
      }
      viewStore.set({
        library_entries: entries,
        library_query: query,
        library_cursor: page.next_cursor,
        library_has_more: page.has_more,
        library_status: "ready",
        library_error: null,
        library_freshness: freshness,
        library_cover_generation: append
          ? state.library_cover_generation
          : state.library_cover_generation + 1
      })
    })
  })

export const searchLibrary = (query: string) =>
  Effect.gen(function*() {
    const current = viewStore.getState()
    yield* Effect.sync(() => viewStore.set({
      library_query: query,
      library_entries: [],
      library_cursor: null,
      library_has_more: false,
      ...(current.library_query === query
        ? {}
        : {
            library_selected_entry_id: null,
            library_open_profile_id: null
          })
    }))
    yield* loadLibrary(false, query)
  })

export const saveRoot = Effect.gen(function*() {
  const client = yield* RootPreviewClient
  const state = viewStore.getState()
  const preview = state.root_preview
  if (!preview || !("children" in preview) || !canSaveRoot(state)) return

  const confirmedPath = preview.selected_server_path
  const confirmedLabel = state.root_label
  const operationId = state.root_save_target_label === confirmedLabel && state.root_save_target_path === confirmedPath
    ? state.root_save_operation_id ?? newOperationId()
    : newOperationId()
  yield* Effect.sync(() => viewStore.set({
    root_save_operation_id: operationId,
    root_save_status: "loading",
    root_save_error: null,
    root_save_target_label: confirmedLabel,
    root_save_target_path: confirmedPath
  }))
  const result = yield* client.save({
    operation_id: operationId,
    instance_id: preview.instance_id,
    epoch: preview.epoch,
    label: state.root_label,
    path: preview.selected_server_path,
    preview_identity: preview.preview_identity
  })
  if (result.ok) {
    yield* Effect.sync(() => {
      const roots = viewStore.getState().root_saved_roots
      viewStore.set({
        root_saved_roots: roots.some((root) => root.root_id === result.data.root_id)
          ? roots.map((root) => root.root_id === result.data.root_id ? result.data : root)
          : [...roots, result.data],
        root_save_status: "ready",
        root_save_error: null,
        root_save_target_label: confirmedLabel,
        root_save_target_path: confirmedPath
      })
    })
  } else {
    const listed = yield* client.list()
    const existing = listed.ok
      ? listed.data.find((root) => root.canonical_server_path === preview.preview_identity.canonical_server_path)
      : undefined
    viewStore.set({
      ...(listed.ok ? { root_saved_roots: listed.data, root_roots_status: "ready", root_roots_error: null } : {}),
      root_save_status: existing?.label === confirmedLabel ? "ready" : "error",
      root_save_error: existing === undefined ? result.error.message
        : existing.label === confirmedLabel ? null : `Directory is already saved as ${existing.label}.`
    })
  }
})

const isCurrent = (generation: number): boolean =>
  viewStore.getState().connection_generation === generation

const verifiedInstanceId = (state: ReturnType<typeof viewStore.getState>): string | null =>
  state.connection.instance_id ?? state.instance_id

const connectedStatus = (instanceId: string, epoch: string): ConnectionStatusView => ({
  state: "connected",
  instance_id: instanceId,
  epoch,
  reason: null
})

const hasRetainedFormIntent = (state: ReturnType<typeof viewStore.getState>): boolean => {
  if (state.note !== null) return state.form_text !== state.note.text
  if (state.saved_draft !== null) return true
  // With no loaded note, the initial empty form is clean. Any retained text
  // or edit version is evidence of disconnected typing or a local edit.
  return state.form_text !== "" || state.form_edit_version > 0
}

/**
 * Loads the note and captures the revision the form edits from. `base_revision`
 * is intentionally not rebased after a commit, so a second save from the same
 * captured revision reproduces the stale-revision conflict a second device
 * would see.
 */
const loadNoteWithOptions = (preserveFormText: boolean) => Effect.gen(function*() {
  const client = yield* PrototypeClient
  const initialState = viewStore.getState()
  const editVersionAtStart = initialState.form_edit_version
  const connectionGenerationAtStart = initialState.connection_generation
  const initiallyDirty = preserveFormText && hasRetainedFormIntent(initialState)
  yield* Effect.sync(() => viewStore.set({ status: "loading", outcome: null }))

  const handshake = yield* client.handshake()
  if (!handshake.ok) {
    if (isCurrent(connectionGenerationAtStart)) {
      yield* Effect.sync(() => viewStore.set({ status: "error", outcome: { kind: "error", message: handshake.error.message } }))
    }
    return
  }

  if (!isCurrent(connectionGenerationAtStart)) return
  viewStore.setConnection(connectedStatus(handshake.data.instance_id, handshake.data.epoch))
  const readGeneration = viewStore.getState().connection_generation

  const note = yield* client.getNote(NOTE_ID)
  if (!note.ok) {
    if (isCurrent(readGeneration)) {
      yield* Effect.sync(() =>
        viewStore.set({ status: "error", outcome: { kind: "error", message: note.error.message } })
      )
    }
    return
  }

  if (!isCurrent(readGeneration)) return
  yield* Effect.sync(() => {
    const currentState = viewStore.getState()
    const changedDuringRead = currentState.form_edit_version !== editVersionAtStart
    const retainFormText = preserveFormText && (initiallyDirty || changedDuringRead)
    const copied = !retainFormText && currentState.form_edit_version === editVersionAtStart
    viewStore.set({
      status: "ready",
      instance_id: handshake.data.instance_id,
      epoch: handshake.data.epoch,
      note: note.data,
      base_revision: retainFormText ? initialState.base_revision : note.data.revision,
      base_epoch: retainFormText ? initialState.base_epoch : handshake.data.epoch,
      ...(copied ? { form_text: note.data.text } : {}),
      outcome: null
    })
  })
})

export const loadNote = loadNoteWithOptions(false)

export const loadLibraryConnectionStatus = Effect.gen(function*() {
  const client = yield* ConnectionClient
  const connectionGeneration = viewStore.getState().connection_generation
  const result = yield* client.connectionStatus()
  if (result.ok) {
    yield* Effect.sync(() => viewStore.publishConnection(result.data, connectionGeneration))
  }
})

export const loadLibraryWorkspace = Effect.gen(function*() {
  yield* loadLibraryConnectionStatus
  yield* loadRootWorkspace
})

export const disconnectLibrary = Effect.gen(function*() {
  const client = yield* ConnectionClient
  const connectionGeneration = viewStore.beginConnectionTransition("disconnected")
  const result = yield* client.disconnect()
  if (result.ok) {
    yield* Effect.sync(() => {
      if (!viewStore.publishConnection(result.data, connectionGeneration) || !isCurrent(connectionGeneration)) return
      const state = viewStore.getState()
      const filtered = state.library_query.trim() !== ""
      viewStore.set(filtered
        ? {
            library_entries: [],
            library_cursor: null,
            library_has_more: false,
            library_freshness: null,
            library_status: "error",
            library_error: "Filtered Library results were cleared while disconnected. Reconnect to search again."
          }
        : {
            library_status: state.library_freshness === null ? "idle" : "ready",
            library_error: null,
            library_freshness: state.library_freshness === null
              ? null
              : { ...state.library_freshness, source: "cached", stale: true, partial: true }
          })
    })
  } else if (isCurrent(connectionGeneration)) {
    yield* Effect.sync(() => viewStore.set({ library_error: result.error.message }))
  }
})

export const reconnectLibrary = Effect.gen(function*() {
  const client = yield* ConnectionClient
  const connectionGeneration = viewStore.beginConnectionTransition("connecting")
  const result = yield* client.connect()
  if (!result.ok) {
    const status = yield* client.connectionStatus()
    if (isCurrent(connectionGeneration) && status.ok) {
      yield* Effect.sync(() => viewStore.publishConnection(status.data, connectionGeneration))
    }
    if (isCurrent(connectionGeneration)) {
      yield* Effect.sync(() => {
        const state = viewStore.getState()
        const filtered = state.library_query.trim() !== ""
        viewStore.set(filtered
          ? {
              library_entries: [],
              library_cursor: null,
              library_has_more: false,
              library_freshness: null,
              library_status: "error",
              library_error: result.error.message
            }
          : {
              library_status: state.library_freshness === null ? "idle" : "ready",
              library_error: result.error.message,
              ...(state.library_entries.length > 0 && state.library_freshness !== null
                ? { library_freshness: { ...state.library_freshness, source: "cached", stale: true, partial: true } }
                : {})
            })
      })
    }
    return
  }
  if (!isCurrent(connectionGeneration)) return
  yield* Effect.sync(() => viewStore.publishConnection(result.data, connectionGeneration))
  yield* loadLibrary()
})

export const loadConnectionStatus = Effect.gen(function*() {
  const client = yield* PrototypeClient
  const connectionGeneration = viewStore.getState().connection_generation
  const result = yield* client.connectionStatus()
  if (result.ok) {
    yield* Effect.sync(() => viewStore.publishConnection(result.data, connectionGeneration))
    yield* loadOpenJournal
  }
})

export const loadOpenJournal = Effect.gen(function*() {
  const clientOption = yield* Effect.serviceOption(OpenJournalClient)
  if (Option.isNone(clientOption)) return
  const client = clientOption.value
  const initialState = viewStore.getState()
  const connectionGeneration = initialState.connection_generation
  const ownerInstanceId = verifiedInstanceId(initialState)
  const result = yield* client.list()
  if (result.ok) {
    if (!isCurrent(connectionGeneration) || verifiedInstanceId(viewStore.getState()) !== ownerInstanceId) return
    yield* Effect.sync(() => viewStore.set({ open_journal: result.data, open_journal_error: null }))
  } else if (isCurrent(connectionGeneration) && verifiedInstanceId(viewStore.getState()) === ownerInstanceId) {
    yield* Effect.sync(() => viewStore.set({ open_journal_error: result.error.message }))
  }
})

const mutateOpenJournal = (
  row: Pick<OpenJournalView, "instanceId" | "actionId">,
  command: "dismiss_unknown" | "discard_held"
) =>
  Effect.gen(function*() {
    const client = yield* OpenJournalClient
    const result = yield* client.recover({
      instance_id: row.instanceId,
      action_id: row.actionId,
      command
    })
    if (result.ok) {
      yield* loadOpenJournal
    } else {
      yield* Effect.sync(() => viewStore.set({ open_journal_error: result.error.message }))
    }
  })

export const dismissUnknownOpenJournal = (row: Pick<OpenJournalView, "instanceId" | "actionId">) =>
  mutateOpenJournal(row, "dismiss_unknown")

export const discardHeldOpenEvent = (row: Pick<OpenJournalView, "instanceId" | "actionId">) =>
  mutateOpenJournal(row, "discard_held")

export const saveNote = (text: string) =>
  Effect.gen(function*() {
    const client = yield* PrototypeClient
    const state = viewStore.getState()
    const connectionGeneration = state.connection_generation
    if (state.base_revision === null) return
    if (state.base_epoch === null || state.base_epoch !== state.epoch) {
      yield* Effect.sync(() =>
        viewStore.set({ outcome: { kind: "error", message: "reload the current note before saving after reconnect" } })
      )
      return
    }

    const result = yield* client.editNote({
      note_id: NOTE_ID,
      text,
      expected_revision: state.base_revision,
      base_epoch: state.base_epoch,
      operation_id: newOperationId()
    })

    if (result.ok) {
      if (!isCurrent(connectionGeneration)) return
      yield* Effect.sync(() =>
        viewStore.set({
          note: result.data,
          outcome: { kind: "committed", revision: result.data.revision }
        })
      )
    } else if (result.error.code === "revision_conflict") {
      if (!isCurrent(connectionGeneration)) return
      yield* Effect.sync(() =>
        viewStore.set({
          outcome: { kind: "conflict", current_revision: result.error.current_revision ?? "unknown" }
        })
      )
    } else {
      if (!isCurrent(connectionGeneration)) return
      yield* Effect.sync(() =>
        viewStore.set({ outcome: { kind: "error", message: result.error.message } })
      )
    }
  })

export const saveLocalDraft = Effect.gen(function*() {
  const client = yield* PrototypeClient
  const state = viewStore.getState()
  const ownerInstanceId = verifiedInstanceId(state)
  if (state.base_revision === null || state.base_epoch === null || ownerInstanceId === null) {
    yield* Effect.sync(() =>
      viewStore.set({ outcome: { kind: "error", message: "load the current note before saving a local draft" } })
    )
    return
  }
  const result = yield* client.saveDraft({
    note_id: NOTE_ID,
    form_id: FORM_ID,
    text: state.form_text,
    expected_local_revision: state.draft_local_revision,
    base_server_revision: state.base_revision,
    base_epoch: state.base_epoch
  })
  if (result.ok) {
    const current = viewStore.getState()
    if (verifiedInstanceId(current) !== ownerInstanceId || result.data.instance_id !== ownerInstanceId) return
    yield* Effect.sync(() =>
      viewStore.set({
        saved_draft: result.data,
        draft_local_revision: result.data.local_revision,
        outcome: { kind: "draft_saved", local_revision: result.data.local_revision }
      })
    )
  } else if (result.error.code === "draft_conflict") {
    if (verifiedInstanceId(viewStore.getState()) !== ownerInstanceId) return
    yield* Effect.sync(() =>
      viewStore.set({
        outcome: {
          kind: "draft_conflict",
          current_local_revision: result.error.current_local_revision ?? "unknown"
        }
      })
    )
  } else {
    if (verifiedInstanceId(viewStore.getState()) !== ownerInstanceId) return
    yield* Effect.sync(() => viewStore.set({ outcome: { kind: "error", message: result.error.message } }))
  }
})

export const loadSavedDraft = Effect.gen(function*() {
  const client = yield* PrototypeClient
  const initialState = viewStore.getState()
  const editVersionAtStart = initialState.form_edit_version
  const ownerInstanceId = verifiedInstanceId(initialState)
  const result = yield* client.loadDraft({ note_id: NOTE_ID, form_id: FORM_ID })
  if (verifiedInstanceId(viewStore.getState()) !== ownerInstanceId) return
  if (!result.ok) {
    yield* Effect.sync(() => viewStore.set({ outcome: { kind: "error", message: result.error.message } }))
    return
  }
  const draft = result.data
  if (draft !== null && draft.instance_id !== ownerInstanceId) return
  if (draft === null) {
    yield* Effect.sync(() =>
      viewStore.set({ saved_draft: null, outcome: { kind: "error", message: "no saved local draft" } })
    )
    return
  }
  if (!("text" in draft)) {
    yield* Effect.sync(() =>
      viewStore.set({
        saved_draft: null,
        draft_local_revision: draft.local_revision,
        outcome: { kind: "error", message: "no saved local draft" }
      })
    )
    return
  }
  yield* Effect.sync(() => {
    const copied = viewStore.getState().form_edit_version === editVersionAtStart
    viewStore.set({
      saved_draft: draft,
      draft_local_revision: draft.local_revision,
      ...(copied
        ? {
            form_text: draft.text,
            base_revision: draft.base_server_revision,
            base_epoch: draft.base_epoch
          }
        : {}),
      outcome: { kind: "draft_loaded", copied }
    })
  })
})

export const discardSavedDraft = Effect.gen(function*() {
  const client = yield* PrototypeClient
  const state = viewStore.getState()
  const ownerInstanceId = verifiedInstanceId(state)
  const result = yield* client.discardDraft({
    note_id: NOTE_ID,
    form_id: FORM_ID,
    expected_local_revision: state.draft_local_revision
  })
  if (result.ok) {
    const current = viewStore.getState()
    if (verifiedInstanceId(current) !== ownerInstanceId || result.data.instance_id !== ownerInstanceId) return
    yield* Effect.sync(() =>
      viewStore.set({
        saved_draft: null,
        draft_local_revision: result.data.local_revision,
        outcome: { kind: "draft_discarded", local_revision: result.data.local_revision }
      })
    )
  } else if (result.error.code === "draft_conflict") {
    if (verifiedInstanceId(viewStore.getState()) !== ownerInstanceId) return
    yield* Effect.sync(() =>
      viewStore.set({
        outcome: {
          kind: "draft_conflict",
          current_local_revision: result.error.current_local_revision ?? "unknown"
        }
      })
    )
  } else {
    if (verifiedInstanceId(viewStore.getState()) !== ownerInstanceId) return
    yield* Effect.sync(() => viewStore.set({ outcome: { kind: "error", message: result.error.message } }))
  }
})

export const loadRecovery = Effect.gen(function*() {
  const client = yield* PrototypeClient
  const ownerInstanceId = verifiedInstanceId(viewStore.getState())
  const result = yield* client.listCommandAttempts()
  if (result.ok) {
    if (
      verifiedInstanceId(viewStore.getState()) !== ownerInstanceId ||
      result.data.some((attempt) => attempt.instance_id !== ownerInstanceId)
    ) return
    yield* Effect.sync(() => viewStore.set({ recovery_attempts: result.data, outcome: null }))
  } else {
    if (verifiedInstanceId(viewStore.getState()) === ownerInstanceId) {
      yield* Effect.sync(() => viewStore.set({ outcome: { kind: "error", message: result.error.message } }))
    }
  }
})

export const reconcileRecovery = (operationId: string) =>
  Effect.gen(function*() {
    const client = yield* PrototypeClient
    const connectionGeneration = viewStore.getState().connection_generation
    const result = yield* client.reconcileCommand(operationId)
    if (result.ok) {
      if (!isCurrent(connectionGeneration)) return
      yield* Effect.sync(() =>
        viewStore.set({
          recovery_result: result.data,
          recovery_attempts: viewStore
            .getState()
            .recovery_attempts.map((attempt) =>
              attempt.operation_id === operationId ? result.data.attempt : attempt
            ),
          outcome: { kind: "reconciled", requires_reconciliation: result.data.requires_reconciliation }
        })
      )
    } else {
      if (isCurrent(connectionGeneration)) {
        yield* Effect.sync(() => viewStore.set({ outcome: { kind: "error", message: result.error.message } }))
      }
    }
  })

export const dismissRecovery = (operationId: string) =>
  Effect.gen(function*() {
    const client = yield* PrototypeClient
    const initialState = viewStore.getState()
    const ownerInstanceId = initialState.recovery_attempts.find(
      (attempt) => attempt.operation_id === operationId
    )?.instance_id ?? verifiedInstanceId(initialState)
    const result = yield* client.dismissCommand(operationId)
    if (result.ok) {
      const current = viewStore.getState()
      if (verifiedInstanceId(current) !== ownerInstanceId || result.data.instance_id !== ownerInstanceId) return
      const state = viewStore.getState()
      yield* Effect.sync(() =>
        viewStore.set({
          recovery_attempts: state.recovery_attempts.filter((attempt) => attempt.operation_id !== operationId),
          recovery_result:
            state.recovery_result?.attempt.operation_id === operationId
              ? null
              : state.recovery_result,
          outcome: null
        })
      )
    } else {
      if (verifiedInstanceId(viewStore.getState()) === ownerInstanceId) {
        yield* Effect.sync(() => viewStore.set({ outcome: { kind: "error", message: result.error.message } }))
      }
    }
  })

export const disconnect = Effect.gen(function*() {
  const client = yield* PrototypeClient
  const connectionGeneration = viewStore.beginConnectionTransition("disconnected")
  const result = yield* client.disconnect()
  if (result.ok) {
    yield* Effect.sync(() => viewStore.publishConnection(result.data, connectionGeneration))
  } else if (isCurrent(connectionGeneration)) {
    yield* Effect.sync(() => viewStore.set({ outcome: { kind: "error", message: result.error.message } }))
  }
})

export const reconnect = Effect.gen(function*() {
  const client = yield* PrototypeClient
  const connectionGeneration = viewStore.beginConnectionTransition("connecting")
  const result = yield* client.connect()
  if (!result.ok) {
    const status = yield* client.connectionStatus()
    if (!isCurrent(connectionGeneration)) return
    if (status.ok) {
      yield* Effect.sync(() => viewStore.publishConnection(status.data, connectionGeneration))
    }
    if (isCurrent(connectionGeneration)) {
      yield* Effect.sync(() => viewStore.set({ outcome: { kind: "error", message: result.error.message } }))
    }
    return
  }
  if (!isCurrent(connectionGeneration)) return
  yield* Effect.sync(() => viewStore.publishConnection(result.data, connectionGeneration))
  if (!isCurrent(connectionGeneration)) return
  yield* loadOpenJournal
  yield* loadNoteWithOptions(true)
})
