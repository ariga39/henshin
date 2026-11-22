import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { LibraryEntry, OpenBookIpcResult, ReaderProfile } from "@henshin/contracts"
import { LibraryClient, type Result } from "../src/renderer/client"
import {
  chooseLibraryOpenProfile,
  libraryOpenStateFor,
  openSelectedLibraryEntry,
  selectLibraryEntry
} from "../src/renderer/workflows"
import { viewStore } from "../src/renderer/store"

const namespaceId = "11111111-1111-4111-8111-111111111111"
const libraryId = "22222222-2222-4222-8222-222222222222"
const profileId = "33333333-3333-4333-8333-333333333333"
const otherProfileId = "44444444-4444-4444-8444-444444444444"
const entryAId = "55555555-5555-4555-8555-555555555555"
const entryBId = "66666666-6666-4666-8666-666666666666"

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

const accepted = (entryId: string): OpenBookIpcResult => ({
  action_id: "88888888-8888-4888-8888-888888888888",
  entry_id: entryId,
  status: "accepted",
  message: "The operating system accepted the reader handoff.",
  event_durable: true
})

const run = <A>(effect: Effect.Effect<A, unknown, LibraryClient>, client: LibraryClient["Service"]) =>
  Effect.runPromise(Effect.provide(effect, Layer.succeed(LibraryClient, client)))

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
  it("keeps a delayed result scoped to its pending entry and blocks a duplicate launch", async () => {
    let resolveOpen!: (value: Result<OpenBookIpcResult>) => void
    const delayed = new Promise<Result<OpenBookIpcResult>>((resolve) => { resolveOpen = resolve })
    const calls: Array<{ readonly entry_id: string; readonly profile_id: string }> = []
    const client = LibraryClient.of({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      open: (input) => {
        calls.push({ entry_id: input.entry_id, profile_id: input.profile_id })
        return Effect.promise(() => delayed)
      },
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

  it("ignores a delayed result after the verified namespace changes", async () => {
    let resolveOpen!: (value: Result<OpenBookIpcResult>) => void
    const delayed = new Promise<Result<OpenBookIpcResult>>((resolve) => { resolveOpen = resolve })
    const client = LibraryClient.of({
      search: () => Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } }),
      open: () => Effect.promise(() => delayed),
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
})
