import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import electronPath from "electron"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP_DIR = fileURLToPath(new URL("..", import.meta.url))
const launched: ElectronApplication[] = []

const launch = async (dbPath: string): Promise<{ app: ElectronApplication; window: Page }> => {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: ["."],
    cwd: APP_DIR,
    env: {
      ...process.env,
      HENSHIN_PROTOTYPE_DB: dbPath,
      HENSHIN_PROTOTYPE_CLIENT_DB: `${dbPath}.client`
    }
  })
  launched.push(app)
  return { app, window: await app.firstWindow() }
}

test.afterEach(async () => {
  for (const app of launched.splice(0)) await app.close().catch(() => undefined)
})

test("previews, confirms a labeled root, survives restart, and recovers from stale verification", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-root-preview-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-root-preview-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")
  const missingDirectory = path.join(fixtureDirectory, "appears-later")

  try {
    for (let index = 0; index < 40; index += 1) {
      await writeFile(path.join(fixtureDirectory, `child-${index.toString().padStart(2, "0")}.txt`), "sample")
    }

    const firstLaunch = await launch(dbPath)
    const { window } = firstLaunch
    await expect(window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    expect(await window.evaluate(() => "henshinPrototype" in window)).toBe(false)
    await window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await window.getByTestId("root-preview-submit").click()
    await expect(window.getByTestId("root-preview-selected-path")).toHaveText(fixtureDirectory)
    await expect(window.getByTestId("root-preview-outcome")).toHaveText(
      "Showing the first 32 items. More are available."
    )
    await expect(window.getByTestId("root-preview-children").locator("li")).toHaveCount(32)
    await expect(window.getByTestId("root-preview-children").locator("li").first()).toContainText(/child-\d+\.txt/)
    await window.getByTestId("root-label").fill("Books")
    await expect(window.getByTestId("root-save")).toBeEnabled()

    // Editing a new proposal does not relabel the displayed result from the
    // last submitted path.
    await window.getByTestId("root-preview-path").fill(path.join(dbDirectory, "not-submitted"))
    await expect(window.getByTestId("root-save")).toBeDisabled()
    await expect(window.getByTestId("root-preview-selected-path")).toHaveText(fixtureDirectory)
    await expect(window.getByTestId("root-preview-children").locator("li")).toHaveCount(32)

    await rm(fixtureDirectory, { recursive: true, force: true })
    await window.getByTestId("root-preview-path").fill(missingDirectory)
    await window.getByTestId("root-preview-submit").click()
    await expect(window.getByTestId("root-preview-outcome")).toContainText("Preview failed")

    await mkdir(missingDirectory, { recursive: true })
    await window.getByTestId("root-preview-retry").click()
    await expect(window.getByTestId("root-preview-outcome")).toHaveText("The directory is empty.")

    const savedFixture = path.join(fixtureDirectory, "saved-collection")
    await mkdir(savedFixture)
    await window.getByTestId("root-preview-path").fill(savedFixture)
    await window.getByTestId("root-preview-submit").click()
    await expect(window.getByTestId("root-preview-selected-path")).toHaveText(savedFixture)
    await expect(window.getByTestId("root-save")).toBeEnabled()

    // A new directory at the same path has a different native identity. The
    // stale preview must fail without creating an active root.
    await rm(savedFixture, { recursive: true, force: true })
    await mkdir(savedFixture)
    await window.getByTestId("root-save").click()
    await expect(window.getByTestId("root-preview-outcome")).toContainText("Save failed")
    await expect(window.getByTestId("root-saved-roots").locator("li")).toHaveCount(0)

    await window.getByTestId("root-preview-submit").click()
    await expect(window.getByTestId("root-preview-outcome")).toHaveText("The directory is empty.")
    await window.getByTestId("root-save").click()
    await expect(window.getByTestId("root-preview-outcome")).toHaveText(`Server root saved: Books (${savedFixture}).`)
    await expect(window.getByTestId("root-saved")).toContainText("Books")
    await expect(window.getByTestId("root-saved")).toContainText(savedFixture)

    await firstLaunch.app.close()
    const restarted = await launch(dbPath)
    await expect(restarted.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await expect(restarted.window.getByTestId("root-saved")).toContainText("Books")
    await expect(restarted.window.getByTestId("root-saved")).toContainText(savedFixture)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})

test("previews book candidates for an existing saved root after restart", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-root-discovery-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-root-discovery-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")

  try {
    const book = path.join(fixtureDirectory, "book")
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "sample")
    await writeFile(path.join(fixtureDirectory, "loose.jpg"), "sample")

    const first = await launch(dbPath)
    await expect(first.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await first.window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await first.window.getByTestId("root-preview-submit").click()
    await first.window.getByTestId("root-label").fill("Books")
    await first.window.getByTestId("root-save").click()
    await expect(first.window.getByTestId("root-saved")).toContainText("Books")

    await first.app.close()
    const restarted = await launch(dbPath)
    await expect(restarted.window.getByTestId("root-saved")).toContainText("Books")
    await restarted.window.getByTestId("root-saved-preview").click()
    await expect(restarted.window.getByTestId("root-preview-candidates").locator("li")).toHaveCount(1)
    await expect(restarted.window.getByTestId("root-preview-candidates").locator("li").first()).toContainText("book")
    await expect(restarted.window.getByTestId("root-preview-coverage")).toContainText("1 unassigned loose images")
    await expect(restarted.window.getByTestId("root-save")).toHaveCount(0)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})
