import { execFile as execFileCallback } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Worker } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import { acquireDesktopOwnership } from "../src/persistence/DesktopOwnership"

const execFile = promisify(execFileCallback)
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const workspaces: Array<string> = []
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111"
const OTHER_INSTALLATION_ID = "22222222-2222-4222-8222-222222222222"
const INSTANCE_ID = "33333333-3333-4333-8333-333333333333"
const workerUrl = new URL("../../desktop/dist/draft-worker.mjs", import.meta.url)

const createDesktopStore = async (dataDirectory: string, installationId = INSTALLATION_ID, draftText = "old durable draft"): Promise<void> => {
  const collectionDirectory = path.join(path.dirname(dataDirectory), "collection")
  await mkdir(collectionDirectory, { recursive: true })
  await writeFile(path.join(dataDirectory, "device-id"), `${installationId}\n`, { mode: 0o600 })
  const database = new DatabaseSync(path.join(dataDirectory, "prototype-client.db"))
  database.exec(`
    CREATE TABLE desktop_store_metadata(id INTEGER PRIMARY KEY CHECK(id = 1), installation_id TEXT NOT NULL, schema_version INTEGER NOT NULL, application_version TEXT);
    CREATE TABLE unsent_drafts(instance_id TEXT NOT NULL, note_id TEXT NOT NULL, form_id TEXT NOT NULL, text TEXT NOT NULL, local_revision INTEGER NOT NULL, base_server_revision INTEGER NOT NULL, base_epoch TEXT NOT NULL, present INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(instance_id, note_id, form_id));
    CREATE TABLE command_attempts(instance_id TEXT NOT NULL, operation_id TEXT NOT NULL, note_id TEXT NOT NULL, intent_text TEXT NOT NULL, base_revision INTEGER NOT NULL, epoch TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, result_note TEXT, expires_at_ms INTEGER, error_code TEXT, error_message TEXT, current_revision INTEGER, dismissed INTEGER NOT NULL, PRIMARY KEY(instance_id, operation_id));
    CREATE TABLE client_mappings(instance_id TEXT NOT NULL, root_id TEXT NOT NULL, selected_path TEXT NOT NULL, canonical_path TEXT NOT NULL, mapping_revision INTEGER NOT NULL, selected_identity TEXT, canonical_identity TEXT, selected_resolution TEXT, canonical_resolution TEXT, state TEXT NOT NULL, PRIMARY KEY(instance_id, root_id));
    CREATE TABLE reader_profiles(profile_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL, launch_mode TEXT NOT NULL, supported_formats TEXT NOT NULL, target_mode TEXT NOT NULL, executable_path TEXT, argument_tokens TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
    CREATE TABLE launch_journal(instance_id TEXT NOT NULL, action_id TEXT NOT NULL, entry_id TEXT NOT NULL, profile_id TEXT, device_id TEXT NOT NULL, observed_location_revision INTEGER NOT NULL, observed_content_version INTEGER NOT NULL, status TEXT NOT NULL, event_json TEXT, delivery_status TEXT NOT NULL, delivery_error_code TEXT, delivery_error_message TEXT, failure_code TEXT, failure_message TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(instance_id, action_id));
  `)
  database.prepare("INSERT INTO desktop_store_metadata VALUES(1, ?, 1, 'desktop-test-version')").run(installationId)
  database.prepare("INSERT INTO unsent_drafts VALUES(?, 'note-1', 'form-1', ?, 1, 0, ?, 1, 1000)").run(INSTANCE_ID, draftText, INSTANCE_ID)
  database.prepare("INSERT INTO client_mappings VALUES(?, '55555555-5555-4555-8555-555555555555', ?, ?, 1, NULL, NULL, NULL, NULL, 'active')").run(INSTANCE_ID, collectionDirectory, collectionDirectory)
  database.prepare("INSERT INTO reader_profiles VALUES('66666666-6666-4666-8666-666666666666', 1, 'Recovered reader', 'explicit-executable', '[\"cbz\"]', 'archive', '/bin/echo', '[\"{target}\"]', 1000)").run()
  database.prepare("INSERT INTO launch_journal VALUES(?, '44444444-4444-4444-8444-444444444444', 'entry-1', 'reader-1', ?, 1, 1, 'prepared', NULL, 'pending', NULL, NULL, NULL, NULL, 1000, 1000)").run(INSTANCE_ID, installationId)
  database.close()
}

const run = (args: ReadonlyArray<string>) => execFile(process.execPath, [SERVER_PATH, ...args])

const verifyDesktopWorkerStartup = async (dbPath: string): Promise<void> => {
  const worker = new Worker(workerUrl, {
    workerData: {
      dbPath,
      installationId: INSTALLATION_ID,
      applicationVersion: "desktop-test-version"
    }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject)
      worker.once("message", (message: { readonly id?: number; readonly ok?: boolean; readonly error?: string }) => {
        if (message.id !== 1) return
        if (message.ok === true) resolve()
        else reject(new Error(message.error ?? "desktop worker startup failed"))
      })
      worker.postMessage({ id: 1, request: { op: "close" } })
    })
  } finally {
    await worker.terminate()
  }
}

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

