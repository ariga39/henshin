import { Schema } from "effect"
import { NoteId, Revision, Text, Uuid } from "@henshin/contracts/ids"
import { RootExclusions, RootPolicyCommand } from "@henshin/contracts/root"

/** A persisted prototype note row, always with a canonical decimal revision. */
export const NoteRow = Schema.Struct({
  note_id: NoteId,
  text: Text,
  revision: Revision
})
export type NoteRow = typeof NoteRow.Type

export const ReadNoteResult = Schema.NullOr(NoteRow)
export type ReadNoteResult = typeof ReadNoteResult.Type

export const ServerRootRow = Schema.Struct({
  libraryId: Uuid,
  rootId: Uuid,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  selectedPath: Schema.String,
  canonicalPath: Schema.String,
  device: Schema.String,
  inode: Schema.String,
  mappingRevision: Revision,
  policyRevision: Revision,
  exclusions: RootExclusions,
  state: Schema.Literal("active")
})
export type ServerRootRow = typeof ServerRootRow.Type

export const RootRegistrationOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("registered"), root: ServerRootRow }),
  Schema.Struct({ kind: Schema.Literal("replayed"), root: ServerRootRow }),
  Schema.Struct({ kind: Schema.Literal("operation_conflict") }),
  Schema.Struct({ kind: Schema.Literal("root_overlap") })
])
export type RootRegistrationOutcome = typeof RootRegistrationOutcome.Type

export const RootReplayLookup = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not_found") }),
  Schema.Struct({ kind: Schema.Literal("replay"), root: ServerRootRow }),
  Schema.Struct({ kind: Schema.Literal("operation_conflict") })
])
export type RootReplayLookup = typeof RootReplayLookup.Type

export const RootPolicyCommandOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("committed"), root: ServerRootRow }),
  Schema.Struct({ kind: Schema.Literal("replayed"), root: ServerRootRow }),
  Schema.Struct({ kind: Schema.Literal("operation_conflict") }),
  Schema.Struct({ kind: Schema.Literal("root_not_found") }),
  Schema.Struct({ kind: Schema.Literal("policy_revision_conflict"), currentPolicyRevision: Revision })
])
export type RootPolicyCommandOutcome = typeof RootPolicyCommandOutcome.Type

export const OperationResultRow = Schema.Struct({
  operationId: Uuid,
  note: NoteRow,
  expiresAtMs: Schema.Int
})
export type OperationResultRow = typeof OperationResultRow.Type

export const OperationLookupOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("found"), result: OperationResultRow }),
  Schema.Struct({ kind: Schema.Literal("expired") })
])
export type OperationLookupOutcome = typeof OperationLookupOutcome.Type

export const CommitOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("committed"), result: OperationResultRow }),
  Schema.Struct({ kind: Schema.Literal("replayed"), result: OperationResultRow }),
  Schema.Struct({ kind: Schema.Literal("operation_conflict") }),
  Schema.Struct({ kind: Schema.Literal("operation_expired") }),
  Schema.Struct({ kind: Schema.Literal("storage_full") }),
  Schema.Struct({ kind: Schema.Literal("revision_conflict"), currentRevision: Revision }),
  Schema.Struct({ kind: Schema.Literal("not_found") })
])
export type CommitOutcome = typeof CommitOutcome.Type

/**
 * Worker request protocol. Validated on both sides of the worker boundary so a
 * malformed message can never reach SQLite or corrupt a caller's expectation.
 */
export const WorkerRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("init") }),
  Schema.Struct({ op: Schema.Literal("readNote"), noteId: NoteId }),
  Schema.Struct({ op: Schema.Literal("listRoots") }),
  Schema.Struct({
    op: Schema.Literal("lookupRootOperation"),
    operationId: Uuid,
    label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    selectedPath: Schema.String,
    canonicalPath: Schema.String,
    device: Schema.String,
    inode: Schema.String
  }),
  Schema.Struct({
    op: Schema.Literal("readOperation"),
    operationId: Uuid,
    epoch: Uuid
  }),
  Schema.Struct({
    op: Schema.Literal("commitNote"),
    noteId: NoteId,
    text: Text,
    expectedRevision: Revision,
    operationId: Uuid,
    epoch: Uuid
  }),
  Schema.Struct({
    op: Schema.Literal("registerRoot"),
    operationId: Uuid,
    label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    selectedPath: Schema.String,
    canonicalPath: Schema.String,
    device: Schema.String,
    inode: Schema.String
  }),
  Schema.Struct({
    op: Schema.Literal("commitRootPolicy"),
    rootId: Uuid,
    operationId: Uuid,
    epoch: Uuid,
    expectedPolicyRevision: Revision,
    command: RootPolicyCommand
  }),
  Schema.Struct({ op: Schema.Literal("close") })
])
export type WorkerRequest = typeof WorkerRequest.Type

export const WorkerMessage = Schema.Struct({
  id: Schema.Int,
  request: WorkerRequest
})
export type WorkerMessage = typeof WorkerMessage.Type

export const WorkerResponse = Schema.Union([
  Schema.Struct({ id: Schema.Int, ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ id: Schema.Int, ok: Schema.Literal(false), error: Schema.String })
])
export type WorkerResponse = typeof WorkerResponse.Type
