import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import electronPath from "electron"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP_DIR = fileURLToPath(new URL("..", import.meta.url))
const launched: ElectronApplication[] = []
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
)

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

test("renders a decoded server cover and keeps an unavailable neighbor usable", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-covers-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-covers-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")

  try {
    const decoded = path.join(fixtureDirectory, "decoded-book")
    const unavailable = path.join(fixtureDirectory, "unavailable-book")
    await mkdir(decoded)
    await mkdir(unavailable)
    await writeFile(path.join(decoded, "001.png"), validPng)
    await writeFile(path.join(unavailable, "001.png"), Buffer.from("not an image"))

    const { window } = await launch(dbPath)
    await expect(window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await window.getByTestId("root-preview-submit").click()
    await window.getByTestId("root-label").fill("Cover cases")
    await window.getByTestId("root-save").click()
    await expect(window.getByTestId("root-saved")).toContainText("Cover cases")
    await window.getByTestId("root-saved-preview").click()
    await window.getByTestId("scan-hold-new-discoveries").uncheck()
    await window.getByTestId("start-held-scan").click()

    await expect(window.getByTestId("library-entries").locator("li")).toHaveCount(2, { timeout: 30_000 })
    const decodedEntry = window.getByTestId("library-entry").filter({ hasText: "decoded-book" })
    const unavailableEntry = window.getByTestId("library-entry").filter({ hasText: "unavailable-book" })
    await expect(decodedEntry.getByTestId("library-cover-image")).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => decodedEntry.getByTestId("library-cover-image").evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    await expect(decodedEntry.getByTestId("library-cover-image")).toHaveAttribute("alt", "")
    await expect(unavailableEntry.getByTestId("library-cover-placeholder")).toContainText("Cover unavailable")
    await expect(unavailableEntry.getByTestId("library-cover-placeholder")).toHaveAttribute("aria-hidden", "true")
    await expect(unavailableEntry).toContainText("unavailable-book")

    await window.getByTestId("library-refresh").click()
    await expect(decodedEntry.getByTestId("library-cover-image")).toBeVisible({ timeout: 30_000 })
    await expect(unavailableEntry.getByTestId("library-cover-placeholder")).toContainText("Cover unavailable")
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})

test("loads covers in the viewport and releases them after scrolling away", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-viewport-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-viewport-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")

  try {
    for (let index = 1; index <= 12; index += 1) {
      const book = path.join(fixtureDirectory, `book-${index}`)
      await mkdir(book)
      await writeFile(path.join(book, "001.png"), validPng)
    }

    const { window } = await launch(dbPath)
    await expect(window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await window.getByTestId("root-preview-submit").click()
    await window.getByTestId("root-label").fill("Viewport cases")
    await window.getByTestId("root-save").click()
    await window.getByTestId("root-saved-preview").click()
    await window.getByTestId("scan-hold-new-discoveries").uncheck()
    await window.getByTestId("start-held-scan").click()

    await expect(window.getByTestId("library-entries").locator("li")).toHaveCount(12, { timeout: 30_000 })
    const firstEntry = window.getByTestId("library-entry").first()
    const lastEntry = window.getByTestId("library-entry").last()
    await expect(firstEntry.getByTestId("library-cover-image")).toBeVisible({ timeout: 30_000 })
    await expect(lastEntry.getByTestId("library-cover-placeholder")).toHaveAttribute("data-cover-state", "loading")

    await lastEntry.scrollIntoViewIfNeeded()
    await expect(lastEntry.getByTestId("library-cover-image")).toBeVisible({ timeout: 30_000 })
    await expect(firstEntry.getByTestId("library-cover-placeholder")).toHaveAttribute("data-cover-state", "loading")
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})
