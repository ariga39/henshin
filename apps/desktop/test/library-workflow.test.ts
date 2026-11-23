import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { LibraryEntry, LibraryEntryDetails, OpenBookIpcResult, ReaderProfile } from "@henshin/contracts"
import { LibraryClient, type Result } from "../src/renderer/client"
import {
  chooseLibraryOpenProfile,
  libraryOpenStateFor,
  loadActiveLibraryOpenState,
  openSelectedLibraryEntry,
  searchLibrary,
  selectLibraryEntry,
  updateLibraryNote
} from "../src/renderer/workflows"
import { viewStore } from "../src/renderer/store"

const namespaceId = "11111111-1111-4111-8111-111111111111"
const libraryId = "22222222-2222-4222-8222-222222222222"
const profileId = "33333333-3333-4333-8333-333333333333"
const otherProfileId = "44444444-4444-4444-8444-444444444444"
const entryAId = "55555555-5555-4555-8555-555555555555"
const entryBId = "66666666-6666-4666-8666-666666666666"
const firstActionId = "88888888-8888-4888-8888-888888888888"

const entry = (entryId: string, title: string): LibraryEntry => ({
  entry_id: entryId,
  library_id: libraryId,
  root_id: "77777777-7777-4777-8777-777777777777",
  relative_path: `${title}/001.png`,
  source_path: `/books/${title}`,
  kind: "image-directory",
  title,
  page_count: 1,
  state: "accepted",
  replacement: null,
  match_fields: [],
  availability: { status: "present", observed_at_ms: 1 },
  content_version: "1",
  location_revision: "1",
  cover: null
})

const profile = (id: string): ReaderProfile => ({
  profile_id: id,
  revision: "1",
  name: id === profileId ? "Primary reader" : "Other reader",
  launch_mode: "system-association",
  supported_formats: ["image-directory"],
  target_mode: "directory",
  executable_name: null,
  argument_tokens: []
})

const accepted = (entryId: string, actionId = firstActionId): OpenBookIpcResult => ({
  action_id: actionId,
  entry_id: entryId,
  profile_id: profileId,
  status: "accepted",
  message: "The operating system accepted the reader handoff.",
  event_durable: true
})

const run = <A>(effect: Effect.Effect<A, unknown, LibraryClient>, client: LibraryClient["Service"]) =>
  Effect.runPromise(Effect.provide(effect, Layer.succeed(LibraryClient, client)))

const makeLibraryClient = (overrides: Partial<LibraryClient["Service"]>): LibraryClient["Service"] => LibraryClient.of({
  entry: () => Effect.succeed({ ok: false as const, error: { code: "not_used", message: "not used", retryable: false } }),
  note: () => Effect.succeed({ ok: false as const, error: { code: "not_used", message: "not used", retryable: false } }),
  search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
  open: () => Effect.succeed({ ok: true as const, data: accepted(entryAId) }),
  status: () => Effect.succeed({ ok: true as const, data: null }),
  getThumbnail: () => Effect.succeed({ ok: true as const, data: new Uint8Array() }),
  ...overrides
})

const resetView = () => {
  viewStore.set({
    connection: { state: "disconnected", instance_id: null, epoch: null, reason: null },
    connection_generation: 0,
    library_entries: [],
    library_selected_entry_id: null,
    library_open_profile_id: null,
    library_open_states: []
  })
}

afterEach(resetView)

