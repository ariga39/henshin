import { Effect } from "effect"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { LibraryEntry } from "@henshin/contracts"
import { LibraryClient } from "./client"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { loadLibrary, showSetup } from "./workflows"

type CoverState =
  | { readonly key: string | null; readonly request: number; readonly status: "loading" | "unavailable"; readonly src: null }
  | { readonly key: string; readonly request: number; readonly status: "ready"; readonly src: string }

const coverPlaceholder = (entry: LibraryEntry, loading: boolean) => (
  <div
    className="library-cover-placeholder"
    data-testid="library-cover-placeholder"
    data-cover-state={loading ? "loading" : "unavailable"}
    role="img"
    aria-label={`${loading ? "Loading" : "Cover unavailable"} for ${entry.title}`}
  >
    <span>{loading ? "Loading cover…" : "Cover unavailable"}</span>
    <strong>{entry.title}</strong>
  </div>
)

const LibraryCover = ({ entry }: { readonly entry: LibraryEntry }) => {
  const key = entry.cover?.key ?? null
  const requestRef = useRef(0)
  const [cover, setCover] = useState<CoverState>({
    key,
    request: 0,
    status: key === null ? "unavailable" : "loading",
    src: null
  })

  useEffect(() => {
    const request = requestRef.current + 1
    requestRef.current = request
    let objectUrl: string | null = null
    let cancelled = false

    if (key === null) {
      setCover({ key: null, request, status: "unavailable", src: null })
      return () => {
        cancelled = true
      }
    }

    setCover({ key, request, status: "loading", src: null })
    const markUnavailable = () => {
      if (!cancelled && requestRef.current === request) {
        setCover({ key, request, status: "unavailable", src: null })
      }
    }
    void runtime.runPromise(
      Effect.gen(function*() {
        const client = yield* LibraryClient
        return yield* client.getThumbnail(key)
      })
    ).then((result) => {
        if (cancelled || requestRef.current !== request) return
        if (!result.ok) {
          markUnavailable()
          return
        }
        try {
          const bytes = new Uint8Array(result.data)
          if (bytes.byteLength === 0) throw new Error("empty thumbnail")
          objectUrl = URL.createObjectURL(new Blob([bytes.buffer], { type: "image/webp" }))
          setCover({ key, request, status: "ready", src: objectUrl })
        } catch {
          markUnavailable()
        }
      }).catch(markUnavailable)

    return () => {
      cancelled = true
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [key])

  const isCurrent = cover.key === key && cover.request === requestRef.current
  if (!isCurrent || cover.status === "loading") return coverPlaceholder(entry, true)
  if (cover.status !== "ready") return coverPlaceholder(entry, false)
  const readyCover = cover

  return (
    <img
      className="library-cover-image"
      data-testid="library-cover-image"
      alt={`Cover of ${entry.title}`}
      src={readyCover.src}
      onError={(event) => {
        if (requestRef.current !== readyCover.request || event.currentTarget.src !== readyCover.src) return
        URL.revokeObjectURL(readyCover.src)
        setCover({ key: readyCover.key, request: readyCover.request, status: "unavailable", src: null })
      }}
    />
  )
}

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
      {state.library_scan_status === "error" && state.library_error !== null && (
        <p role="alert" data-testid="library-scan-error">Normal scan failed: {state.library_error}</p>
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
              <LibraryCover entry={entry} />
              <div className="library-entry-details">
                <strong>{entry.title}</strong>
                <span>{entry.source_path}</span>
                <small>{entry.entry_id}</small>
              </div>
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
