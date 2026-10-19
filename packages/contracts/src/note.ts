import { Schema } from "effect"
import { DraftFormId, NoteId, Revision, Text, Uuid } from "./ids"

/**
 * The synthetic prototype subject. It is deliberately not a production domain
 * record: a single note with a monotonic revision, used only to exercise a
 * conditional edit end to end.
 */
export const Note = Schema.Struct({
  note_id: NoteId,
  text: Text,
  revision: Revision
})
export type Note = typeof Note.Type

/** A desktop-local saved form snapshot; it is never a server mutation. */
export const SavedDraft = Schema.Struct({
  instance_id: Uuid,
  note_id: NoteId,
  form_id: DraftFormId,
  text: Text,
  local_revision: Revision,
  base_server_revision: Revision,
  base_epoch: Uuid
})
export type SavedDraft = typeof SavedDraft.Type

/** No saved text is present, but the key's local revision remains conditional. */
export const SavedDraftAbsent = Schema.Struct({
  instance_id: Uuid,
  note_id: NoteId,
  form_id: DraftFormId,
  local_revision: Revision
})
export type SavedDraftAbsent = typeof SavedDraftAbsent.Type

/** Result of a successful discard, including the tombstone revision. */
export const DiscardedDraft = Schema.Struct({
  instance_id: Uuid,
  note_id: NoteId,
  form_id: DraftFormId,
  local_revision: Revision
})
export type DiscardedDraft = typeof DiscardedDraft.Type

export const EditNotePayload = Schema.Struct({
  operation_id: Uuid,
  expected_revision: Revision,
  text: Text,
  instance_id: Uuid,
  epoch: Uuid
})
export type EditNotePayload = typeof EditNotePayload.Type

/**
 * The durable result of a note mutation. The same shape is returned by the
 * mutation and by the operation-status query so a recovered reply is
 * equivalent at the typed boundary.
 */
export const OperationResult = Schema.Struct({
  operation_id: Uuid,
  note: Note,
  expires_at_ms: Schema.Int
})
export type OperationResult = typeof OperationResult.Type

export const CommandAttemptStatus = Schema.Union([
  Schema.Literal("prepared"),
  Schema.Literal("submitted"),
  Schema.Literal("unresolved"),
  Schema.Literal("succeeded"),
  Schema.Literal("rejected")
])
export type CommandAttemptStatus = typeof CommandAttemptStatus.Type

/**
 * Main-owned local recovery state for one deliberate note command. The intent
 * is bounded and non-secret so it can survive a renderer or desktop restart.
 */
export const CommandAttempt = Schema.Struct({
  instance_id: Uuid,
  operation_id: Uuid,
  note_id: NoteId,
  intent_text: Text,
  base_revision: Revision,
  epoch: Uuid,
  status: CommandAttemptStatus,
  created_at_ms: Schema.Int,
  updated_at_ms: Schema.Int,
  result_note: Schema.NullOr(Note),
  expires_at_ms: Schema.NullOr(Schema.Int),
  error_code: Schema.NullOr(Schema.String),
  error_message: Schema.NullOr(Schema.String),
  current_revision: Schema.NullOr(Revision),
  dismissed: Schema.Boolean
})
export type CommandAttempt = typeof CommandAttempt.Type

export const CommandReconciliation = Schema.Struct({
  attempt: CommandAttempt,
  current_note: Schema.NullOr(Note),
  server_result: Schema.NullOr(OperationResult),
  requires_reconciliation: Schema.Boolean,
  reconciliation_reason: Schema.Union([
    Schema.Literal("complete"),
    Schema.Literal("operation_expired"),
    Schema.Literal("query_unavailable"),
    Schema.Literal("persistence_failed"),
    Schema.Literal("changed_epoch")
  ])
})
export type CommandReconciliation = typeof CommandReconciliation.Type

export const HandshakeData = Schema.Struct({
  api_version: Schema.String,
  capabilities: Schema.Array(Schema.String)
})
export type HandshakeData = typeof HandshakeData.Type
