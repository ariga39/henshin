import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import electronPath from "electron"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "../../server/node_modules/@zip.js/zip.js/index.cjs"

const execFile = promisify(execFileCallback)
const APP_DIR = path.resolve("apps/desktop")
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const launched: ElectronApplication[] = []
const workspaces: string[] = []

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

test.afterEach(async () => {
  for (const app of launched.splice(0)) await app.close().catch(() => undefined)
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

test("holds the desktop owner through durable work and permits maintenance after shutdown", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-contention-"))
  workspaces.push(workspace)
  const dataDirectory = path.join(workspace, "desktop-data")
  const outputDirectory = path.join(workspace, "backups")
  await mkdir(outputDirectory)
  const destination = path.join(outputDirectory, "desktop.henshin.zip")

  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [".", `--user-data-dir=${dataDirectory}`],
    cwd: APP_DIR,
    env: { ...process.env, HENSHIN_PROTOTYPE_MODE: "1" }
  })
  launched.push(app)
  const resolvedUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"))
  expect(await realpath(resolvedUserData)).toBe(await realpath(dataDirectory))
  const window = await app.firstWindow()
  await window.getByTestId("load").click()
  await expect(window.getByTestId("note-text")).toHaveText("hello")
  await window.getByTestId("text-input").fill("retained in stopped desktop backup")
  await window.getByTestId("save-local-draft").click()
  await expect(window.getByTestId("outcome")).toContainText("local draft saved")

  const deviceId = (await readFile(path.join(dataDirectory, "device-id"), "utf8")).trim()
  const database = new DatabaseSync(path.join(dataDirectory, "prototype-client.db"))
  database.prepare(`
    INSERT INTO launch_journal(
      instance_id, action_id, entry_id, profile_id, device_id,
      observed_location_revision, observed_content_version, status, event_json,
      delivery_status, delivery_error_code, delivery_error_message,
      failure_code, failure_message, created_at_ms, updated_at_ms
    ) VALUES(?, ?, 'entry-from-real-store', NULL, ?, 1, 1, 'prepared', NULL,
      'pending', NULL, NULL, NULL, NULL, ?, ?)
  `).run(
    "22222222-2222-4222-8222-222222222222",
    "55555555-5555-4555-8555-555555555555",
    deviceId,
    Date.now(),
    Date.now()
  )
  database.close()

  await expect(execFile(process.execPath, [
    SERVER_PATH,
    "backup", "desktop",
    "--data-dir", dataDirectory,
    "--output", destination
  ])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("data directory is already owned")
  })

  await app.close()
  launched.splice(launched.indexOf(app), 1)
  const result = await execFile(process.execPath, [
    SERVER_PATH,
    "backup", "desktop",
    "--data-dir", dataDirectory,
    "--output", destination
  ])
  expect(JSON.parse(result.stdout)).toMatchObject({ store_kind: "desktop" })

  const payloads = await readArchivePayloads(destination)
  expect([...payloads.keys()].sort()).toEqual(["configuration.json", "manifest.json", "state.sqlite"])
  const manifest = JSON.parse(new TextDecoder().decode(payloads.get("manifest.json"))) as {
    application_version: string
  }
  expect(manifest.application_version).toBe("0.0.0")
  const snapshotPath = path.join(workspace, "published-state.sqlite")
  await writeFile(snapshotPath, payloads.get("state.sqlite") as Uint8Array)
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
  expect((snapshot.prepare("SELECT text FROM unsent_drafts WHERE text = ?").get("retained in stopped desktop backup") as { text: string }).text)
    .toBe("retained in stopped desktop backup")
  expect(snapshot.prepare(
    "SELECT status FROM launch_journal WHERE action_id = '55555555-5555-4555-8555-555555555555'"
  ).get()).toEqual({ status: "prepared" })
  snapshot.close()
})

