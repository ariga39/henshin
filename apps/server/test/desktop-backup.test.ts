import { execFile as execFileCallback } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { afterEach, describe, expect, it } from "vitest"
import { createDesktopBackupArchive } from "../src/maintenance/DesktopBackupArchive"
import { acquireDesktopOwnership } from "../src/persistence/DesktopOwnership"

const execFile = promisify(execFileCallback)
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const workspaces: Array<string> = []

const createDesktopStore = async (dataDirectory: string): Promise<void> => {
  await writeFile(path.join(dataDirectory, "device-id"), "11111111-1111-4111-8111-111111111111\n", { mode: 0o600 })
  const database = new DatabaseSync(path.join(dataDirectory, "prototype-client.db"))
  database.exec(`
    CREATE TABLE unsent_drafts(
      instance_id TEXT NOT NULL, note_id TEXT NOT NULL, form_id TEXT NOT NULL,
      text TEXT NOT NULL, local_revision INTEGER NOT NULL, base_server_revision INTEGER NOT NULL,
      base_epoch TEXT NOT NULL, present INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(instance_id, note_id, form_id)
    );
    CREATE TABLE command_attempts(
      instance_id TEXT NOT NULL, operation_id TEXT NOT NULL, note_id TEXT NOT NULL,
      intent_text TEXT NOT NULL, base_revision INTEGER NOT NULL, epoch TEXT NOT NULL,
      status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      result_note TEXT, expires_at_ms INTEGER, error_code TEXT, error_message TEXT,
      current_revision INTEGER, dismissed INTEGER NOT NULL,
      PRIMARY KEY(instance_id, operation_id)
    );
    CREATE TABLE client_mappings(
      instance_id TEXT NOT NULL, root_id TEXT NOT NULL, selected_path TEXT NOT NULL,
      canonical_path TEXT NOT NULL, mapping_revision INTEGER NOT NULL,
      selected_identity TEXT, canonical_identity TEXT, selected_resolution TEXT,
      canonical_resolution TEXT, state TEXT NOT NULL,
      PRIMARY KEY(instance_id, root_id)
    );
    CREATE TABLE reader_profiles(
      profile_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL,
      launch_mode TEXT NOT NULL, supported_formats TEXT NOT NULL, target_mode TEXT NOT NULL,
      executable_path TEXT, argument_tokens TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE launch_journal(
      instance_id TEXT NOT NULL, action_id TEXT NOT NULL, entry_id TEXT NOT NULL,
      profile_id TEXT, device_id TEXT NOT NULL, observed_location_revision INTEGER NOT NULL,
      observed_content_version INTEGER NOT NULL, status TEXT NOT NULL, event_json TEXT,
      delivery_status TEXT NOT NULL, delivery_error_code TEXT, delivery_error_message TEXT,
      failure_code TEXT, failure_message TEXT, created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL, PRIMARY KEY(instance_id, action_id)
    );
    CREATE TABLE open_resolution_cache(
      instance_id TEXT NOT NULL, entry_id TEXT NOT NULL, epoch TEXT NOT NULL,
      resolution_json TEXT NOT NULL, cached_at_ms INTEGER NOT NULL,
      PRIMARY KEY(instance_id, entry_id)
    );
    CREATE TABLE secret_sentinel(value TEXT NOT NULL);
  `)
  database.prepare(`
    INSERT INTO unsent_drafts(
      instance_id, note_id, form_id, text, local_revision, base_server_revision,
      base_epoch, present, updated_at_ms
    ) VALUES('22222222-2222-4222-8222-222222222222', 'note-1', 'form-1', 'durable pending draft', 1, 0, '33333333-3333-4333-8333-333333333333', 1, 1)
  `).run()
  database.prepare(`
    INSERT INTO command_attempts(
      instance_id, operation_id, note_id, intent_text, base_revision, epoch,
      status, created_at_ms, updated_at_ms, result_note, expires_at_ms,
      error_code, error_message, current_revision, dismissed
    ) VALUES('22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444', 'note-1', 'durable pending command', 0, '33333333-3333-4333-8333-333333333333', 'unresolved', 1, 1, NULL, NULL, NULL, NULL, NULL, 0)
  `).run()
  database.prepare("INSERT INTO open_resolution_cache VALUES('cache', 'entry', 'epoch', 'cache-secret', 1)").run()
  database.prepare("INSERT INTO secret_sentinel VALUES('must-not-be-published')").run()
  database.close()
}

