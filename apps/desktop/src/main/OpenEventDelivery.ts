import { Data, Effect } from "effect"
import { OpenEventHttpClient } from "@henshin/contracts"
import type { OpenEventOutcome } from "@henshin/contracts/event"
import { OpenJournalStore } from "./persistence/OpenJournalStore"
import type { OpenJournalRow } from "./persistence/draft-worker-protocol"

export interface OpenEventDeliverySession {
  readonly instanceId: string
  readonly epoch: string
}

export class OpenEventDeliveryNamespaceError extends Data.TaggedError("OpenEventDeliveryNamespaceError")<{
  readonly message: string
}> {}

export class OpenEventDeliveryResponseError extends Data.TaggedError("OpenEventDeliveryResponseError")<{
  readonly message: string
}> {}

const pendingEvents = (rows: ReadonlyArray<OpenJournalRow>, instanceId: string) =>
  rows.filter((row) => row.status === "accepted" && row.deliveryStatus === "pending" && row.event !== null && row.instanceId === instanceId)

/**
 * Drains one authenticated namespace. The caller owns the HTTP connection;
 * this effect never launches a reader and only mutates the local delivery
 * state after the server has returned a per-event result.
 */
export const deliverOpenEvents = Effect.fnUntraced(function*(
  store: OpenJournalStore["Service"],
  client: OpenEventHttpClient["Service"],
  session: OpenEventDeliverySession
) {
  const rows = yield* store.list(session.instanceId)
  const candidates = pendingEvents(rows, session.instanceId)
  const events = candidates.flatMap((row) => row.event === null ? [] : [row.event])

  if (rows.some((row) => row.status === "accepted" && row.deliveryStatus === "pending" && row.event !== null && row.event.instance_id !== session.instanceId)) {
    return yield* new OpenEventDeliveryNamespaceError({
      message: "pending open event belongs to another server instance"
    })
  }
  if (events.length === 0) return { attempted: 0, acknowledged: 0, alreadyAccepted: 0, held: 0 }

  const response = yield* client.batch({ payload: { epoch: session.epoch, events } })
  if (response.instance_id !== session.instanceId || response.epoch !== session.epoch) {
    return yield* new OpenEventDeliveryNamespaceError({
      message: "open event response belongs to another authenticated server namespace"
    })
  }

  const rowsByEventId = new Map(events.map((event, index) => [event.event_id, candidates[index]!]))
  const seen = new Set<string>()
  for (const result of response.data.results) {
    if (!rowsByEventId.has(result.event_id) || seen.has(result.event_id)) {
      return yield* new OpenEventDeliveryResponseError({ message: "open event response was not attributable" })
    }
    seen.add(result.event_id)
  }

  let acknowledged = 0
  let alreadyAccepted = 0
  let held = 0
  for (const result of response.data.results as ReadonlyArray<OpenEventOutcome>) {
    const row = rowsByEventId.get(result.event_id)
    if (row === undefined) {
      return yield* new OpenEventDeliveryResponseError({ message: "open event response was not attributable" })
    }
    switch (result.outcome) {
      case "accepted":
      case "already_accepted":
        acknowledged += 1
        alreadyAccepted += 1
        yield* store.acknowledge({ instanceId: row.instanceId, actionId: row.actionId })
        break
      case "conflict":
        held += 1
        yield* store.hold({
          instanceId: row.instanceId,
          actionId: row.actionId,
          deliveryErrorCode: "event_conflict",
          deliveryErrorMessage: "server rejected a different payload for this event ID"
        })
        break
      case "missing_entry":
        held += 1
        yield* store.hold({
          instanceId: row.instanceId,
          actionId: row.actionId,
          deliveryErrorCode: "entry_missing",
          deliveryErrorMessage: "the original entry is no longer present on the server"
        })
        break
    }
  }

  return { attempted: events.length, acknowledged, alreadyAccepted, held }
})
