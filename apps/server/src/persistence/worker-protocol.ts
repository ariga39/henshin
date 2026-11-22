import { Schema } from "effect"
import { NoteId, Revision, Text, Uuid } from "@henshin/contracts/ids"
import { RootExclusions, RootPolicyCommand, RootRelativePath } from "@henshin/contracts/root"
import { ThumbnailReference } from "@henshin/contracts/thumbnail"

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
  Schema.Struct({ kind: Schema.Literal("exclusion_limit") }),
  Schema.Struct({ kind: Schema.Literal("operation_expired") }),
  Schema.Struct({ kind: Schema.Literal("storage_full") }),
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

const ScanStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "completed_with_errors",
  "failed",
  "interrupted"
])

export const ScanTaskRow = Schema.Struct({
  task_id: Uuid,
  operation_id: Uuid,
  epoch: Uuid,
  root_id: Uuid,
  mapping_revision: Revision,
  status: ScanStatus,
  hold_new_discoveries: Schema.Boolean,
  directories_visited: Schema.Natural,
  candidates_discovered: Schema.Natural,
  candidates_analyzed: Schema.Natural,
  analysis_error_count: Schema.Natural,
  review_needed_count: Schema.Natural,
  coverage_json: Schema.NullOr(Schema.String),
  readiness_error_code: Schema.NullOr(Schema.String),
  readiness_error_message: Schema.NullOr(Schema.String),
  error_code: Schema.NullOr(Schema.String),
  error_message: Schema.NullOr(Schema.String),
  created_at_ms: Schema.Int,
  updated_at_ms: Schema.Int
})
export type ScanTaskRow = typeof ScanTaskRow.Type

export const StagedDiscoveryRow = Schema.Struct({
  candidate_id: Uuid,
  task_id: Uuid,
  root_id: Uuid,
  relative_path: Schema.String,
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  candidate_version: Schema.Natural,
  hold_state: Schema.Union([Schema.Literal("held"), Schema.Literal("eligible")]),
  analysis_status: Schema.Union([Schema.Literal("ready"), Schema.Literal("error")]),
  manifest_json: Schema.NullOr(Schema.String),
  analysis_error_json: Schema.NullOr(Schema.String),
  updated_at_ms: Schema.Int
})
export type StagedDiscoveryRow = typeof StagedDiscoveryRow.Type

export const LibraryEntryRow = Schema.Struct({
  entry_id: Uuid,
  library_id: Uuid,
  root_id: Uuid,
  relative_path: Schema.String,
  source_path: Schema.String,
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  title: Schema.String,
  page_count: Schema.Natural,
  state: Schema.Literal("accepted"),
  content_version: Revision,
  location_revision: Revision,
  cover: Schema.NullOr(ThumbnailReference)
})
export type LibraryEntryRow = typeof LibraryEntryRow.Type

export const AcceptedThumbnailEntryRow = Schema.Struct({
  entry_id: Uuid,
  root_id: Uuid,
  relative_path: Schema.String,
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  content_version: Revision,
  manifest_json: Schema.String
})
export type AcceptedThumbnailEntryRow = typeof AcceptedThumbnailEntryRow.Type

export const LibrarySummaryRow = Schema.Struct({
  library_id: Uuid,
  change_revision: Revision
})
export type LibrarySummaryRow = typeof LibrarySummaryRow.Type

export const LibraryEntryPageRow = Schema.Struct({
  entries: Schema.Array(LibraryEntryRow),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Uuid),
  library_change_revision: Revision
})
export type LibraryEntryPageRow = typeof LibraryEntryPageRow.Type

export const IndexedRootSampleRow = Schema.Struct({
  relative_path: RootRelativePath,
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  format_evidence: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
  size_bytes: Schema.NullOr(Schema.Natural)
})
export type IndexedRootSampleRow = typeof IndexedRootSampleRow.Type

export const IndexedRootSamplePageRow = Schema.Struct({
  samples: Schema.Array(IndexedRootSampleRow),
  sample_truncated: Schema.Boolean,
  library_change_revision: Revision
})
export type IndexedRootSamplePageRow = typeof IndexedRootSamplePageRow.Type