const readArchivePayloads = async (archivePath: string): Promise<Map<string, Uint8Array>> => {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(archivePath))))
  const payloads = new Map<string, Uint8Array>()
  for (const entry of await reader.getEntries()) {
    if (entry.directory) throw new Error(`unexpected directory: ${entry.filename}`)
    payloads.set(entry.filename, new Uint8Array(await entry.getData(new Uint8ArrayWriter())))
  }
  await reader.close()
  return payloads
}

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

describe("stopped desktop backup", () => {
  it("refuses a live desktop owner, then publishes durable work without caches or secrets", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-backup-"))
    workspaces.push(workspace)
    const dataDirectory = path.join(workspace, "desktop-data")
    const outputDirectory = path.join(workspace, "backups")
    const destination = path.join(outputDirectory, "backup.henshin.zip")
    await mkdir(dataDirectory)
    await mkdir(outputDirectory)
    await createDesktopStore(dataDirectory)

    const owner = await acquireDesktopOwnership(dataDirectory)
    try {
      await expect(execFile(process.execPath, [
        SERVER_PATH,
        "backup", "desktop",
        "--data-dir", dataDirectory,
        "--output", destination
      ])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("data directory is already owned") })
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      owner.close()
    }

    const result = await execFile(process.execPath, [
      SERVER_PATH,
      "backup", "desktop",
      "--data-dir", dataDirectory,
      "--output", destination,
      "--label", "durable work"
    ])
    const summary = JSON.parse(result.stdout) as { store_kind: string; installation_id: string }
    expect(summary).toMatchObject({
      store_kind: "desktop",
      installation_id: "11111111-1111-4111-8111-111111111111"
    })
    expect((await stat(destination)).mode & 0o777).toBe(0o600)

    const payloads = await readArchivePayloads(destination)
    expect([...payloads.keys()].sort()).toEqual(["configuration.json", "manifest.json", "state.sqlite"])
    const configuration = JSON.parse(new TextDecoder().decode(payloads.get("configuration.json"))) as {
      excluded_data_classes: ReadonlyArray<string>
    }
    expect(configuration.excluded_data_classes).toContain("desktop connection credentials")
    const snapshotPath = path.join(workspace, "snapshot.sqlite")
    await writeFile(snapshotPath, payloads.get("state.sqlite") as Uint8Array)
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
    expect((snapshot.prepare("SELECT text FROM unsent_drafts").get() as { text: string }).text)
      .toBe("durable pending draft")
    expect((snapshot.prepare("SELECT intent_text FROM command_attempts").get() as { intent_text: string }).intent_text)
      .toBe("durable pending command")
    expect(snapshot.prepare("SELECT name FROM sqlite_master WHERE name = 'open_resolution_cache'").get()).toBeUndefined()
    expect(snapshot.prepare("SELECT name FROM sqlite_master WHERE name = 'secret_sentinel'").get()).toBeUndefined()
    snapshot.close()
  })

  it("removes a failed publication without leaving a private partial artifact", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-backup-failure-"))
    workspaces.push(workspace)
    const dataDirectory = path.join(workspace, "desktop-data")
    const outputDirectory = path.join(workspace, "backups")
    const destination = path.join(outputDirectory, "failed.henshin.zip")
    await mkdir(dataDirectory)
    await mkdir(outputDirectory)
    await createDesktopStore(dataDirectory)

    await expect(createDesktopBackupArchive({
      dataDirectory,
      outputPath: destination,
      installationId: "11111111-1111-4111-8111-111111111111",
      label: null,
      beforePublish: async () => {
        throw new Error("simulated publication failure")
      }
    })).rejects.toThrow("simulated publication failure")
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await readdir(outputDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
})
