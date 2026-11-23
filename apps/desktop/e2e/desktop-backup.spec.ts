import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import electronPath from "electron"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const APP_DIR = path.resolve("apps/desktop")
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const launched: ElectronApplication[] = []
const workspaces: string[] = []

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
})
