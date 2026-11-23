import { useEffect, useSyncExternalStore } from "react"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { discardHeldOpenEvent, dismissUnknownOpenJournal, loadOpenJournal } from "./workflows"
import {
  acceptedOpenJournalRows,
  nonAcceptedOpenJournalRows,
  openJournalStatusText,
  pendingOpenJournalRows
} from "./openJournalPresentation"

export const OpenJournalDiagnostics = () => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)
  const pendingOpenEvents = pendingOpenJournalRows(state.open_journal)
  const acceptedOpenEvents = acceptedOpenJournalRows(state.open_journal)
  const nonAcceptedOpenEvents = nonAcceptedOpenJournalRows(state.open_journal)

  useEffect(() => {
    const onOpenJournalChanged = window.henshinOpenJournal?.onChanged
    void runtime.runPromise(loadOpenJournal)
    if (onOpenJournalChanged === undefined) return undefined
    return onOpenJournalChanged(() => {
      void runtime.runPromise(loadOpenJournal)
    })
  }, [])

  return (
    <section aria-labelledby="open-delivery-actions">
      <h2 id="open-delivery-actions">Reader handoff recovery</h2>
      <p>
        Accepted reader handoffs stay pending until the authenticated original server acknowledges the same event.
      </p>
      <button data-testid="load-open-journal" onClick={() => void runtime.runPromise(loadOpenJournal)}>
        Refresh handoff status
      </button>
      <p data-testid="open-delivery-status">{pendingOpenEvents.length} pending handoff event(s)</p>
      {acceptedOpenEvents.map((row) => (
        <article key={row.actionId} data-testid={`open-event-${row.actionId}`}>
          <p>
            entry {row.entryId}: {openJournalStatusText(row)}
          </p>
          {row.deliveryErrorMessage !== null && <p>{row.deliveryErrorMessage}</p>}
          {row.deliveryStatus === "held" && (
            <>
              <p>
                Discarding this held event permanently removes it; the pending reading count can be lost and it will not be replayed.
              </p>
              <button
                data-testid={`discard-held-${row.actionId}`}
                onClick={() => {
                  if (window.confirm("Discard this held event? The pending reading count can be lost and the event will not be replayed.")) {
                      void runtime.runPromise(discardHeldOpenEvent(row))
                  }
                }}
              >
                Discard held event
              </button>
            </>
          )}
        </article>
      ))}
      {nonAcceptedOpenEvents.length > 0 && (
        <div data-testid="open-journal-other-outcomes">
          <h3>Other handoff outcomes</h3>
          {nonAcceptedOpenEvents.map((row) => (
            <article key={row.actionId} data-testid={`open-event-${row.actionId}`}>
              <p>entry {row.entryId}: {row.status}</p>
              {row.failureCode !== null && <p>{row.failureCode}</p>}
              {row.failureMessage !== null && <p>{row.failureMessage}</p>}
              {row.status === "unknown" && (
                <>
                  <p>The dispatch result is unknown; dismissing this intent only removes its local diagnostic record.</p>
                  <button
                    data-testid={`dismiss-unknown-${row.actionId}`}
                    onClick={() => void runtime.runPromise(dismissUnknownOpenJournal(row))}
                  >
                    Dismiss unknown intent
                  </button>
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
