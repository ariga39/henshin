import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import electronPath from "electron"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP_DIR = fileURLToPath(new URL("..", import.meta.url))
const launched: ElectronApplication[] = []

const launch = async (dbPath: string, environment: Record<string, string> = {}): Promise<{ app: ElectronApplication; window: Page }> => {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: ["."],
    cwd: APP_DIR,
    env: {
      ...process.env,
      HENSHIN_PROTOTYPE_DB: dbPath,
      HENSHIN_PROTOTYPE_CLIENT_DB: `${dbPath}.client`,
      ...environment
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
    await expect(window.getByTestId("root-save")).toBeDisabled()
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
    const siblingBook = path.join(fixtureDirectory, "book-sibling")
    await mkdir(book)
    await mkdir(siblingBook)
    await writeFile(path.join(book, "001.jpg"), "sample")
    await writeFile(path.join(siblingBook, "001.jpg"), "sample")
    await writeFile(path.join(fixtureDirectory, "book.cbz"), "sample")
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
    await expect(restarted.window.getByTestId("root-preview-candidates").locator("li")).toHaveCount(3)
    const archiveCandidate = restarted.window.getByTestId("root-preview-candidates").locator("li").filter({ hasText: "book.cbz" })
    await archiveCandidate.getByRole("button", { name: "Exclude file" }).click()
    await expect(restarted.window.getByTestId("root-preview-candidates")).not.toContainText("book.cbz")
    const subtreeCandidate = restarted.window.getByTestId("root-preview-candidates").locator("li").filter({ hasText: "book" }).filter({ hasNotText: "book-sibling" })
    await subtreeCandidate.getByRole("button", { name: "Exclude subtree" }).click()
    await expect(restarted.window.getByTestId("root-preview-candidates").locator("li")).toHaveCount(1)
    await expect(restarted.window.getByTestId("root-preview-candidates").locator("li").first()).toContainText("book-sibling")
    await expect(restarted.window.getByTestId("root-saved-policy")).toContainText("book.cbz (exact)")
    await expect(restarted.window.getByTestId("root-saved-policy")).toContainText("book (subtree)")
    await restarted.window.getByTestId("root-saved-policy").getByRole("button", { name: "Remove exclusion" }).first().click()
    await expect(restarted.window.getByTestId("root-preview-candidates").locator("li")).toHaveCount(2)
    await expect(restarted.window.getByTestId("root-preview-candidates")).toContainText("book.cbz")
    await expect(restarted.window.getByTestId("root-saved-policy")).not.toContainText("book.cbz (exact)")
    await expect(restarted.window.getByTestId("root-preview-coverage")).toContainText("1 unassigned loose images")
    await expect(restarted.window.getByTestId("root-save")).toHaveCount(0)

    await restarted.app.close()
    const reopened = await launch(dbPath)
    await expect(reopened.window.getByTestId("root-saved-policy")).not.toContainText("book.cbz (exact)")
    await expect(reopened.window.getByTestId("root-saved-policy")).toContainText("book (subtree)")
    const database = new DatabaseSync(dbPath)
    try {
      const root = database.prepare("SELECT root_id, policy_revision FROM server_roots WHERE label = ?").get("Books") as
        | { root_id: string; policy_revision: number }
        | undefined
      if (root === undefined) throw new Error("saved root missing")
      database.prepare("UPDATE server_roots SET policy_revision = ?, exclusions = ? WHERE root_id = ?").run(
        root.policy_revision + 1,
        "[]",
        root.root_id
      )
    } finally {
      database.close()
    }
    await reopened.window.getByTestId("root-saved-policy").getByRole("button", { name: "Remove exclusion" }).click()
    await expect(reopened.window.getByTestId("root-saved-policy")).toContainText("book (subtree)")
    await expect(reopened.window.getByTestId("root-policy-refresh")).toBeVisible()
    await reopened.window.getByTestId("root-policy-refresh").click()
    await expect(reopened.window.getByTestId("root-saved-policy")).toContainText("No exclusions")
    await expect(reopened.window.getByTestId("root-policy-refresh")).toHaveCount(0)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})

