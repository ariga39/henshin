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

test("previews a real managed-server directory, bounds samples, and retries an unavailable path", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-root-preview-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-root-preview-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")
  const missingDirectory = path.join(fixtureDirectory, "appears-later")

  try {
    for (let index = 0; index < 40; index += 1) {
      await writeFile(path.join(fixtureDirectory, `child-${index.toString().padStart(2, "0")}.txt`), "sample")
    }

    const { window } = await launch(dbPath)
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

    // Editing a new proposal does not relabel the displayed result from the
    // last submitted path.
    await window.getByTestId("root-preview-path").fill(path.join(dbDirectory, "not-submitted"))
    await expect(window.getByTestId("root-preview-selected-path")).toHaveText(fixtureDirectory)
    await expect(window.getByTestId("root-preview-children").locator("li")).toHaveCount(32)

    await rm(fixtureDirectory, { recursive: true, force: true })
    await window.getByTestId("root-preview-path").fill(missingDirectory)
    await window.getByTestId("root-preview-submit").click()
    await expect(window.getByTestId("root-preview-outcome")).toContainText("Preview failed")

    await mkdir(missingDirectory, { recursive: true })
    await window.getByTestId("root-preview-retry").click()
    await expect(window.getByTestId("root-preview-outcome")).toHaveText("The directory is empty.")
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})
