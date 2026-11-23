import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test"
import electronPath from "electron"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const APP_DIR = fileURLToPath(new URL("..", import.meta.url))
const launched: ElectronApplication[] = []
const execFileAsync = promisify(execFile)
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
)

const bundledServerPid = async (app: ElectronApplication): Promise<number | null> => {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="])
  const parentPid = app.process().pid
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (match !== null && Number(match[2]) === parentPid && match[3].includes("dist/server/server.mjs")) {
      return Number(match[1])
    }
  }
  return null
}

const stableImageSrc = async (image: Locator): Promise<string> => {
  let previous: string | null = null
  let stableReads = 0
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await image.getAttribute("src")
    if (current !== null && current === previous) stableReads += 1
    else stableReads = 0
    if (stableReads >= 2 && current !== null) return current
    previous = current
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("cover URL did not settle")
}

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

    const { app, window } = await launch(dbPath)
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

    await decodedEntry.getByRole("button", { name: /Open details/ }).click()
    const details = window.getByTestId("library-details")
    await expect(details.getByTestId("entry-binding")).toHaveText("Unbound")
    await expect(details.getByTestId("entry-metadata-pending")).toContainText("Metadata pending")
    await details.getByTestId("entry-binding-url").fill("http://e-hentai.org/g/54321/NoNetwork_1/?ignored=true")
    await details.getByTestId("entry-bind").click()
    await expect(details.getByTestId("entry-binding")).toContainText("EH / 54321")
    await expect(details.getByTestId("entry-binding")).toContainText("https://e-hentai.org/g/54321/NoNetwork_1/")

    await app.close()
    const reopened = await launch(dbPath)
    await expect(reopened.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await reopened.window.getByTestId("open-library").click()
    const reopenedEntry = reopened.window.getByTestId("library-entry").filter({ hasText: "decoded-book" })
    await expect(reopenedEntry).toBeVisible()
    await reopenedEntry.getByRole("button", { name: /Open details/ }).click()
    const reopenedDetails = reopened.window.getByTestId("library-details")
    await expect(reopenedDetails.getByTestId("entry-binding")).toContainText("https://e-hentai.org/g/54321/NoNetwork_1/")
    await expect(reopenedDetails.getByTestId("entry-metadata-pending")).toContainText("Metadata pending")

    await reopened.window.getByTestId("library-refresh").click()
    await expect(reopenedEntry.getByTestId("library-cover-image")).toBeVisible({ timeout: 30_000 })
    await expect(reopened.window.getByTestId("library-entry").filter({ hasText: "unavailable-book" }).getByTestId("library-cover-placeholder")).toContainText("Cover unavailable")

    const displayedSrc = await stableImageSrc(reopenedEntry.getByTestId("library-cover-image"))
    const serverPid = await bundledServerPid(reopened.app)
    if (serverPid === null) throw new Error("bundled server process was not found")
    process.kill(serverPid, "SIGTERM")
    await expect.poll(() => bundledServerPid(reopened.app), { timeout: 5_000 }).toBeNull()
    await reopened.window.getByTestId("library-refresh").click()
    await expect(reopened.window.getByRole("alert")).toContainText("Could not load library")
    await expect(reopenedEntry.getByTestId("library-cover-image")).toBeVisible()
    await expect(reopenedEntry.getByTestId("library-cover-image")).toHaveAttribute("src", displayedSrc ?? "")
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

test("searches the real Library screen and shows field match evidence", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-search-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-search-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")

  try {
    for (const name of ["book-alpha", "book-beta", "other-title"]) {
      const book = path.join(fixtureDirectory, name)
      await mkdir(book)
      await writeFile(path.join(book, "001.png"), validPng)
    }

    const { window } = await launch(dbPath)
    await expect(window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await window.getByTestId("root-preview-submit").click()
    await window.getByTestId("root-label").fill("Search cases")
    await window.getByTestId("root-save").click()
    await window.getByTestId("root-saved-preview").click()
    await window.getByTestId("scan-hold-new-discoveries").uncheck()
    await window.getByTestId("start-held-scan").click()

    await expect(window.getByTestId("library-entries").locator("li")).toHaveCount(3, { timeout: 30_000 })
    await window.getByTestId("library-search").fill("book-beta")
    await window.getByTestId("library-search-submit").click()
    await expect(window.getByTestId("library-entries").locator("li")).toHaveCount(1)
    await expect(window.getByTestId("library-entry")).toContainText("book-beta")
    await expect(window.getByTestId("library-match-evidence")).toContainText("Matched in book name and filename")

    await window.getByTestId("library-search").fill("book-does-not-exist")
    await window.getByTestId("library-search-submit").click()
    await expect(window.getByTestId("library-no-matches")).toContainText("No books match")
    await expect(window.getByTestId("library-empty")).toHaveCount(0)
    await window.getByTestId("library-clear-search").click()
    await expect(window.getByTestId("library-entries").locator("li")).toHaveCount(3)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})
