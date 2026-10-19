import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { HandshakeView, NoteView, SavedDraft } from "@henshin/contracts"
import { PrototypeClient, type Result } from "../../desktop/src/renderer/client"
import { loadNote, loadSavedDraft } from "../../desktop/src/renderer/workflows"
import { viewStore } from "../../desktop/src/renderer/store"

const handshake: HandshakeView = {
  instance_id: "11111111-1111-4111-8111-111111111111",
  epoch: "22222222-2222-4222-8222-222222222222"
}

const note: NoteView = { note_id: "note-1", text: "server-text", revision: "4" }
const draft: SavedDraft = {
  instance_id: handshake.instance_id,
  note_id: "note-1",
  form_id: "synthetic-note",
  text: "saved-draft-text",
  local_revision: "3",
  base_server_revision: "2",
  base_epoch: handshake.epoch
}

const deferred = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const resetView = () => {
  viewStore.set({
    status: "idle",
    instance_id: null,
    epoch: null,
    note: null,
    base_revision: null,
    form_text: "",
    form_edit_version: 0,
    draft_local_revision: "0",
    saved_draft: null,
    outcome: null
  })
}

afterEach(resetView)

describe("explicit renderer load races", () => {
  it("does not replace text typed while the current-note load is outstanding", async () => {
    const pendingNote = deferred<Result<NoteView>>()
    const client = PrototypeClient.of({
      handshake: () => Effect.succeed({ ok: true, data: handshake }),
      getNote: () => Effect.promise(() => pendingNote.promise),
      editNote: () => Effect.succeed({ ok: true, data: note }),
      saveDraft: () => Effect.succeed({ ok: true, data: draft }),
      loadDraft: () => Effect.succeed({ ok: true, data: null }),
      discardDraft: () => Effect.succeed({ ok: true, data: {
        instance_id: handshake.instance_id,
        note_id: "note-1",
        form_id: "synthetic-note",
        local_revision: "4"
      } })
    })

    const loading = Effect.runPromise(Effect.provide(loadNote, Layer.succeed(PrototypeClient, client)))
    await Promise.resolve()
    viewStore.editFormText("typed-during-load")
    pendingNote.resolve({ ok: true, data: note })
    await loading

    expect(viewStore.getState()).toMatchObject({
      form_text: "typed-during-load",
      note,
      base_revision: "4"
    })
  })

  it("does not replace text typed while saved-draft load is outstanding", async () => {
    const pendingDraft = deferred<Result<SavedDraft | null>>()
    const client = PrototypeClient.of({
      handshake: () => Effect.succeed({ ok: true, data: handshake }),
      getNote: () => Effect.succeed({ ok: true, data: note }),
      editNote: () => Effect.succeed({ ok: true, data: note }),
      saveDraft: () => Effect.succeed({ ok: true, data: draft }),
      loadDraft: () => Effect.promise(() => pendingDraft.promise),
      discardDraft: () => Effect.succeed({ ok: true, data: {
        instance_id: handshake.instance_id,
        note_id: "note-1",
        form_id: "synthetic-note",
        local_revision: "4"
      } })
    })

    viewStore.set({
      status: "ready",
      instance_id: handshake.instance_id,
      epoch: handshake.epoch,
      note,
      base_revision: note.revision,
      form_text: "initial",
      form_edit_version: 0
    })
    const loading = Effect.runPromise(Effect.provide(loadSavedDraft, Layer.succeed(PrototypeClient, client)))
    await Promise.resolve()
    viewStore.editFormText("typed-during-draft-load")
    pendingDraft.resolve({ ok: true, data: draft })
    await loading

    expect(viewStore.getState()).toMatchObject({
      form_text: "typed-during-draft-load",
      saved_draft: draft,
      outcome: { kind: "draft_loaded", copied: false }
    })
  })
})
