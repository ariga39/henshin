import { execFile as execFileCallback } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { afterEach, describe, expect, it } from "vitest"

const execFile = promisify(execFileCallback)
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const workspaces: Array<string> = []

const run = async (args: ReadonlyArray<string>, options?: { readonly env?: NodeJS.ProcessEnv }) => {
  const result = await execFile(process.execPath, [SERVER_PATH, ...args], {
    cwd: path.resolve("."),
    env: options?.env
  }).catch((error: unknown) => {
    const failure = error as { stderr?: string; code?: number }
    throw new Error(`${failure.code ?? "unknown"}: ${failure.stderr ?? ""}`, { cause: error })
  })
  return JSON.parse(result.stdout) as Record<string, unknown>
}

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

describe("server backup archive", () => {
  it("creates, verifies, and preserves a snapshot through the shipped CLI", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-backup-archive-"))
    workspaces.push(workspace)
    const dataDir = path.join(workspace, "data")
    const collection = path.join(workspace, "collection")
    const destination = path.join(workspace, "destination")
    await Promise.all([mkdir(dataDir), mkdir(collection), mkdir(destination)])
    const sourceFile = path.join(collection, "Book.cbz")
    const sourceBytes = Buffer.from("collection bytes")
    await writeFile(sourceFile, sourceBytes)

    const registered = await run([
      "backup-destination", "register", "--data-dir", dataDir,
      "--name", "primary", "--path", destination
    ])
    const saved = registered.destination as { destination_id: string }
    await execFile(process.execPath, [SERVER_PATH, "--data-dir", dataDir, "--initialize-owner"], {
      cwd: path.resolve(".")
    })
    await stat(path.join(dataDir, ".henshin-server-auth.sqlite"))
    const database = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    try {
      const library = database.prepare("SELECT library_id FROM server_library WHERE id = 1").get() as { library_id: string }
      const identity = await stat(collection)
      const canonicalCollection = await realpath(collection)
      const rootId = randomUUID()
      const entryId = randomUUID()
      database.prepare(`
        INSERT INTO server_roots(
          library_id, root_id, label, selected_path, canonical_path, device, inode,
          mapping_revision, policy_revision, exclusions, state
        ) VALUES (?, ?, 'Books', ?, ?, ?, ?, 1, 0, '[]', 'active')
      `).run(library.library_id, rootId, collection, canonicalCollection, String(identity.dev), String(identity.ino))
      const manifest = JSON.stringify({ version: 1, pages: [], before: { bytes: 0, entry_count: 0 }, after: { bytes: 0, entry_count: 0 } })
      database.prepare(`
        INSERT INTO library_entries(
          entry_id, library_id, root_id, relative_path, source_path, kind, title, page_count,
          state, content_version, location_revision, decision_version, manifest_json,
          created_at_ms, updated_at_ms, accepted_observation_json
        ) VALUES (?, ?, ?, 'Book.cbz', ?, 'archive', 'Book', 0, 'accepted', 1, 1, 1, ?, ?, ?, ?)
      `).run(entryId, library.library_id, rootId, sourceFile, manifest, Date.now(), Date.now(), "{}")
      database.prepare("INSERT INTO entry_statistics(entry_id, open_count, last_opened_at_ms) VALUES (?, 1, ?)").run(entryId, Date.now())
      database.prepare(`
        INSERT INTO open_events(
          event_id, instance_id, entry_id, device_id, observed_location_revision,
          observed_content_version, occurred_at_ms, receipt_at_ms
        ) VALUES (?, (SELECT instance_id FROM server_state WHERE id = 1), ?, 'fixture', 1, 1, ?, ?)
      `).run(randomUUID(), entryId, Date.now(), Date.now())
      database.prepare("UPDATE server_library SET change_revision = change_revision + 1 WHERE id = 1").run()
    } finally {
      database.close()
    }

    const created = await run([
      "backup", "create", "--data-dir", dataDir, "--destination-id", saved.destination_id,
      "--label", "test archive"
    ])
    const archivePath = created.archive_path as string
    const archiveBytes = new Uint8Array(await readFile(archivePath))
    const reader = new ZipReader(new Uint8ArrayReader(archiveBytes))
    const entries = await reader.getEntries()
    const payloads = new Map<string, Uint8Array>()
    for (const entry of entries) {
      if (entry.directory) throw new Error(`unexpected directory: ${entry.filename}`)
      payloads.set(entry.filename, new Uint8Array(await entry.getData(new Uint8ArrayWriter())))
    }
    await reader.close()
    expect([...payloads.keys()].sort()).toEqual(["configuration.json", "manifest.json", "state.sqlite"])

    const manifest = JSON.parse(new TextDecoder().decode(payloads.get("manifest.json"))) as {
      payloads: Record<string, { size_bytes: number; sha256: string }>
      library_id: string
    }
    for (const name of ["state.sqlite", "configuration.json"]) {
      const payload = payloads.get(name)
      if (payload === undefined) throw new Error(`missing ${name}`)
      expect(manifest.payloads[name]).toEqual({
        size_bytes: payload.byteLength,
        sha256: createHash("sha256").update(payload).digest("hex")
      })
    }
    const unpacked = path.join(workspace, "unpacked.sqlite")
    await writeFile(unpacked, payloads.get("state.sqlite") as Uint8Array)
    const snapshot = new DatabaseSync(unpacked, { readOnly: true })
    expect((snapshot.prepare("SELECT library_id FROM server_library WHERE id = 1").get() as { library_id: string }).library_id)
      .toBe(manifest.library_id)
    expect((snapshot.prepare("SELECT COUNT(*) AS count FROM library_entries").get() as { count: number }).count).toBe(1)
    expect((snapshot.prepare("SELECT COUNT(*) AS count FROM open_events").get() as { count: number }).count).toBe(1)
    expect((snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok")
    expect(snapshot.prepare("PRAGMA foreign_key_check").all()).toEqual([])
    snapshot.close()
    expect(await readFile(sourceFile)).toEqual(sourceBytes)

    const restarted = await run([
      "backup", "create", "--data-dir", dataDir, "--destination-id", saved.destination_id
    ])
    expect(restarted.publication_order).toBe(2)
    expect((await readdir(path.join(destination, "archives"))).filter((name) => name.endsWith(".henshin.zip"))).toHaveLength(2)

    const interrupted = await execFile(process.execPath, [SERVER_PATH, "backup", "create", "--data-dir", dataDir, "--destination-id", saved.destination_id], {
      cwd: path.resolve("."),
      env: { ...process.env, HENSHIN_TEST_INTERRUPT_PUBLICATION: "1" }
    }).then(() => false).catch(() => true)
    expect(interrupted).toBe(true)
    expect((await readdir(path.join(destination, "archives"))).filter((name) => name.endsWith(".henshin.zip"))).toHaveLength(2)
  })
})
