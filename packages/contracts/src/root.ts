import { Schema } from "effect"
import { Revision, Uuid } from "./ids"

/**
 * A bounded read-only sample of a server-local directory. The selected path is
 * returned as display data; it is never turned into a root or an entry.
 */
export const RootPreviewRequest = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
})
export type RootPreviewRequest = typeof RootPreviewRequest.Type

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

/** Native identity captured with a preview and checked again before activation. */
export const RootPreviewIdentity = Schema.Struct({
  canonical_server_path: Schema.String,
  device: Schema.String,
  inode: Schema.String
})
export type RootPreviewIdentity = typeof RootPreviewIdentity.Type

export const RootLabel = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
export type RootLabel = typeof RootLabel.Type

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
