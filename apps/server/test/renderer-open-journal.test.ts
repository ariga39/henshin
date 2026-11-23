import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { OpenJournalView } from "../../desktop/src/renderer/client"
import { OpenJournalClient } from "../../desktop/src/renderer/client"
import {
  acceptedOpenJournalRows,
  nonAcceptedOpenJournalRows,
  openJournalStatusText,
  pendingOpenJournalRows
} from "../../desktop/src/renderer/openJournalPresentation"
import { loadOpenJournal } from "../../desktop/src/renderer/workflows"
import { viewStore } from "../../desktop/src/renderer/store"

const row = (overrides: Partial<OpenJournalView>): OpenJournalView => ({
  instanceId: "11111111-1111-4111-8111-111111111111",
  actionId: "22222222-2222-4222-8222-222222222222",
  entryId: "33333333-3333-4333-8333-333333333333",
  deviceId: "44444444-4444-4444-8444-444444444444",
  observedLocationRevision: "1",
  observedContentVersion: "1",
  status: "accepted",
  event: null,
  deliveryStatus: "pending",
  deliveryErrorCode: null,
  deliveryErrorMessage: null,
  failureCode: null,
  failureMessage: null,
  createdAtMs: 1,
  updatedAtMs: 1,
  ...overrides
})

describe("open journal presentation", () => {
  it("does not present prepared, failed, or unknown rows as pending delivery", () => {
    const rows = [
      row({ status: "prepared", deliveryStatus: null }),
      row({ status: "failed", deliveryStatus: null, failureCode: "reader_failed", failureMessage: "reader failed" }),
      row({ status: "unknown", deliveryStatus: null }),
      row({ status: "accepted", deliveryStatus: "pending" })
    ]

    expect(pendingOpenJournalRows(rows)).toHaveLength(1)
    expect(acceptedOpenJournalRows(rows)).toHaveLength(1)
    expect(nonAcceptedOpenJournalRows(rows).map(openJournalStatusText)).toEqual(["prepared", "failed", "unknown"])
  })

  afterEach(() => {
    viewStore.set({ open_journal: [], open_journal_error: null })
  })

  it("keeps status unavailable on a failed read and clears the journal error after retry", async () => {
    let reads = 0
    const client = OpenJournalClient.of({
      list: () => Effect.succeed(
        reads++ === 0
          ? { ok: false as const, error: { code: "open_journal_unavailable", message: "journal read failed", retryable: true } }
          : { ok: true as const, data: [row({ status: "failed", deliveryStatus: null })] }
      ),
      recover: () => Effect.succeed({ ok: true as const, data: null })
    })

    await Effect.runPromise(Effect.provide(loadOpenJournal, Layer.succeed(OpenJournalClient, client)))
    expect(viewStore.getState().open_journal).toEqual([])
    expect(viewStore.getState().open_journal_error).toBe("journal read failed")

    await Effect.runPromise(Effect.provide(loadOpenJournal, Layer.succeed(OpenJournalClient, client)))
    expect(viewStore.getState().open_journal).toHaveLength(1)
    expect(viewStore.getState().open_journal_error).toBeNull()
  })
})
