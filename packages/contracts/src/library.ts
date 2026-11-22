import { Schema } from "effect"
import { Revision, Uuid } from "./ids"
import { ScanManifestObservation, ScanManifestPage, ServerRootList } from "./root"

export const LibraryEntry = Schema.Struct({
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
  location_revision: Revision
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

export const EntryResolutionSiblingClaim = Schema.Struct({
  entry_id: Uuid,
  relative_path: Schema.String
})
export type EntryResolutionSiblingClaim = typeof EntryResolutionSiblingClaim.Type

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
  sibling_claims_truncated: Schema.Boolean
})
export type EntryResolution = typeof EntryResolution.Type
