import { Schema } from "effect"
import { Revision, Uuid } from "./ids"

const EventTime = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Immutable payload created after an external reader handoff was accepted. */
export const OpenEvent = Schema.Struct({
  event_id: Uuid,
  instance_id: Uuid,
  entry_id: Uuid,
  device_id: Uuid,
  observed_location_revision: Revision,
  observed_content_version: Revision,
  occurred_at_ms: EventTime
})
export type OpenEvent = typeof OpenEvent.Type

/** Transport context is intentionally separate from each immutable event. */
export const OpenEventBatchRequest = Schema.Struct({
  epoch: Uuid,
  events: Schema.Array(OpenEvent).check(Schema.isMaxLength(100))
})
export type OpenEventBatchRequest = typeof OpenEventBatchRequest.Type

export const OpenEventOutcome = Schema.Union([
  Schema.Struct({
    event_id: Uuid,
    outcome: Schema.Literal("accepted"),
    receipt_at_ms: EventTime
  }),
  Schema.Struct({
    event_id: Uuid,
    outcome: Schema.Literal("already_accepted"),
    receipt_at_ms: EventTime
  }),
  Schema.Struct({
    event_id: Uuid,
    outcome: Schema.Literal("conflict")
  }),
  Schema.Struct({
    event_id: Uuid,
    outcome: Schema.Literal("missing_entry")
  })
])
export type OpenEventOutcome = typeof OpenEventOutcome.Type

export const OpenEventBatchResult = Schema.Struct({
  results: Schema.Array(OpenEventOutcome)
})
export type OpenEventBatchResult = typeof OpenEventBatchResult.Type
