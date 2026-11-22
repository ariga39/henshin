import { Schema } from "effect"
import { Revision, Uuid } from "./ids"
import { ServerRootList } from "./root"
import { ThumbnailReference } from "./thumbnail"

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
  location_revision: Revision,
  cover: Schema.NullOr(ThumbnailReference)
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