export const NormalPublishOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("published") }),
  Schema.Struct({
    kind: Schema.Literal("allocation_deferred"),
    missingPaths: Schema.Array(Schema.String),
    changedPaths: Schema.Array(Schema.String),
    excludedPaths: Schema.Array(Schema.String)
  }),
  Schema.Struct({ kind: Schema.Literal("root_not_found") }),
  Schema.Struct({ kind: Schema.Literal("mapping_revision_conflict") }),
  Schema.Struct({ kind: Schema.Literal("policy_revision_conflict") })
])
export type NormalPublishOutcome = typeof NormalPublishOutcome.Type

export const ScanStartOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("active_scan_conflict"), taskId: Uuid, policyRevision: Revision }),
  Schema.Struct({ kind: Schema.Literal("created"), task: ScanTaskRow }),
  Schema.Struct({ kind: Schema.Literal("replayed"), task: ScanTaskRow }),
  Schema.Struct({ kind: Schema.Literal("active"), task: ScanTaskRow }),
  Schema.Struct({ kind: Schema.Literal("operation_conflict") }),
  Schema.Struct({ kind: Schema.Literal("root_not_found") }),
  Schema.Struct({ kind: Schema.Literal("mapping_revision_conflict"), currentMappingRevision: Revision }),
  Schema.Struct({ kind: Schema.Literal("policy_revision_conflict"), currentPolicyRevision: Revision })
])
export type ScanStartOutcome = typeof ScanStartOutcome.Type

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
    op: Schema.Literal("startManualScan"),
    taskId: Uuid,
    operationId: Uuid,
    epoch: Uuid,
    rootId: Uuid,
    expectedMappingRevision: Revision,
    expectedPolicyRevision: Revision,
    holdNewDiscoveries: Schema.Boolean
  }),
  Schema.Struct({ op: Schema.Literal("listScanTasks") }),
  Schema.Struct({ op: Schema.Literal("readScanTask"), taskId: Uuid }),
  Schema.Struct({ op: Schema.Literal("listStagedDiscoveries") }),
  Schema.Struct({
    op: Schema.Literal("recordDiscovery"), taskId: Uuid, directories: Schema.Natural,
    candidates: Schema.Natural, coverageJson: Schema.String
  }),
  Schema.Struct({ op: Schema.Literal("markScanRunning"), taskId: Uuid }),
  Schema.Struct({
    op: Schema.Literal("stageDiscovery"),
    candidateId: Uuid,
    taskId: Uuid,
    rootId: Uuid,
    relativePath: Schema.String,
    kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
    analysisStatus: Schema.Union([Schema.Literal("ready"), Schema.Literal("error")]),
    holdState: Schema.Union([Schema.Literal("held"), Schema.Literal("eligible")]),
    manifestJson: Schema.NullOr(Schema.String),
    analysisErrorJson: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({
    op: Schema.Literal("publishNormalScan"),
    taskId: Uuid,
    rootId: Uuid,
    mappingRevision: Revision,
    expectedPolicyRevision: Revision,
    observedCandidatePaths: Schema.Array(Schema.String)
  }),
  Schema.Struct({ op: Schema.Literal("readLibrary") }),
  Schema.Struct({ op: Schema.Literal("listLibraryEntries"), pageSize: Schema.Natural, cursor: Schema.NullOr(Uuid) }),
  Schema.Struct({ op: Schema.Literal("listIndexedRootSamples"), rootId: Uuid, sampleLimit: Schema.Literal(33) }),
  Schema.Struct({ op: Schema.Literal("readAcceptedThumbnailEntry"), entryId: Uuid }),
  Schema.Struct({
    op: Schema.Literal("finishScan"),
    taskId: Uuid,
    status: Schema.Union([
      Schema.Literal("succeeded"),
      Schema.Literal("completed_with_errors"),
      Schema.Literal("failed"),
      Schema.Literal("interrupted")
    ]),
    directoriesVisited: Schema.Natural,
    candidatesDiscovered: Schema.Natural,
    candidatesAnalyzed: Schema.Natural,
    analysisErrorCount: Schema.Natural,
    reviewNeededCount: Schema.Natural,
    coverageJson: Schema.NullOr(Schema.String),
    errorCode: Schema.NullOr(Schema.String),
    errorMessage: Schema.NullOr(Schema.String),
    readinessErrorCode: Schema.NullOr(Schema.String),
    readinessErrorMessage: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({ op: Schema.Literal("recoverScans") }),
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
