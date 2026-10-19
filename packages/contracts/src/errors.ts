import { Schema } from "effect"
import { Revision } from "./ids"

/**
 * Fields every public prototype error carries. `request_id` is a random
 * correlation id. `instance_id`/`epoch` are present only when the caller was
 * authenticated, so an authentication failure never discloses the live
 * namespace or authority epoch. `details` carries bounded, non-private context
 * where a specific error needs it.
 */
const envelope = {
  request_id: Schema.String,
  instance_id: Schema.optional(Schema.String),
  epoch: Schema.optional(Schema.String)
} as const

export class AuthenticationRequired extends Schema.TaggedError<AuthenticationRequired>()(
  "AuthenticationRequired",
  {
    code: Schema.Literal("authentication_required"),
    message: Schema.String,
    retryable: Schema.Boolean,
    ...envelope
  },
  { httpApiStatus: 401 }
) {}

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  {
    code: Schema.Literal("invalid_request"),
    message: Schema.String,
    retryable: Schema.Boolean,
    details: Schema.optional(Schema.Struct({ field: Schema.String })),
    ...envelope
  },
  { httpApiStatus: 400 }
) {}

export class NoteNotFound extends Schema.TaggedError<NoteNotFound>()(
  "NoteNotFound",
  {
    code: Schema.Literal("not_found"),
    message: Schema.String,
    retryable: Schema.Boolean,
    ...envelope
  },
  { httpApiStatus: 404 }
) {}

export class RevisionConflict extends Schema.TaggedError<RevisionConflict>()(
  "RevisionConflict",
  {
    code: Schema.Literal("revision_conflict"),
    message: Schema.String,
    retryable: Schema.Boolean,
    details: Schema.Struct({ current_revision: Revision }),
    ...envelope
  },
  { httpApiStatus: 409 }
) {}

export class OperationConflict extends Schema.TaggedError<OperationConflict>()(
  "OperationConflict",
  {
    code: Schema.Literal("operation_conflict"),
    message: Schema.String,
    retryable: Schema.Boolean,
    ...envelope
  },
  { httpApiStatus: 409 }
) {}

export class OperationExpired extends Schema.TaggedError<OperationExpired>()(
  "OperationExpired",
  {
    code: Schema.Literal("operation_expired"),
    message: Schema.String,
    retryable: Schema.Literal(false),
    ...envelope
  },
  { httpApiStatus: 410 }
) {}

export class StorageFull extends Schema.TaggedError<StorageFull>()(
  "StorageFull",
  {
    code: Schema.Literal("storage_full503"),
    message: Schema.String,
    retryable: Schema.Literal(true),
    ...envelope
  },
  { httpApiStatus: 503 }
) {}

export class DraftConflict extends Schema.TaggedError<DraftConflict>()(
  "DraftConflict",
  {
    code: Schema.Literal("draft_conflict"),
    message: Schema.String,
    retryable: Schema.Literal(false),
    details: Schema.Struct({ current_local_revision: Revision }),
    ...envelope
  },
  { httpApiStatus: 409 }
) {}

export class DraftStoreFull extends Schema.TaggedError<DraftStoreFull>()(
  "DraftStoreFull",
  {
    code: Schema.Literal("draft_store_full"),
    message: Schema.String,
    retryable: Schema.Literal(false),
    ...envelope
  },
  { httpApiStatus: 507 }
) {}

export class EpochChanged extends Schema.TaggedError<EpochChanged>()(
  "EpochChanged",
  {
    code: Schema.Literal("epoch_changed"),
    message: Schema.String,
    retryable: Schema.Boolean,
    ...envelope
  },
  { httpApiStatus: 409 }
) {}

export class InstanceMismatch extends Schema.TaggedError<InstanceMismatch>()(
  "InstanceMismatch",
  {
    code: Schema.Literal("instance_mismatch"),
    message: Schema.String,
    retryable: Schema.Boolean,
    ...envelope
  },
  { httpApiStatus: 409 }
) {}

/**
 * Opaque internal failure. It never carries a cause, stack, SQL text, or path,
 * so private internals cannot leak through a generic 500.
 */
export class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  {
    code: Schema.Literal("internal_error"),
    message: Schema.String,
    retryable: Schema.Boolean,
    ...envelope
  },
  { httpApiStatus: 500 }
) {}

/**
 * Every public error, as a single schema. Clients map an unknown failure to the
 * public shape only when it decodes here; anything else becomes an opaque
 * failure rather than leaking an arbitrary message.
 */
export const PublicApiError = Schema.Union([
  AuthenticationRequired,
  InvalidRequest,
  NoteNotFound,
  RevisionConflict,
  OperationConflict,
  OperationExpired,
  StorageFull,
  DraftConflict,
  DraftStoreFull,
  EpochChanged,
  InstanceMismatch,
  InternalError
])
export type PublicApiError = typeof PublicApiError.Type
