import { Schema } from "effect"
import { NoteId, Revision, Text, Uuid } from "./ids"

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

export const EditNotePayload = Schema.Struct({
  operation_id: Uuid,
  expected_revision: Revision,
  text: Text,
  instance_id: Uuid,
  epoch: Uuid
})
export type EditNotePayload = typeof EditNotePayload.Type

export const HandshakeData = Schema.Struct({
  api_version: Schema.String,
  capabilities: Schema.Array(Schema.String)
})
export type HandshakeData = typeof HandshakeData.Type

/**
 * Canonical command identity used for same-epoch deduplication. Field order is
 * fixed so an identical logical payload always serializes identically.
 */
export const canonicalEditPayload = (input: {
  readonly noteId: string
  readonly text: string
  readonly expectedRevision: string
}): string =>
  JSON.stringify({
    expected_revision: input.expectedRevision,
    note_id: input.noteId,
    text: input.text
  })
