import { Schema } from "effect"
import { Revision, Uuid } from "./ids"

/** A portable path relative to a saved source root. */
export const RootRelativePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.makeFilter((value) => {
    if (value.includes("\\") || value.includes("\u0000") || value.startsWith("/")) return false
    const segments = value.split("/")
    return segments.every(
      (segment, index) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !(index === 0 && /^[A-Za-z]:/.test(segment))
    )
  })
)
export type RootRelativePath = typeof RootRelativePath.Type

/** A persisted scan-scope exclusion; `subtree` includes the named directory. */
export const RootExclusion = Schema.Struct({
  path: RootRelativePath,
  scope: Schema.Union([Schema.Literal("exact"), Schema.Literal("subtree")])
})
export type RootExclusion = typeof RootExclusion.Type

export const MAX_ROOT_EXCLUSIONS = 256
export const RootExclusions = Schema.Array(RootExclusion).check(Schema.isMaxLength(MAX_ROOT_EXCLUSIONS))
export type RootExclusions = typeof RootExclusions.Type

/** Root-policy commands for suppressing or restoring one exact path or subtree. */
export const RootPolicyCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("exclude"),
    exclusion: RootExclusion
  }),
  Schema.Struct({
    type: Schema.Literal("remove-exclusion"),
    exclusion: RootExclusion
  })
])
export type RootPolicyCommand = typeof RootPolicyCommand.Type

export const RootPolicyCommandRequest = Schema.Struct({
  operation_id: Uuid,
  instance_id: Uuid,
  epoch: Uuid,
  expected_policy_revision: Revision,
  command: RootPolicyCommand
})
export type RootPolicyCommandRequest = typeof RootPolicyCommandRequest.Type

/**
 * A bounded read-only sample of a server-local directory. The selected path is
 * returned as display data; it is never turned into a root or an entry.
 */
const RootPreviewPathRequest = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
})

export const SavedRootPreviewRequest = Schema.Struct({
  kind: Schema.Literal("saved-root"),
  root_id: Uuid
})
export type SavedRootPreviewRequest = typeof SavedRootPreviewRequest.Type

export const RootPreviewRequest = Schema.Union([RootPreviewPathRequest, SavedRootPreviewRequest])
export type RootPreviewRequest = typeof RootPreviewRequest.Type

export const RootPreviewCandidate = Schema.Struct({
  relative_path: Schema.String,
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  direct_image_count: Schema.Natural,
  unsupported_direct_image_count: Schema.Natural
})
export type RootPreviewCandidate = typeof RootPreviewCandidate.Type

export const RootPreviewIssue = Schema.Struct({
  code: Schema.String,
  relative_path: Schema.optional(Schema.String)
})
export type RootPreviewIssue = typeof RootPreviewIssue.Type

export const RootPreviewCoverage = Schema.Struct({
  status: Schema.Union([Schema.Literal("complete"), Schema.Literal("partial")]),
  directories_visited: Schema.Natural,
  entries_observed: Schema.Natural,
  candidate_count: Schema.Natural,
  candidate_sample_truncated: Schema.Boolean,
  excluded_links: Schema.Array(Schema.String),
  excluded_link_count: Schema.Natural,
  unsupported_names: Schema.Array(Schema.String),
  unsupported_name_count: Schema.Natural,
  unsupported_directories: Schema.Array(Schema.String),
  unsupported_directory_count: Schema.Natural,
  issues: Schema.Array(RootPreviewIssue),
  issue_count: Schema.Natural
})
export type RootPreviewCoverage = typeof RootPreviewCoverage.Type

export const RootPreviewIdentity = Schema.Struct({
  canonical_server_path: Schema.String,
  device: Schema.String,
  inode: Schema.String
})
export type RootPreviewIdentity = typeof RootPreviewIdentity.Type

export const RootPreviewChild = Schema.Struct({
  name: Schema.String,
  kind: Schema.Union([
    Schema.Literal("file"),
    Schema.Literal("directory"),
    Schema.Literal("symlink"),
    Schema.Literal("other")
  ])
})
export type RootPreviewChild = typeof RootPreviewChild.Type

