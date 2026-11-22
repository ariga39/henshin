import { useEffect, useSyncExternalStore } from "react"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { loadLibrary, showSetup } from "./workflows"

export const LibraryScreen = () => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)

  useEffect(() => {
    if (viewStore.getState().library_status === "idle") void runtime.runPromise(loadLibrary())
  }, [])

  return (
    <main className="collection" data-testid="library-screen">
      <header className="library-header">
        <div>
          <h1>Library</h1>
          <p>Accepted books from the saved server roots.</p>
        </div>
        <button data-testid="library-setup" onClick={() => void runtime.runPromise(showSetup)}>
          Collection setup
        </button>
      </header>

      {state.library_scan_task !== null && (
        <p role="status" data-testid="library-scan-status">
          Scan task {state.library_scan_task.status}.
        </p>
      )}
      {state.library_scan_status === "starting" && (
        <p role="status">Scanning saved root; accepted results will appear when the scan completes.</p>
      )}
      {state.library_scan_status === "error" && state.library_scan_error !== null && (
        <p role="alert" data-testid="library-scan-error">Normal scan failed: {state.library_scan_error}</p>
      )}

      <section aria-labelledby="library-entries-heading">
        <h2 id="library-entries-heading">Books</h2>
        <button data-testid="library-refresh" onClick={() => void runtime.runPromise(loadLibrary())}>
          Refresh
        </button>
        {state.library_status === "loading" && <p role="status">Loading library…</p>}
        {state.library_status === "error" && <p role="alert">Could not load library: {state.library_error}</p>}
        {state.library_status === "ready" && state.library_entries.length === 0 && (
          <p data-testid="library-empty">No accepted books yet. Start a normal scan from a saved root.</p>
        )}
        <ul data-testid="library-entries">
          {state.library_entries.map((entry) => (
            <li key={entry.entry_id} data-testid="library-entry">
              <strong>{entry.title}</strong>
              <span>{entry.source_path}</span>
              <small>{entry.entry_id}</small>
            </li>
          ))}
        </ul>
        {state.library_has_more && (
          <button data-testid="library-load-more" onClick={() => void runtime.runPromise(loadLibrary(true))}>
            Load more
          </button>
        )}
      </section>
    </main>
  )
}
