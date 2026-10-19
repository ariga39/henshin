import { Effect, Layer } from "effect"
import type {
  CommandAttempt,
  CommandReconciliation,
  ConnectionStatusView,
  HandshakeView,
  NoteView,
  SavedDraft
} from "@henshin/contracts"
import { afterEach, describe, expect, it } from "vitest"
import { PrototypeClient } from "../../desktop/src/renderer/client"
import { dismissRecovery } from "../../desktop/src/renderer/workflows"
import { viewStore } from "../../desktop/src/renderer/store"

const handshake: HandshakeView = {
  instance_id: "11111111-1111-4111-8111-111111111111",
  epoch: "22222222-2222-4222-8222-222222222222"
}
const note: NoteView = { note_id: "note-1", text: "server-text", revision: "4" }
const connected: ConnectionStatusView = {
  state: "connected",
  instance_id: handshake.instance_id,
  epoch: handshake.epoch,
  reason: null
}

const emptyDraft: SavedDraft = {
  instance_id: handshake.instance_id,
  note_id: "note-1",
  form_id: "synthetic-note",
  text: "",
  local_revision: "0",
  base_server_revision: "4",
  base_epoch: handshake.epoch
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

const clientFor = (dismiss: (operationId: string) => CommandAttempt) => PrototypeClient.of({
  handshake: () => Effect.succeed({ ok: true, data: handshake }),
  connect: () => Effect.succeed({ ok: true, data: connected }),
  disconnect: () => Effect.succeed({ ok: true, data: { ...connected, state: "disconnected", epoch: null, reason: "explicit_disconnect" } }),
  connectionStatus: () => Effect.succeed({ ok: true, data: connected }),
  getNote: () => Effect.succeed({ ok: true, data: note }),
  editNote: () => Effect.succeed({ ok: true, data: note }),
  saveDraft: () => Effect.succeed({ ok: true, data: emptyDraft }),
  loadDraft: () => Effect.succeed({ ok: true, data: null }),
  discardDraft: () => Effect.succeed({ ok: true, data: { instance_id: handshake.instance_id, note_id: "note-1", form_id: "synthetic-note", local_revision: "1" } }),
  listCommandAttempts: () => Effect.succeed({ ok: true, data: [] }),
  reconcileCommand: () => Effect.succeed({ ok: false, error: { code: "unused", message: "unused", retryable: false } }),
  dismissCommand: (operationId) => Effect.succeed({ ok: true, data: dismiss(operationId) })
})

afterEach(resetView)

describe("renderer recovery dismissal", () => {
  it("clears only the reconciliation result for the dismissed operation", async () => {
    const matchingOperationId = "33333333-3333-4333-8333-333333333333"
    const otherOperationId = "44444444-4444-4444-8444-444444444444"
    const makeAttempt = (operationId: string, intentText: string): CommandAttempt => ({
      instance_id: handshake.instance_id,
      operation_id: operationId,
      note_id: "note-1",
      intent_text: intentText,
      base_revision: "4",
      epoch: handshake.epoch,
      status: "unresolved",
      created_at_ms: 1,
      updated_at_ms: 2,
      result_note: null,
      expires_at_ms: null,
      error_code: null,
      error_message: null,
      current_revision: null,
      dismissed: false
    })
    const matchingAttempt = makeAttempt(matchingOperationId, "matching")
    const otherAttempt = makeAttempt(otherOperationId, "other")
    const reconciliation: CommandReconciliation = {
      attempt: matchingAttempt,
      current_note: note,
      server_result: null,
      requires_reconciliation: true,
      reconciliation_reason: "query_unavailable"
    }
    const client = clientFor((operationId) => operationId === matchingOperationId ? matchingAttempt : otherAttempt)

    viewStore.set({
      status: "ready",
      connection: connected,
      connection_generation: 0,
      recovery_attempts: [matchingAttempt, otherAttempt],
      recovery_result: reconciliation
    })

    await Effect.runPromise(Effect.provide(dismissRecovery(otherOperationId), Layer.succeed(PrototypeClient, client)))
    expect(viewStore.getState().recovery_attempts).toEqual([matchingAttempt])
    expect(viewStore.getState().recovery_result).toBe(reconciliation)

    await Effect.runPromise(Effect.provide(dismissRecovery(matchingOperationId), Layer.succeed(PrototypeClient, client)))
    expect(viewStore.getState().recovery_attempts).toEqual([])
    expect(viewStore.getState().recovery_result).toBeNull()
  })
})