export const RootPreview = Schema.Struct({
  selected_server_path: Schema.String,
  instance_id: Uuid,
  epoch: Uuid,
  preview_identity: RootPreviewIdentity,
  outcome: Schema.Union([Schema.Literal("selected"), Schema.Literal("empty"), Schema.Literal("truncated")]),
  children: Schema.Array(RootPreviewChild),
  sample_limit: Schema.Int
})
export type RootPreview = typeof RootPreview.Type

/** Bounded book-candidate discovery for an already registered root. */
export const SavedRootPreview = Schema.Struct({
  kind: Schema.Literal("saved-root-discovery"),
  root_id: Uuid,
  selected_server_path: Schema.String,
  instance_id: Uuid,
  epoch: Uuid,
  policy_revision: Revision,
  candidates: Schema.Array(RootPreviewCandidate),
  sample_limit: Schema.Natural,
  unassigned_loose_images: Schema.Array(Schema.String),
  unassigned_loose_image_count: Schema.Natural,
  unsupported_loose_images: Schema.Array(Schema.String),
  unsupported_loose_image_count: Schema.Natural,
  coverage: RootPreviewCoverage
})
export type SavedRootPreview = typeof SavedRootPreview.Type

export const LocalMappingSample = Schema.Struct({
  relative_path: RootRelativePath,
  indexed_kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  indexed_format_evidence: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
  indexed_size_bytes: Schema.NullOr(Schema.Natural),
  status: Schema.Union([
    Schema.Literal("found"),
    Schema.Literal("missing"),
    Schema.Literal("unsafe"),
    Schema.Literal("unsupported"),
    Schema.Literal("collision"),
    Schema.Literal("error")
  ]),
  collision_kind: Schema.NullOr(Schema.Union([
    Schema.Literal("name-equivalence"),
    Schema.Literal("physical-identity")
  ])),
  local_kind: Schema.NullOr(Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")])),
  local_format_evidence: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
  local_size_bytes: Schema.NullOr(Schema.Natural),
  local_evidence_status: Schema.Union([
    Schema.Literal("complete"),
    Schema.Literal("partial"),
    Schema.Literal("unavailable")
  ]),
  local_error: Schema.NullOr(Schema.Union([
    Schema.Literal("missing"),
    Schema.Literal("unsafe"),
    Schema.Literal("unsupported"),
    Schema.Literal("permission-denied"),
    Schema.Literal("directory-limit"),
    Schema.Literal("budget-exceeded"),
    Schema.Literal("unavailable")
  ]))
})
export type LocalMappingSample = typeof LocalMappingSample.Type

export const LocalMappingPreview = Schema.Struct({
  root_id: Uuid,
  selected_local_path: Schema.String,
  samples: Schema.Array(LocalMappingSample),
  sample_limit: Schema.Literal(32),
  sample_truncated: Schema.Boolean,
  local_budget_exhausted: Schema.Boolean
})
export type LocalMappingPreview = typeof LocalMappingPreview.Type

export const RootPreviewResult = Schema.Union([RootPreview, SavedRootPreview])
export type RootPreviewResult = typeof RootPreviewResult.Type

export const RootLabel = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
export type RootLabel = typeof RootLabel.Type

/** The user-confirmed proposal accepted by POST /roots. */
export const RootRegistrationRequest = Schema.Struct({
  operation_id: Uuid,
  instance_id: Uuid,
  epoch: Uuid,
  label: RootLabel,
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  preview_identity: RootPreviewIdentity
})
export type RootRegistrationRequest = typeof RootRegistrationRequest.Type

export const ServerRoot = Schema.Struct({
  library_id: Uuid,
  root_id: Uuid,
  label: RootLabel,
  selected_server_path: Schema.String,
  canonical_server_path: Schema.String,
  mapping_revision: Revision,
  policy_revision: Revision,
  exclusions: RootExclusions,
  state: Schema.Literal("active")
})
export type ServerRoot = typeof ServerRoot.Type

export const ServerRootList = Schema.Array(ServerRoot)
export type ServerRootList = typeof ServerRootList.Type

export const RootScanCommand = Schema.Struct({
  type: Schema.Literal("start-scan"),
  mode: Schema.Literal("manual"),
  hold_new_discoveries: Schema.Boolean
})
export type RootScanCommand = typeof RootScanCommand.Type

/** The explicit, non-accepting manual scan command for a saved root. */
export const RootScanCommandRequest = Schema.Struct({
  operation_id: Uuid,
  instance_id: Uuid,
  epoch: Uuid,
  expected_mapping_revision: Revision,
  expected_policy_revision: Revision,
  command: RootScanCommand
})
export type RootScanCommandRequest = typeof RootScanCommandRequest.Type

export const RootCommandRequest = Schema.Union([RootPolicyCommandRequest, RootScanCommandRequest])
export type RootCommandRequest = typeof RootCommandRequest.Type

export const ScanTaskError = Schema.Struct({
  code: Schema.String,
  message: Schema.String
})
export type ScanTaskError = typeof ScanTaskError.Type

export const ScanTaskStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "completed_with_errors",
  "failed",
  "interrupted"
])
export type ScanTaskStatus = typeof ScanTaskStatus.Type

