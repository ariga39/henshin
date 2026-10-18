import { Schema } from "effect"

/** Largest value a SQLite INTEGER column can hold. */
const MAX_SQLITE_INTEGER = 9223372036854775807n

/**
 * Canonical nonnegative decimal revision. Validated as a string so it never
 * round-trips through a JavaScript number, and bounded to the SQLite integer
 * range so the persisted INTEGER column is always exact.
 */
export const isCanonicalRevision = Schema.makeFilter<string>(
  (value) => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= MAX_SQLITE_INTEGER
)

export const Revision = Schema.String.check(isCanonicalRevision)
export type Revision = typeof Revision.Type

/** Opaque prototype record identifier. */
export const NoteId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))
export type NoteId = typeof NoteId.Type

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Operation id, instance id, and epoch are all UUIDs on the wire. */
export const Uuid = Schema.String.check(Schema.isPattern(UUID_PATTERN))
export type Uuid = typeof Uuid.Type

/** Bounded prototype note text (UTF-16 code units). */
export const Text = Schema.String.check(Schema.isMaxLength(1024))
export type Text = typeof Text.Type
