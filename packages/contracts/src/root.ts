import { Schema } from "effect"

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

export const RootPreview = Schema.Struct({
  selected_server_path: Schema.String,
  outcome: Schema.Union([Schema.Literal("selected"), Schema.Literal("empty"), Schema.Literal("truncated")]),
  children: Schema.Array(RootPreviewChild),
  sample_limit: Schema.Int
})
export type RootPreview = typeof RootPreview.Type