export const ScanTask = Schema.Struct({
  task_id: Uuid,
  root_id: Uuid,
  kind: Schema.Literal("manual-scan"),
  mode: Schema.Literal("manual"),
  hold_new_discoveries: Schema.Boolean,
  mapping_revision: Revision,
  status: ScanTaskStatus,
  directories_visited: Schema.Natural,
  candidates_discovered: Schema.Natural,
  candidates_analyzed: Schema.Natural,
  analysis_error_count: Schema.Natural,
  review_needed_count: Schema.Natural,
  coverage: Schema.NullOr(RootPreviewCoverage),
  readiness_error: Schema.NullOr(ScanTaskError),
  error: Schema.NullOr(ScanTaskError),
  created_at_ms: Schema.Int,
  updated_at_ms: Schema.Int
})
export type ScanTask = typeof ScanTask.Type

export const ScanTaskList = Schema.Array(ScanTask)
export type ScanTaskList = typeof ScanTaskList.Type

export const ScanTaskSubmission = Schema.Struct({
  task: ScanTask
})
export type ScanTaskSubmission = typeof ScanTaskSubmission.Type

export const ScanManifestPage = Schema.Struct({
  name: Schema.String,
  format: Schema.String,
  declared_bytes: Schema.Natural
})
export type ScanManifestPage = typeof ScanManifestPage.Type

export const ScanManifestDiagnostics = Schema.Struct({
  supported_pages: Schema.Natural,
  unsupported_pages: Schema.Natural,
  ignored_entries: Schema.Natural,
  directory_records: Schema.Natural
})
export type ScanManifestDiagnostics = typeof ScanManifestDiagnostics.Type

export const ScanManifestObservation = Schema.Struct({
  kind: Schema.Union([Schema.Literal("directory"), Schema.Literal("archive")]),
  bytes: Schema.Natural,
  mtime_ms: Schema.Number,
  entry_count: Schema.Natural,
  /** Stable lightweight token; older persisted manifests may omit it. */
  observation_token: Schema.optional(Schema.String)
})
export type ScanManifestObservation = typeof ScanManifestObservation.Type

export const ScanManifest = Schema.Struct({
  source_kind: Schema.Union([Schema.Literal("directory"), Schema.Literal("archive")]),
  pages: Schema.Array(ScanManifestPage),
  diagnostics: ScanManifestDiagnostics,
  before: ScanManifestObservation,
  after: ScanManifestObservation
})
export type ScanManifest = typeof ScanManifest.Type

export const ScanAnalysisError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  diagnostics: ScanManifestDiagnostics
})
export type ScanAnalysisError = typeof ScanAnalysisError.Type

/** A durable discovery awaiting explicit review; it is never an accepted entry. */
export const StagedDiscovery = Schema.Struct({
  candidate_id: Uuid,
  task_id: Uuid,
  root_id: Uuid,
  relative_path: Schema.String,
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  candidate_version: Schema.Natural,
  hold_state: Schema.Union([Schema.Literal("held"), Schema.Literal("eligible")]),
  analysis_status: Schema.Union([Schema.Literal("ready"), Schema.Literal("error")]),
  manifest: Schema.NullOr(ScanManifest),
  analysis_error: Schema.NullOr(ScanAnalysisError),
  updated_at_ms: Schema.Int
})
export type StagedDiscovery = typeof StagedDiscovery.Type

export const StagedDiscoveryList = Schema.Array(StagedDiscovery)
export type StagedDiscoveryList = typeof StagedDiscoveryList.Type
