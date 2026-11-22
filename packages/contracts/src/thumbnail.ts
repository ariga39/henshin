import { Schema } from "effect"
import { Uuid } from "./ids"

export const ThumbnailProfile = Schema.Literal("default-cover-v1")
export type ThumbnailProfile = typeof ThumbnailProfile.Type

/** Opaque server-issued key for one accepted entry/content version. */
export const ThumbnailKey = Schema.String.check(
  Schema.isPattern(/^default-v1\.[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(0|[1-9][0-9]*)$/)
)
export type ThumbnailKey = typeof ThumbnailKey.Type

export const ThumbnailReference = Schema.Struct({
  key: ThumbnailKey,
  profile: ThumbnailProfile
})
export type ThumbnailReference = typeof ThumbnailReference.Type

export const ThumbnailEntryId = Uuid
