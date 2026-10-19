import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { ConnectionStatusView, HandshakeView, NoteView, SavedDraft } from "@henshin/contracts"
import { PrototypeClient, type Result } from "../../desktop/src/renderer/client"
import {
  disconnect,
  loadConnectionStatus,
  loadNote,
  loadRecovery,
  loadSavedDraft,
  reconnect
} from "../../desktop/src/renderer/workflows"
import { viewStore } from "../../desktop/src/renderer/store"

const handshake: HandshakeView = {
  instance_id: "11111111-1111-4111-8111-111111111111",
  epoch: "22222222-2222-4222-8222-222222222222"
}

const note: NoteView = { note_id: "note-1", text: "server-text", revision: "4" }
const refreshedNote: NoteView = { note_id: "note-1", text: "fresh-server-text", revision: "5" }
const draft: SavedDraft = {
  instance_id: handshake.instance_id,
  note_id: "note-1",
  form_id: "synthetic-note",
  text: "saved-draft-text",
  local_revision: "3",
  base_server_revision: "2",
  base_epoch: handshake.epoch
}

const connected: ConnectionStatusView = {
  state: "connected",
  instance_id: handshake.instance_id,
  epoch: handshake.epoch,
  reason: null
}

const reconnectClient = (getNote: () => Effect.Effect<Result<NoteView>>) => PrototypeClient.of({
  handshake: () => Effect.succeed({ ok: true, data: handshake }),
  connect: () => Effect.succeed({ ok: true, data: connected }),
  disconnect: () => Effect.succeed({
    ok: true,
    data: { state: "disconnected", instance_id: handshake.instance_id, epoch: null, reason: "explicit_disconnect" }
  }),
  connectionStatus: () => Effect.succeed({ ok: true, data: connected }),
  getNote,
  editNote: () => Effect.succeed({ ok: true, data: note }),
  saveDraft: () => Effect.succeed({ ok: true, data: draft }),
  loadDraft: () => Effect.succeed({ ok: true, data: null }),
  discardDraft: () => Effect.succeed({ ok: true, data: {
    instance_id: handshake.instance_id,
    note_id: "note-1",
    form_id: "synthetic-note",
    local_revision: "1"
  } }),
  listCommandAttempts: () => Effect.succeed({ ok: true, data: [] }),
  reconcileCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } }),
  dismissCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } })
})

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
    recovery_attempts: [],
    recovery_result: null,
    outcome: null,
    connection: { state: "disconnected", instance_id: null, epoch: null, reason: null },
    connection_generation: 0
  })
}

afterEach(resetView)

