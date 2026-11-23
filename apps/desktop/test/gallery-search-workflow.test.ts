import { Effect, Layer } from "effect"
import type { EhGalleryCandidate, LibraryEntryDetails } from "@henshin/contracts"
import { afterEach, describe, expect, it } from "vitest"
import { EhClient, LibraryClient } from "../src/renderer/client"
import {
  bindSelectedGalleryCandidate,
  cancelGallerySearch,
  searchGalleryCandidates,
  selectLibraryEntry
} from "../src/renderer/workflows"
import { viewStore } from "../src/renderer/store"

const entryId = "11111111-1111-4111-8111-111111111111"
const candidate = (gid: string, title: string): EhGalleryCandidate => ({
  source: "EH",
  gid,
  canonical_url: `https://e-hentai.org/g/${gid}/fixture-token/`,
  title,
  language_evidence: ["English"],
  page_count: 20,
  rating: 4.5
})

const details: LibraryEntryDetails = {
  entry_id: entryId,
  library_id: "22222222-2222-4222-8222-222222222222",
  root_id: "33333333-3333-4333-8333-333333333333",
  relative_path: "synthetic-book",
  source_path: "/synthetic/fixture/synthetic-book",
  kind: "image-directory",
  title: "Synthetic Public Fixture",
  page_count: 1,
  state: "accepted",
  decision_version: "1",
  content_version: "1",
  location_revision: "1",
  cover: null,
  replacement: null,
  binding: null
}

const reset = () => {
  viewStore.set({
    library_selected_entry_id: null,
    library_entry: null,
    library_entry_status: "idle",
    library_entry_error: null,
    gallery_search_title: "",
    gallery_search_author: "",
    gallery_search_language: "",
    gallery_search_status: "idle",
    gallery_search_error: null,
    gallery_candidates: [],
    gallery_selected_candidate_url: null,
    gallery_search_generation: 0,
    gallery_bind_status: "idle",
    gallery_bind_error: null,
    gallery_bind_operation_id: null
  })
}

const run = <A>(
  effect: Effect.Effect<A, unknown, EhClient | LibraryClient>,
  eh: EhClient["Service"],
  library: LibraryClient["Service"]
) => Effect.runPromise(Effect.provide(effect, Layer.mergeAll(
  Layer.succeed(EhClient, eh),
  Layer.succeed(LibraryClient, library)
)))

afterEach(reset)

