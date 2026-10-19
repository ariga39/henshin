import { Schema } from "effect"
import { DraftFormId, NoteId, Revision, Text, Uuid } from "@henshin/contracts/ids"

export const DraftRow = Schema.Struct({
  instanceId: Uuid,
  noteId: NoteId,
  formId: DraftFormId,
  text: Text,
  localRevision: Revision,
  baseServerRevision: Revision,
  baseEpoch: Uuid,
  present: Schema.Boolean
})
export type DraftRow = typeof DraftRow.Type

export const DraftAbsent = Schema.Struct({
  kind: Schema.Literal("absent"),
  instanceId: Uuid,
  noteId: NoteId,
  formId: DraftFormId,
  localRevision: Revision
})
export type DraftAbsent = typeof DraftAbsent.Type

export const DraftReadResult = Schema.NullOr(Schema.Union([DraftRow, DraftAbsent]))
export type DraftReadResult = typeof DraftReadResult.Type

export const DraftWriteOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("saved"), draft: DraftRow }),
  Schema.Struct({ kind: Schema.Literal("discarded"), instanceId: Uuid, noteId: NoteId, formId: DraftFormId, localRevision: Revision }),
  Schema.Struct({ kind: Schema.Literal("conflict"), currentLocalRevision: Revision }),
  Schema.Struct({ kind: Schema.Literal("full") })
])
export type DraftWriteOutcome = typeof DraftWriteOutcome.Type

export const DraftWorkerRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("load"), instanceId: Uuid, noteId: NoteId, formId: DraftFormId }),
  Schema.Struct({
    op: Schema.Literal("save"),
    instanceId: Uuid,
    noteId: NoteId,
    formId: DraftFormId,
    text: Text,
    expectedLocalRevision: Revision,
    baseServerRevision: Revision,
    baseEpoch: Uuid
  }),
  Schema.Struct({
    op: Schema.Literal("discard"),
    instanceId: Uuid,
    noteId: NoteId,
    formId: DraftFormId,
    expectedLocalRevision: Revision
  }),
  Schema.Struct({ op: Schema.Literal("close") })
])
export type DraftWorkerRequest = typeof DraftWorkerRequest.Type

export const DraftWorkerMessage = Schema.Struct({
  id: Schema.Int,
  request: DraftWorkerRequest
})
export type DraftWorkerMessage = typeof DraftWorkerMessage.Type

export const DraftWorkerResponse = Schema.Union([
  Schema.Struct({ id: Schema.Int, ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ id: Schema.Int, ok: Schema.Literal(false), error: Schema.String })
])
export type DraftWorkerResponse = typeof DraftWorkerResponse.Type
