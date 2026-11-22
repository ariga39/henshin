import { Schema } from "effect"
import { OpenEvent } from "@henshin/contracts/event"
import { DraftFormId, NoteId, Revision, Text, Uuid } from "@henshin/contracts/ids"
import {
  ReaderEntryFormat,
  ReaderLaunchMode,
  ReaderTargetMode
} from "@henshin/contracts"
import { CommandAttemptStatus } from "@henshin/contracts/note"

export const ReaderProfileRow = Schema.Struct({
  profileId: Uuid,
  revision: Revision,
  name: Schema.String,
  launchMode: ReaderLaunchMode,
  supportedFormats: Schema.Array(ReaderEntryFormat),
  targetMode: ReaderTargetMode,
  executablePath: Schema.NullOr(Schema.String),
  argumentTokens: Schema.Array(Schema.String)
})
export type ReaderProfileRow = typeof ReaderProfileRow.Type

export const ReaderProfileRows = Schema.Array(ReaderProfileRow)
export type ReaderProfileRows = typeof ReaderProfileRows.Type

export const ReaderProfileReadResult = Schema.NullOr(ReaderProfileRow)
export type ReaderProfileReadResult = typeof ReaderProfileReadResult.Type

export const ReaderProfileWriteOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("saved"), profile: ReaderProfileRow }),
  Schema.Struct({ kind: Schema.Literal("conflict"), currentRevision: Revision }),
  Schema.Struct({ kind: Schema.Literal("not_found") }),
  Schema.Struct({ kind: Schema.Literal("full") })
])
export type ReaderProfileWriteOutcome = typeof ReaderProfileWriteOutcome.Type

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

export const OpenJournalStatus = Schema.Union([
  Schema.Literal("prepared"),
  Schema.Literal("accepted"),
  Schema.Literal("failed"),
  Schema.Literal("unknown")
])
export type OpenJournalStatus = typeof OpenJournalStatus.Type

export const OpenDeliveryStatus = Schema.Union([
  Schema.Literal("pending"),
  Schema.Literal("acknowledged"),
  Schema.Literal("held")
])
export type OpenDeliveryStatus = typeof OpenDeliveryStatus.Type

export const OpenJournalRow = Schema.Struct({
  instanceId: Uuid,
  actionId: Uuid,
  entryId: Uuid,
  deviceId: Uuid,
  observedLocationRevision: Revision,
  observedContentVersion: Revision,
  status: OpenJournalStatus,
  event: Schema.NullOr(OpenEvent),
  deliveryStatus: Schema.NullOr(OpenDeliveryStatus),
  deliveryErrorCode: Schema.NullOr(Schema.String),
  deliveryErrorMessage: Schema.NullOr(Schema.String),
  failureCode: Schema.NullOr(Schema.String),
  failureMessage: Schema.NullOr(Schema.String),
  createdAtMs: Schema.Int,
  updatedAtMs: Schema.Int
})
export type OpenJournalRow = typeof OpenJournalRow.Type

export const OpenJournalRows = Schema.Array(OpenJournalRow)
export type OpenJournalRows = typeof OpenJournalRows.Type

export const OpenJournalReadResult = Schema.NullOr(OpenJournalRow)
export type OpenJournalReadResult = typeof OpenJournalReadResult.Type

export const OpenJournalAdmission = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("admitted"), entry: OpenJournalRow }),
  Schema.Struct({ kind: Schema.Literal("existing"), entry: OpenJournalRow }),
  Schema.Struct({ kind: Schema.Literal("conflict") }),
  Schema.Struct({ kind: Schema.Literal("full") })
])
export type OpenJournalAdmission = typeof OpenJournalAdmission.Type

export const OpenJournalMutation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("updated"), entry: OpenJournalRow }),
  Schema.Struct({ kind: Schema.Literal("existing"), entry: OpenJournalRow }),
  Schema.Struct({ kind: Schema.Literal("not_found") }),
  Schema.Struct({ kind: Schema.Literal("conflict") })
])
export type OpenJournalMutation = typeof OpenJournalMutation.Type

export const DraftWorkerRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("listReaderProfiles") }),
  Schema.Struct({ op: Schema.Literal("getReaderProfile"), profileId: Uuid }),
  Schema.Struct({
    op: Schema.Literal("saveReaderProfile"),
    profileId: Uuid,
    expectedRevision: Revision,
    name: Schema.String,
    launchMode: ReaderLaunchMode,
    supportedFormats: Schema.Array(ReaderEntryFormat),
    targetMode: ReaderTargetMode,
    executablePath: Schema.NullOr(Schema.String),
    argumentTokens: Schema.Array(Schema.String)
  }),
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
  Schema.Struct({
    op: Schema.Literal("prepareOpen"),
    instanceId: Uuid,
    actionId: Uuid,
    entryId: Uuid,
    deviceId: Uuid,
    observedLocationRevision: Revision,
    observedContentVersion: Revision
  }),
  Schema.Struct({ op: Schema.Literal("recordOpenAccepted"), instanceId: Uuid, actionId: Uuid, event: OpenEvent }),
  Schema.Struct({ op: Schema.Literal("acknowledgeOpenEvent"), instanceId: Uuid, actionId: Uuid }),
  Schema.Struct({
    op: Schema.Literal("holdOpenEvent"),
    instanceId: Uuid,
    actionId: Uuid,
    deliveryErrorCode: Schema.String,
    deliveryErrorMessage: Schema.String
  }),
  Schema.Struct({
    op: Schema.Literal("recordOpenFailed"),
    instanceId: Uuid,
    actionId: Uuid,
    failureCode: Schema.String,
    failureMessage: Schema.String
  }),
  Schema.Struct({ op: Schema.Literal("listOpenJournal"), instanceId: Uuid }),
  Schema.Struct({ op: Schema.Literal("getOpenJournal"), instanceId: Uuid, actionId: Uuid }),
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
