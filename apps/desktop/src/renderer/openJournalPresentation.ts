import type { OpenJournalView } from "./client"

export const pendingOpenJournalRows = (rows: ReadonlyArray<OpenJournalView>): ReadonlyArray<OpenJournalView> =>
  rows.filter((row) => row.status === "accepted" && row.deliveryStatus === "pending")

export const acceptedOpenJournalRows = (rows: ReadonlyArray<OpenJournalView>): ReadonlyArray<OpenJournalView> =>
  rows.filter((row) => row.status === "accepted" && row.deliveryStatus !== "acknowledged")

export const nonAcceptedOpenJournalRows = (rows: ReadonlyArray<OpenJournalView>): ReadonlyArray<OpenJournalView> =>
  rows.filter((row) => row.status !== "accepted")

export const openJournalStatusText = (row: OpenJournalView): string => {
  if (row.status !== "accepted") return row.status
  return row.deliveryStatus === "held" ? "held" : "pending"
}
