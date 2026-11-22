import { Schema } from "effect"
import { DraftFormId, NoteId, Revision, Text, Uuid } from "@henshin/contracts/ids"
import { CommandAttemptStatus } from "@henshin/contracts/note"

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

export const CommandAttemptRow = Schema.Struct({
  instanceId: Uuid,
  operationId: Uuid,
  noteId: NoteId,
  intentText: Text,
  baseRevision: Revision,
  epoch: Uuid,
  status: CommandAttemptStatus,
  createdAtMs: Schema.Int,
  updatedAtMs: Schema.Int,
  resultNote: Schema.NullOr(Schema.Struct({ note_id: NoteId, text: Text, revision: Revision })),
  expiresAtMs: Schema.NullOr(Schema.Int),
  errorCode: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  currentRevision: Schema.NullOr(Revision),
  dismissed: Schema.Boolean
})
export type CommandAttemptRow = typeof CommandAttemptRow.Type

export const CommandAttemptAdmission = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("admitted"), attempt: CommandAttemptRow }),
  Schema.Struct({ kind: Schema.Literal("existing"), attempt: CommandAttemptRow }),
  Schema.Struct({ kind: Schema.Literal("conflict") }),
  Schema.Struct({ kind: Schema.Literal("full") })
])
export type CommandAttemptAdmission = typeof CommandAttemptAdmission.Type

export const CommandAttemptMutation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("updated"), attempt: CommandAttemptRow }),
  Schema.Struct({ kind: Schema.Literal("not_found") })
])
export type CommandAttemptMutation = typeof CommandAttemptMutation.Type

export const CommandAttemptRows = Schema.Array(CommandAttemptRow)
export type CommandAttemptRows = typeof CommandAttemptRows.Type

export const CommandAttemptNote = Schema.Struct({
  note_id: NoteId,
  text: Text,
  revision: Revision
})
export type CommandAttemptNote = typeof CommandAttemptNote.Type

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
  Schema.Struct({
    op: Schema.Literal("admitCommand"),
    instanceId: Uuid,
    operationId: Uuid,
    noteId: NoteId,
    intentText: Text,
    baseRevision: Revision,
    epoch: Uuid
  }),
  Schema.Struct({ op: Schema.Literal("markCommandSubmitted"), instanceId: Uuid, operationId: Uuid }),
  Schema.Struct({ op: Schema.Literal("markCommandUnresolved"), instanceId: Uuid, operationId: Uuid }),
  Schema.Struct({
    op: Schema.Literal("markCommandSucceeded"),
    instanceId: Uuid,
    operationId: Uuid,
    resultNote: CommandAttemptNote,
    expiresAtMs: Schema.Int
  }),
  Schema.Struct({
    op: Schema.Literal("markCommandRejected"),
    instanceId: Uuid,
    operationId: Uuid,
    errorCode: Schema.String,
    errorMessage: Schema.String,
    currentRevision: Schema.NullOr(Revision)
  }),
  Schema.Struct({ op: Schema.Literal("listCommandAttempts"), instanceId: Uuid }),
  Schema.Struct({ op: Schema.Literal("getCommandAttempt"), instanceId: Uuid, operationId: Uuid }),
  Schema.Struct({ op: Schema.Literal("dismissCommand"), instanceId: Uuid, operationId: Uuid }),
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
