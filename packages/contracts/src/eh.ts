import { Effect, Schema } from "effect"
import { Revision, Text, Uuid } from "./ids"
import { DetachMissingCommand, ReplacementComparison } from "./library"
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

const personalTitle = Schema.String.check(Schema.isMaxLength(1024))

export const SetPersonalTitleCommand = Schema.Struct({
  type: Schema.Literal("set-personal-title"),
  title: personalTitle
})
export type SetPersonalTitleCommand = typeof SetPersonalTitleCommand.Type

export const RemovePersonalTitleCommand = Schema.Struct({
  type: Schema.Literal("remove-personal-title")
})
export type RemovePersonalTitleCommand = typeof RemovePersonalTitleCommand.Type

export const SetEntryNoteCommand = Schema.Struct({
  type: Schema.Literal("set-note"),
  text: Text
})
export type SetEntryNoteCommand = typeof SetEntryNoteCommand.Type

export const ClearEntryNoteCommand = Schema.Struct({
  type: Schema.Literal("clear-note")
})
export type ClearEntryNoteCommand = typeof ClearEntryNoteCommand.Type

export const EntryNote = Schema.Struct({
  text: Text,
  revision: Revision
})
export type EntryNote = typeof EntryNote.Type

export const EntryCommand = Schema.Union([
  BindEntryCommand,
  SetPersonalTitleCommand,
  RemovePersonalTitleCommand,
  SetEntryNoteCommand,
  ClearEntryNoteCommand
])
export type EntryCommand = typeof EntryCommand.Type

export const EntryCommandRequest = Schema.Struct({
  operation_id: Uuid,
  instance_id: Uuid,
  epoch: Uuid,
  expected_decision_version: Revision,
  expected_location_revision: Schema.optional(Revision),
  command: Schema.Union([EntryCommand, DetachMissingCommand])
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
  title_override: Schema.NullOr(personalTitle).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null))
  ),
  page_count: Schema.Natural,
  state: Schema.Union([Schema.Literal("accepted"), Schema.Literal("replacement-pending"), Schema.Literal("detached")]),
  decision_version: Revision,
  content_version: Revision,
  location_revision: Revision,
  cover: Schema.NullOr(ThumbnailReference),
  replacement: Schema.NullOr(ReplacementComparison),
  binding: Schema.NullOr(EhGalleryBinding),
  note: Schema.NullOr(EntryNote).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null))
  )
})
export type LibraryEntryDetails = typeof LibraryEntryDetails.Type

export const EntryCommandResult = Schema.Struct({
  operation_id: Uuid,
  entry: LibraryEntryDetails
})
export type EntryCommandResult = typeof EntryCommandResult.Type
