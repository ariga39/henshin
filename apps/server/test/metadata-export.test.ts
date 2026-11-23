import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { LibraryHttpClient } from "@henshin/contracts"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const servers: RunningServer[] = []
const dbPaths = new Set<string>()

const withLibraryClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, LibraryHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, LibraryHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const seedUnavailableEntries = (dbPath: string) => {
  const db = new DatabaseSync(dbPath)
  try {
    const library = db.prepare("SELECT library_id FROM server_library WHERE id = 1").get() as { library_id: string }
    const rootId = randomUUID()
    const boundId = randomUUID()
    const detachedId = randomUUID()
    db.prepare(
      "INSERT INTO server_roots(library_id, root_id, label, selected_path, canonical_path, device, inode, mapping_revision, policy_revision, exclusions, state) VALUES(?, ?, ?, ?, ?, ?, ?, 1, 0, '[]', 'active')"
    ).run(library.library_id, rootId, "Unavailable NAS", "/nas/unavailable", "/nas/unavailable", "fixture-device", "fixture-inode")
    const insertEntry = db.prepare(
      "INSERT INTO library_entries(entry_id, library_id, root_id, relative_path, source_path, kind, title, title_search, basename_search, page_count, state, content_version, location_revision, decision_version, manifest_json, created_at_ms, updated_at_ms, accepted_observation_json, availability_status, availability_observed_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, 1, 1, 1, '{}', 0, 0, NULL, ?, 1)"
    )
    insertEntry.run(boundId, library.library_id, rootId, "日本語/Book.cbz", "/nas/unavailable/日本語/Book.cbz", "archive", "日本語の本", 4, "accepted", "missing")
    insertEntry.run(detachedId, library.library_id, rootId, "detached/book", "/nas/unavailable/detached/book", "image-directory", "Detached book", 0, "detached", "unknown")
    const galleryId = randomUUID()
    db.prepare(
      "INSERT INTO galleries(gallery_id, source, gid, token, preferred_domain, created_at_ms, updated_at_ms) VALUES(?, 'EH', ?, ?, 'exhentai.org', 0, 0)"
    ).run(galleryId, "12345", "private-locator")
    db.prepare("INSERT INTO bindings(entry_id, gallery_id, preferred_domain, bound_at_ms) VALUES(?, ?, 'exhentai.org', 0)").run(boundId, galleryId)
    db.prepare("INSERT INTO entry_statistics(entry_id, open_count, last_opened_at_ms) VALUES(?, 3, 1234)").run(boundId)
    return { boundId, detachedId }
  } finally {
    db.close()
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
})

