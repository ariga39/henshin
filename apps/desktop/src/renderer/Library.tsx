import { Effect } from "effect"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { LibraryEntry } from "@henshin/contracts"
import { LibraryClient } from "./client"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { createThumbnailLoadRequest } from "./thumbnail-loading"
import {
  bindSelectedGalleryCandidate,
  cancelGallerySearch,
  chooseLibraryOpenProfile,
  libraryOpenStateFor,
  loadLibrary,
  loadActiveLibraryOpenState,
  loadReaderProfiles,
  openSelectedLibraryEntry,
  searchGalleryCandidates,
  searchLibrary,
  updateLibraryNote,
  selectLibraryEntry,
  showSetup
} from "./workflows"

type CoverState =
  | { readonly key: string | null; readonly request: number; readonly status: "loading" | "unavailable"; readonly src: null }
  | { readonly key: string; readonly request: number; readonly status: "ready"; readonly src: string }

const availabilityText = (entry: LibraryEntry): string => {
  const label = entry.availability.status
  return entry.availability.observed_at_ms === null
    ? `Server availability: ${label}`
    : `Server availability: ${label}; observed ${new Date(entry.availability.observed_at_ms).toISOString()}`
}

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
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState, viewStore.getState)
  const [searchText, setSearchText] = useState(state.library_query)
  const hasLibraryQuery = state.library_query.trim().length > 0

  useEffect(() => {
    if (viewStore.getState().library_status === "idle") void runtime.runPromise(loadLibrary())
    if (viewStore.getState().reader_profiles_status === "idle") void runtime.runPromise(loadReaderProfiles)
    const unsubscribe = window.henshinLibrary.onOpenStateChanged(() => {
      const entryId = viewStore.getState().library_selected_entry_id
      if (entryId !== null) void runtime.runPromise(loadActiveLibraryOpenState(entryId))
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (state.library_status === "ready" && state.library_selected_entry_id !== null) {
      void runtime.runPromise(loadActiveLibraryOpenState(state.library_selected_entry_id))
    }
  }, [state.library_status, state.library_selected_entry_id, state.connection_generation])

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
  const openProfile = openResult?.profile_id === null || openResult === null
    ? null
    : state.reader_profiles.find((profile) => profile.profile_id === openResult.profile_id) ?? null
  const selectedEntryCanOpen = selectedEntry?.state === "accepted"

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
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            void runtime.runPromise(searchLibrary(searchText))
          }}
        >
          <label htmlFor="library-search">Search books</label>
          <input
            id="library-search"
            data-testid="library-search"
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search by book name"
          />
          <button type="submit" data-testid="library-search-submit">Search</button>
        </form>
        <button data-testid="library-refresh" onClick={() => void runtime.runPromise(loadLibrary())}>
          Refresh
        </button>
        {state.library_status === "loading" && <p role="status">Loading library…</p>}
        {state.library_status === "error" && <p role="alert">Could not load library: {state.library_error}</p>}
        {state.library_status === "ready" && state.library_entries.length === 0 && hasLibraryQuery && (
          <>
            <p data-testid="library-no-matches">No books match “{state.library_query}”.</p>
            <button
              type="button"
              data-testid="library-clear-search"
              onClick={() => {
                setSearchText("")
                void runtime.runPromise(searchLibrary(""))
              }}
            >
              Clear search
            </button>
          </>
        )}
        {state.library_status === "ready" && state.library_entries.length === 0 && !hasLibraryQuery && (
          <p data-testid="library-empty">No accepted books yet. Start a normal scan from a saved root.</p>
        )}
        <ul data-testid="library-entries">
          {state.library_entries.map((entry) => (
            <li key={entry.entry_id} data-testid="library-entry">
              <LibraryCover entry={entry} refreshGeneration={state.library_cover_generation} />
              <button
                type="button"
                className="library-entry-details"
                data-testid={`library-entry-details-${entry.entry_id}`}
                aria-label={`Open details for ${entry.title}`}
                onClick={() => void runtime.runPromise(selectLibraryEntry(entry.entry_id))}
              >
                <strong>{entry.title}</strong>
                <span>{entry.source_path}</span>
                {entry.match_fields.length > 0 && (
                  <small data-testid="library-match-evidence">
                    Matched in {entry.match_fields.map((field) => field === "title" ? "book name" : "filename").join(" and ")}.
                  </small>
                )}
                <small data-testid="library-availability">{availabilityText(entry)}</small>
                <small data-testid="library-entry-id">{entry.entry_id}</small>
              </button>
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
            {state.library_entry_status === "loading" && (
              <p role="status" data-testid="entry-metadata-pending">Loading saved entry details…</p>
            )}
            {state.library_entry_status === "error" && (
              <p role="alert">Could not load entry details: {state.library_entry_error}</p>
            )}
            {state.library_entry_status === "ready" && state.library_entry?.entry_id === selectedEntry.entry_id && (
              <form
                data-testid="entry-note-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void runtime.runPromise(updateLibraryNote(state.library_note_text))
                }}
              >
                <label htmlFor={`entry-note-${selectedEntry.entry_id}`}>Private note</label>
                <textarea
                  id={`entry-note-${selectedEntry.entry_id}`}
                  data-testid="entry-note"
                  value={state.library_note_text}
                  onChange={(event) => viewStore.set({ library_note_text: event.target.value })}
                  disabled={state.library_note_status === "loading"}
                  rows={5}
                />
                <button
                  type="submit"
                  data-testid="entry-note-save"
                  disabled={state.library_note_status === "loading"}
                >
                  {state.library_note_status === "loading" ? "Saving…" : "Save note"}
                </button>
                <button
                  type="button"
                  data-testid="entry-note-clear"
                  disabled={state.library_note_status === "loading" || state.library_note_text.length === 0}
                  onClick={() => void runtime.runPromise(updateLibraryNote(""))}
                >
                  Clear note
                </button>
                {state.library_note_error !== null && (
                  <p role="alert" data-testid="entry-note-error">{state.library_note_error}</p>
                )}
                {state.library_note_server_text !== null && (
                  <p data-testid="entry-note-current-server">
                    Current server note: {state.library_note_server_text || "(empty)"}
                  </p>
                )}
              </form>
            )}
            <section aria-labelledby="gallery-search-heading" data-testid="gallery-search-panel">
              <h4 id="gallery-search-heading">Compare gallery candidates</h4>
              {state.library_entry_status === "loading" && <p role="status">Loading book details…</p>}
              {state.library_entry_status === "error" && <p role="alert">Could not load book details: {state.library_entry_error}</p>}
              {state.library_entry_status === "ready" && state.library_entry?.entry_id === selectedEntry.entry_id && (
                <>
                  {state.library_entry.binding === null ? (
                    <p data-testid="gallery-binding-status">Unbound; review candidates before confirming a binding.</p>
                  ) : (
                    <p data-testid="gallery-binding-status">Bound to {state.library_entry.binding.canonical_url}</p>
                  )}
                  <form onSubmit={(event) => { event.preventDefault(); void runtime.runPromise(searchGalleryCandidates()) }}>
                    <label htmlFor="gallery-search-title">Title</label>
                    <input
                      id="gallery-search-title"
                      data-testid="gallery-search-title"
                      value={state.gallery_search_title}
                      onChange={(event) => viewStore.set({ gallery_search_title: event.target.value })}
                      disabled={state.gallery_search_status === "loading"}
                    />
                    <label htmlFor="gallery-search-author">Author</label>
                    <input
                      id="gallery-search-author"
                      data-testid="gallery-search-author"
                      value={state.gallery_search_author}
                      onChange={(event) => viewStore.set({ gallery_search_author: event.target.value })}
                      disabled={state.gallery_search_status === "loading"}
                    />
                    <label htmlFor="gallery-search-language">Language</label>
                    <input
                      id="gallery-search-language"
                      data-testid="gallery-search-language"
                      value={state.gallery_search_language}
                      onChange={(event) => viewStore.set({ gallery_search_language: event.target.value })}
                      disabled={state.gallery_search_status === "loading"}
                    />
                    <button type="submit" data-testid="gallery-search-submit" disabled={state.gallery_search_status === "loading" || state.gallery_search_title.trim().length === 0}>
                      Search galleries
                    </button>
                    {state.gallery_search_status === "loading" && (
                      <button type="button" data-testid="gallery-search-cancel" onClick={() => void runtime.runPromise(cancelGallerySearch)}>
                        Stop waiting
                      </button>
                    )}
                  </form>
                  {state.gallery_search_status === "empty" && <p data-testid="gallery-search-empty">No gallery candidates matched this query.</p>}
                  {state.gallery_search_status === "access_failed" && <p role="alert" data-testid="gallery-search-access-failed">Gallery search could not access the upstream service.</p>}
                  {state.gallery_search_status === "rate_limited" && (
                    <p role="alert" data-testid="gallery-search-rate-limited">
                      Gallery search is rate limited; retry in {Math.max(1, Math.ceil((state.gallery_search_retry_after_ms ?? 0) / 1000))} seconds.
                    </p>
                  )}
                  {state.gallery_search_status === "restricted" && <p role="alert" data-testid="gallery-search-restricted">Gallery search access is restricted by the upstream service.</p>}
                  {state.gallery_search_status === "unrecognized_layout" && <p role="alert" data-testid="gallery-search-unrecognized">Gallery search returned an unrecognized upstream layout.</p>}
                  {state.gallery_search_status === "cancelled" && <p data-testid="gallery-search-cancelled">Stopped waiting for search results.</p>}
                  {state.gallery_search_status === "error" && <p role="alert">Gallery search failed: {state.gallery_search_error}</p>}
                  {state.gallery_candidates.length > 0 && (
                    <fieldset data-testid="gallery-candidates">
                      <legend>Review candidates before binding</legend>
                      {state.gallery_candidates.map((candidate) => (
                        <label key={candidate.canonical_url} data-testid="gallery-candidate">
                          <input
                            type="radio"
                            name="gallery-candidate"
                            value={candidate.canonical_url}
                            checked={state.gallery_selected_candidate_url === candidate.canonical_url}
                            onChange={() => viewStore.set({ gallery_selected_candidate_url: candidate.canonical_url, gallery_bind_operation_id: null })}
                          />
                          <span>
                            <strong>{candidate.title}</strong> — <span data-testid="gallery-candidate-url">{candidate.canonical_url}</span>
                            <small>Language: {candidate.language_evidence.join(", ") || "unknown"}; pages: {candidate.page_count ?? "unknown"}; rating: {candidate.rating ?? "unknown"}</small>
                          </span>
                        </label>
                      ))}
                      <button
                        type="button"
                        data-testid="gallery-confirm"
                        disabled={state.gallery_selected_candidate_url === null || state.gallery_bind_status === "loading" || state.library_entry.binding !== null}
                        onClick={() => void runtime.runPromise(bindSelectedGalleryCandidate())}
                      >
                        {state.gallery_bind_status === "loading" ? "Binding…" : "Confirm selected gallery"}
                      </button>
                      {state.gallery_bind_error !== null && <p role="alert">Could not bind gallery: {state.gallery_bind_error}</p>}
                      {state.gallery_bind_status === "confirmed" && <p role="status" data-testid="gallery-bind-confirmed">Gallery binding confirmed.</p>}
                    </fieldset>
                  )}
                </>
              )}
            </section>
            {selectedEntryCanOpen ? (
              <>
                <p>Accepted {selectedEntry.kind}; target resolution is checked by the desktop main process.</p>
                {state.reader_profiles_status === "loading" && <p role="status">Loading compatible reader profiles…</p>}
                {state.reader_profiles_status === "error" && (
                  <p role="alert" data-testid="library-reader-profile-error">
                    Could not load compatible reader profiles: {state.reader_profiles_error} {" "}
                    <button
                      type="button"
                      data-testid="library-reader-profile-retry"
                      onClick={() => void runtime.runPromise(loadReaderProfiles)}
                    >
                      Retry loading reader profiles
                    </button>
                  </p>
                )}
                {state.reader_profiles_status === "ready" && compatibleProfiles.length === 0 && (
                  <p data-testid="library-no-compatible-profile">Configure a compatible reader profile in Collection setup.</p>
                )}
                {state.reader_profiles_status === "ready" && compatibleProfiles.length > 0 && (
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
              </>
            ) : selectedEntry.state === "replacement-pending" ? (
              <p data-testid="library-open-blocked">Open unavailable: replacement review is required before this entry can be opened.</p>
            ) : (
              <p data-testid="library-open-blocked">Open unavailable: this entry is detached and no longer available to open.</p>
            )}
            {openResult !== null && (
              <p
                role={openResult.status === "failed" ? "alert" : "status"}
                data-testid="library-open-result"
              >
                {openResult.status}: {openResult.message}
                {openResult.profile_id !== null && (
                  <> (action {openResult.action_id}; reader {openProfile?.name ?? openResult.profile_id})</>
                )}
                {openResult.status === "accepted" && !openResult.event_durable ? " Local history is not durable yet." : ""}
              </p>
            )}
            {openResult?.status === "unknown" && (
              <button
                type="button"
                data-testid="library-open-status-retry"
                onClick={() => void runtime.runPromise(loadActiveLibraryOpenState(selectedEntry.entry_id, openResult.action_id))}
              >
                Retry status
              </button>
            )}
          </section>
        )}
      </section>
    </main>
  )
}
