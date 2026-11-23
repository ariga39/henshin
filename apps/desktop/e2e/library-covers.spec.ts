import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test"
import electronPath from "electron"
import { execFile } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"

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

    await window.getByTestId("library-refresh").click()
    await expect(decodedEntry.getByTestId("library-cover-image")).toBeVisible({ timeout: 30_000 })
    await expect(unavailableEntry.getByTestId("library-cover-placeholder")).toContainText("Cover unavailable")

    const displayedSrc = await stableImageSrc(decodedEntry.getByTestId("library-cover-image"))
    const serverPid = await bundledServerPid(app)
    if (serverPid === null) throw new Error("bundled server process was not found")
    process.kill(serverPid, "SIGTERM")
    await expect.poll(() => bundledServerPid(app), { timeout: 5_000 }).toBeNull()
    await window.getByTestId("library-refresh").click()
    await expect(window.getByRole("alert")).toContainText("Could not load library")
    await expect(decodedEntry.getByTestId("library-cover-image")).toBeVisible()
    await expect(decodedEntry.getByTestId("library-cover-image")).toHaveAttribute("src", displayedSrc ?? "")
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

test("filters effective tags with the canonical picker after reopening the real Library", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-tags-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-tags-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")

  try {
    for (const name of ["alpha-one", "alpha-two", "alpha-three", "beta"]) {
      const book = path.join(fixtureDirectory, name)
      await mkdir(book)
      await writeFile(path.join(book, "001.png"), validPng)
    }

    const first = await launch(dbPath)
    await expect(first.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await first.window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await first.window.getByTestId("root-preview-submit").click()
    await first.window.getByTestId("root-label").fill("Tag cases")
    await first.window.getByTestId("root-save").click()
    await first.window.getByTestId("root-saved-preview").click()
    await first.window.getByTestId("scan-hold-new-discoveries").uncheck()
    await first.window.getByTestId("start-held-scan").click()
    await expect(first.window.getByTestId("library-entries").locator("li")).toHaveCount(4, { timeout: 30_000 })

    const serverPid = await bundledServerPid(first.app)
    if (serverPid === null) throw new Error("bundled server process was not found")
    process.kill(serverPid, "SIGTERM")
    await expect.poll(() => bundledServerPid(first.app), { timeout: 5_000 }).toBeNull()
    const db = new DatabaseSync(dbPath)
    const entries = db.prepare("SELECT entry_id, relative_path FROM library_entries WHERE state = 'accepted'").all() as unknown as ReadonlyArray<{ entry_id: string; relative_path: string }>
    const tagsByPath: Record<string, ReadonlyArray<string>> = {
      "alpha-one": ["artist:alpha", "genre:comic"],
      "alpha-two": ["artist:alpha", "genre:comic"],
      "alpha-three": ["artist:alpha", "genre:other", "group:alpha"],
      beta: ["artist:beta"]
    }
    const insertGallery = db.prepare(
      "INSERT INTO galleries(gallery_id, source, gid, token, preferred_domain, metadata_tags_json, created_at_ms, updated_at_ms) VALUES(?, 'EH', ?, 'token', 'e-hentai.org', ?, 0, 0)"
    )
    const insertBinding = db.prepare(
      "INSERT INTO bindings(entry_id, gallery_id, preferred_domain, bound_at_ms) VALUES(?, ?, 'e-hentai.org', 0)"
    )
    for (const [index, entry] of entries.entries()) {
      const galleryId = randomUUID()
      insertGallery.run(galleryId, String(index + 1), JSON.stringify(tagsByPath[entry.relative_path] ?? []))
      insertBinding.run(entry.entry_id, galleryId)
    }
    db.prepare("UPDATE server_library SET change_revision = change_revision + 1 WHERE id = 1").run()
    db.close()
    await first.app.close()

    const reopened = await launch(dbPath)
    await expect(reopened.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await expect(reopened.window.getByTestId("root-saved")).toContainText("Tag cases", { timeout: 30_000 })
    await reopened.window.getByRole("button", { name: "Library" }).click()
    await expect(reopened.window.getByTestId("library-entries").locator("li")).toHaveCount(4, { timeout: 30_000 })

    const picker = reopened.window.getByTestId("library-tag-picker")
    await expect(picker.locator("option")).toContainText(["artist:alpha", "group:alpha"])
    await picker.selectOption("artist:alpha")
    await reopened.window.getByTestId("library-include-tag").click()
    await expect(reopened.window.getByTestId("library-entries").locator("li")).toHaveCount(3)
    await expect(reopened.window.getByTestId("library-include-chip")).toContainText("artist:alpha")

    await picker.selectOption("genre:comic")
    await reopened.window.getByTestId("library-exclude-tag").click()
    await expect(reopened.window.getByTestId("library-entries").locator("li")).toHaveCount(1)
    await expect(reopened.window.getByTestId("library-entry")).toContainText("alpha-three")

    await reopened.window.getByTestId("library-clear-filters").click()
    await expect(reopened.window.getByTestId("library-entries").locator("li")).toHaveCount(4)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})
