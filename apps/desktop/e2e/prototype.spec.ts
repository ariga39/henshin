import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from "@playwright/test"
import electronPath from "electron"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP_DIR = fileURLToPath(new URL("..", import.meta.url))
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Launched {
  readonly app: ElectronApplication
  readonly window: Page
}

// Every launched app is tracked so a failing assertion can never leave a window
// or an owned server child running.
const launched: ElectronApplication[] = []

const launch = async (dbPath: string): Promise<Launched> => {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: ["."],
    cwd: APP_DIR,
    env: { ...process.env, HENSHIN_PROTOTYPE_DB: dbPath }
  })
  launched.push(app)
  const window = await app.firstWindow()
  return { app, window }
}

const close = async (app: ElectronApplication): Promise<void> => {
  const index = launched.indexOf(app)
  if (index >= 0) launched.splice(index, 1)
  await app.close()
}

const tempDbPath = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "henshin-e2e-"))
  return path.join(dir, "prototype.db")
}

test.afterEach(async () => {
  for (const app of launched.splice(0)) {
    try {
      await app.close()
    } catch {
      // Best-effort teardown of a leaked app.
    }
  }
})

test("a synthetic conditional edit commits, persists across restart, and reports a stale conflict without writing", async () => {
  const dbPath = await tempDbPath()
  const observed: {
    firstInstance?: string
    firstEpoch?: string
    secondInstance?: string
    secondEpoch?: string
  } = {}

  const first = await launch(dbPath)
  try {
    await first.window.getByTestId("load").click()
    await expect(first.window.getByTestId("committed-revision")).toHaveText("0")
    await expect(first.window.getByTestId("base-revision")).toHaveText("0")
    observed.firstInstance = (await first.window.getByTestId("instance").textContent()) ?? ""
    observed.firstEpoch = (await first.window.getByTestId("epoch").textContent()) ?? ""

    await first.window.getByTestId("text-input").fill("persisted")
    await first.window.getByTestId("save").click()
    await expect(first.window.getByTestId("outcome")).toContainText("committed revision=1")
    await expect(first.window.getByTestId("committed-revision")).toHaveText("1")

    // A second save from the same captured revision is a stale conflict and must
    // not change committed state.
    await first.window.getByTestId("text-input").fill("conflicting")
    await first.window.getByTestId("save").click()
    await expect(first.window.getByTestId("outcome")).toContainText("conflict current_revision=1")
    await expect(first.window.getByTestId("committed-revision")).toHaveText("1")
  } finally {
    await close(first.app)
  }

  const second = await launch(dbPath)
  try {
    await second.window.getByTestId("load").click()
    await expect(second.window.getByTestId("note-text")).toHaveText("persisted")
    await expect(second.window.getByTestId("committed-revision")).toHaveText("1")
    observed.secondInstance = (await second.window.getByTestId("instance").textContent()) ?? ""
    observed.secondEpoch = (await second.window.getByTestId("epoch").textContent()) ?? ""
  } finally {
    await close(second.app)
  }

  // Both namespace identifiers are real UUIDs, not placeholder text.
  expect(observed.firstInstance).toMatch(UUID_PATTERN)
  expect(observed.firstEpoch).toMatch(UUID_PATTERN)
  expect(observed.secondInstance).toMatch(UUID_PATTERN)
  expect(observed.secondEpoch).toMatch(UUID_PATTERN)

  // Same namespace, fresh authority epoch after restart.
  expect(observed.secondInstance).toBe(observed.firstInstance)
  expect(observed.secondEpoch).not.toBe(observed.firstEpoch)
})