describe("selected metadata export", () => {
  it("exports authenticated selected entries without reading unavailable sources", async () => {
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath)
    servers.push(server)
    const { boundId, detachedId } = seedUnavailableEntries(dbPath)
    const missingId = randomUUID()

    const redacted = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).export({
        payload: { entry_ids: [boundId, detachedId, missingId], include_notes: false }
      })
    }))
    expect(redacted.data.schema).toBe("henshin-metadata-export-v1")
    expect(redacted.data.instance_id).toBe(server.instanceId)
    expect(redacted.data.selected_entry_ids).toEqual([boundId, detachedId, missingId])
    expect(redacted.data.missing_entry_ids).toEqual([missingId])
    expect(redacted.data.privacy).toEqual({
      classification: "private",
      locator_disclosure: "Gallery URLs contain private locators.",
      notes_included: false,
      omitted: [
        "native prefixes",
        "credentials",
        "raw source responses",
        "file bytes",
        "device history",
        "personal notes"
      ]
    })
    expect(redacted.data.entries).toHaveLength(2)
    expect(redacted.data.entries[0]).toMatchObject({
      entry_id: boundId,
      state: "accepted",
      relative_path: "日本語/Book.cbz",
      binding_url: "https://exhentai.org/g/12345/private-locator/",
      statistics: { open_count: 3, last_opened_at_ms: 1234 }
    })
    expect(redacted.data.entries[1]).toMatchObject({ entry_id: detachedId, state: "detached" })
    expect("notes" in redacted.data.entries[0]).toBe(false)
    expect(JSON.stringify(redacted.data)).not.toContain("/nas/unavailable")

    const withNotes = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).export({
        payload: { entry_ids: [boundId], include_notes: true }
      })
    }))
    expect(withNotes.data.privacy.notes_included).toBe(true)
    expect("source_metadata" in withNotes.data.entries[0]!).toBe(false)
    expect("local_overrides" in withNotes.data.entries[0]!).toBe(false)
    expect(withNotes.data.entries[0]?.notes).toEqual([])

    const unauthorized = await fetch(`${server.baseUrl}/api/v1/entries/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entry_ids: [boundId], include_notes: false })
    })
    expect(unauthorized.status).toBe(401)
  })

  it("joins persisted source, override, and opted-in note values without fabricating absent fields", async () => {
    const dbPath = await makeTempDbPath()
    dbPaths.add(dbPath)
    const server = await startServer(dbPath)
    servers.push(server)
    const { boundId, detachedId } = seedUnavailableEntries(dbPath)
    const db = new DatabaseSync(dbPath)
    try {
      const galleryId = (db.prepare("SELECT gallery_id FROM bindings WHERE entry_id = ?").get(boundId) as { gallery_id: string }).gallery_id
      db.prepare(
        "UPDATE galleries SET metadata_title = ?, metadata_title_jpn = ?, metadata_tags_json = ?, metadata_status = 'ready' WHERE gallery_id = ?"
      ).run("Persisted source", "保存された原題", JSON.stringify(["artist:owner"]), galleryId)
      db.prepare("INSERT INTO entry_overrides(entry_id, title_present, title, title_search, notes) VALUES(?, 1, ?, ?, ?)").run(boundId, "Saved local title", "saved local title", "Private note")
      db.prepare("INSERT INTO entry_tag_overrides(entry_id, tag, action) VALUES(?, ?, ?), (?, ?, ?)").run(boundId, "local:add", "add", boundId, "artist:owner", "suppress")
      db.prepare("UPDATE bindings SET preferred_domain = 'e-hentai.org' WHERE entry_id = ?").run(boundId)
      db.prepare("INSERT INTO bindings(entry_id, gallery_id, preferred_domain, bound_at_ms) VALUES(?, ?, 'exhentai.org', 0)").run(detachedId, galleryId)
    } finally {
      db.close()
    }

    const withoutNotes = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).export({ payload: { entry_ids: [boundId], include_notes: false } })
    }))
    const withoutNotesEntry = withoutNotes.data.entries[0]!
    expect(withoutNotesEntry.source_metadata).toEqual({
      title: "Persisted source",
      title_jpn: "保存された原題",
      tags: ["artist:owner"]
    })
    expect(withoutNotesEntry.local_overrides).toEqual({
      title: "Saved local title",
      tags: ["local:add"],
      suppressed_tags: ["artist:owner"]
    })
    expect("notes" in withoutNotesEntry).toBe(false)
    expect(withoutNotes.data.privacy.notes_included).toBe(false)

    const withNotes = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).export({ payload: { entry_ids: [boundId], include_notes: true } })
    }))
    expect(withNotes.data.privacy.notes_included).toBe(true)
    expect(withNotes.data.entries[0]?.notes).toEqual(["Private note"])
    expect(withNotes.data.instance_id).toBe(server.instanceId)

    const sharedGallery = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).export({ payload: { entry_ids: [boundId, detachedId], include_notes: true } })
    }))
    expect(sharedGallery.data.entries.map((entry) => entry.binding_url)).toEqual([
      "https://e-hentai.org/g/12345/private-locator/",
      "https://exhentai.org/g/12345/private-locator/"
    ])
  })
})
