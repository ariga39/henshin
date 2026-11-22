import { Schema } from "effect"
import { Revision, Uuid } from "./ids"
import { RootRelativePath, ScanAnalysisError, ScanManifestDiagnostics, ScanManifestObservation, ScanManifestPage, ServerRootList } from "./root"
import { ThumbnailReference } from "./thumbnail"

const replacementObservationFields = {
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  page_count: Schema.Natural,
  format_evidence: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
  size_bytes: Schema.NullOr(Schema.Natural),
  entry_count: Schema.Natural,
  diagnostics: ScanManifestDiagnostics
} as const

export const ReplacementObservation = Schema.Struct(replacementObservationFields)
export type ReplacementObservation = typeof ReplacementObservation.Type

export const ReplacementCandidateObservation = Schema.Struct({
  ...replacementObservationFields,
  analysis_status: Schema.Union([Schema.Literal("ready"), Schema.Literal("error")]),
  analysis_error: Schema.NullOr(ScanAnalysisError)
})
export type ReplacementCandidateObservation = typeof ReplacementCandidateObservation.Type

export const ReplacementComparison = Schema.Struct({
  candidate_id: Uuid,
  candidate_version: Schema.Natural,
  decision_version: Revision,
  old_observation: ReplacementObservation,
  candidate_observation: ReplacementCandidateObservation
})
export type ReplacementComparison = typeof ReplacementComparison.Type

export const LibraryEntry = Schema.Struct({
  entry_id: Uuid,
  library_id: Uuid,
  root_id: Uuid,
  relative_path: Schema.String,
  source_path: Schema.String,
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  title: Schema.String,
  page_count: Schema.Natural,
  state: Schema.Union([Schema.Literal("accepted"), Schema.Literal("replacement-pending")]),
  content_version: Revision,
  location_revision: Revision,
  cover: Schema.NullOr(ThumbnailReference),
  replacement: Schema.NullOr(ReplacementComparison)
})
export type LibraryEntry = typeof LibraryEntry.Type

export const LibraryEntryPage = Schema.Struct({
  entries: Schema.Array(LibraryEntry),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Uuid),
  library_change_revision: Revision
})
export type LibraryEntryPage = typeof LibraryEntryPage.Type

export const LibraryView = Schema.Struct({
  library_id: Uuid,
  change_revision: Revision,
  roots: ServerRootList
})
export type LibraryView = typeof LibraryView.Type

const pageSize = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200))

export const LibrarySearchRequest = Schema.Struct({
  page_size: Schema.optional(pageSize),
  cursor: Schema.optional(Uuid)
})
export type LibrarySearchRequest = typeof LibrarySearchRequest.Type

export const INDEXED_ROOT_SAMPLE_LIMIT = 32 as const

export const IndexedRootSample = Schema.Struct({
  relative_path: RootRelativePath,
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  format_evidence: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
  size_bytes: Schema.NullOr(Schema.Natural)
})
export type IndexedRootSample = typeof IndexedRootSample.Type

export const IndexedRootSamplePage = Schema.Struct({
  root_id: Uuid,
  samples: Schema.Array(IndexedRootSample),
  sample_limit: Schema.Literal(INDEXED_ROOT_SAMPLE_LIMIT),
  sample_truncated: Schema.Boolean,
  library_change_revision: Revision
})
export type IndexedRootSamplePage = typeof IndexedRootSamplePage.Type

export const ReplacementResolutionCommand = Schema.Struct({
  type: Schema.Literal("resolve-replacement"),
  entry_id: Uuid,
  decision: Schema.Union([Schema.Literal("keep"), Schema.Literal("replace")])
})
export type ReplacementResolutionCommand = typeof ReplacementResolutionCommand.Type

export const ReplacementResolutionResult = Schema.Struct({
  operation_id: Uuid,
  decision: Schema.Union([Schema.Literal("keep"), Schema.Literal("replace")]),
  entry: LibraryEntry,
  detached_entry_id: Schema.NullOr(Uuid)
})
export type ReplacementResolutionResult = typeof ReplacementResolutionResult.Type
export const EntryResolutionSiblingClaim = Schema.Struct({
  entry_id: Uuid,
  relative_path: Schema.String
})
export type EntryResolutionSiblingClaim = typeof EntryResolutionSiblingClaim.Type

const entryResolutionCursor = Schema.String.check(Schema.isMaxLength(8192))

export const EntryResolutionQuery = Schema.Struct({
  sibling_cursor: Schema.optional(entryResolutionCursor),
  sibling_claims_revision: Schema.optional(Revision)
})
export type EntryResolutionQuery = typeof EntryResolutionQuery.Type

export const EntryResolution = Schema.Struct({
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
  sibling_claims: Schema.Array(EntryResolutionSiblingClaim),
  sibling_claims_truncated: Schema.Boolean,
  sibling_claims_next_cursor: Schema.NullOr(entryResolutionCursor),
  sibling_claims_revision: Revision
})
export type EntryResolution = typeof EntryResolution.Type