describe("gallery candidate review workflow", () => {
  it("keeps both candidates reviewable and binds only the explicitly selected URL", async () => {
    const first = candidate("12345", "Synthetic Public Fixture — Alpha")
    const second = candidate("67890", "Synthetic Public Fixture — Beta")
    let bindInput: { readonly operation_id: string; readonly entry_id: string; readonly url: string; readonly expected_decision_version: string } | null = null
    const library = LibraryClient.of({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      getThumbnail: () => Effect.succeed({ ok: false as const, error: { code: "not_used", message: "not used", retryable: false } }),
      entry: () => Effect.succeed({ ok: true as const, data: details }),
      bind: (input) => {
        bindInput = input
        return Effect.succeed({ ok: true as const, data: { operation_id: "44444444-4444-4444-8444-444444444444", entry: { ...details, decision_version: "2", binding: {
          source: "EH" as const, gid: second.gid, canonical_url: second.canonical_url, preferred_domain: "e-hentai.org" as const
        } } } })
      }
    })
    const eh = EhClient.of({
      candidates: () => Effect.succeed({ ok: true as const, data: { status: "results" as const, candidates: [first, second] } })
    })

    await run(selectLibraryEntry(entryId), eh, library)
    await run(searchGalleryCandidates(), eh, library)
    expect(viewStore.getState().gallery_candidates).toEqual([first, second])
    expect(viewStore.getState().gallery_selected_candidate_url).toBeNull()

    viewStore.set({ gallery_selected_candidate_url: second.canonical_url })
    await run(bindSelectedGalleryCandidate(), eh, library)
    expect(bindInput).toMatchObject({ entry_id: entryId, url: second.canonical_url, expected_decision_version: "1" })
    expect(bindInput?.operation_id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(viewStore.getState().gallery_bind_status).toBe("confirmed")
    expect(viewStore.getState().library_entry?.binding?.canonical_url).toBe(second.canonical_url)
  })

  it("fences a cancelled request so a late response cannot publish candidates", async () => {
    type SearchReply = { readonly ok: true; readonly data: ReturnType<typeof candidateSearchResult> }
    let resolveSearch: ((value: SearchReply) => void) | null = null
    const pending = new Promise<SearchReply>((resolve) => { resolveSearch = resolve })
    const library = LibraryClient.of({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      getThumbnail: () => Effect.succeed({ ok: false as const, error: { code: "not_used", message: "not used", retryable: false } }),
      entry: () => Effect.succeed({ ok: true as const, data: details }),
      bind: () => Effect.succeed({ ok: false as const, error: { code: "not_used", message: "not used", retryable: false } })
    })
    const eh = EhClient.of({ candidates: () => Effect.promise(() => pending) })

    await run(selectLibraryEntry(entryId), eh, library)
    const search = run(searchGalleryCandidates(), eh, library)
    await Promise.resolve()
    expect(viewStore.getState().gallery_search_status).toBe("loading")
    await Effect.runPromise(cancelGallerySearch)
    resolveSearch?.({ ok: true, data: candidateSearchResult() })
    await search
    expect(viewStore.getState().gallery_search_status).toBe("cancelled")
    expect(viewStore.getState().gallery_candidates).toEqual([])
  })

  it("fences a late bind response when selection changes", async () => {
    const otherEntryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const otherDetails = { ...details, entry_id: otherEntryId, title: "Other fixture" }
    const selected = candidate("24680", "Selected fixture")
    let resolveBind!: (value: {
      readonly ok: true
      readonly data: { readonly operation_id: string; readonly entry: LibraryEntryDetails }
    }) => void
    const pendingBind = new Promise<{
      readonly ok: true
      readonly data: { readonly operation_id: string; readonly entry: LibraryEntryDetails }
    }>((resolve) => { resolveBind = resolve })
    const library = LibraryClient.of({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      getThumbnail: () => Effect.succeed({ ok: false as const, error: { code: "not_used", message: "not used", retryable: false } }),
      entry: (input) => Effect.succeed({ ok: true as const, data: input.entry_id === entryId ? details : otherDetails }),
      bind: () => Effect.promise(() => pendingBind)
    })
    const eh = EhClient.of({ candidates: () => Effect.succeed({ ok: true as const, data: { status: "results" as const, candidates: [selected] } }) })

    await run(selectLibraryEntry(entryId), eh, library)
    viewStore.set({
      gallery_selected_candidate_url: selected.canonical_url,
      gallery_search_author: "old author",
      gallery_search_language: "old language"
    })
    const binding = run(bindSelectedGalleryCandidate(), eh, library)
    await Promise.resolve()
    await run(selectLibraryEntry(otherEntryId), eh, library)
    resolveBind({
      ok: true,
      data: {
        operation_id: "55555555-5555-4555-8555-555555555555",
        entry: { ...details, decision_version: "2", binding: {
          source: "EH", gid: selected.gid, canonical_url: selected.canonical_url, preferred_domain: "e-hentai.org"
        } }
      }
    })
    await binding

    expect(viewStore.getState().library_selected_entry_id).toBe(otherEntryId)
    expect(viewStore.getState().library_entry?.entry_id).toBe(otherEntryId)
    expect(viewStore.getState().library_entry?.binding).toBeNull()
    expect(viewStore.getState().gallery_bind_status).toBe("idle")
    expect(viewStore.getState().gallery_search_author).toBe("")
    expect(viewStore.getState().gallery_search_language).toBe("")
  })

  it("refreshes entry details after a failed bind before allowing a retry", async () => {
    const refreshed = { ...details, decision_version: "2" }
    const selected = candidate("13579", "Revision fixture")
    let entryCalls = 0
    const library = LibraryClient.of({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      getThumbnail: () => Effect.succeed({ ok: false as const, error: { code: "not_used", message: "not used", retryable: false } }),
      entry: () => {
        entryCalls += 1
        return Effect.succeed({ ok: true as const, data: entryCalls === 1 ? details : refreshed })
      },
      bind: () => Effect.succeed({ ok: false as const, error: { code: "revision_conflict", message: "entry changed", retryable: true } })
    })
    const eh = EhClient.of({ candidates: () => Effect.succeed({ ok: true as const, data: { status: "results" as const, candidates: [selected] } }) })

    await run(selectLibraryEntry(entryId), eh, library)
    viewStore.set({ gallery_selected_candidate_url: selected.canonical_url })
    await run(bindSelectedGalleryCandidate(), eh, library)

    expect(entryCalls).toBe(2)
    expect(viewStore.getState().library_entry?.decision_version).toBe("2")
    expect(viewStore.getState().gallery_bind_status).toBe("error")
    expect(viewStore.getState().gallery_bind_error).toBe("entry changed")
  })

  it("keeps the selected candidate and ignores new searches until its bind settles", async () => {
    const selected = candidate("97531", "Overlapping fixture")
    let resolveBind!: (value: {
      readonly ok: true
      readonly data: { readonly operation_id: string; readonly entry: LibraryEntryDetails }
    }) => void
    const pendingBind = new Promise<{
      readonly ok: true
      readonly data: { readonly operation_id: string; readonly entry: LibraryEntryDetails }
    }>((resolve) => { resolveBind = resolve })
    const library = LibraryClient.of({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      getThumbnail: () => Effect.succeed({ ok: false as const, error: { code: "not_used", message: "not used", retryable: false } }),
      entry: () => Effect.succeed({ ok: true as const, data: details }),
      bind: (input) => {
        expect(input.operation_id).toMatch(/^[0-9a-f-]{36}$/u)
        return Effect.promise(() => pendingBind)
      }
    })
    const eh = EhClient.of({ candidates: () => { throw new Error("unexpected search during binding") } })

    await run(selectLibraryEntry(entryId), eh, library)
    viewStore.set({ gallery_selected_candidate_url: selected.canonical_url })
    const binding = run(bindSelectedGalleryCandidate(), eh, library)
    await Promise.resolve()
    expect(viewStore.getState().gallery_bind_status).toBe("loading")
    await run(searchGalleryCandidates(), eh, library)
    expect(viewStore.getState().gallery_selected_candidate_url).toBe(selected.canonical_url)
    resolveBind({
      ok: true,
      data: {
        operation_id: "66666666-6666-4666-8666-666666666666",
        entry: { ...details, decision_version: "2", binding: {
          source: "EH", gid: selected.gid, canonical_url: selected.canonical_url, preferred_domain: "e-hentai.org"
        } }
      }
    })
    await binding
    expect(viewStore.getState().gallery_bind_status).toBe("confirmed")
    expect(viewStore.getState().library_entry?.binding?.canonical_url).toBe(selected.canonical_url)
  })
})

const candidateSearchResult = () => ({
  status: "results" as const,
  candidates: [candidate("99999", "Late response")]
})
