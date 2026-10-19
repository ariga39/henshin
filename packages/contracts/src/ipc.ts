import { Schema } from "effect"
import { DraftFormId, NoteId, Revision, Text, Uuid } from "./ids"
import type {
  CommandAttempt,
  CommandReconciliation,
  DiscardedDraft,
  SavedDraft,
  SavedDraftAbsent
} from "./note"

export const ConnectionState = Schema.Union([
  Schema.Literal("connecting"),
  Schema.Literal("connected"),
  Schema.Literal("disconnected"),
  Schema.Literal("blocked")
])
export type ConnectionState = typeof ConnectionState.Type

export const ConnectionStatusView = Schema.Struct({
  state: ConnectionState,
  instance_id: Schema.NullOr(Uuid),
  epoch: Schema.NullOr(Uuid),
  reason: Schema.NullOr(Schema.String)
})
export type ConnectionStatusView = typeof ConnectionStatusView.Type

/**
 * IPC request schemas. The renderer never supplies instance/epoch/auth: main
 * adds namespace and epoch from its own authenticated session before dispatch.
 */
export const HandshakeIpcRequest = Schema.Struct({})
export type HandshakeIpcRequest = typeof HandshakeIpcRequest.Type

export const ConnectIpcRequest = Schema.Struct({})
export type ConnectIpcRequest = typeof ConnectIpcRequest.Type

export const DisconnectIpcRequest = Schema.Struct({})
export type DisconnectIpcRequest = typeof DisconnectIpcRequest.Type

export const ConnectionStatusIpcRequest = Schema.Struct({})
export type ConnectionStatusIpcRequest = typeof ConnectionStatusIpcRequest.Type

export const GetNoteIpcRequest = Schema.Struct({
  note_id: NoteId
})
export type GetNoteIpcRequest = typeof GetNoteIpcRequest.Type

export const EditNoteIpcRequest = Schema.Struct({
  note_id: NoteId,
  text: Text,
  expected_revision: Revision,
  base_epoch: Uuid,
  operation_id: Uuid
})
export type EditNoteIpcRequest = typeof EditNoteIpcRequest.Type

export const SaveDraftIpcRequest = Schema.Struct({
  note_id: NoteId,
  form_id: DraftFormId,
  text: Text,
  expected_local_revision: Revision,
  base_server_revision: Revision,
  base_epoch: Uuid
})
export type SaveDraftIpcRequest = typeof SaveDraftIpcRequest.Type

export const LoadDraftIpcRequest = Schema.Struct({
  note_id: NoteId,
  form_id: DraftFormId
})
export type LoadDraftIpcRequest = typeof LoadDraftIpcRequest.Type

export const DiscardDraftIpcRequest = Schema.Struct({
  note_id: NoteId,
  form_id: DraftFormId,
  expected_local_revision: Revision
})
export type DiscardDraftIpcRequest = typeof DiscardDraftIpcRequest.Type

export type SavedDraftIpcResult = SavedDraft | SavedDraftAbsent | null
export type DiscardedDraftIpcResult = DiscardedDraft

export const ListCommandAttemptsIpcRequest = Schema.Struct({})
export type ListCommandAttemptsIpcRequest = typeof ListCommandAttemptsIpcRequest.Type

export const ReconcileCommandIpcRequest = Schema.Struct({ operation_id: Uuid })
export type ReconcileCommandIpcRequest = typeof ReconcileCommandIpcRequest.Type

export const DismissCommandIpcRequest = Schema.Struct({ operation_id: Uuid })
export type DismissCommandIpcRequest = typeof DismissCommandIpcRequest.Type

export type CommandAttemptsIpcResult = ReadonlyArray<CommandAttempt>
export type CommandReconciliationIpcResult = CommandReconciliation

/** Public error shape returned across the IPC boundary. */
export const PublicError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  current_revision: Schema.optional(Revision),
  current_local_revision: Schema.optional(Revision)
})
export type PublicError = typeof PublicError.Type

export const NoteView = Schema.Struct({
  note_id: NoteId,
  text: Text,
  revision: Revision
})
export type NoteView = typeof NoteView.Type

export const HandshakeView = Schema.Struct({
  instance_id: Uuid,
  epoch: Uuid
})
export type HandshakeView = typeof HandshakeView.Type
