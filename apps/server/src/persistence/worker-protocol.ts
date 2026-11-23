import { Schema } from "effect"
import { INDEXED_ROOT_SAMPLE_LIMIT, ServerAvailability } from "@henshin/contracts"
import { NoteId, Revision, Text, Uuid } from "@henshin/contracts/ids"
import { OpenEvent, OpenEventOutcome } from "@henshin/contracts/event"
import { RootExclusions, RootPolicyCommand, RootRelativePath, ScanManifestObservation, ScanManifestPage } from "@henshin/contracts/root"
import { ThumbnailReference } from "@henshin/contracts/thumbnail"
import { ReplacementComparison } from "@henshin/contracts"
import {
  ClearEntryNoteCommand,
  EntryCommandResult,
  LibraryEntryDetails,
  RemovePersonalTitleCommand,
  SetEntryNoteCommand,
  SetPersonalTitleCommand
} from "@henshin/contracts"

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

export const BackupDestinationRow = Schema.Struct({
  destinationId: Uuid,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  selectedPath: Schema.String,
  canonicalPath: Schema.String,
  device: Schema.String,
  inode: Schema.String,
  state: Schema.Literal("active")
})
export type BackupDestinationRow = typeof BackupDestinationRow.Type

export const BackupDestinationRegistrationOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("registered"), destination: BackupDestinationRow }),
  Schema.Struct({ kind: Schema.Literal("replayed"), destination: BackupDestinationRow }),
  Schema.Struct({ kind: Schema.Literal("name_conflict") }),
  Schema.Struct({ kind: Schema.Literal("destination_not_found") }),
  Schema.Struct({ kind: Schema.Literal("destination_overlap") })
])
export type BackupDestinationRegistrationOutcome = typeof BackupDestinationRegistrationOutcome.Type

export const BackupArtifactRow = Schema.Struct({
  artifactId: Uuid,
  destinationId: Uuid,
  operationId: Uuid,
  relativePath: Schema.String,
  publicationOrder: Schema.Natural,
  retentionClass: Schema.Literal("archive"),
  label: Schema.NullOr(Schema.String),
  status: Schema.Union([Schema.Literal("reserved"), Schema.Literal("completed")]),
  manifestDigest: Schema.NullOr(Schema.String),
  sizeBytes: Schema.NullOr(Schema.Natural),
  createdAtMs: Schema.Int,
  completedAtMs: Schema.NullOr(Schema.Int)
})
export type BackupArtifactRow = typeof BackupArtifactRow.Type

/** Durable HTTP submission joined with its reserved/published artifact. */
export const BackupTaskRow = Schema.Struct({
  task_id: Uuid,
  operation_id: Uuid,
  epoch: Uuid,
  artifact_id: Uuid,
  destination_id: Uuid,
  relative_path: Schema.String,
  publication_order: Schema.Natural,
  retention_class: Schema.Literal("archive"),
  label: Schema.NullOr(Schema.String),
  artifact_status: Schema.Union([Schema.Literal("reserved"), Schema.Literal("completed")]),
  manifest_digest: Schema.NullOr(Schema.String),
  size_bytes: Schema.NullOr(Schema.Natural),
  artifact_completed_at_ms: Schema.NullOr(Schema.Int),
  status: Schema.Union([
    Schema.Literal("queued"),
    Schema.Literal("running"),
    Schema.Literal("succeeded"),
    Schema.Literal("failed"),
    Schema.Literal("interrupted")
  ]),
  error_code: Schema.NullOr(Schema.String),
  error_message: Schema.NullOr(Schema.String),
  created_at_ms: Schema.Int,
  updated_at_ms: Schema.Int,
  destination_selected_path: Schema.String,
  destination_canonical_path: Schema.String,
  destination_device: Schema.String,
  destination_inode: Schema.String
})
export type BackupTaskRow = typeof BackupTaskRow.Type

export const BackupTaskStartOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("created"), task: BackupTaskRow }),
  Schema.Struct({ kind: Schema.Literal("replayed"), task: BackupTaskRow }),
  Schema.Struct({ kind: Schema.Literal("operation_conflict") }),
  Schema.Struct({ kind: Schema.Literal("destination_not_found") })
])
export type BackupTaskStartOutcome = typeof BackupTaskStartOutcome.Type

export const BackupArtifactReservationOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("reserved"), artifact: BackupArtifactRow }),
  Schema.Struct({ kind: Schema.Literal("replayed"), artifact: BackupArtifactRow }),
  Schema.Struct({ kind: Schema.Literal("operation_conflict") }),
  Schema.Struct({ kind: Schema.Literal("destination_not_found") })
])
export type BackupArtifactReservationOutcome = typeof BackupArtifactReservationOutcome.Type