describe("same-installation desktop recovery", () => {
  it("reuses preview validation and applies an older point with durable reauthorization holds", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-recovery-"))
    workspaces.push(workspace)
    const dataDirectory = path.join(workspace, "desktop-data")
    const outputDirectory = path.join(workspace, "backups")
    await Promise.all([mkdir(dataDirectory), mkdir(outputDirectory)])
    await createDesktopStore(dataDirectory)

    const oldArchive = path.join(outputDirectory, "old.henshin.zip")
    await run(["backup", "desktop", "--data-dir", dataDirectory, "--output", oldArchive])
    const live = new DatabaseSync(path.join(dataDirectory, "prototype-client.db"))
    live.prepare("UPDATE unsent_drafts SET text = 'newer local work', updated_at_ms = 2000").run()
    live.close()

    const preview = await run(["backup", "desktop", "restore", "--data-dir", dataDirectory, "--input", oldArchive])
    expect(JSON.parse(preview.stdout)).toMatchObject({
      target_installation_id: INSTALLATION_ID,
      recovery_installation_id: INSTALLATION_ID,
      requires_confirmation: true
    })
    const before = await readFile(path.join(dataDirectory, "prototype-client.db"))
    const applied = JSON.parse((await run(["backup", "desktop", "restore", "--data-dir", dataDirectory, "--input", oldArchive, "--confirm"])).stdout) as {
      rollback_directory: string
      recovery_state_path: string
    }
    expect(await readFile(path.join(dataDirectory, "prototype-client.db"))).not.toEqual(before)
    const restored = new DatabaseSync(path.join(dataDirectory, "prototype-client.db"), { readOnly: true })
    expect((restored.prepare("SELECT text FROM unsent_drafts").get() as { text: string }).text).toBe("old durable draft")
    expect((restored.prepare("SELECT status FROM launch_journal").get() as { status: string }).status).toBe("unknown")
    expect((restored.prepare("SELECT requires_reauthorization FROM client_mappings").get() as { requires_reauthorization: number }).requires_reauthorization).toBe(1)
    expect((restored.prepare("SELECT requires_reauthorization FROM reader_profiles").get() as { requires_reauthorization: number }).requires_reauthorization).toBe(1)
    restored.close()
    await verifyDesktopWorkerStartup(path.join(dataDirectory, "prototype-client.db"))
    const rollback = new DatabaseSync(path.join(applied.rollback_directory, "prototype-client.db"), { readOnly: true })
    expect((rollback.prepare("SELECT text FROM unsent_drafts").get() as { text: string }).text).toBe("newer local work")
    rollback.close()
    expect((await stat(applied.rollback_directory)).mode & 0o777).toBe(0o700)
    expect((await stat(applied.recovery_state_path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(applied.recovery_state_path, "utf8"))).toMatchObject({
      requires_fresh_authentication: true,
      mappings_require_review: true,
      reader_profiles_require_review: true,
      automatic_reader_launch_disabled: true
    })
    expect((await readdir(dataDirectory)).filter((name) => name.startsWith(".desktop-recovery-validation-") || name.startsWith(".desktop-recovery-staging-") || name === ".desktop-recovery-in-progress.json")).toEqual([])
  })

  it("refuses a running target before preview or apply mutation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-recovery-owned-"))
    workspaces.push(workspace)
    const dataDirectory = path.join(workspace, "desktop-data")
    const outputDirectory = path.join(workspace, "backups")
    await Promise.all([mkdir(dataDirectory), mkdir(outputDirectory)])
    await createDesktopStore(dataDirectory)
    const archive = path.join(outputDirectory, "backup.henshin.zip")
    await run(["backup", "desktop", "--data-dir", dataDirectory, "--output", archive])
    const owner = await acquireDesktopOwnership(dataDirectory)
    try {
      await expect(run(["backup", "desktop", "restore", "--data-dir", dataDirectory, "--input", archive, "--confirm"])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("data directory is already owned")
      })
    } finally {
      owner.close()
    }
  })

  it("blocks both preview and apply for a different installation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-recovery-mismatch-"))
    workspaces.push(workspace)
    const source = path.join(workspace, "source")
    const target = path.join(workspace, "target")
    const outputDirectory = path.join(workspace, "backups")
    await Promise.all([mkdir(source), mkdir(target), mkdir(outputDirectory)])
    await createDesktopStore(source)
    await createDesktopStore(target, OTHER_INSTALLATION_ID)
    const archive = path.join(outputDirectory, "source.henshin.zip")
    await run(["backup", "desktop", "--data-dir", source, "--output", archive])
    const targetDatabase = path.join(target, "prototype-client.db")
    const before = await readFile(targetDatabase)
    for (const mode of ["--preview", "--confirm"] as const) {
      await expect(run(["backup", "desktop", "restore", mode, "--data-dir", target, "--input", archive]))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("belongs to another installation") })
    }
    expect(await readFile(targetDatabase)).toEqual(before)
  })
})
