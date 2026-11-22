import { Schema } from "effect"
import { Revision, Uuid } from "./ids"

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
  candidates: Schema.Array(RootPreviewCandidate),
  sample_limit: Schema.Natural,
  unassigned_loose_images: Schema.Array(Schema.String),
  unassigned_loose_image_count: Schema.Natural,
  unsupported_loose_images: Schema.Array(Schema.String),
  unsupported_loose_image_count: Schema.Natural,
  coverage: RootPreviewCoverage
})
export type SavedRootPreview = typeof SavedRootPreview.Type

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
  state: Schema.Literal("active")
})
export type ServerRoot = typeof ServerRoot.Type

export const ServerRootList = Schema.Array(ServerRoot)
export type ServerRootList = typeof ServerRootList.Type