export const BackupArtifactCompletionOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("completed"), artifact: BackupArtifactRow }),
  Schema.Struct({ kind: Schema.Literal("replayed"), artifact: BackupArtifactRow }),
  Schema.Struct({ kind: Schema.Literal("artifact_not_found") }),
  Schema.Struct({ kind: Schema.Literal("artifact_conflict") }),
  Schema.Struct({ kind: Schema.Literal("artifact_not_reserved") })
])
export type BackupArtifactCompletionOutcome = typeof BackupArtifactCompletionOutcome.Type

export const BackupDrillRunRow = Schema.Struct({
  runId: Uuid,
  artifactId: Uuid,
  manifestDigest: Schema.String,
  status: Schema.Union([
    Schema.Literal("running"),
    Schema.Literal("passed"),
    Schema.Literal("failed"),
    Schema.Literal("interrupted")
  ]),
  startedAtMs: Schema.Int,
  completedAtMs: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(Schema.Natural),
  diagnosticCode: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
  diagnosticMessage: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  checksJson: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64 * 1024)))
})
export type BackupDrillRunRow = typeof BackupDrillRunRow.Type

export const BackupDrillStartOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("started"), run: BackupDrillRunRow }),
  Schema.Struct({ kind: Schema.Literal("replayed"), run: BackupDrillRunRow }),
  Schema.Struct({ kind: Schema.Literal("run_conflict") }),
  Schema.Struct({ kind: Schema.Literal("artifact_not_found") }),
  Schema.Struct({ kind: Schema.Literal("artifact_not_completed") }),
  Schema.Struct({ kind: Schema.Literal("manifest_conflict") })
])
export type BackupDrillStartOutcome = typeof BackupDrillStartOutcome.Type

export const BackupDrillCompletionOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("completed"), run: BackupDrillRunRow }),
  Schema.Struct({ kind: Schema.Literal("replayed"), run: BackupDrillRunRow }),
  Schema.Struct({ kind: Schema.Literal("run_not_found") }),
  Schema.Struct({ kind: Schema.Literal("run_conflict") })
])
export type BackupDrillCompletionOutcome = typeof BackupDrillCompletionOutcome.Type

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
  title_override: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024)))),
  page_count: Schema.Natural,
  state: Schema.Union([Schema.Literal("accepted"), Schema.Literal("replacement-pending")]),
  content_version: Revision,
  location_revision: Revision,
  match_fields: Schema.Array(Schema.Literals(["title", "basename"])),
  availability: ServerAvailability,
  cover: Schema.NullOr(ThumbnailReference),
  replacement: Schema.NullOr(ReplacementComparison)
})
export type LibraryEntryRow = typeof LibraryEntryRow.Type

export const ResolveReplacementOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("committed"),
    decision: Schema.Union([Schema.Literal("keep"), Schema.Literal("replace")]),
    candidate: StagedDiscoveryRow,
    entry: LibraryEntryRow,
    detachedEntryId: Schema.NullOr(Uuid)
  }),
  Schema.Struct({
    kind: Schema.Literal("replayed"),
    decision: Schema.Union([Schema.Literal("keep"), Schema.Literal("replace")]),
    candidate: StagedDiscoveryRow,
    entry: LibraryEntryRow,
    detachedEntryId: Schema.NullOr(Uuid)
  }),
  Schema.Struct({ kind: Schema.Literal("operation_conflict") }),
  Schema.Struct({ kind: Schema.Literal("operation_expired") }),
  Schema.Struct({ kind: Schema.Literal("storage_full") }),
  Schema.Struct({ kind: Schema.Literal("candidate_not_found") }),
  Schema.Struct({ kind: Schema.Literal("entry_not_found") }),
  Schema.Struct({ kind: Schema.Literal("candidate_version_conflict"), currentCandidateVersion: Schema.Natural }),
  Schema.Struct({
    kind: Schema.Literal("entry_revision_conflict"),
    currentDecisionVersion: Revision,
    currentLocationRevision: Revision
  }),
  Schema.Struct({ kind: Schema.Literal("entry_not_pending") }),
  Schema.Struct({ kind: Schema.Literal("fresh_observation_conflict") }),
  Schema.Struct({ kind: Schema.Literal("candidate_not_ready") }),
  Schema.Struct({ kind: Schema.Literal("root_not_found") }),
  Schema.Struct({ kind: Schema.Literal("mapping_revision_conflict"), currentMappingRevision: Revision }),
  Schema.Struct({ kind: Schema.Literal("policy_revision_conflict"), currentPolicyRevision: Revision })
])
export type ResolveReplacementOutcome = typeof ResolveReplacementOutcome.Type