describe("library renderer workflow", () => {
  it("retains draft text when a note save is stale and shows the current server note", async () => {
    const currentEntry: LibraryEntryDetails = {
      entry_id: entryAId,
      library_id: libraryId,
      root_id: "77777777-7777-4777-8777-777777777777",
      relative_path: "book-a",
      source_path: "/books/book-a",
      kind: "image-directory",
      title: "book-a",
      page_count: 1,
      state: "accepted",
      decision_version: "2",
      content_version: "1",
      location_revision: "1",
      cover: null,
      replacement: null,
      binding: null,
      note: { text: "server text", revision: "1" }
    }
    const client = makeLibraryClient({
      entry: () => Effect.succeed({ ok: true as const, data: currentEntry }),
      note: () => Effect.succeed({ ok: false as const, error: { code: "revision_conflict", message: "stale", retryable: false } })
    })
    viewStore.set({
      library_selected_entry_id: entryAId,
      library_entry: { ...currentEntry, decision_version: "1", note: null },
      library_note_text: "draft text"
    })

    await run(updateLibraryNote("draft text"), client)

    expect(viewStore.getState().library_note_text).toBe("draft text")
    expect(viewStore.getState().library_note_server_text).toBe("server text")
    expect(viewStore.getState().library_note_error).toContain("retained")
    expect(viewStore.getState().library_entry?.decision_version).toBe("2")
  })

  it("does not open a replacement-pending entry", async () => {
    const state = "replacement-pending" as const
    let calls = 0
    const client = makeLibraryClient({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      open: () => {
        calls += 1
        return Effect.succeed({ ok: true as const, data: accepted(entryAId) })
      },
      status: () => Effect.succeed({ ok: true as const, data: null }),
      getThumbnail: () => Effect.succeed({ ok: true as const, data: new Uint8Array() })
    })
    viewStore.set({
      connection: { state: "connected", instance_id: namespaceId, epoch: "99999999-9999-4999-8999-999999999999", reason: null },
      connection_generation: 7,
      library_entries: [{ ...entry(entryAId, "book-a"), state }],
      library_selected_entry_id: entryAId,
      library_open_profile_id: profileId
    })

    await run(openSelectedLibraryEntry, client)

    expect(calls).toBe(0)
    expect(viewStore.getState().library_open_states).toEqual([])
  })

  it("clears the selected entry and profile when the Library query changes", async () => {
    const client = makeLibraryClient({
      search: (input) => {
        expect(input).toEqual({ query: "new query", page_size: 50 })
        return Effect.succeed({
          ok: true as const,
          data: { entries: [entry(entryBId, "book-b")], has_more: false, next_cursor: null, library_change_revision: "2" }
        })
      },
      open: () => Effect.succeed({ ok: true as const, data: accepted(entryAId) }),
      status: () => Effect.succeed({ ok: true as const, data: null }),
      getThumbnail: () => Effect.succeed({ ok: true as const, data: new Uint8Array() })
    })
    viewStore.set({
      library_query: "old query",
      library_entries: [entry(entryAId, "book-a")],
      library_selected_entry_id: entryAId,
      library_open_profile_id: profileId,
      library_open_states: [{
        namespace_id: namespaceId,
        entry_id: entryAId,
        profile_id: profileId,
        connection_generation: 0,
        status: "accepted",
        result: accepted(entryAId)
      }]
    })

    await run(searchLibrary("new query"), client)

    expect(viewStore.getState().library_selected_entry_id).toBeNull()
    expect(viewStore.getState().library_open_profile_id).toBeNull()
    expect(viewStore.getState().library_entries).toEqual([entry(entryBId, "book-b")])
    expect(viewStore.getState().library_open_states).toHaveLength(1)
  })

  it("keeps the latest terminal action through reselection and follows a newer active action", async () => {
    const actionA = firstActionId
    const actionB = "99999999-9999-4999-8999-999999999999"
    const actionC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const acceptedB = accepted(entryAId, actionB)
    const activeC: OpenBookIpcResult = {
      ...acceptedB,
      action_id: actionC,
      profile_id: otherProfileId,
      status: "in-flight",
      message: "another reader handoff is already opening this entry; follow the active action",
      event_durable: false
    }
    const acceptedC: OpenBookIpcResult = {
      ...activeC,
      status: "accepted",
      message: "The operating system accepted the reader handoff.",
      event_durable: true
    }
    const statusRequests: Array<{ readonly entry_id?: string; readonly action_id?: string }> = []
    const client = makeLibraryClient({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      open: () => Effect.succeed({ ok: true as const, data: acceptedB }),
      status: (input) => {
        statusRequests.push(input)
        return Effect.succeed({ ok: true as const, data: statusRequests.length === 1 ? activeC : acceptedC })
      },
      getThumbnail: () => Effect.succeed({ ok: true as const, data: new Uint8Array() })
    })
    viewStore.set({
      connection: { state: "connected", instance_id: namespaceId, epoch: "99999999-9999-4999-8999-999999999999", reason: null },
      connection_generation: 7,
      library_entries: [entry(entryAId, "book-a")],
      library_selected_entry_id: entryAId,
      library_open_profile_id: profileId,
      library_open_states: [{
        namespace_id: namespaceId,
        entry_id: entryAId,
        profile_id: profileId,
        connection_generation: 7,
        status: "unknown",
        result: {
          action_id: actionA,
          entry_id: entryAId,
          profile_id: profileId,
          status: "unknown",
          message: "The reader handoff has no available terminal result; it may have opened.",
          event_durable: false
        }
      }]
    })

    await run(openSelectedLibraryEntry, client)
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      status: "accepted",
      result: { action_id: actionB }
    })

    await run(chooseLibraryOpenProfile(otherProfileId), client)
    await run(selectLibraryEntry(entryAId), client)
    expect(viewStore.getState().library_open_profile_id).toBe(otherProfileId)
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      status: "accepted",
      result: { action_id: actionB }
    })

    viewStore.set({ library_entries: [entry(entryAId, "book-a")] })
    await run(selectLibraryEntry(entryAId), client)
    await run(loadActiveLibraryOpenState(entryAId), client)
    expect(statusRequests).toEqual([{ entry_id: entryAId }])
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      status: "loading",
      profile_id: otherProfileId,
      result: { action_id: actionC, status: "in-flight" }
    })

    await run(loadActiveLibraryOpenState(entryAId), client)
    expect(statusRequests).toEqual([{ entry_id: entryAId }, { action_id: actionC }])
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      status: "accepted",
      profile_id: otherProfileId,
      result: { action_id: actionC, status: "accepted" }
    })
  })

  it("keeps a delayed result scoped to its pending entry and blocks a duplicate launch", async () => {
    let resolveOpen!: (value: Result<OpenBookIpcResult>) => void
    const delayed = new Promise<Result<OpenBookIpcResult>>((resolve) => { resolveOpen = resolve })
    const calls: Array<{ readonly entry_id: string; readonly profile_id: string }> = []
    const client = makeLibraryClient({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      open: (input) => {
        calls.push({ entry_id: input.entry_id, profile_id: input.profile_id })
        return Effect.promise(() => delayed)
      },
      status: () => Effect.succeed({ ok: true as const, data: null }),
      getThumbnail: () => Effect.succeed({ ok: true as const, data: new Uint8Array() })
    })
    viewStore.set({
      connection: { state: "connected", instance_id: namespaceId, epoch: "99999999-9999-4999-8999-999999999999", reason: null },
      connection_generation: 7,
      library_entries: [entry(entryAId, "book-a"), entry(entryBId, "book-b")],
      library_selected_entry_id: entryAId,
      library_open_profile_id: profileId,
      reader_profiles: [profile(profileId), profile(otherProfileId)]
    })

    const pending = run(openSelectedLibraryEntry, client)
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      namespace_id: namespaceId,
      entry_id: entryAId,
      profile_id: profileId,
      status: "loading",
      result: null
    })

    await run(selectLibraryEntry(entryBId), client)
    expect(viewStore.getState().library_open_profile_id).toBeNull()
    expect(libraryOpenStateFor(viewStore.getState(), entryBId)).toBeNull()

    await run(selectLibraryEntry(entryAId), client)
    expect(viewStore.getState().library_open_profile_id).toBe(profileId)
    await run(chooseLibraryOpenProfile(otherProfileId), client)
    expect(viewStore.getState().library_open_profile_id).toBe(profileId)
    const duplicate = run(openSelectedLibraryEntry, client)
    await Promise.resolve()
    expect(calls).toEqual([{ entry_id: entryAId, profile_id: profileId }])

    resolveOpen({ ok: true, data: accepted(entryAId) })
    await Promise.all([pending, duplicate])

    expect(libraryOpenStateFor(viewStore.getState(), entryBId)).toBeNull()
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      status: "accepted",
      result: { entry_id: entryAId, status: "accepted" }
    })
  })

  it("follows main's active action through status without resubmitting Open", async () => {
    let resolveFirst!: (value: Result<OpenBookIpcResult>) => void
    const first = new Promise<Result<OpenBookIpcResult>>((resolve) => { resolveFirst = resolve })
    let resolveStatus!: (value: Result<OpenBookIpcResult | null>) => void
    const statusResult = new Promise<Result<OpenBookIpcResult | null>>((resolve) => { resolveStatus = resolve })
    const calls: Array<{ readonly entry_id: string; readonly profile_id: string; readonly action_id: string }> = []
    const statusCalls: Array<{ readonly entry_id?: string; readonly action_id?: string }> = []
    const client = makeLibraryClient({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      open: (input) => {
        calls.push(input)
        return calls.length === 1
          ? Effect.promise(() => first)
          : Effect.succeed({
            ok: true as const,
            data: {
              action_id: calls[0]!.action_id,
              entry_id: input.entry_id,
              profile_id: profileId,
              status: "in-flight" as const,
              message: "another reader handoff is already opening this entry; follow the active action",
              event_durable: false
            }
          })
      },
      status: (input) => {
        statusCalls.push(input)
        return Effect.promise(() => statusResult)
      },
      getThumbnail: () => Effect.succeed({ ok: true as const, data: new Uint8Array() })
    })
    viewStore.set({
      connection: { state: "connected", instance_id: namespaceId, epoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", reason: null },
      connection_generation: 9,
      library_entries: [entry(entryAId, "book-a")],
      library_selected_entry_id: entryAId,
      library_open_profile_id: profileId,
      reader_profiles: [profile(profileId), profile(otherProfileId)]
    })

    const firstWindow = run(openSelectedLibraryEntry, client)
    await Promise.resolve()
    // A second renderer has its own pending-state store and submits another profile.
    viewStore.set({ library_open_states: [], library_open_profile_id: otherProfileId })
    const secondWindow = run(openSelectedLibraryEntry, client)
    await Promise.resolve()

    const firstRequest = calls[0]
    const secondRequest = calls[1]
    expect(firstRequest).toMatchObject({ entry_id: entryAId, profile_id: profileId })
    expect(secondRequest).toMatchObject({ entry_id: entryAId, profile_id: otherProfileId })
    if (firstRequest === undefined || secondRequest === undefined) throw new Error("expected both renderer requests")
    expect(secondRequest.action_id).not.toBe(firstRequest.action_id)
    expect(calls).toHaveLength(2)
    expect(statusCalls).toEqual([{ action_id: firstRequest.action_id }])
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      profile_id: profileId,
      status: "loading",
      result: {
        action_id: firstRequest.action_id,
        entry_id: entryAId,
        profile_id: profileId,
        status: "in-flight"
      }
    })

    resolveStatus({ ok: true, data: accepted(entryAId, firstRequest.action_id) })
    resolveFirst({ ok: true, data: accepted(entryAId, firstRequest.action_id) })
    await Promise.all([firstWindow, secondWindow])
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      profile_id: profileId,
      status: "accepted",
      result: { action_id: firstRequest.action_id, profile_id: profileId, status: "accepted" }
    })
  })

  it("reports unknown when active-action status lookup fails without resubmitting Open", async () => {
    const openCalls: Array<{ readonly entry_id: string; readonly profile_id: string; readonly action_id: string }> = []
    const statusCalls: Array<{ readonly action_id?: string; readonly entry_id?: string }> = []
    const client = makeLibraryClient({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      open: (input) => {
        openCalls.push(input)
        return Effect.succeed({
          ok: true as const,
          data: {
            action_id: input.action_id,
            entry_id: input.entry_id,
            profile_id: input.profile_id,
            status: "in-flight" as const,
            message: "another reader handoff is already opening this entry; follow the active action",
            event_durable: false
          }
        })
      },
      status: (input) => {
        statusCalls.push(input)
        return Effect.succeed({
          ok: false as const,
          error: { code: "transport", message: "status lookup interrupted", retryable: true }
        })
      },
      getThumbnail: () => Effect.succeed({ ok: true as const, data: new Uint8Array() })
    })
    viewStore.set({
      connection: { state: "connected", instance_id: namespaceId, epoch: "99999999-9999-4999-8999-999999999999", reason: null },
      connection_generation: 7,
      library_entries: [entry(entryAId, "book-a")],
      library_selected_entry_id: entryAId,
      library_open_profile_id: profileId
    })

    await run(openSelectedLibraryEntry, client)

    expect(openCalls).toHaveLength(1)
    expect(statusCalls).toEqual([{ action_id: openCalls[0]!.action_id }])
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      status: "unknown",
      result: {
        action_id: openCalls[0]!.action_id,
        entry_id: entryAId,
        profile_id: profileId,
        status: "unknown",
        message: "The reader handoff outcome is temporarily unavailable. Retry status before opening again.",
        event_durable: false
      }
    })
  })

  it("ignores a delayed result after the verified namespace changes", async () => {
    let resolveOpen!: (value: Result<OpenBookIpcResult>) => void
    const delayed = new Promise<Result<OpenBookIpcResult>>((resolve) => { resolveOpen = resolve })
    const client = makeLibraryClient({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      open: () => Effect.promise(() => delayed),
      status: () => Effect.succeed({ ok: true as const, data: null }),
      getThumbnail: () => Effect.succeed({ ok: true as const, data: new Uint8Array() })
    })
    viewStore.set({
      connection: { state: "connected", instance_id: namespaceId, epoch: "99999999-9999-4999-8999-999999999999", reason: null },
      connection_generation: 7,
      library_entries: [entry(entryAId, "book-a")],
      library_selected_entry_id: entryAId,
      library_open_profile_id: profileId
    })

    const pending = run(openSelectedLibraryEntry, client)
    viewStore.set({
      connection: { state: "connected", instance_id: otherProfileId, epoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", reason: null },
      connection_generation: 8
    })
    resolveOpen({ ok: true, data: accepted(entryAId) })
    await pending

    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toBeNull()
    expect(viewStore.getState().library_open_states).toHaveLength(1)
    expect(viewStore.getState().library_open_states[0]?.status).toBe("loading")
  })

  it("refreshes terminal entries by entry and fences stale observations", async () => {
    let resolveStatus!: (value: Result<OpenBookIpcResult | null>) => void
    const delayedStatus = new Promise<Result<OpenBookIpcResult | null>>((resolve) => { resolveStatus = resolve })
    const statusRequests: Array<{ readonly entry_id?: string; readonly action_id?: string }> = []
    let currentStatusResult: Result<OpenBookIpcResult | null> = { ok: true, data: null }
    const client = makeLibraryClient({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      open: () => Effect.succeed({ ok: false as const, error: { code: "not_used", message: "not used", retryable: false } }),
      status: (input) => {
        statusRequests.push(input)
        return statusRequests.length === 1
          ? Effect.promise(() => delayedStatus)
          : Effect.succeed(currentStatusResult)
      },
      getThumbnail: () => Effect.succeed({ ok: true as const, data: new Uint8Array() })
    })
    const oldResult = accepted(entryAId)
    viewStore.set({
      connection: { state: "connected", instance_id: namespaceId, epoch: "99999999-9999-4999-8999-999999999999", reason: null },
      connection_generation: 7,
      library_entries: [entry(entryAId, "book-a")],
      library_selected_entry_id: entryAId,
      library_open_states: [{
        namespace_id: namespaceId,
        entry_id: entryAId,
        profile_id: profileId,
        connection_generation: 7,
        status: "accepted",
        result: oldResult
      }]
    })

    const refresh = run(loadActiveLibraryOpenState(entryAId), client)
    await Promise.resolve()
    expect(statusRequests).toEqual([{ entry_id: entryAId }])

    viewStore.set({
      library_open_states: [{
        namespace_id: namespaceId,
        entry_id: entryAId,
        profile_id: profileId,
        connection_generation: 7,
        status: "loading",
        result: null
      }]
    })
    resolveStatus({ ok: true, data: oldResult })
    await refresh
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({ status: "loading", result: null })

    const activeResult: OpenBookIpcResult = {
      ...oldResult,
      status: "in-flight",
      message: "another reader handoff is already opening this entry; follow the active action",
      event_durable: false
    }
    currentStatusResult = { ok: true, data: activeResult }
    viewStore.set({
      library_open_states: [{
        namespace_id: namespaceId,
        entry_id: entryAId,
        profile_id: profileId,
        connection_generation: 7,
        status: "loading",
        result: activeResult
      }]
    })
    const activeRefresh = run(loadActiveLibraryOpenState(entryAId), client)
    await Promise.resolve()
    expect(statusRequests[1]).toEqual({ action_id: activeResult.action_id })
    resolveStatus({ ok: true, data: activeResult })
    await activeRefresh
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({ status: "loading", result: activeResult })
  })

  it("keeps missing outcomes unknown and makes transient lookup failure retryable", async () => {
    let lookup: Result<OpenBookIpcResult | null> = { ok: true, data: null }
    let openCalls = 0
    const statusRequests: Array<{ readonly entry_id?: string; readonly action_id?: string }> = []
    const activeResult: OpenBookIpcResult = {
      ...accepted(entryAId),
      status: "in-flight",
      message: "another reader handoff is already opening this entry; follow the active action",
      event_durable: false
    }
    const client = makeLibraryClient({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      open: () => {
        openCalls += 1
        return Effect.succeed({ ok: true as const, data: accepted(entryAId, "99999999-9999-4999-8999-999999999999") })
      },
      status: (input) => {
        statusRequests.push(input)
        return Effect.succeed(lookup)
      },
      getThumbnail: () => Effect.succeed({ ok: true as const, data: new Uint8Array() })
    })
    viewStore.set({
      connection: { state: "connected", instance_id: namespaceId, epoch: "99999999-9999-4999-8999-999999999999", reason: null },
      connection_generation: 7,
      library_entries: [entry(entryAId, "book-a")],
      library_selected_entry_id: entryAId,
      library_open_profile_id: profileId,
      library_open_states: [{
        namespace_id: namespaceId,
        entry_id: entryAId,
        profile_id: profileId,
        connection_generation: 7,
        status: "loading",
        result: activeResult
      }]
    })

    await run(loadActiveLibraryOpenState(entryAId), client)
    expect(statusRequests[0]).toEqual({ action_id: activeResult.action_id })
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      status: "unknown",
      result: {
        action_id: activeResult.action_id,
        entry_id: entryAId,
        profile_id: profileId,
        status: "unknown",
        message: "The reader handoff has no available terminal result; it may have opened. Retry status or open again deliberately.",
        event_durable: false
      }
    })
    expect(openCalls).toBe(0)

    lookup = { ok: true, data: accepted(entryAId, activeResult.action_id) }
    await run(loadActiveLibraryOpenState(entryAId, activeResult.action_id), client)
    expect(statusRequests[1]).toEqual({ action_id: activeResult.action_id })
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      status: "accepted",
      result: { action_id: activeResult.action_id, status: "accepted" }
    })

    const newerActiveResult: OpenBookIpcResult = {
      ...activeResult,
      action_id: "99999999-9999-4999-8999-999999999999"
    }
    lookup = { ok: true, data: newerActiveResult }
    viewStore.set({ library_open_states: [{
      namespace_id: namespaceId,
      entry_id: entryAId,
      profile_id: profileId,
      connection_generation: 7,
      status: "accepted",
      result: accepted(entryAId, activeResult.action_id)
    }] })
    await run(loadActiveLibraryOpenState(entryAId), client)
    expect(statusRequests[2]).toEqual({ entry_id: entryAId })
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      status: "loading",
      result: { action_id: newerActiveResult.action_id, status: "in-flight" }
    })

    lookup = {
      ok: false,
      error: { code: "transport", message: "status lookup interrupted", retryable: true }
    }
    viewStore.set({ library_open_states: [{
      namespace_id: namespaceId,
      entry_id: entryAId,
      profile_id: profileId,
      connection_generation: 7,
      status: "loading",
      result: activeResult
    }] })
    await run(loadActiveLibraryOpenState(entryAId), client)
    expect(statusRequests[3]).toEqual({ action_id: activeResult.action_id })
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      status: "unknown",
      result: {
        action_id: activeResult.action_id,
        entry_id: entryAId,
        profile_id: profileId,
        status: "unknown",
        message: "The reader handoff outcome is temporarily unavailable. Retry status before opening again.",
        event_durable: false
      }
    })
    expect(openCalls).toBe(0)

    await run(openSelectedLibraryEntry, client)
    expect(openCalls).toBe(1)
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({ status: "accepted" })
  })

  it("ignores a late successful status reply after a newer unavailable observation", async () => {
    let resolveLate!: (value: Result<OpenBookIpcResult | null>) => void
    const late = new Promise<Result<OpenBookIpcResult | null>>((resolve) => { resolveLate = resolve })
    let statusCalls = 0
    const activeResult: OpenBookIpcResult = {
      ...accepted(entryAId),
      status: "in-flight",
      message: "another reader handoff is already opening this entry; follow the active action",
      event_durable: false
    }
    const client = makeLibraryClient({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      open: () => Effect.succeed({ ok: false as const, error: { code: "not_used", message: "not used", retryable: false } }),
      status: () => {
        statusCalls += 1
        return statusCalls === 1
          ? Effect.promise(() => late)
          : Effect.succeed({ ok: false as const, error: { code: "transport", message: "status lookup interrupted", retryable: true } })
      },
      getThumbnail: () => Effect.succeed({ ok: true as const, data: new Uint8Array() })
    })
    viewStore.set({
      connection: { state: "connected", instance_id: namespaceId, epoch: "99999999-9999-4999-8999-999999999999", reason: null },
      connection_generation: 7,
      library_entries: [entry(entryAId, "book-a")],
      library_selected_entry_id: entryAId,
      library_open_profile_id: profileId,
      library_open_states: [{
        namespace_id: namespaceId,
        entry_id: entryAId,
        profile_id: profileId,
        connection_generation: 7,
        status: "loading",
        result: activeResult
      }]
    })

    const lateRefresh = run(loadActiveLibraryOpenState(entryAId), client)
    await Promise.resolve()
    await run(loadActiveLibraryOpenState(entryAId), client)
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({ status: "unknown" })

    resolveLate({ ok: true, data: accepted(entryAId, activeResult.action_id) })
    await lateRefresh
    expect(libraryOpenStateFor(viewStore.getState(), entryAId)).toMatchObject({
      status: "unknown",
      result: { status: "unknown", action_id: activeResult.action_id }
    })
  })
})