test("runs a held manual scan, reports a disappeared release, and releases another discovery", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-held-scan-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-held-scan-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")

  try {
    const healthy = path.join(fixtureDirectory, "healthy-book")
    const excluded = path.join(fixtureDirectory, "excluded-sibling")
    await mkdir(healthy)
    await mkdir(excluded)
    await writeFile(path.join(healthy, "001.jpg"), "sample")
    await writeFile(path.join(excluded, "001.jpg"), "excluded")
    await writeFile(path.join(fixtureDirectory, "broken.cbz"), "not a zip archive")

    const first = await launch(dbPath)
    await expect(first.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await first.window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await first.window.getByTestId("root-preview-submit").click()
    await first.window.getByTestId("root-label").fill("Held books")
    await first.window.getByTestId("root-save").click()
    await expect(first.window.getByTestId("root-saved")).toContainText("Held books")

    await first.window.getByTestId("root-saved-preview").click()
    await expect(first.window.getByTestId("root-preview-candidates").locator("li")).toHaveCount(3)
    const excludedCandidate = first.window
      .getByTestId("root-preview-candidates")
      .locator("li")
      .filter({ hasText: "excluded-sibling" })
    await excludedCandidate.getByRole("button", { name: "Exclude subtree" }).click()
    await expect(first.window.getByTestId("root-preview-candidates").locator("li")).toHaveCount(2)

    await expect(first.window.getByTestId("scan-hold-new-discoveries")).not.toBeChecked()
    await expect(first.window.getByTestId("start-held-scan")).toBeEnabled()
    await first.window.getByTestId("scan-hold-new-discoveries").check()
    await expect(first.window.getByTestId("start-held-scan")).toBeEnabled()
    await expect(first.window.getByTestId("held-scan-root")).toContainText("Held books")
    await expect(first.window.getByTestId("held-scan-root")).toContainText(fixtureDirectory)
    await first.window.getByTestId("start-held-scan").click()
    await expect(first.window.getByTestId("scan-task-status")).toHaveText("Status: completed with errors", { timeout: 30_000 })
    await expect(first.window.getByTestId("scan-task-error")).toContainText("could not be analyzed")
    await expect(first.window.getByTestId("staged-discoveries").locator("li")).toHaveCount(2)
    await expect(first.window.getByTestId("staged-discoveries")).toContainText("healthy-book")
    await expect(first.window.getByTestId("staged-discoveries")).toContainText("broken.cbz")
    await expect(first.window.getByTestId("staged-discoveries")).not.toContainText("excluded-sibling")
    await expect(first.window.getByTestId("staged-discoveries")).toContainText("hold: held")

    await first.app.close()
    const reopened = await launch(dbPath)
    await expect(reopened.window.getByTestId("held-scan-review")).toBeVisible()
    await expect(reopened.window.getByTestId("scan-task-summary")).toContainText("completed with errors")
    await expect(reopened.window.getByTestId("scan-task-summary")).toContainText("Held books")
    await expect(reopened.window.getByTestId("scan-task-summary")).toContainText(fixtureDirectory)
    await expect(reopened.window.getByTestId("staged-discoveries").locator("li")).toHaveCount(2)
    await expect(reopened.window.getByTestId("staged-discoveries")).toContainText("healthy-book")
    await expect(reopened.window.getByTestId("staged-discoveries")).toContainText("broken.cbz")
    await expect(reopened.window.getByTestId("staged-discoveries")).toContainText("hold: held")
    await expect(reopened.window.getByTestId("staged-discovery-root").first()).toContainText(fixtureDirectory)

    const database = new DatabaseSync(dbPath)
    try {
      database.prepare("DELETE FROM staged_discoveries WHERE relative_path = ?").run("healthy-book")
    } finally {
      database.close()
    }
    await reopened.window
      .getByTestId("staged-discoveries")
      .locator("li")
      .filter({ hasText: "healthy-book" })
      .getByRole("button", { name: "Release hold" })
      .click()
    await expect(reopened.window.getByTestId("staged-discoveries")).not.toContainText("healthy-book")
    await expect(reopened.window.getByTestId("scan-release-error")).toContainText(
      "staged discovery not found; refresh Review"
    )
    await expect(reopened.window.getByTestId("staged-discoveries")).toContainText("broken.cbz")
    await expect(reopened.window.getByTestId("staged-discoveries")).toContainText("hold: held")

    await reopened.window
      .getByTestId("staged-discoveries")
      .locator("li")
      .filter({ hasText: "broken.cbz" })
      .getByRole("button", { name: "Release hold" })
      .click()
    await expect(reopened.window.getByTestId("staged-discoveries")).toContainText("hold: eligible")
    await expect(reopened.window.getByTestId("scan-release-error")).toHaveCount(0)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})

test("runs normal scans from the saved-root preview and refreshes accepted books after completion", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-normal-scan-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-normal-scan-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")

  try {
    for (const name of ["existing-a", "existing-b", "existing-c", "excluded-book"]) {
      const directory = path.join(fixtureDirectory, name)
      await mkdir(directory)
      await writeFile(path.join(directory, "001.jpg"), name)
    }

    const first = await launch(dbPath)
    await expect(first.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await first.window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await first.window.getByTestId("root-preview-submit").click()
    await first.window.getByTestId("root-label").fill("Normal books")
    await first.window.getByTestId("root-save").click()
    await expect(first.window.getByTestId("root-saved")).toContainText("Normal books")

    await first.window.getByTestId("root-saved-preview").click()
    await expect(first.window.getByTestId("root-preview-candidates").locator("li")).toHaveCount(4)
    const excludedCandidate = first.window
      .getByTestId("root-preview-candidates")
      .locator("li")
      .filter({ hasText: "excluded-book" })
    await excludedCandidate.getByRole("button", { name: "Exclude subtree" }).click()
    await expect(first.window.getByTestId("root-preview-candidates").locator("li")).toHaveCount(3)

    await first.window.getByTestId("scan-hold-new-discoveries").check()
    await first.window.getByTestId("start-held-scan").click()
    await expect(first.window.getByTestId("scan-task-status")).toHaveText("Status: succeeded", { timeout: 30_000 })
    await expect(first.window.getByTestId("staged-discoveries").locator("li")).toHaveCount(3)
    await expect(first.window.getByTestId("library-screen")).toHaveCount(0)

    for (const name of ["new-book-a", "new-book-b"]) {
      const directory = path.join(fixtureDirectory, name)
      await mkdir(directory)
      await writeFile(path.join(directory, "001.jpg"), name)
    }

    await first.window.getByTestId("scan-hold-new-discoveries").uncheck()
    await first.window.getByTestId("start-held-scan").click()
    await expect(first.window.getByTestId("library-screen")).toBeVisible()
    await expect(first.window.getByTestId("library-scan-status")).toHaveText("Scan task succeeded.", { timeout: 30_000 })
    await expect(first.window.getByTestId("library-entries").locator("li")).toHaveCount(2, { timeout: 30_000 })
    await expect(first.window.getByTestId("library-entries")).toContainText("new-book-a")
    await expect(first.window.getByTestId("library-entries")).toContainText("new-book-b")
    const firstIds = (await first.window.getByTestId("library-entry").locator("small").allTextContents()).sort()
    expect(firstIds).toHaveLength(2)

    await first.window.getByTestId("library-setup").click()
    await first.window.getByTestId("root-saved-preview").click()
    await expect(first.window.getByTestId("scan-hold-new-discoveries")).not.toBeChecked()
    await first.window.getByTestId("start-held-scan").click()
    await expect(first.window.getByTestId("library-scan-status")).toHaveText("Scan task succeeded.", { timeout: 30_000 })
    await expect(first.window.getByTestId("library-entries").locator("li")).toHaveCount(2, { timeout: 30_000 })
    const repeatedIds = (await first.window.getByTestId("library-entry").locator("small").allTextContents()).sort()
    expect(repeatedIds).toEqual(firstIds)

    await first.app.close()
    const reopened = await launch(dbPath)
    await reopened.window.getByTestId("open-library").click()
    await expect(reopened.window.getByTestId("library-entries").locator("li")).toHaveCount(2, { timeout: 30_000 })
    const restartedIds = (await reopened.window.getByTestId("library-entry").locator("small").allTextContents()).sort()
    expect(restartedIds).toEqual(firstIds)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})

test("preserves accepted entries across an interrupted normal scan and explicitly retries restored coverage", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-interrupted-scan-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-interrupted-scan-fixture-"))
  const disconnectedDirectory = `${fixtureDirectory}-disconnected`
  const dbPath = path.join(dbDirectory, "prototype.db")

  try {
    const stableBook = path.join(fixtureDirectory, "stable-book")
    await mkdir(stableBook)
    await writeFile(path.join(stableBook, "001.jpg"), "stable")

    const scanEnvironment = { HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS: "1000" }
    const first = await launch(dbPath, scanEnvironment)
    await first.window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await first.window.getByTestId("root-preview-submit").click()
    await first.window.getByTestId("root-label").fill("Interrupted books")
    await first.window.getByTestId("root-save").click()
    await expect(first.window.getByTestId("root-saved")).toContainText("Interrupted books")
    await first.window.getByTestId("root-saved-preview").click()
    await first.window.getByTestId("start-held-scan").click()
    await expect(first.window.getByTestId("library-scan-status")).toHaveText("Scan task succeeded.", { timeout: 30_000 })
    await expect(first.window.getByTestId("library-entries").locator("li")).toHaveCount(1)
    const stableEntryId = await first.window.getByTestId("library-entry").locator("small").textContent()
    if (stableEntryId === null) throw new Error("stable entry identity was not rendered")

    await first.window.getByTestId("library-setup").click()
    for (const name of ["new-book-a", "new-book-b"]) {
      const book = path.join(fixtureDirectory, name)
      await mkdir(book)
      await writeFile(path.join(book, "001.jpg"), name)
    }
    await first.window.getByTestId("root-saved-preview").click()
    await first.window.getByTestId("start-held-scan").click()
    const database = new DatabaseSync(dbPath)
    try {
      await expect.poll(() => {
        const row = database.prepare("SELECT COUNT(*) AS count FROM staged_discoveries WHERE analysis_status = 'ready'").get() as { count: number }
        return row.count
      }, { timeout: 30_000 }).toBeGreaterThan(0)
    } finally {
      database.close()
    }
    await rename(fixtureDirectory, disconnectedDirectory)
    await expect(first.window.getByTestId("library-scan-status")).toHaveText("Scan task failed.", { timeout: 120_000 })
    await rename(disconnectedDirectory, fixtureDirectory)

    await first.app.close()
    const reopened = await launch(dbPath, scanEnvironment)
    await expect(reopened.window.getByTestId("scan-task-coverage").filter({ hasText: "coverage: partial" })).toHaveCount(1)
    await expect(reopened.window.getByTestId("staged-discoveries")).toContainText("new-book-a")
    await expect(reopened.window.getByTestId("staged-discoveries")).toContainText("new-book-b")
    await reopened.window.getByTestId("open-library").click()
    await expect(reopened.window.getByTestId("library-entry").locator("small")).toContainText(stableEntryId)

    await reopened.window.getByTestId("library-setup").click()
    await reopened.window.getByTestId("root-saved-preview").click()
    await reopened.window.getByTestId("start-held-scan").click()
    await expect(reopened.window.getByTestId("library-scan-status")).toHaveText("Scan task succeeded.", { timeout: 120_000 })
    await expect(reopened.window.getByTestId("library-entries")).toContainText("stable-book")
    await expect(reopened.window.getByTestId("library-entries")).toContainText("new-book-a")
    await expect(reopened.window.getByTestId("library-entries")).toContainText("new-book-b")
    await expect(reopened.window.getByTestId("library-entry").filter({ hasText: "stable-book" }).locator("small")).toHaveText(stableEntryId)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
    await rm(disconnectedDirectory, { recursive: true, force: true })
  }
})

test("pages the Library and reviews an off-page replacement after a held scan", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-pages-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-pages-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")

  try {
    for (let index = 0; index < 51; index += 1) {
      const directory = path.join(fixtureDirectory, `book-${index.toString().padStart(2, "0")}`)
      await mkdir(directory)
      await writeFile(path.join(directory, "001.jpg"), `book-${index}`)
    }

    const first = await launch(dbPath)
    await first.window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await first.window.getByTestId("root-preview-submit").click()
    await first.window.getByTestId("root-label").fill("Paged books")
    await first.window.getByTestId("root-save").click()
    await expect(first.window.getByTestId("root-saved")).toContainText("Paged books")
    await first.window.getByTestId("root-saved-preview").click()
    await first.window.getByTestId("start-held-scan").click()

    await expect(first.window.getByTestId("library-screen")).toBeVisible()
    await expect(first.window.getByTestId("library-scan-status")).toHaveText("Scan task succeeded.", { timeout: 30_000 })
    await expect(first.window.getByTestId("library-entries").locator("li")).toHaveCount(50, { timeout: 30_000 })
    await expect(first.window.getByTestId("library-load-more")).toBeVisible()
    await first.window.getByTestId("library-load-more").click()
    await expect(first.window.getByTestId("library-entries").locator("li")).toHaveCount(51, { timeout: 30_000 })

    const lastBook = first.window.getByTestId("library-entry").last()
    const lastTitle = await lastBook.locator(".library-entry-details > strong").innerText()
    const lastId = await lastBook.locator("small").innerText()
    await first.window.getByTestId("library-refresh").click()
    await expect(first.window.getByTestId("library-entry")).toHaveCount(50)
    await expect(first.window.getByText(lastId, { exact: true })).toHaveCount(0)

    await first.window.getByTestId("library-setup").click()
    await writeFile(path.join(fixtureDirectory, lastTitle, "002.jpg"), "Replacement second page")
    await first.window.getByTestId("root-saved-preview").click()
    await first.window.getByTestId("scan-hold-new-discoveries").check()
    await first.window.getByTestId("start-held-scan").click()
    const pending = first.window.getByTestId(`replacement-${lastId}`)
    await expect(pending.getByTestId("replacement-candidate-path")).toHaveText(lastTitle, { timeout: 30_000 })
    await expect(pending.getByTestId("replacement-candidate-pages")).toHaveText("2")
    await pending.getByTestId(`replacement-keep-${lastId}`).click()
    await expect(pending).toHaveCount(0)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})

test("inspects and recovers retained handoff outcomes from the ordinary desktop screen across restart", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-open-journal-ui-db-"))
  const dbPath = path.join(dbDirectory, "prototype.db")
  const clientDbPath = `${dbPath}.client`
  const unknownActionId = randomUUID()
  const heldActionId = randomUUID()
  const protectedActionId = randomUUID()
  const entryId = randomUUID()
  const deviceId = randomUUID()

  try {
    const first = await launch(dbPath)
    await expect(first.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await expect(first.window.getByTestId("reader-settings")).toBeVisible()
    await first.app.close()
    launched.splice(launched.indexOf(first.app), 1)

    const serverDatabase = new DatabaseSync(dbPath)
    const instanceId = (serverDatabase.prepare("SELECT instance_id FROM server_state WHERE id = 1").get() as { instance_id: string }).instance_id
    serverDatabase.close()

    const clientDatabase = new DatabaseSync(clientDbPath)
    const now = Date.now()
    const heldEvent = JSON.stringify({
      event_id: heldActionId,
      instance_id: instanceId,
      entry_id: entryId,
      device_id: deviceId,
      observed_location_revision: "3",
      observed_content_version: "5",
      occurred_at_ms: now
    })
    clientDatabase.prepare(`
      INSERT INTO launch_journal(
        instance_id, action_id, entry_id, device_id, observed_location_revision,
        observed_content_version, status, event_json, delivery_status,
        delivery_error_code, delivery_error_message, failure_code, failure_message,
        created_at_ms, updated_at_ms
      ) VALUES(?, ?, ?, ?, 3, 5, 'prepared', NULL, 'pending', NULL, NULL, NULL, NULL, ?, ?),
               (?, ?, ?, ?, 3, 5, 'accepted', ?, 'held', 'offline', 'server unavailable', NULL, NULL, ?, ?),
               (?, ?, ?, ?, 3, 5, 'failed', NULL, 'pending', NULL, NULL, 'reader_failed', 'reader rejected the target', ?, ?)
    `).run(
      instanceId, unknownActionId, randomUUID(), deviceId, now, now,
      instanceId, heldActionId, entryId, deviceId, heldEvent, now, now,
      instanceId, protectedActionId, randomUUID(), deviceId, now, now
    )
    clientDatabase.close()

    const second = await launch(dbPath)
    await second.window.getByTestId("load-open-journal").click()
    await expect(second.window.getByTestId(`dismiss-unknown-${unknownActionId}`)).toBeVisible()
    await expect(second.window.getByTestId(`open-event-${heldActionId}`)).toContainText("pending reading count can be lost")
    await expect(second.window.evaluate(({ actionId, instanceId }) =>
      window.henshinOpenJournal.recover({
        instance_id: instanceId,
        action_id: actionId,
        command: "dismiss_unknown"
      }), { actionId: unknownActionId, instanceId })).resolves.toEqual({ ok: true, data: null })
    await second.window.getByTestId(`dismiss-unknown-${unknownActionId}`).click()
    await expect(second.window.getByTestId("open-journal-error")).toContainText("no longer retained")
    await second.window.getByTestId("load-open-journal").click()
    await expect(second.window.getByTestId("open-journal-error")).toHaveCount(0)
    await expect(second.window.getByTestId(`dismiss-unknown-${unknownActionId}`)).toHaveCount(0)
    second.window.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("pending reading count can be lost")
      await dialog.dismiss()
    })
    await second.window.getByTestId(`discard-held-${heldActionId}`).click()
    await expect(second.window.getByTestId(`open-event-${heldActionId}`)).toBeVisible()
    second.window.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("pending reading count can be lost")
      await dialog.accept()
    })
    await second.window.getByTestId(`discard-held-${heldActionId}`).click()
    await expect(second.window.getByTestId(`open-event-${heldActionId}`)).toHaveCount(0)
    await expect(second.window.getByTestId(`dismiss-unknown-${unknownActionId}`)).toHaveCount(0)
    await second.app.close()
    launched.splice(launched.indexOf(second.app), 1)

    const third = await launch(dbPath)
    await expect(third.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await expect(third.window.getByTestId(`open-event-${protectedActionId}`)).toContainText("failed")
    await expect(third.window.getByTestId(`open-event-${heldActionId}`)).toHaveCount(0)
    await expect(third.window.getByTestId(`dismiss-unknown-${unknownActionId}`)).toHaveCount(0)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
  }
})

