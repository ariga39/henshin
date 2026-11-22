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
