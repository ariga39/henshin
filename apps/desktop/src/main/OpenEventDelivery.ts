import { Data, Duration, Effect } from "effect"
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

export interface OpenEventDeliveryControl {
  readonly isActive?: () => boolean
  readonly batchSize?: number
  readonly sleep?: (milliseconds: number) => Effect.Effect<void>
  readonly random?: () => number
}

export interface OpenEventDeliveryResult {
  readonly attempted: number
  readonly acknowledged: number
  readonly alreadyAccepted: number
  readonly held: number
  readonly missingResults: boolean
}

const DEFAULT_BATCH_SIZE = 32
const RETRY_BASE_DELAY_MS = 100
const RETRY_MAX_DELAY_MS = 5_000

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
  session: OpenEventDeliverySession,
  control: OpenEventDeliveryControl = {}
) {
  const rows = yield* store.list(session.instanceId)
  const candidates = pendingEvents(rows, session.instanceId).slice(0, control.batchSize ?? DEFAULT_BATCH_SIZE)
  const events = candidates.flatMap((row) => row.event === null ? [] : [row.event])

  if (rows.some((row) => row.status === "accepted" && row.deliveryStatus === "pending" && row.event !== null && row.event.instance_id !== session.instanceId)) {
    return yield* new OpenEventDeliveryNamespaceError({
      message: "pending open event belongs to another server instance"
    })
  }
  if (events.length === 0) {
    return { attempted: 0, acknowledged: 0, alreadyAccepted: 0, held: 0, missingResults: false }
  }

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
        acknowledged += 1
        yield* store.acknowledge({ instanceId: row.instanceId, actionId: row.actionId })
        break
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

  return {
    attempted: events.length,
    acknowledged,
    alreadyAccepted,
    held,
    missingResults: response.data.results.length < events.length
  }
})

const isStoppedDeliveryError = (error: unknown): boolean => {
  if (error instanceof OpenEventDeliveryNamespaceError || error instanceof OpenEventDeliveryResponseError) return true
  if (typeof error !== "object" || error === null) return false
  if ("_tag" in error && (error._tag === "EpochChanged" || error._tag === "InstanceMismatch" || error._tag === "AuthenticationRequired")) return true
  return "retryable" in error && error.retryable === false
}

const retryDelay = (retry: number, random: () => number): number => {
  const cap = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** Math.min(retry, 6)))
  return Math.floor(cap / 2 + Math.max(0, Math.min(1, random())) * cap / 2)
}

/**
 * Drains all currently pending events in bounded batches. A transient or lost
 * response retries the same batch with capped exponential backoff and jitter;
 * an incomplete result stops the drain so a missing result cannot spin.
 * Connection lifecycle interruption supplies the normal cancellation path.
 */
export const drainOpenEvents = Effect.fnUntraced(function*(
  store: OpenJournalStore["Service"],
  client: OpenEventHttpClient["Service"],
  session: OpenEventDeliverySession,
  control: OpenEventDeliveryControl = {}
) {
  const isActive = control.isActive ?? (() => true)
  const sleep = control.sleep ?? ((milliseconds: number) => Effect.sleep(Duration.millis(milliseconds)))
  const random = control.random ?? Math.random
  const total = { attempted: 0, acknowledged: 0, alreadyAccepted: 0, held: 0 }
  let retry = 0

  while (isActive()) {
    const attempt = yield* deliverOpenEvents(store, client, session, control).pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (result) => ({ ok: true as const, result })
      })
    )
    if (!attempt.ok) {
      const error = attempt.error
      if (isStoppedDeliveryError(error) || !isActive()) return { ...total, missingResults: false }
      yield* sleep(retryDelay(retry, random))
      retry += 1
      continue
    }
    const result = attempt.result
    retry = 0

    total.attempted += result.attempted
    total.acknowledged += result.acknowledged
    total.alreadyAccepted += result.alreadyAccepted
    total.held += result.held
    if (result.missingResults || result.attempted === 0 || result.acknowledged + result.held === 0) {
      return { ...total, missingResults: result.missingResults }
    }
  }

  return { ...total, missingResults: false }
})
