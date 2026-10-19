import { Effect } from "effect"
import type { ConnectionStatusView } from "@henshin/contracts"
import { PrototypeClient } from "./client"
import { viewStore } from "./store"

export const NOTE_ID = "note-1"
export const FORM_ID = "synthetic-note"

const newOperationId = (): string => crypto.randomUUID()

const isCurrent = (generation: number): boolean =>
  viewStore.getState().connection_generation === generation

const connectedStatus = (instanceId: string, epoch: string): ConnectionStatusView => ({
  state: "connected",
  instance_id: instanceId,
  epoch,
  reason: null
})

const hasRetainedFormIntent = (state: ReturnType<typeof viewStore.getState>): boolean => {
  if (state.saved_draft !== null) return true
  if (state.note !== null) return state.form_text !== state.note.text
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

    const result = yield* client.editNote({
      note_id: NOTE_ID,
      text,
      expected_revision: state.base_revision,
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
  const connectionGeneration = state.connection_generation
  if (state.base_revision === null || state.epoch === null || state.instance_id === null) {
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
    base_epoch: state.epoch
  })
  if (result.ok) {
    if (!isCurrent(connectionGeneration)) return
    yield* Effect.sync(() =>
      viewStore.set({
        saved_draft: result.data,
        draft_local_revision: result.data.local_revision,
        outcome: { kind: "draft_saved", local_revision: result.data.local_revision }
      })
    )
  } else if (result.error.code === "draft_conflict") {
    if (!isCurrent(connectionGeneration)) return
    yield* Effect.sync(() =>
      viewStore.set({
        outcome: {
          kind: "draft_conflict",
          current_local_revision: result.error.current_local_revision ?? "unknown"
        }
      })
    )
  } else {
    if (!isCurrent(connectionGeneration)) return
    yield* Effect.sync(() => viewStore.set({ outcome: { kind: "error", message: result.error.message } }))
  }
})

export const loadSavedDraft = Effect.gen(function*() {
  const client = yield* PrototypeClient
  const editVersionAtStart = viewStore.getState().form_edit_version
  const connectionGeneration = viewStore.getState().connection_generation
  const result = yield* client.loadDraft({ note_id: NOTE_ID, form_id: FORM_ID })
  if (!isCurrent(connectionGeneration)) return
  if (!result.ok) {
    yield* Effect.sync(() => viewStore.set({ outcome: { kind: "error", message: result.error.message } }))
    return
  }
  const draft = result.data
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
      ...(copied ? { form_text: draft.text } : {}),
      outcome: { kind: "draft_loaded", copied }
    })
  })
})

export const discardSavedDraft = Effect.gen(function*() {
  const client = yield* PrototypeClient
  const state = viewStore.getState()
  const connectionGeneration = state.connection_generation
  const result = yield* client.discardDraft({
    note_id: NOTE_ID,
    form_id: FORM_ID,
    expected_local_revision: state.draft_local_revision
  })
  if (result.ok) {
    if (!isCurrent(connectionGeneration)) return
    yield* Effect.sync(() =>
      viewStore.set({
        saved_draft: null,
        draft_local_revision: result.data.local_revision,
        outcome: { kind: "draft_discarded", local_revision: result.data.local_revision }
      })
    )
  } else if (result.error.code === "draft_conflict") {
    if (!isCurrent(connectionGeneration)) return
    yield* Effect.sync(() =>
      viewStore.set({
        outcome: {
          kind: "draft_conflict",
          current_local_revision: result.error.current_local_revision ?? "unknown"
        }
      })
    )
  } else {
    if (!isCurrent(connectionGeneration)) return
    yield* Effect.sync(() => viewStore.set({ outcome: { kind: "error", message: result.error.message } }))
  }
})

export const loadRecovery = Effect.gen(function*() {
  const client = yield* PrototypeClient
  const connectionGeneration = viewStore.getState().connection_generation
  const result = yield* client.listCommandAttempts()
  if (result.ok) {
    if (!isCurrent(connectionGeneration)) return
    yield* Effect.sync(() => viewStore.set({ recovery_attempts: result.data, outcome: null }))
  } else {
    if (isCurrent(connectionGeneration)) {
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
    const connectionGeneration = viewStore.getState().connection_generation
    const result = yield* client.dismissCommand(operationId)
    if (result.ok) {
      if (!isCurrent(connectionGeneration)) return
      yield* Effect.sync(() =>
        viewStore.set({
          recovery_attempts: viewStore
            .getState()
            .recovery_attempts.filter((attempt) => attempt.operation_id !== operationId),
          outcome: null
        })
      )
    } else {
      if (isCurrent(connectionGeneration)) {
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
