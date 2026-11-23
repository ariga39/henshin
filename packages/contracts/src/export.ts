import { Schema } from "effect"
import { Uuid } from "./ids"

export const MetadataExportRequest = Schema.Struct({
  entry_ids: Schema.Array(Uuid).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  include_notes: Schema.Boolean
})
export type MetadataExportRequest = typeof MetadataExportRequest.Type

const MetadataExportEntryState = Schema.Literals(["accepted", "replacement-pending", "detached"])

export const MetadataExportEntry = Schema.Struct({
  entry_id: Uuid,
  state: MetadataExportEntryState,
  root_id: Uuid,
  relative_path: Schema.String,
  kind: Schema.Union([Schema.Literal("archive"), Schema.Literal("image-directory")]),
  title: Schema.String,
  page_count: Schema.Natural,
  binding_url: Schema.NullOr(Schema.String),
  /** Present only when an owner has persisted source metadata for this entry. */
  source_metadata: Schema.optional(Schema.Struct({
    title: Schema.optional(Schema.String),
    title_jpn: Schema.optional(Schema.String),
    tags: Schema.optional(Schema.Array(Schema.String))
  })),
  /** Present only when an owner has persisted a local override. */
  local_overrides: Schema.optional(Schema.Struct({
    title: Schema.optional(Schema.String),
    tags: Schema.optional(Schema.Array(Schema.String)),
    suppressed_tags: Schema.optional(Schema.Array(Schema.String))
  })),
  statistics: Schema.Struct({
    open_count: Schema.Natural,
    last_opened_at_ms: Schema.NullOr(Schema.Int)
  }),
  notes: Schema.optional(Schema.Array(Schema.String))
})
export type MetadataExportEntry = typeof MetadataExportEntry.Type

export const MetadataExportDocument = Schema.Struct({
  schema: Schema.Literal("henshin-metadata-export-v1"),
  exported_at_ms: Schema.Int,
  instance_id: Uuid,
  library_id: Uuid,
  selected_entry_ids: Schema.Array(Uuid),
  missing_entry_ids: Schema.Array(Uuid),
  privacy: Schema.Struct({
    classification: Schema.Literal("private"),
    locator_disclosure: Schema.Literal("Gallery URLs contain private locators."),
    notes_included: Schema.Boolean,
    omitted: Schema.Array(Schema.String)
  }),
  entries: Schema.Array(MetadataExportEntry)
})
export type MetadataExportDocument = typeof MetadataExportDocument.Type