export const EntryResolutionLookupOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("replayed"),
    decision: Schema.Union([Schema.Literal("keep"), Schema.Literal("replace")]),
    candidate: StagedDiscoveryRow,
    entry: LibraryEntryRow,
    detachedEntryId: Schema.NullOr(Uuid)
  }),
  Schema.Struct({ kind: Schema.Literal("operation_conflict") }),
  Schema.Struct({ kind: Schema.Literal("operation_expired") }),
  Schema.Struct({ kind: Schema.Literal("not_found") })
])
export type EntryResolutionLookupOutcome = typeof EntryResolutionLookupOutcome.Type

const LibraryEntryResolution = Schema.Struct({
  entry_id: Uuid,
  root_id: Uuid,
  relative_path: Schema.String,
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  decision_version: Revision,
  location_revision: Revision,
  content_version: Revision,
  status: Schema.Union([Schema.Literal("usable"), Schema.Literal("unresolved")]),
  reason: Schema.NullOr(Schema.Union([
    Schema.Literal("known-change"),
    Schema.Literal("insufficient-evidence")
  ])),
  accepted_observation: ScanManifestObservation,
  first_page: Schema.NullOr(ScanManifestPage),
  sibling_claims: Schema.Array(Schema.Struct({ entry_id: Uuid, relative_path: Schema.String })),
  sibling_claims_truncated: Schema.Boolean,
  sibling_claims_next_cursor: Schema.NullOr(Schema.String),
  sibling_claims_revision: Revision
})
export const LibraryEntryResolutionRow = Schema.NullOr(LibraryEntryResolution)
export type LibraryEntryResolutionRow = typeof LibraryEntryResolutionRow.Type
export const LibraryEntryResolutionResult = Schema.Union([
  LibraryEntryResolutionRow,
  Schema.Struct({ kind: Schema.Literal("invalid_cursor") })
])
export type LibraryEntryResolutionResult = typeof LibraryEntryResolutionResult.Type

export const AcceptedThumbnailEntryRow = Schema.Struct({
  entry_id: Uuid,
  root_id: Uuid,
  relative_path: Schema.String,
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  state: Schema.Union([Schema.Literal("accepted"), Schema.Literal("replacement-pending")]),
  content_version: Revision,
  manifest_json: Schema.String
})
export type AcceptedThumbnailEntryRow = typeof AcceptedThumbnailEntryRow.Type

export const LibrarySummaryRow = Schema.Struct({
  library_id: Uuid,
  change_revision: Revision
})
export type LibrarySummaryRow = typeof LibrarySummaryRow.Type

export const OpenEventBatchOutcome = Schema.Struct({
  results: Schema.Array(OpenEventOutcome)
})
export type OpenEventBatchOutcome = typeof OpenEventBatchOutcome.Type

export const LibraryEntryPageRow = Schema.Struct({
  entries: Schema.Array(LibraryEntryRow),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8192))),
  library_change_revision: Revision
})
export type LibraryEntryPageRow = typeof LibraryEntryPageRow.Type

export const LibraryEntryPageResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("page"), page: LibraryEntryPageRow }),
  Schema.Struct({ kind: Schema.Literal("invalid_cursor") })
])
export type LibraryEntryPageResult = typeof LibraryEntryPageResult.Type
export const LibraryEntryDetailsRow = LibraryEntryDetails
export type LibraryEntryDetailsRow = typeof LibraryEntryDetailsRow.Type

export const EntryCommandOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("committed"), result: EntryCommandResult }),
  Schema.Struct({ kind: Schema.Literal("replayed"), result: EntryCommandResult }),
  Schema.Struct({ kind: Schema.Literal("operation_conflict") }),
  Schema.Struct({ kind: Schema.Literal("entry_not_found") }),
  Schema.Struct({ kind: Schema.Literal("operation_expired") }),
  Schema.Struct({ kind: Schema.Literal("storage_full") }),
  Schema.Struct({ kind: Schema.Literal("revision_conflict"), currentDecisionVersion: Revision }),
  Schema.Struct({ kind: Schema.Literal("locator_conflict") })
])
export type EntryCommandOutcome = typeof EntryCommandOutcome.Type
export const BindEntryOutcome = EntryCommandOutcome
export type BindEntryOutcome = EntryCommandOutcome

