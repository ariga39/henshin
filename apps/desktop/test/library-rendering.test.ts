import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import type { LibraryEntry } from "@henshin/contracts"
import { LibraryScreen } from "../src/renderer/Library"
import { viewStore } from "../src/renderer/store"

const entry: LibraryEntry = {
  entry_id: "11111111-1111-4111-8111-111111111111",
  library_id: "22222222-2222-4222-8222-222222222222",
  root_id: "33333333-3333-4333-8333-333333333333",
  relative_path: "book/001.png",
  source_path: "/books/book",
  kind: "image-directory",
  title: "Book",
  page_count: 1,
  state: "accepted",
  replacement: null,
  match_fields: [],
  availability: { status: "present", observed_at_ms: 1 },
  content_version: "1",
  location_revision: "1",
  cover: null
}

const renderLibraryDetails = (): string => renderToStaticMarkup(createElement(LibraryScreen))

const setProfileState = (
  status: "loading" | "error" | "ready",
  error: string | null = null
): void => {
  viewStore.set({
    library_entries: [entry],
    library_status: "ready",
    library_selected_entry_id: entry.entry_id,
    reader_profiles: [],
    reader_profiles_status: status,
    reader_profiles_error: error
  })
}

afterEach(() => {
  viewStore.set({
    library_entries: [],
    library_status: "idle",
    library_selected_entry_id: null,
    library_open_profile_id: null,
    library_open_states: [],
    reader_profiles: [],
    reader_profiles_status: "idle",
    reader_profiles_error: null
  })
})

describe("Library reader profile details", () => {
  it("renders distinct loading, error/retry, and ready-empty states", () => {
    setProfileState("loading")
    const loading = renderLibraryDetails()
    expect(loading).toContain("Loading compatible reader profiles…")
    expect(loading).not.toContain("Configure a compatible reader profile")

    setProfileState("error", "profile store unavailable")
    const error = renderLibraryDetails()
    expect(error).toContain("Could not load compatible reader profiles: profile store unavailable")
    expect(error).toContain('data-testid="library-reader-profile-retry"')
    expect(error).toContain("Retry loading reader profiles")
    expect(error).not.toContain("Configure a compatible reader profile")

    setProfileState("ready")
    const readyEmpty = renderLibraryDetails()
    expect(readyEmpty).toContain("Configure a compatible reader profile in Collection setup.")
    expect(readyEmpty).not.toContain("Loading compatible reader profiles")
    expect(readyEmpty).not.toContain("Could not load compatible reader profiles")
    expect(readyEmpty).not.toContain("library-reader-profile-retry")
  })

  it("keeps entry details as a native keyboard-activatable control in the list item", () => {
    setProfileState("ready")
    const markup = renderLibraryDetails()
    expect(markup).toContain('<li data-testid="library-entry">')
    expect(markup).toContain(`<button type="button" class="library-entry-details" data-testid="library-entry-details-${entry.entry_id}"`)
    expect(markup).toContain('aria-label="Open details for Book"')
  })

  it("renders a busy failure result instead of a successful launch", () => {
    setProfileState("ready")
    viewStore.set({
      connection: { state: "connected", instance_id: entry.library_id, epoch: "99999999-9999-4999-8999-999999999999", reason: null },
      connection_generation: 1,
      library_open_profile_id: "33333333-3333-4333-8333-333333333333",
      reader_profiles: [{
        profile_id: "33333333-3333-4333-8333-333333333333",
        revision: "1",
        name: "Reader",
        launch_mode: "system-association",
        supported_formats: ["image-directory"],
        target_mode: "directory",
        executable_name: null,
        argument_tokens: []
      }],
      library_open_states: [{
        namespace_id: entry.library_id,
        entry_id: entry.entry_id,
        profile_id: "33333333-3333-4333-8333-333333333333",
        connection_generation: 1,
        status: "failed",
        result: {
          action_id: "99999999-9999-4999-8999-999999999999",
          entry_id: entry.entry_id,
          profile_id: "33333333-3333-4333-8333-333333333333",
          status: "failed",
          message: "another reader handoff is already opening this entry",
          event_durable: false
        }
      }]
    })
    const markup = renderLibraryDetails()
    expect(markup).toContain("failed: another reader handoff is already opening this entry")
    expect(markup).toContain('data-testid="library-open"')
    expect(markup).not.toContain('data-testid="library-open" disabled')
    expect(markup).not.toContain("accepted: The operating system accepted the reader handoff.")
  })

  it("renders an unavailable handoff as unknown with status retry and an enabled Open", () => {
    setProfileState("ready")
    viewStore.set({
      connection: { state: "connected", instance_id: entry.library_id, epoch: "99999999-9999-4999-8999-999999999999", reason: null },
      connection_generation: 1,
      library_open_profile_id: "33333333-3333-4333-8333-333333333333",
      reader_profiles: [{
        profile_id: "33333333-3333-4333-8333-333333333333",
        revision: "1",
        name: "Reader",
        launch_mode: "system-association",
        supported_formats: ["image-directory"],
        target_mode: "directory",
        executable_name: null,
        argument_tokens: []
      }],
      library_open_states: [{
        namespace_id: entry.library_id,
        entry_id: entry.entry_id,
        profile_id: "33333333-3333-4333-8333-333333333333",
        connection_generation: 1,
        status: "unknown",
        result: {
          action_id: "99999999-9999-4999-8999-999999999999",
          entry_id: entry.entry_id,
          profile_id: "33333333-3333-4333-8333-333333333333",
          status: "unknown",
          message: "The reader handoff has no available terminal result; it may have opened. Retry status or open again deliberately.",
          event_durable: false
        }
      }]
    })
    const markup = renderLibraryDetails()
    expect(markup).toContain("unknown: The reader handoff has no available terminal result; it may have opened.")
    expect(markup).toContain('data-testid="library-open-status-retry"')
    expect(markup).toContain('data-testid="library-open"')
    expect(markup).not.toContain('data-testid="library-open" disabled')
  })

  it("explains why a replacement-pending entry cannot be opened", () => {
    const state = "replacement-pending" as const
    const reason = "replacement review is required"
    viewStore.set({
      library_entries: [{ ...entry, state }],
      library_status: "ready",
      library_selected_entry_id: entry.entry_id,
      reader_profiles: [
        {
          profile_id: "33333333-3333-4333-8333-333333333333",
          revision: "1",
          name: "Reader",
          launch_mode: "system-association",
          supported_formats: ["image-directory"],
          target_mode: "directory",
          executable_name: null,
          argument_tokens: []
        }
      ],
      reader_profiles_status: "ready"
    })

    const rendered = renderLibraryDetails()
    expect(rendered).toContain(`Open unavailable: ${reason}`)
    expect(rendered).not.toContain('data-testid="library-open"')
    expect(rendered).not.toContain('data-testid="library-open-profile"')
  })
})
