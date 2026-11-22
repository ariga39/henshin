/**
 * Canonical command identity used for same-epoch deduplication. Field order is
 * fixed so an identical logical payload always serializes identically.
 *
 * This is computed from validated command fields (never from an unvalidated
 * transport string), so no separate length bound is required here; the stored
 * value is bounded by the validated field bounds.
 */
export const canonicalEditPayload = (input: {
  readonly noteId: string
  readonly text: string
  readonly expectedRevision: string
}): string =>
  JSON.stringify({
    expected_revision: input.expectedRevision,
    note_id: input.noteId,
    text: input.text
  })

/**
 * Canonical identity for an immutable open event. Receipt time is deliberately
 * absent because it is assigned by the server only when the event is first
 * inserted.
 */
export const canonicalOpenEventPayload = (input: {
  readonly eventId: string
  readonly instanceId: string
  readonly entryId: string
  readonly deviceId: string
  readonly observedLocationRevision: string
  readonly observedContentVersion: string
  readonly occurredAtMs: number
}): string =>
  JSON.stringify({
    device_id: input.deviceId,
    entry_id: input.entryId,
    event_id: input.eventId,
    instance_id: input.instanceId,
    occurred_at_ms: input.occurredAtMs,
    observed_content_version: input.observedContentVersion,
    observed_location_revision: input.observedLocationRevision
  })
