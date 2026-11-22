import { describe, expect, it } from "vitest"
import type { OpenJournalView } from "../../desktop/src/renderer/client"
import {
  acceptedOpenJournalRows,
  nonAcceptedOpenJournalRows,
  openJournalStatusText,
  pendingOpenJournalRows
} from "../../desktop/src/renderer/openJournalPresentation"

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
})
