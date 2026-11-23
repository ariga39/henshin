import { execFile as execFileCallback } from "node:child_process"
import { spawnSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Worker } from "node:worker_threads"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { afterEach, describe, expect, it } from "vitest"
import { createDesktopBackupArchive } from "../src/maintenance/DesktopBackupArchive"
import { acquireDesktopOwnership } from "../src/persistence/DesktopOwnership"

const execFile = promisify(execFileCallback)
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const DRAFT_WORKER_URL = new URL("../../desktop/dist/draft-worker.mjs", import.meta.url)
const workspaces: Array<string> = []

const runDesktopWorker = async (dbPath: string, applicationVersion: string): Promise<void> => {
  const worker = new Worker(DRAFT_WORKER_URL, {
    workerData: {
      dbPath,
      installationId: "11111111-1111-4111-8111-111111111111",
      applicationVersion
    }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject)
      worker.once("message", (message: { readonly ok: boolean; readonly error?: string }) => {
        if (message.ok) resolve()
        else reject(new Error(message.error ?? "desktop worker close failed"))
      })
      worker.postMessage({ id: 1, request: { op: "close" } })
    })
  } finally {
    await worker.terminate()
  }
}

const createDesktopStore = async (
  dataDirectory: string,
  installationId = "11111111-1111-4111-8111-111111111111"
): Promise<void> => {
  await writeFile(path.join(dataDirectory, "device-id"), `${installationId}\n`, { mode: 0o600 })
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
    CREATE TABLE desktop_store_metadata(
      id INTEGER PRIMARY KEY CHECK (id = 1),
      installation_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      application_version TEXT
    );
  `)
  database.prepare("INSERT INTO desktop_store_metadata VALUES(1, ?, 1, 'desktop-test-version')").run(installationId)
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
  database.prepare(`
    INSERT INTO launch_journal(
      instance_id, action_id, entry_id, profile_id, device_id,
      observed_location_revision, observed_content_version, status, event_json,
      delivery_status, delivery_error_code, delivery_error_message,
      failure_code, failure_message, created_at_ms, updated_at_ms
    ) VALUES(
      '22222222-2222-4222-8222-222222222222', '55555555-5555-4555-8555-555555555555',
      'entry-1', 'reader-1', '11111111-1111-4111-8111-111111111111',
      1, 1, 'prepared', NULL, 'pending', NULL, NULL, NULL, NULL, 1, 1
    )
  `).run()
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
  it("refreshes producer version on desktop upgrade before backup", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-backup-upgrade-"))
    workspaces.push(workspace)
    const dataDirectory = path.join(workspace, "desktop-data")
    const outputDirectory = path.join(workspace, "backups")
    const destination = path.join(outputDirectory, "upgraded.henshin.zip")
    await mkdir(dataDirectory)
    await mkdir(outputDirectory)
    await createDesktopStore(dataDirectory)
    const dbPath = path.join(dataDirectory, "prototype-client.db")

    await runDesktopWorker(dbPath, "desktop-upgraded-version")
    const result = await execFile(process.execPath, [
      SERVER_PATH,
      "backup", "desktop",
      "--data-dir", dataDirectory,
      "--output", destination
    ])
    const payloads = await readArchivePayloads(destination)
    const configuration = JSON.parse(new TextDecoder().decode(payloads.get("configuration.json"))) as {
      application_version: string
    }
    const manifest = JSON.parse(new TextDecoder().decode(payloads.get("manifest.json"))) as {
      application_version: string
    }
    expect(result.stdout).toContain("11111111-1111-4111-8111-111111111111")
    expect(configuration.application_version).toBe("desktop-upgraded-version")
    expect(manifest.application_version).toBe("desktop-upgraded-version")
  })

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
      application_version: string
    }
    expect(configuration.excluded_data_classes).toContain("desktop connection credentials")
    expect(configuration.application_version).toBe("desktop-test-version")
    const manifest = JSON.parse(new TextDecoder().decode(payloads.get("manifest.json"))) as {
      application_version: string
    }
    expect(manifest.application_version).toBe("desktop-test-version")
    const snapshotPath = path.join(workspace, "snapshot.sqlite")
    await writeFile(snapshotPath, payloads.get("state.sqlite") as Uint8Array)
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
    expect((snapshot.prepare("SELECT text FROM unsent_drafts").get() as { text: string }).text)
      .toBe("durable pending draft")
    expect((snapshot.prepare("SELECT intent_text FROM command_attempts").get() as { intent_text: string }).intent_text)
      .toBe("durable pending command")
    expect(snapshot.prepare("SELECT name FROM sqlite_master WHERE name = 'open_resolution_cache'").get()).toBeUndefined()
    expect((snapshot.prepare("SELECT status FROM launch_journal WHERE action_id = '55555555-5555-4555-8555-555555555555'").get() as { status: string }).status)
      .toBe("prepared")
    expect(snapshot.prepare("SELECT installation_id, schema_version, application_version FROM desktop_store_metadata WHERE id = 1").get())
      .toEqual({ installation_id: "11111111-1111-4111-8111-111111111111", schema_version: 1, application_version: "desktop-test-version" })
    snapshot.close()
  })

  it("previews the selected backup only for a matching live database identity and schema", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-preview-"))
    workspaces.push(workspace)
    const dataDirectory = path.join(workspace, "client")
    const outputDirectory = path.join(workspace, "backups")
    const archive = path.join(outputDirectory, "point.zip")
    await Promise.all([mkdir(dataDirectory), mkdir(outputDirectory)])
    await createDesktopStore(dataDirectory)
    await execFile(process.execPath, [SERVER_PATH, "backup", "desktop", "--data-dir", dataDirectory, "--output", archive])
    const preview = () => execFile(process.execPath, [SERVER_PATH, "backup", "desktop", "restore", "--data-dir", dataDirectory, "--input", archive])
    expect(JSON.parse((await preview()).stdout)).toMatchObject({
      pending_work: { drafts: 1, command_attempts: 1, launch_journal: 1 },
      requires_confirmation: true
    })
    const dbPath = path.join(dataDirectory, "prototype-client.db")
    const originalId = (await readFile(path.join(dataDirectory, "device-id"), "utf8")).trim()
    for (const [id, version, diagnostic] of [
      ["22222222-2222-4222-8222-222222222222", 1, "identity disagree"],
      [originalId, 2, "unsupported schema version"]
    ] as const) {
      const db = new DatabaseSync(dbPath)
      try {
        db.prepare("UPDATE desktop_store_metadata SET installation_id = ?, schema_version = ? WHERE id = 1").run(id, version)
      } finally {
        db.close()
      }
      const before = await readFile(dbPath)
      await expect(preview()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(diagnostic) })
      expect((await readFile(dbPath)).equals(before)).toBe(true)
    }
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
        const stagingDirectories = (await readdir(dataDirectory)).filter((name) => name.startsWith(".desktop-backup-staging-"))
        expect(stagingDirectories).toHaveLength(1)
        expect((await stat(path.join(dataDirectory, stagingDirectories[0]))).mode & 0o777).toBe(0o700)
        const temporaryArchives = (await readdir(outputDirectory)).filter((name) => name.endsWith(".tmp"))
        expect(temporaryArchives).toHaveLength(1)
        expect((await stat(path.join(outputDirectory, temporaryArchives[0]))).mode & 0o777).toBe(0o600)
        throw new Error("simulated publication failure")
      }
    })).rejects.toThrow("simulated publication failure")
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await readdir(outputDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect((await readdir(dataDirectory)).filter((name) => name.startsWith(".desktop-backup-staging-"))).toEqual([])
  })

  it("backs up a dirty WAL through private staging without changing the source store", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-backup-dirty-wal-"))
    workspaces.push(workspace)
    const dataDirectory = path.join(workspace, "desktop-data")
    const outputDirectory = path.join(workspace, "backups")
    const destination = path.join(outputDirectory, "dirty.henshin.zip")
    await mkdir(dataDirectory)
    await mkdir(outputDirectory)
    await createDesktopStore(dataDirectory)
    const dbPath = path.join(dataDirectory, "prototype-client.db")
    const child = spawnSync(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite")
      const db = new DatabaseSync(process.argv[1])
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
      db.prepare("UPDATE unsent_drafts SET text = 'dirty WAL draft', updated_at_ms = 2").run()
      process.kill(process.pid, "SIGKILL")
    `, dbPath])
    expect(child.signal).toBe("SIGKILL")
    const walPath = `${dbPath}-wal`
    expect((await stat(walPath)).size).toBeGreaterThan(0)
    const sourceBefore = await readFile(dbPath)
    const walBefore = await readFile(walPath)

    await createDesktopBackupArchive({
      dataDirectory,
      outputPath: destination,
      installationId: "11111111-1111-4111-8111-111111111111",
      label: null,
      beforePublish: async () => {
        const stagingDirectories = (await readdir(dataDirectory)).filter((name) => name.startsWith(".desktop-backup-staging-"))
        expect(stagingDirectories).toHaveLength(1)
        const stagingDirectory = path.join(dataDirectory, stagingDirectories[0])
        expect((await stat(stagingDirectory)).mode & 0o777).toBe(0o700)
        expect((await stat(path.join(stagingDirectory, "source.sqlite"))).mode & 0o777).toBe(0o600)
      }
    })
    expect((await stat(destination)).isFile()).toBe(true)

    expect(await readFile(dbPath)).toEqual(sourceBefore)
    expect(await readFile(walPath)).toEqual(walBefore)
    const payloads = await readArchivePayloads(destination)
    const snapshotPath = path.join(workspace, "dirty-snapshot.sqlite")
    await writeFile(snapshotPath, payloads.get("state.sqlite") as Uint8Array)
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
    expect((snapshot.prepare("SELECT text FROM unsent_drafts").get() as { text: string }).text)
      .toBe("dirty WAL draft")
    snapshot.close()
    expect((await readdir(dataDirectory)).filter((name) => name.startsWith(".desktop-backup-staging-"))).toEqual([])
    expect((await readdir(outputDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it.each([
    "CREATE TABLE sqliteXfoo(id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    "CREATE INDEX foreign_draft_idx ON unsent_drafts(note_id)"
  ])("refuses to archive an unrecognized schema object from %s", async (ddl) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-backup-schema-"))
    workspaces.push(workspace)
    const dataDirectory = path.join(workspace, "desktop-data")
    const outputDirectory = path.join(workspace, "backups")
    const destination = path.join(outputDirectory, "schema.henshin.zip")
    await mkdir(dataDirectory)
    await mkdir(outputDirectory)
    await createDesktopStore(dataDirectory)
    const database = new DatabaseSync(path.join(dataDirectory, "prototype-client.db"))
    database.exec(ddl)
    database.close()

    await expect(createDesktopBackupArchive({
      dataDirectory,
      outputPath: destination,
      installationId: "11111111-1111-4111-8111-111111111111",
      label: null
    })).rejects.toThrow("unrecognized schema object")
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("lets only one stopped installation publish a contested output", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-backup-race-"))
    workspaces.push(workspace)
    const firstDataDirectory = path.join(workspace, "desktop-data-one")
    const secondDataDirectory = path.join(workspace, "desktop-data-two")
    const outputDirectory = path.join(workspace, "backups")
    const destination = path.join(outputDirectory, "same-name.henshin.zip")
    await mkdir(firstDataDirectory)
    await mkdir(secondDataDirectory)
    await mkdir(outputDirectory)
    await Promise.all([
      createDesktopStore(firstDataDirectory, "11111111-1111-4111-8111-111111111111"),
      createDesktopStore(secondDataDirectory, "22222222-2222-4222-8222-222222222222")
    ])

    const results = await Promise.allSettled([
      createDesktopBackupArchive({
        dataDirectory: firstDataDirectory,
        outputPath: destination,
        installationId: "11111111-1111-4111-8111-111111111111",
        label: "first"
      }),
      createDesktopBackupArchive({
        dataDirectory: secondDataDirectory,
        outputPath: destination,
        installationId: "22222222-2222-4222-8222-222222222222",
        label: "second"
      })
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({
      message: "desktop backup destination already exists"
    })
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
    expect((await readdir(outputDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect((await readdir(firstDataDirectory)).filter((name) => name.startsWith(".desktop-backup-staging-"))).toEqual([])
    expect((await readdir(secondDataDirectory)).filter((name) => name.startsWith(".desktop-backup-staging-"))).toEqual([])
  })
})