test("reviews a changed occupied path before keeping or replacing its entry", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-replacement-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-replacement-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")
  const bookDirectory = path.join(fixtureDirectory, "book")

  try {
    await mkdir(bookDirectory)
    await writeFile(path.join(bookDirectory, "001.jpg"), "Book A")

    const first = await launch(dbPath)
    await first.window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await first.window.getByTestId("root-preview-submit").click()
    await first.window.getByTestId("root-label").fill("Replacement books")
    await first.window.getByTestId("root-save").click()
    await expect(first.window.getByTestId("root-saved")).toContainText("Replacement books")
    await first.window.getByTestId("root-saved-preview").click()
    await first.window.getByTestId("start-held-scan").click()
    await expect(first.window.getByTestId("library-screen")).toBeVisible()
    await expect(first.window.getByTestId("library-scan-status")).toHaveText("Scan task succeeded.", { timeout: 30_000 })
    await expect(first.window.getByTestId("library-entries").locator("li")).toHaveCount(1, { timeout: 30_000 })
    const originalId = await first.window.getByTestId("library-entry").locator("small").textContent()

    await first.window.getByTestId("library-setup").click()
    await writeFile(path.join(bookDirectory, "001.jpg"), "Book B")
    await writeFile(path.join(bookDirectory, "002.jpg"), "Book B second page")
    await first.window.getByTestId("root-saved-preview").click()
    await expect(first.window.getByTestId("root-preview-candidates").locator("li")).toHaveCount(1)
    await first.window.getByTestId("start-held-scan").click()
    await expect(first.window.getByTestId("library-screen")).toBeVisible()
    await expect(first.window.getByTestId("library-scan-status")).toContainText("completed_with_errors", { timeout: 30_000 })

    await first.window.getByTestId("library-setup").click()
    await expect(first.window.getByTestId("replacement-review")).toBeVisible()
    const pending = first.window.getByTestId(`replacement-${originalId}`)
    await expect(pending.getByTestId("replacement-previous-details")).toHaveText("book (image-directory, 1 page)")
    await expect(pending.getByTestId("replacement-candidate-path")).toHaveText("book")
    await expect(pending.getByTestId("replacement-candidate-pages")).toHaveText("2")
    await expect(pending.getByTestId("replacement-pending-note")).toContainText("Decide later")
    await pending.getByTestId(`replacement-keep-${originalId}`).click()
    await expect(first.window.getByTestId("replacement-review")).toHaveCount(0, { timeout: 30_000 })
    await first.window.getByTestId("open-library").click()
    await expect(first.window.getByTestId("library-entries").locator("li")).toHaveCount(1)
    await expect(first.window.getByTestId("library-entry").locator("small")).toHaveText(originalId ?? "")

    await first.window.getByTestId("library-setup").click()
    await writeFile(path.join(bookDirectory, "001.jpg"), "Book C")
    await writeFile(path.join(bookDirectory, "003.jpg"), "Book C third page")
    await first.window.getByTestId("root-saved-preview").click()
    await first.window.getByTestId("start-held-scan").click()
    await expect(first.window.getByTestId("library-screen")).toBeVisible()
    await expect(first.window.getByTestId("library-scan-status")).toContainText("completed_with_errors", { timeout: 30_000 })
    await first.window.getByTestId("library-setup").click()
    await expect(first.window.getByTestId("replacement-review")).toBeVisible()
    await first.window.getByTestId(`replacement-replace-${originalId}`).click()
    await expect(first.window.getByTestId("replacement-review")).toHaveCount(0, { timeout: 30_000 })
    await first.window.getByTestId("open-library").click()
    await expect(first.window.getByTestId("library-entries").locator("li")).toHaveCount(1)
    const replacementId = await first.window.getByTestId("library-entry").locator("small").textContent()
    expect(replacementId).not.toBe(originalId)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})