describe("explicit renderer load races", () => {
  it("does not replace text typed while the current-note load is outstanding", async () => {
    const pendingNote = deferred<Result<NoteView>>()
    const client = PrototypeClient.of({
      handshake: () => Effect.succeed({ ok: true, data: handshake }),
      connect: () => Effect.succeed({ ok: true, data: { state: "connected", instance_id: handshake.instance_id, epoch: handshake.epoch, reason: null } }),
      disconnect: () => Effect.succeed({ ok: true, data: { state: "disconnected", instance_id: handshake.instance_id, epoch: null, reason: "explicit_disconnect" } }),
      connectionStatus: () => Effect.succeed({ ok: true, data: { state: "connected", instance_id: handshake.instance_id, epoch: handshake.epoch, reason: null } }),
      getNote: () => Effect.promise(() => pendingNote.promise),
      editNote: () => Effect.succeed({ ok: true, data: note }),
      saveDraft: () => Effect.succeed({ ok: true, data: draft }),
      loadDraft: () => Effect.succeed({ ok: true, data: null }),
      discardDraft: () => Effect.succeed({ ok: true, data: {
        instance_id: handshake.instance_id,
        note_id: "note-1",
        form_id: "synthetic-note",
        local_revision: "4"
      } }),
      listCommandAttempts: () => Effect.succeed({ ok: true, data: [] }),
      reconcileCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } }),
      dismissCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } })
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
      connect: () => Effect.succeed({ ok: true, data: { state: "connected", instance_id: handshake.instance_id, epoch: handshake.epoch, reason: null } }),
      disconnect: () => Effect.succeed({ ok: true, data: { state: "disconnected", instance_id: handshake.instance_id, epoch: null, reason: "explicit_disconnect" } }),
      connectionStatus: () => Effect.succeed({ ok: true, data: { state: "connected", instance_id: handshake.instance_id, epoch: handshake.epoch, reason: null } }),
      getNote: () => Effect.succeed({ ok: true, data: note }),
      editNote: () => Effect.succeed({ ok: true, data: note }),
      saveDraft: () => Effect.succeed({ ok: true, data: draft }),
      loadDraft: () => Effect.promise(() => pendingDraft.promise),
      discardDraft: () => Effect.succeed({ ok: true, data: {
        instance_id: handshake.instance_id,
        note_id: "note-1",
        form_id: "synthetic-note",
        local_revision: "4"
      } }),
      listCommandAttempts: () => Effect.succeed({ ok: true, data: [] }),
      reconcileCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } }),
      dismissCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } })
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

  it("fences a held read response as soon as disconnect is requested", async () => {
    const pendingNote = deferred<Result<NoteView>>()
    const pendingDisconnect = deferred<Result<ConnectionStatusView>>()
    const client = PrototypeClient.of({
      handshake: () => Effect.succeed({ ok: true, data: handshake }),
      connect: () => Effect.succeed({ ok: true, data: connected }),
      disconnect: () => Effect.promise(() => pendingDisconnect.promise),
      connectionStatus: () => Effect.succeed({ ok: true, data: connected }),
      getNote: () => Effect.promise(() => pendingNote.promise),
      editNote: () => Effect.succeed({ ok: true, data: note }),
      saveDraft: () => Effect.succeed({ ok: true, data: draft }),
      loadDraft: () => Effect.succeed({ ok: true, data: null }),
      discardDraft: () => Effect.succeed({ ok: true, data: {
        instance_id: handshake.instance_id,
        note_id: "note-1",
        form_id: "synthetic-note",
        local_revision: "1"
      } }),
      listCommandAttempts: () => Effect.succeed({ ok: true, data: [] }),
      reconcileCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } }),
      dismissCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } })
    })

    const loading = Effect.runPromise(Effect.provide(loadNote, Layer.succeed(PrototypeClient, client)))
    await Promise.resolve()
    const disconnecting = Effect.runPromise(Effect.provide(disconnect, Layer.succeed(PrototypeClient, client)))
    await Promise.resolve()
    pendingNote.resolve({ ok: true, data: note })
    await loading

    expect(viewStore.getState()).toMatchObject({
      connection: { state: "disconnected" },
      note: null,
      status: "loading"
    })

    pendingDisconnect.resolve({
      ok: true,
      data: { state: "disconnected", instance_id: handshake.instance_id, epoch: null, reason: "explicit_disconnect" }
    })
    await disconnecting
  })

  it("fences a held recovery response during a connection transition", async () => {
    const pendingRecovery = deferred<Result<ReadonlyArray<never>>>()
    const client = PrototypeClient.of({
      handshake: () => Effect.succeed({ ok: true, data: handshake }),
      connect: () => Effect.succeed({ ok: true, data: connected }),
      disconnect: () => Effect.succeed({
        ok: true,
        data: { state: "disconnected", instance_id: handshake.instance_id, epoch: null, reason: "explicit_disconnect" }
      }),
      connectionStatus: () => Effect.succeed({ ok: true, data: connected }),
      getNote: () => Effect.succeed({ ok: true, data: note }),
      editNote: () => Effect.succeed({ ok: true, data: note }),
      saveDraft: () => Effect.succeed({ ok: true, data: draft }),
      loadDraft: () => Effect.succeed({ ok: true, data: null }),
      discardDraft: () => Effect.succeed({ ok: true, data: {
        instance_id: handshake.instance_id,
        note_id: "note-1",
        form_id: "synthetic-note",
        local_revision: "1"
      } }),
      listCommandAttempts: () => Effect.promise(() => pendingRecovery.promise),
      reconcileCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } }),
      dismissCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } })
    })

    viewStore.set({ connection: connected, connection_generation: 1 })
    const loading = Effect.runPromise(Effect.provide(loadRecovery, Layer.succeed(PrototypeClient, client)))
    await Promise.resolve()
    viewStore.beginConnectionTransition("disconnected")
    pendingRecovery.resolve({ ok: true, data: [] })
    await loading

    expect(viewStore.getState()).toMatchObject({
      connection: { state: "disconnected" },
      recovery_attempts: []
    })
  })

  it("refreshes server context on reconnect without rebasing retained unsaved text", async () => {
    const client = PrototypeClient.of({
      handshake: () => Effect.succeed({ ok: true, data: { ...handshake, epoch: "33333333-3333-4333-8333-333333333333" } }),
      connect: () => Effect.succeed({
        ok: true,
        data: { state: "connected", instance_id: handshake.instance_id, epoch: "33333333-3333-4333-8333-333333333333", reason: null }
      }),
      disconnect: () => Effect.succeed({
        ok: true,
        data: { state: "disconnected", instance_id: handshake.instance_id, epoch: null, reason: "explicit_disconnect" }
      }),
      connectionStatus: () => Effect.succeed({ ok: true, data: connected }),
      getNote: () => Effect.succeed({ ok: true, data: refreshedNote }),
      editNote: () => Effect.succeed({ ok: true, data: refreshedNote }),
      saveDraft: () => Effect.succeed({ ok: true, data: draft }),
      loadDraft: () => Effect.succeed({ ok: true, data: null }),
      discardDraft: () => Effect.succeed({ ok: true, data: {
        instance_id: handshake.instance_id,
        note_id: "note-1",
        form_id: "synthetic-note",
        local_revision: "1"
      } }),
      listCommandAttempts: () => Effect.succeed({ ok: true, data: [] }),
      reconcileCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } }),
      dismissCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } })
    })

    viewStore.set({
      status: "ready",
      connection: { state: "disconnected", instance_id: handshake.instance_id, epoch: null, reason: "explicit_disconnect" },
      connection_generation: 4,
      instance_id: handshake.instance_id,
      epoch: handshake.epoch,
      note,
      base_revision: note.revision,
      form_text: "retained-local-text",
      form_edit_version: 1
    })

    await Effect.runPromise(Effect.provide(reconnect, Layer.succeed(PrototypeClient, client)))

    expect(viewStore.getState()).toMatchObject({
      connection: { state: "connected" },
      note: refreshedNote,
      form_text: "retained-local-text",
      base_revision: note.revision,
      epoch: "33333333-3333-4333-8333-333333333333"
    })
  })

  it("copies a refreshed server note into a clean form after reconnect", async () => {
    const client = reconnectClient(() => Effect.succeed({ ok: true, data: refreshedNote }))
    viewStore.set({
      status: "ready",
      connection: { state: "disconnected", instance_id: handshake.instance_id, epoch: null, reason: "explicit_disconnect" },
      connection_generation: 1,
      instance_id: handshake.instance_id,
      epoch: handshake.epoch,
      note,
      base_revision: note.revision,
      form_text: note.text,
      form_edit_version: 0
    })

    await Effect.runPromise(Effect.provide(reconnect, Layer.succeed(PrototypeClient, client)))

    expect(viewStore.getState()).toMatchObject({
      note: refreshedNote,
      form_text: refreshedNote.text,
      base_revision: refreshedNote.revision
    })
  })

  it("retains text typed during a reconnect read and keeps its old edit base", async () => {
    const pendingNote = deferred<Result<NoteView>>()
    let getNoteStartedResolve!: () => void
    const getNoteStarted = new Promise<void>((resolve) => {
      getNoteStartedResolve = resolve
    })
    const client = reconnectClient(() => {
      getNoteStartedResolve()
      return Effect.promise(() => pendingNote.promise)
    })
    viewStore.set({
      status: "ready",
      connection: { state: "disconnected", instance_id: handshake.instance_id, epoch: null, reason: "explicit_disconnect" },
      connection_generation: 1,
      instance_id: handshake.instance_id,
      epoch: handshake.epoch,
      note,
      base_revision: note.revision,
      form_text: note.text,
      form_edit_version: 0
    })

    const reconnecting = Effect.runPromise(Effect.provide(reconnect, Layer.succeed(PrototypeClient, client)))
    await getNoteStarted
    viewStore.editFormText("typed-during-reconnect")
    pendingNote.resolve({ ok: true, data: refreshedNote })
    await reconnecting

    expect(viewStore.getState()).toMatchObject({
      note: refreshedNote,
      form_text: "typed-during-reconnect",
      base_revision: note.revision
    })
  })

  it("ignores an old connection-status response after a newer intent", async () => {
    const pendingStatus = deferred<Result<ConnectionStatusView>>()
    const client = PrototypeClient.of({
      handshake: () => Effect.succeed({ ok: true, data: handshake }),
      connect: () => Effect.succeed({ ok: true, data: connected }),
      disconnect: () => Effect.succeed({ ok: true, data: { state: "disconnected", instance_id: handshake.instance_id, epoch: null, reason: "explicit_disconnect" } }),
      connectionStatus: () => Effect.promise(() => pendingStatus.promise),
      getNote: () => Effect.succeed({ ok: true, data: note }),
      editNote: () => Effect.succeed({ ok: true, data: note }),
      saveDraft: () => Effect.succeed({ ok: true, data: draft }),
      loadDraft: () => Effect.succeed({ ok: true, data: null }),
      discardDraft: () => Effect.succeed({ ok: true, data: {
        instance_id: handshake.instance_id,
        note_id: "note-1",
        form_id: "synthetic-note",
        local_revision: "1"
      } }),
      listCommandAttempts: () => Effect.succeed({ ok: true, data: [] }),
      reconcileCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } }),
      dismissCommand: () => Effect.succeed({ ok: false, error: { code: "not_used", message: "not used", retryable: false } })
    })

    const loading = Effect.runPromise(Effect.provide(loadConnectionStatus, Layer.succeed(PrototypeClient, client)))
    await Promise.resolve()
    viewStore.beginConnectionTransition("connecting")
    pendingStatus.resolve({ ok: true, data: connected })
    await loading

    expect(viewStore.getState().connection.state).toBe("connecting")
  })
})
