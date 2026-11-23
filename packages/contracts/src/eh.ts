import { Schema } from "effect"
import { Revision, Uuid } from "./ids"
import { ReplacementComparison } from "./library"
import { ThumbnailReference } from "./thumbnail"

/** Public identity and preferred link for one E-Hentai/ExHentai gallery. */
export const EhGalleryBinding = Schema.Struct({
  source: Schema.Literal("EH"),
  gid: Schema.String.check(Schema.isPattern(/^[0-9]{1,20}$/)),
  canonical_url: Schema.String.check(Schema.isMaxLength(2048)),
  preferred_domain: Schema.Union([
    Schema.Literal("e-hentai.org"),
    Schema.Literal("exhentai.org")
  ])
})
export type EhGalleryBinding = typeof EhGalleryBinding.Type

export const BindEntryCommand = Schema.Struct({
  type: Schema.Literal("bind"),
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))
})
export type BindEntryCommand = typeof BindEntryCommand.Type

export const EntryCommandRequest = Schema.Struct({
  operation_id: Uuid,
  instance_id: Uuid,
  epoch: Uuid,
  expected_decision_version: Revision,
  command: BindEntryCommand
})
export type EntryCommandRequest = typeof EntryCommandRequest.Type

export const LibraryEntryDetails = Schema.Struct({
  entry_id: Uuid,
  library_id: Uuid,
  root_id: Uuid,
  relative_path: Schema.String,
  source_path: Schema.String,
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  title: Schema.String,
  page_count: Schema.Natural,
  state: Schema.Union([Schema.Literal("accepted"), Schema.Literal("replacement-pending")]),
  decision_version: Revision,
  content_version: Revision,
  location_revision: Revision,
  cover: Schema.NullOr(ThumbnailReference),
  replacement: Schema.NullOr(ReplacementComparison),
  binding: Schema.NullOr(EhGalleryBinding)
})
export type LibraryEntryDetails = typeof LibraryEntryDetails.Type

export const EntryCommandResult = Schema.Struct({
  operation_id: Uuid,
  entry: LibraryEntryDetails
})
export type EntryCommandResult = typeof EntryCommandResult.Type
