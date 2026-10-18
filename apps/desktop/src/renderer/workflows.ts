import { Effect } from "effect"
import { PrototypeClient } from "./client"
import { viewStore } from "./store"

export const NOTE_ID = "note-1"

const newOperationId = (): string => crypto.randomUUID()

/**
 * Loads the note and captures the revision the form edits from. `base_revision`
 * is intentionally not rebased after a commit, so a second save from the same
 * captured revision reproduces the stale-revision conflict a second device
 * would see.
 */
export const loadNote = Effect.gen(function*() {
  const client = yield* PrototypeClient
  yield* Effect.sync(() => viewStore.set({ status: "loading", outcome: null }))

  const handshake = yield* client.handshake()
  if (!handshake.ok) {
    yield* Effect.sync(() =>
      viewStore.set({ status: "error", outcome: { kind: "error", message: handshake.error.message } })
    )
    return
  }

  const note = yield* client.getNote(NOTE_ID)
  if (!note.ok) {
    yield* Effect.sync(() =>
      viewStore.set({ status: "error", outcome: { kind: "error", message: note.error.message } })
    )
    return
  }

  yield* Effect.sync(() =>
    viewStore.set({
      status: "ready",
      instance_id: handshake.data.instance_id,
      epoch: handshake.data.epoch,
      note: note.data,
      base_revision: note.data.revision,
      outcome: null
    })
  )
})

export const saveNote = (text: string) =>
  Effect.gen(function*() {
    const client = yield* PrototypeClient
    const state = viewStore.getState()
    if (state.base_revision === null) return

    const result = yield* client.editNote({
      note_id: NOTE_ID,
      text,
      expected_revision: state.base_revision,
      operation_id: newOperationId()
    })

    if (result.ok) {
      yield* Effect.sync(() =>
        viewStore.set({
          note: result.data,
          outcome: { kind: "committed", revision: result.data.revision }
        })
      )
    } else if (result.error.code === "revision_conflict") {
      yield* Effect.sync(() =>
        viewStore.set({
          outcome: { kind: "conflict", current_revision: result.error.current_revision ?? "unknown" }
        })
      )
    } else {
      yield* Effect.sync(() =>
        viewStore.set({ outcome: { kind: "error", message: result.error.message } })
      )
    }
  })