test("recovers durable draft and requires explicit reader reauthorization across restart", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-recovery-e2e-"))
  workspaces.push(workspace)
  const dataDirectory = path.join(workspace, "desktop-data")
  const outputDirectory = path.join(workspace, "backups")
  const target = path.join(workspace, "target.cbz")
  const olderArchive = path.join(outputDirectory, "older.henshin.zip")
  await mkdir(outputDirectory)
  await writeFile(target, "test archive")

  const launch = async (): Promise<ElectronApplication> => {
    const app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [".", `--user-data-dir=${dataDirectory}`],
      cwd: APP_DIR,
      env: { ...process.env, HENSHIN_PROTOTYPE_MODE: "1" }
    })
    launched.push(app)
    const resolvedUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"))
    expect(await realpath(resolvedUserData)).toBe(await realpath(dataDirectory))
    return app
  }

  const first = await launch()
  const firstWindow = await first.firstWindow()
  await firstWindow.getByTestId("load").click()
  await expect(firstWindow.getByTestId("note-text")).toHaveText("hello")
  await firstWindow.getByTestId("text-input").fill("older recovered draft")
  await firstWindow.getByTestId("save-local-draft").click()
  await expect(firstWindow.getByTestId("outcome")).toContainText("local draft saved")
  await first.evaluate(({ dialog }) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [process.execPath] })
    })
  })
  const executable = await firstWindow.evaluate(() => window.henshinReaderProfiles.selectExecutable())
  if (!executable.ok || executable.data === null) throw new Error("reader executable was not selected")
  const profileResult = await firstWindow.evaluate((handle) => window.henshinReaderProfiles.save({
    profile_id: null,
    expected_revision: "0",
    name: "Recovered reader",
    launch_mode: "explicit-executable",
    supported_formats: ["archive"],
    target_mode: "archive",
    argument_tokens: ["{target}"],
    selection_handle: handle
  }), executable.data.selection_handle)
  expect(profileResult).toMatchObject({ ok: true, data: { name: "Recovered reader", revision: "1" } })
  await first.close()
  launched.splice(launched.indexOf(first), 1)
  await runBackup(olderArchive, dataDirectory)

  const second = await launch()
  const secondWindow = await second.firstWindow()
  await secondWindow.getByTestId("load").click()
  await secondWindow.getByTestId("load-local-draft").click()
  await expect(secondWindow.getByTestId("text-input")).toHaveValue("older recovered draft")
  await secondWindow.getByTestId("text-input").fill("newer lost draft")
  await secondWindow.getByTestId("save-local-draft").click()
  await expect(secondWindow.getByTestId("outcome")).toContainText("local draft saved")
  await second.close()
  launched.splice(launched.indexOf(second), 1)

  await execFile(process.execPath, [
    SERVER_PATH, "backup", "desktop", "restore", "--data-dir", dataDirectory, "--input", olderArchive, "--confirm"
  ])

  const recovered = await launch()
  const recoveredWindow = await recovered.firstWindow()
  await expect(recoveredWindow.getByTestId("connection-status")).toHaveText("disconnected")
  const profiles = await recoveredWindow.evaluate(() => window.henshinReaderProfiles.list())
  if (!profiles.ok || profiles.data[0] === undefined) throw new Error("recovered reader profile was absent")
  const currentProfile = profiles.data[0]
  await recovered.evaluate(({ dialog }, selected) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [selected] })
    })
  }, target)
  const targetSelection = await recoveredWindow.evaluate((profile) => window.henshinReaderProfiles.selectTestTarget({
    profile_id: profile.profile_id,
    expected_revision: profile.revision
  }), currentProfile)
  if (!targetSelection.ok || targetSelection.data === null) throw new Error("recovered reader target was not selected")
  const heldTest = await recoveredWindow.evaluate((input) => window.henshinReaderProfiles.test(input), {
    profile_id: currentProfile.profile_id,
    expected_revision: currentProfile.revision,
    selection_handle: targetSelection.data.selection_handle
  })
  expect(heldTest).toMatchObject({ ok: false, error: { message: expect.stringContaining("review and save") } })

  const reauthorized = await recoveredWindow.evaluate((profile) => window.henshinReaderProfiles.save({
    profile_id: profile.profile_id,
    expected_revision: profile.revision,
    name: profile.name,
    launch_mode: profile.launch_mode,
    supported_formats: profile.supported_formats,
    target_mode: profile.target_mode,
    argument_tokens: profile.argument_tokens,
    selection_handle: null
  }), currentProfile)
  expect(reauthorized).toMatchObject({ ok: true, data: { revision: "2" } })
  await recoveredWindow.getByTestId("reconnect").click()
  await expect(recoveredWindow.getByTestId("connection-status")).toHaveText("connected")
  await recoveredWindow.getByTestId("load").click()
  await recoveredWindow.getByTestId("load-local-draft").click()
  await expect(recoveredWindow.getByTestId("text-input")).toHaveValue("older recovered draft")
  await recovered.close()
  launched.splice(launched.indexOf(recovered), 1)

  const state = JSON.parse(await readFile(path.join(dataDirectory, "desktop-recovery-state.json"), "utf8")) as Record<string, unknown>
  expect(state).toMatchObject({ requires_fresh_authentication: false, reader_profiles_require_review: false })
})

const runBackup = async (archive: string, dataDirectory: string): Promise<void> => {
  await execFile(process.execPath, [SERVER_PATH, "backup", "desktop", "--data-dir", dataDirectory, "--output", archive])
}
