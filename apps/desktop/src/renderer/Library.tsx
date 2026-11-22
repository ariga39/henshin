import { Effect } from "effect"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { LibraryEntry } from "@henshin/contracts"
import { LibraryClient } from "./client"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { createThumbnailLoadRequest } from "./thumbnail-loading"
import {
  chooseLibraryOpenProfile,
  libraryOpenStateFor,
  loadLibrary,
  loadReaderProfiles,
  openSelectedLibraryEntry,
  selectLibraryEntry,
  showSetup
} from "./workflows"

type CoverState =
  | { readonly key: string | null; readonly request: number; readonly status: "loading" | "unavailable"; readonly src: null }
  | { readonly key: string; readonly request: number; readonly status: "ready"; readonly src: string }

const coverPlaceholder = (entry: LibraryEntry, loading: boolean) => (
  <div
    className="library-cover-placeholder"
    data-testid="library-cover-placeholder"
    data-cover-state={loading ? "loading" : "unavailable"}
    aria-hidden="true"
  >
    <span>{loading ? "Loading cover…" : "Cover unavailable"}</span>
    <strong>{entry.title}</strong>
  </div>
)

const LibraryCover = ({
  entry,
  refreshGeneration
}: {
  readonly entry: LibraryEntry
  readonly refreshGeneration: number
}) => {
  const key = entry.cover?.key ?? null
  const requestRef = useRef(0)
  const frameRef = useRef<HTMLDivElement>(null)
  const [inViewport, setInViewport] = useState(false)
  const [cover, setCover] = useState<CoverState>({
    key,
    request: 0,
    status: key === null ? "unavailable" : "loading",
    src: null
  })

  useEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    if (typeof IntersectionObserver === "undefined") {
      setInViewport(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      setInViewport(entry?.isIntersecting ?? false)
    }, { rootMargin: "200px 0px" })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

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

    if (!inViewport) {
      setCover({ key, request, status: "loading", src: null })
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
    const loadRequest = createThumbnailLoadRequest(key, () => runtime.runPromise(
      Effect.gen(function*() {
        const client = yield* LibraryClient
        return yield* client.getThumbnail(key)
      })
    ))
    void loadRequest.promise.then((result) => {
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
      loadRequest.cancel()
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [inViewport, key, refreshGeneration])

  const isCurrent = cover.key === key && cover.request === requestRef.current
  if (!inViewport || !isCurrent || cover.status === "loading") {
    return (
      <div ref={frameRef} className="library-cover-frame">
        {coverPlaceholder(entry, true)}
      </div>
    )
  }
  if (cover.status !== "ready") {
    return (
      <div ref={frameRef} className="library-cover-frame">
        {coverPlaceholder(entry, false)}
      </div>
    )
  }
  const readyCover = cover

  return (
    <div ref={frameRef} className="library-cover-frame">
      <img
        className="library-cover-image"
        data-testid="library-cover-image"
        alt=""
        src={readyCover.src}
        onError={(event) => {
          if (requestRef.current !== readyCover.request || event.currentTarget.src !== readyCover.src) return
          URL.revokeObjectURL(readyCover.src)
          setCover({ key: readyCover.key, request: readyCover.request, status: "unavailable", src: null })
        }}
      />
    </div>
  )
}

export const LibraryScreen = () => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)

  useEffect(() => {
    if (viewStore.getState().library_status === "idle") void runtime.runPromise(loadLibrary())
    if (viewStore.getState().reader_profiles_status === "idle") void runtime.runPromise(loadReaderProfiles)
  }, [])

  const selectedEntry = state.library_entries.find((entry) => entry.entry_id === state.library_selected_entry_id) ?? null
  const compatibleProfiles = selectedEntry === null
    ? []
    : state.reader_profiles.filter((profile) =>
        profile.supported_formats.includes(selectedEntry.kind) &&
        (selectedEntry.kind === "archive" ? profile.target_mode === "archive" : profile.target_mode !== "archive")
      )
  const selectedOpenState = selectedEntry === null ? null : libraryOpenStateFor(state, selectedEntry.entry_id)
  const openIsPending = selectedOpenState?.status === "loading"
  const openResult = selectedOpenState?.result ?? null

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
      {state.library_scan_error !== null && (
        <p
          role={state.library_scan_status === "error" ? "alert" : "status"}
          data-testid="library-scan-error"
        >
          {state.library_scan_status === "error" ? "Normal scan failed" : "Normal scan completed with errors"}: {state.library_scan_error}
        </p>
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
              <LibraryCover entry={entry} refreshGeneration={state.library_cover_generation} />
              <div className="library-entry-details">
                <strong>{entry.title}</strong>
                <span>{entry.source_path}</span>
                <small>{entry.entry_id}</small>
                <button
                  type="button"
                  data-testid={`library-entry-details-${entry.entry_id}`}
                  onClick={() => void runtime.runPromise(selectLibraryEntry(entry.entry_id))}
                >
                  Details
                </button>
              </div>
            </li>
          ))}
        </ul>
        {state.library_has_more && (
          <button data-testid="library-load-more" onClick={() => void runtime.runPromise(loadLibrary(true))}>
            Load more
          </button>
        )}
        {selectedEntry !== null && (
          <section aria-labelledby="library-entry-details-heading" data-testid="library-details">
            <h3 id="library-entry-details-heading">{selectedEntry.title}</h3>
            <p>Accepted {selectedEntry.kind}; target resolution is checked by the desktop main process.</p>
            {state.reader_profiles_status === "loading" && <p role="status">Loading compatible reader profiles…</p>}
            {compatibleProfiles.length === 0 && (
              <p data-testid="library-no-compatible-profile">Configure a compatible reader profile in Collection setup.</p>
            )}
            {compatibleProfiles.length > 0 && (
              <>
                <label htmlFor="library-open-profile">Reader profile</label>
                <select
                  id="library-open-profile"
                  data-testid="library-open-profile"
                  value={state.library_open_profile_id ?? ""}
                  disabled={openIsPending}
                  onChange={(event) => void runtime.runPromise(chooseLibraryOpenProfile(event.target.value))}
                >
                  <option value="" disabled>Choose a compatible profile</option>
                  {compatibleProfiles.map((profile) => (
                    <option key={profile.profile_id} value={profile.profile_id}>{profile.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="library-open"
                  disabled={state.library_open_profile_id === null || openIsPending}
                  onClick={() => void runtime.runPromise(openSelectedLibraryEntry)}
                >
                  {openIsPending ? "Opening…" : "Open"}
                </button>
              </>
            )}
            {openResult !== null && (
              <p
                role={openResult.status === "failed" ? "alert" : "status"}
                data-testid="library-open-result"
              >
                {openResult.status}: {openResult.message}
                {openResult.status === "accepted" && !openResult.event_durable ? " Local history is not durable yet." : ""}
              </p>
            )}
          </section>
        )}
      </section>
    </main>
  )
}
