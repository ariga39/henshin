import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { OpenEventHttpClient } from "@henshin/contracts"
import { OpenJournalStore } from "../src/main/persistence/OpenJournalStore"
import type { OpenJournalRow } from "../src/main/persistence/draft-worker-protocol"
import { deliverOpenEvents } from "../src/main/OpenEventDelivery"

const session = { instanceId: randomUUID(), epoch: randomUUID() }

const makeRow = (overrides: Partial<OpenJournalRow> = {}): OpenJournalRow => {
  const actionId = randomUUID()
  const event = {
    event_id: actionId,
    instance_id: session.instanceId,
    entry_id: randomUUID(),
    device_id: randomUUID(),
    observed_location_revision: "1",
    observed_content_version: "2",
    occurred_at_ms: 1_700_000_000_000
  }
  return {
    instanceId: session.instanceId,
    actionId,
    entryId: event.entry_id,
    deviceId: event.device_id,
    observedLocationRevision: event.observed_location_revision,
    observedContentVersion: event.observed_content_version,
    status: "accepted",
    event,
    deliveryStatus: "pending",
    deliveryErrorCode: null,
    deliveryErrorMessage: null,
    failureCode: null,
    failureMessage: null,
    createdAtMs: event.occurred_at_ms,
    updatedAtMs: event.occurred_at_ms,
    ...overrides
  }
}

const makeStore = (rows: ReadonlyArray<OpenJournalRow>) => {
  const acknowledged: string[] = []
  const held: Array<{ actionId: string; code: string }> = []
  const store = {
    list: () => Effect.succeed(rows),
    acknowledge: ({ actionId }: { actionId: string }) => {
      acknowledged.push(actionId)
      return Effect.succeed(rows.find((row) => row.actionId === actionId)!)
    },
    hold: ({ actionId, deliveryErrorCode }: { actionId: string; deliveryErrorCode: string }) => {
      held.push({ actionId, code: deliveryErrorCode })
      return Effect.succeed(rows.find((row) => row.actionId === actionId)!)
    }
  } as unknown as OpenJournalStore["Service"]
  return { store, acknowledged, held }
}

const clientFor = (batch: OpenEventHttpClient["Service"]["batch"]): OpenEventHttpClient["Service"] =>
  ({ batch } as OpenEventHttpClient["Service"])

describe("accepted open event delivery", () => {
  it("retries a lost acknowledgment with the same event and counts it once", async () => {
    const row = makeRow()
    const { store, acknowledged } = makeStore([row])
    let calls = 0
    let serverCount = 0
    const client = clientFor(({ payload }) => {
      calls += 1
      if (calls === 1) {
        serverCount += 1
        return Effect.fail(new Error("acknowledgment lost after commit"))
      }
      return Effect.succeed({
        instance_id: session.instanceId,
        epoch: session.epoch,
        request_id: randomUUID(),
        server_time: Date.now(),
        data: {
          results: payload.events.map((event) => ({
            event_id: event.event_id,
            outcome: "already_accepted" as const,
            receipt_at_ms: 1_700_000_000_001
          }))
        }
      })
    })

    await expect(Effect.runPromise(deliverOpenEvents(store, client, session))).rejects.toThrow("acknowledgment lost")
    expect(acknowledged).toEqual([])
    await expect(Effect.runPromise(deliverOpenEvents(store, client, session))).resolves.toMatchObject({
      attempted: 1,
      acknowledged: 1,
      alreadyAccepted: 1,
      held: 0
    })
    expect(calls).toBe(2)
    expect(serverCount).toBe(1)
    expect(acknowledged).toEqual([row.actionId])
  })

  it("applies independent per-event outcomes and refuses a different namespace", async () => {
    const first = makeRow()
    const second = makeRow()
    const third = makeRow()
    const { store, acknowledged, held } = makeStore([first, second, third])
    let sent = 0
    const client = clientFor(({ payload }) => {
      sent += 1
      return Effect.succeed({
        instance_id: session.instanceId,
        epoch: session.epoch,
        request_id: randomUUID(),
        server_time: Date.now(),
        data: {
          results: [
            { event_id: payload.events[0]!.event_id, outcome: "accepted" as const, receipt_at_ms: 1 },
            { event_id: payload.events[1]!.event_id, outcome: "conflict" as const },
            { event_id: payload.events[2]!.event_id, outcome: "missing_entry" as const }
          ]
        }
      })
    })

    await expect(Effect.runPromise(deliverOpenEvents(store, client, session))).resolves.toMatchObject({
      attempted: 3,
      acknowledged: 1,
      held: 2
    })
    expect(sent).toBe(1)
    expect(acknowledged).toEqual([first.actionId])
    expect(held).toEqual([
      { actionId: second.actionId, code: "event_conflict" },
      { actionId: third.actionId, code: "entry_missing" }
    ])

    const foreign = makeRow({
      event: { ...first.event!, instance_id: randomUUID() }
    })
    const foreignStore = makeStore([foreign])
    await expect(Effect.runPromise(deliverOpenEvents(foreignStore.store, client, session))).rejects.toMatchObject({
      _tag: "OpenEventDeliveryNamespaceError"
    })
    expect(sent).toBe(1)
  })
})