export const PersonalTitleOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("committed"), result: EntryCommandResult }),
  Schema.Struct({ kind: Schema.Literal("replayed"), result: EntryCommandResult }),
  Schema.Struct({ kind: Schema.Literal("operation_conflict") }),
  Schema.Struct({ kind: Schema.Literal("entry_not_found") }),
  Schema.Struct({ kind: Schema.Literal("operation_expired") }),
  Schema.Struct({ kind: Schema.Literal("storage_full") }),
  Schema.Struct({ kind: Schema.Literal("revision_conflict"), currentDecisionVersion: Revision })
])
export type PersonalTitleOutcome = typeof PersonalTitleOutcome.Type
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
    unidentifiedPaths: Schema.Array(Schema.String),
    changedPaths: Schema.Array(Schema.String),
    excludedPaths: Schema.Array(Schema.String),
    missingPathCount: Schema.Natural,
    unidentifiedPathCount: Schema.Natural,
    changedPathCount: Schema.Natural,
    excludedPathCount: Schema.Natural,
    reviewNeededCount: Schema.Natural
  }),
  Schema.Struct({ kind: Schema.Literal("root_not_found") }),
  Schema.Struct({ kind: Schema.Literal("mapping_revision_conflict") }),
  Schema.Struct({ kind: Schema.Literal("policy_revision_conflict") })
])
export type NormalPublishOutcome = typeof NormalPublishOutcome.Type

export const ReleaseHeldDiscoveryOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("committed"), candidate: StagedDiscoveryRow }),
  Schema.Struct({ kind: Schema.Literal("replayed"), candidate: StagedDiscoveryRow }),
  Schema.Struct({ kind: Schema.Literal("operation_conflict") }),
  Schema.Struct({ kind: Schema.Literal("operation_expired") }),
  Schema.Struct({ kind: Schema.Literal("storage_full") }),
  Schema.Struct({ kind: Schema.Literal("root_not_found") }),
  Schema.Struct({ kind: Schema.Literal("candidate_not_found") }),
  Schema.Struct({ kind: Schema.Literal("candidate_version_conflict"), currentCandidateVersion: Schema.Natural }),
  Schema.Struct({ kind: Schema.Literal("mapping_revision_conflict"), currentMappingRevision: Revision }),
  Schema.Struct({ kind: Schema.Literal("policy_revision_conflict"), currentPolicyRevision: Revision }),
  Schema.Struct({ kind: Schema.Literal("candidate_not_held"), currentCandidateVersion: Schema.Natural })
])
export type ReleaseHeldDiscoveryOutcome = typeof ReleaseHeldDiscoveryOutcome.Type

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
  Schema.Struct({ op: Schema.Literal("listBackupDestinations") }),
  Schema.Struct({ op: Schema.Literal("listBackupArtifacts") }),
  Schema.Struct({ op: Schema.Literal("listBackupDrillRuns") }),
  Schema.Struct({
    op: Schema.Literal("registerBackupDestination"),
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    selectedPath: Schema.String,
    canonicalPath: Schema.String,
    device: Schema.String,
    inode: Schema.String
  }),
  Schema.Struct({
    op: Schema.Literal("replaceBackupDestination"),
    destinationId: Uuid,
    selectedPath: Schema.String,
    canonicalPath: Schema.String,
    device: Schema.String,
    inode: Schema.String
  }),
  Schema.Struct({
    op: Schema.Literal("reserveBackupArtifact"),
    artifactId: Uuid,
    operationId: Uuid,
    destinationId: Uuid,
    relativePath: Schema.String,
    label: Schema.NullOr(Schema.String),
    createdAtMs: Schema.Int
  }),
  Schema.Struct({
    op: Schema.Literal("completeBackupArtifact"),
    artifactId: Uuid,
    manifestDigest: Schema.String,
    sizeBytes: Schema.Natural,
    completedAtMs: Schema.Int
  }),
  Schema.Struct({
    op: Schema.Literal("startBackupTask"),
    taskId: Uuid,
    operationId: Uuid,
    epoch: Uuid,
    artifactId: Uuid,
    destinationId: Uuid,
    relativePath: Schema.String,
    label: Schema.NullOr(Schema.String),
    createdAtMs: Schema.Int,
    destinationSelectedPath: Schema.String,
    destinationCanonicalPath: Schema.String,
    destinationDevice: Schema.String,
    destinationInode: Schema.String
  }),
  Schema.Struct({
    op: Schema.Literal("listBackupTasks")
  }),
  Schema.Struct({
    op: Schema.Literal("readBackupTask"),
    taskId: Uuid
  }),
  Schema.Struct({
    op: Schema.Literal("markBackupTaskRunning"),
    taskId: Uuid,
    updatedAtMs: Schema.Int
  }),
  Schema.Struct({
    op: Schema.Literal("finishBackupTask"),
    taskId: Uuid,
    status: Schema.Union([
      Schema.Literal("succeeded"),
      Schema.Literal("failed"),
      Schema.Literal("interrupted")
    ]),
    errorCode: Schema.NullOr(Schema.String),
    errorMessage: Schema.NullOr(Schema.String),
    updatedAtMs: Schema.Int
  }),
  Schema.Struct({
    op: Schema.Literal("startBackupDrill"),
    runId: Uuid,
    artifactId: Uuid,
    manifestDigest: Schema.String,
    startedAtMs: Schema.Int
  }),
  Schema.Struct({
    op: Schema.Literal("completeBackupDrill"),
    runId: Uuid,
    status: Schema.Union([Schema.Literal("passed"), Schema.Literal("failed"), Schema.Literal("interrupted")]),
    completedAtMs: Schema.Int,
    diagnosticCode: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
    diagnosticMessage: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
    checksJson: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64 * 1024)))
  }),
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
    observedPaths: Schema.Array(Schema.String),
    observedCandidatePaths: Schema.Array(Schema.String)
  }),
  Schema.Struct({
    op: Schema.Literal("releaseHeldDiscovery"),
    candidateId: Uuid,
    rootId: Uuid,
    operationId: Uuid,
    epoch: Uuid,
    expectedCandidateVersion: Schema.Natural,
    expectedMappingRevision: Revision,
    expectedPolicyRevision: Revision
  }),
  Schema.Struct({
    op: Schema.Literal("lookupEntryResolution"),
    candidateId: Uuid,
    rootId: Uuid,
    entryId: Uuid,
    operationId: Uuid,
    epoch: Uuid,
    decision: Schema.Union([Schema.Literal("keep"), Schema.Literal("replace")]),
    expectedCandidateVersion: Schema.Natural,
    expectedDecisionVersion: Revision,
    expectedLocationRevision: Revision,
    expectedMappingRevision: Revision,
    expectedPolicyRevision: Revision
  }),
  Schema.Struct({
    op: Schema.Literal("resolveReplacement"),
    candidateId: Uuid,
    rootId: Uuid,
    entryId: Uuid,
    operationId: Uuid,
    epoch: Uuid,
    decision: Schema.Union([Schema.Literal("keep"), Schema.Literal("replace")]),
    expectedCandidateVersion: Schema.Natural,
    expectedDecisionVersion: Revision,
    expectedLocationRevision: Revision,
    expectedMappingRevision: Revision,
    expectedPolicyRevision: Revision,
    freshManifestJson: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({ op: Schema.Literal("readLibrary") }),
  Schema.Struct({
    op: Schema.Literal("listLibraryEntries"),
    pageSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
    query: Schema.String.check(Schema.isMaxLength(1024)),
    epoch: Uuid,
    cursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8192))),
    state: Schema.NullOr(Schema.Literal("replacement-pending"))
  }),
  Schema.Struct({
    op: Schema.Literal("listIndexedRootSamples"),
    rootId: Uuid,
    sampleLimit: Schema.Literal(INDEXED_ROOT_SAMPLE_LIMIT + 1)
  }),
  Schema.Struct({
    op: Schema.Literal("readEntryResolution"),
    entryId: Uuid,
    siblingCursor: Schema.optional(Schema.String),
    siblingClaimsRevision: Schema.optional(Revision)
  }),
  Schema.Struct({ op: Schema.Literal("readEntry"), entryId: Uuid }),
  Schema.Struct({
    op: Schema.Literal("bindEntry"),
    entryId: Uuid,
    operationId: Uuid,
    epoch: Uuid,
    expectedDecisionVersion: Revision,
    source: Schema.Literal("EH"),
    gid: Schema.String.check(Schema.isPattern(/^[0-9]{1,20}$/)),
    token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
    preferredDomain: Schema.Union([Schema.Literal("e-hentai.org"), Schema.Literal("exhentai.org")]),
    canonicalUrl: Schema.String.check(Schema.isMaxLength(2048))
  }),
  Schema.Struct({
    op: Schema.Literal("updateEntryCommand"),
    entryId: Uuid,
    operationId: Uuid,
    epoch: Uuid,
    expectedDecisionVersion: Revision,
    command: Schema.Union([
      SetPersonalTitleCommand,
      RemovePersonalTitleCommand,
      SetEntryNoteCommand,
      ClearEntryNoteCommand
    ])
  }),
  Schema.Struct({ op: Schema.Literal("readAcceptedThumbnailEntry"), entryId: Uuid }),
  Schema.Struct({ op: Schema.Literal("acceptOpenEvents"), events: Schema.Array(OpenEvent) }),
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
