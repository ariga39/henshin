import { Effect, Fiber } from "effect"
import type {
  ConnectionStatusView,
  RootPreviewRequest,
  RootPreviewResult,
  ScanTask
} from "@henshin/contracts"
import { PrototypeClient, RootPreviewClient, ScanReviewClient } from "./client"
import { viewStore, type ViewState } from "./store"

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
  yield* Effect.sync(() => viewStore.set({
    staged_discoveries: candidates.data,
    scan_status: "ready",
    scan_error: null
  }))
  return true
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

    const operationId = state.scan_release_candidate_id === candidateId
      ? state.scan_release_operation_id ?? newOperationId()
      : newOperationId()
    yield* Effect.sync(() => viewStore.set({
      scan_release_status: "loading",
      scan_release_candidate_id: candidateId,
      scan_release_operation_id: operationId,
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
      yield* Effect.sync(() => viewStore.set({
        scan_release_status: "error",
        scan_release_operation_id: result.error.code === "revision_conflict" || result.error.code === "not_found"
          ? null
          : operationId,
        scan_release_error: result.error.message
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
        scan_release_error: null
      })
    })
  })

const watchScanResultsFor = (client: ScanReviewClient["Service"]) => Effect.gen(function*() {
  while (true) {
    const loaded = yield* loadScanResultsFor(client)
    if (!loaded || !viewStore.getState().scan_tasks.some(scanIsActive)) return
    yield* Effect.sleep("250 millis")
  }
})

let scanResultsWatcher: Fiber.Fiber<void, never> | null = null

export const watchHeldScans = Effect.gen(function*() {
  const existing = scanResultsWatcher
  if (existing !== null) return yield* Fiber.join(existing)

  const client = yield* ScanReviewClient
  const watcher = yield* Effect.forkChild(watchScanResultsFor(client))
  scanResultsWatcher = watcher
  yield* Fiber.join(watcher).pipe(
    Effect.ensuring(Effect.sync(() => {
      if (scanResultsWatcher === watcher) scanResultsWatcher = null
    }))
  )
})

export const retryScanResults = Effect.gen(function*() {
  const loaded = yield* loadScanResults
  if (loaded && viewStore.getState().scan_tasks.some(scanIsActive)) yield* watchHeldScans
})

export const loadRootWorkspace = Effect.gen(function*() {
  yield* loadRoots
  const loaded = yield* loadScanResults
  if (loaded && viewStore.getState().scan_tasks.some(scanIsActive)) yield* watchHeldScans
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

export const startHeldScan = (rootId: string) =>
  Effect.gen(function*() {
    const client = yield* RootPreviewClient
    const state = viewStore.getState()
    const root = state.root_saved_roots.find((candidate) => candidate.root_id === rootId)
    const preview = state.root_preview
    if (root === undefined || !isSavedDiscovery(preview) || preview.root_id !== rootId) return
    if (!state.scan_hold_new_discoveries) return

    yield* Effect.sync(() => viewStore.set({ scan_start_status: "loading", scan_start_error: null }))
    const result = yield* client.command({
      root_id: rootId,
      operation_id: newOperationId(),
      instance_id: preview.instance_id,
      epoch: preview.epoch,
      expected_mapping_revision: root.mapping_revision,
      expected_policy_revision: preview.policy_revision,
      command: { type: "start-scan", mode: "manual", hold_new_discoveries: true }
    })
    if (!result.ok) {
      if (result.error.code === "revision_conflict") yield* loadRoots
      yield* Effect.sync(() => viewStore.set({ scan_start_status: "error", scan_start_error: result.error.message }))
      return
    }
    if (!("task" in result.data)) {
      yield* Effect.sync(() => viewStore.set({
        scan_start_status: "error",
        scan_start_error: "server returned a root policy result instead of a scan task"
      }))
      return
    }
    const submittedTask = result.data.task
    yield* Effect.sync(() => {
      const tasks = viewStore.getState().scan_tasks
      viewStore.set({
        scan_tasks: tasks.some((task) => task.task_id === submittedTask.task_id)
          ? tasks.map((task) => task.task_id === submittedTask.task_id ? submittedTask : task)
          : [...tasks, submittedTask],
        scan_start_status: "idle",
        scan_start_error: null
      })
    })
    yield* watchHeldScans
  })

export const canSaveRoot = (state: ViewState): boolean => {
  const preview = state.root_preview
  return preview !== null && "children" in preview &&
    state.root_preview_status === "ready" &&
    state.root_save_status !== "loading" &&
    state.root_preview_path === preview.selected_server_path &&
    state.root_label.length > 0 &&
    !state.root_saved_roots.some((root) => root.canonical_server_path === preview.preview_identity.canonical_server_path)
}

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

export const loadConnectionStatus = Effect.gen(function*() {
  const client = yield* PrototypeClient
  const connectionGeneration = viewStore.getState().connection_generation
  const result = yield* client.connectionStatus()
  if (result.ok) {
    yield* Effect.sync(() => viewStore.publishConnection(result.data, connectionGeneration))
  }
})

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
  yield* loadNoteWithOptions(true)
})
