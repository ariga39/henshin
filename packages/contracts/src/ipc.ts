import { Schema } from "effect"
import { NoteId, Revision, Text, Uuid } from "./ids"

/**
 * IPC request schemas. The renderer never supplies instance/epoch/auth: main
 * adds namespace and epoch from its own authenticated session before dispatch.
 */
export const HandshakeIpcRequest = Schema.Struct({})
export type HandshakeIpcRequest = typeof HandshakeIpcRequest.Type

export const GetNoteIpcRequest = Schema.Struct({
  note_id: NoteId
})
export type GetNoteIpcRequest = typeof GetNoteIpcRequest.Type

export const EditNoteIpcRequest = Schema.Struct({
  note_id: NoteId,
  text: Text,
  expected_revision: Revision,
  operation_id: Uuid
})
export type EditNoteIpcRequest = typeof EditNoteIpcRequest.Type

/** Public error shape returned across the IPC boundary. */
export const PublicError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  current_revision: Schema.optional(Revision)
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
