import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import electronPath from "electron"
import { execFile } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { promisify } from "node:util"
import { mkdtemp, mkdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP_DIR = fileURLToPath(new URL("..", import.meta.url))
const launched: ElectronApplication[] = []
const execFileAsync = promisify(execFile)
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
)
const fixtureReaderSource = `
#include <stdio.h>
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  FILE *marker = fopen(argv[1], "a");
  if (marker == NULL) return 3;
  fprintf(marker, "%s\\n", argv[2]);
  fclose(marker);
  return 0;
}
`

const launch = async (dbPath: string): Promise<{ readonly app: ElectronApplication; readonly window: Page }> => {
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

const makeBook = async (root: string, name: string): Promise<string> => {
  const book = path.join(root, name)
  await mkdir(book)
  await writeFile(path.join(book, "001.png"), validPng)
  return book
}

test.afterEach(async () => {
  for (const app of launched.splice(0)) await app.close().catch(() => undefined)
})

test("opens an accepted Library entry through one native fixture handoff", async () => {
  test.skip(process.platform === "win32", "the fixture compiler command is scoped to Unix development platforms")
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-open-accepted-book-db-"))
  const serverFixture = await mkdtemp(path.join(os.tmpdir(), "henshin-open-accepted-book-server-"))
  const clientFixture = await mkdtemp(path.join(os.tmpdir(), "henshin-open-accepted-book-client-"))
  const dbPath = path.join(dbDirectory, "prototype.db")
  const markerPath = path.join(dbDirectory, "handoffs.log")
  const sourcePath = path.join(dbDirectory, "fixture-reader.c")
  const readerPath = path.join(dbDirectory, "fixture-reader")
  const collectionPath = serverFixture
  try {
    const failedBook = await makeBook(serverFixture, "failed-book")
    const acceptedBook = await makeBook(serverFixture, "accepted-book")
    const failedClientBook = await makeBook(clientFixture, "failed-book")
    const acceptedClientBook = await makeBook(clientFixture, "accepted-book")
    const observedAt = new Date("2025-02-03T04:05:06.000Z")
    await utimes(failedBook, observedAt, observedAt)
    await utimes(failedClientBook, observedAt, observedAt)
    await utimes(acceptedBook, observedAt, observedAt)
    await utimes(acceptedClientBook, observedAt, observedAt)
    const expectedTarget = await realpath(acceptedClientBook)
    await writeFile(sourcePath, fixtureReaderSource)
    await execFileAsync("cc", ["-O2", "-o", readerPath, sourcePath])

    const { app, window } = await launch(dbPath)
    await expect(window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await window.getByTestId("root-preview-path").fill(collectionPath)
    await window.getByTestId("root-preview-submit").click()
    await window.getByTestId("root-label").fill("Open fixture")
    await window.getByTestId("root-save").click()
    const savedRoot = window.getByTestId("root-saved").filter({ hasText: "Open fixture" })
    await expect(savedRoot).toBeVisible()
    await savedRoot.getByTestId("root-saved-preview").click()
    await window.getByTestId("scan-hold-new-discoveries").uncheck()
    await window.getByRole("button", { name: "Start manual scan" }).click()
    await expect(window.getByTestId("library-entry")).toHaveCount(2, { timeout: 30_000 })

    await window.getByTestId("library-setup").click()
    await app.evaluate(({ dialog }, input) => {
      let index = 0
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [input[index++] ?? input[input.length - 1]] })
      })
    }, [readerPath, collectionPath])
    await window.getByTestId("reader-profile-name").fill("Native fixture reader")
    await window.getByTestId("reader-select-executable").click()
    await expect(window.getByTestId("reader-selected-executable")).toHaveText("fixture-reader")
    await window.getByTestId("reader-format-image-directory").check()
    await window.getByTestId("reader-profile-arguments").fill(`${markerPath}\n{target}`)
    await window.getByTestId("reader-profile-save").click()
    const savedProfiles = window.getByTestId("reader-profile-list")
    await expect(savedProfiles).toContainText("Native fixture reader")
    await expect(savedProfiles).toContainText("executable: fixture-reader")
    await window.getByTestId("reader-profile-name").fill("System default reader")
    await window.getByTestId("reader-profile-launch-mode").selectOption("system-association")
    await window.getByTestId("reader-format-image-directory").check()
    await window.getByTestId("reader-profile-save").click()
    await expect(savedProfiles).toContainText("System default reader")
    const profiles = await window.evaluate(() => (globalThis as unknown as {
      readonly henshinReaderProfiles: {
        readonly list: () => Promise<{
          readonly ok: boolean
          readonly data?: ReadonlyArray<{ readonly profile_id: string; readonly name: string; readonly launch_mode: string }>
        }>
      }
    }).henshinReaderProfiles.list())
    if (!profiles.ok || profiles.data === undefined) throw new Error("reader profiles were not saved")
    const explicitProfileId = profiles.data.find((item) => item.name === "Native fixture reader")?.profile_id
    const systemProfileId = profiles.data.find((item) => item.name === "System default reader")?.profile_id
    if (explicitProfileId === undefined || systemProfileId === undefined) throw new Error("expected both reader profiles")

    await app.evaluate(({ dialog }, selected) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [selected] })
      })
    }, clientFixture)
    await savedRoot.getByTestId("root-local-mapping").click()
    await expect(window.getByTestId("local-mapping-preview")).toBeVisible()
    await savedRoot.getByTestId("local-mapping-activate").click()
    await expect(savedRoot.getByTestId("local-mapping-effective")).toContainText("revision 1")

    await window.getByTestId("open-library").click()
    await expect(window.getByTestId("library-entry")).toHaveCount(2, { timeout: 30_000 })
    const failedEntry = window.getByTestId("library-entry").filter({ has: window.getByText("failed-book", { exact: true }) })
    await failedEntry.getByTestId(/library-entry-details-/).click()
    await window.getByTestId("library-open-profile").selectOption(explicitProfileId)
    await window.getByTestId("library-prepare-local").click()
    await expect(window.getByTestId("library-local-access-result")).toHaveText(/Eligible local copy verified/)
    const acceptedToPrepare = window.getByTestId("library-entry").filter({ has: window.getByText("accepted-book", { exact: true }) })
    await acceptedToPrepare.getByTestId(/library-entry-details-/).click()
    await window.getByTestId("library-open-profile").selectOption(explicitProfileId)
    await window.getByTestId("library-prepare-local").click()
    await expect(window.getByTestId("library-local-access-result")).toHaveText(/Eligible local copy verified/)
    await window.getByTestId("library-disconnect").click()
    await expect(window.getByTestId("library-connection-status")).toHaveText("disconnected")
    await expect(window.getByTestId("library-cache-status")).toContainText("partial and stale")
    await failedEntry.getByTestId(/library-entry-details-/).click()
    await window.getByTestId("library-open-profile").selectOption(explicitProfileId)
    await rm(failedClientBook, { recursive: true, force: true })
    await window.getByTestId("library-open").click()
    await expect(window.getByTestId("library-open-result")).toHaveText(/^failed: .*?(?:missing|unavailable) on this device/)

    const acceptedEntry = window.getByTestId("library-entry").filter({ has: window.getByText("accepted-book", { exact: true }) })
    await acceptedEntry.getByTestId(/library-entry-details-/).click()
    await window.getByTestId("library-open-profile").selectOption(explicitProfileId)
    await window.getByTestId("library-open").click()
    await expect(window.getByTestId("library-open-result")).toHaveText(/^accepted:/)
    await expect.poll(async () => {
      try { return await readFile(markerPath, "utf8") } catch { return "" }
    }).toBe(`${expectedTarget}\n`)
    await window.getByTestId("library-reconnect").click()
    await expect(window.getByTestId("library-connection-status")).toHaveText("connected")
    await expect(window.getByTestId("library-cache-status")).toHaveCount(0)
    const entryId = await acceptedEntry.getByTestId("library-entry-id").textContent()
    if (entryId === null) throw new Error("accepted entry id was not rendered")

    await app.evaluate(({ shell }) => {
      let release!: (error: string) => void
      let signalStarted!: () => void
      const calls: string[] = []
      const held = new Promise<string>((resolve) => { release = resolve })
      const started = new Promise<void>((resolve) => { signalStarted = resolve })
      Object.defineProperty(shell, "openPath", {
        configurable: true,
        value: (target: string) => {
          calls.push(target)
          signalStarted()
          return held
        }
      })
      Object.defineProperty(globalThis, "__henshinOpenPathTest", {
        configurable: true,
        value: { calls, release, started }
      })
    })
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("new-library-window")
      if (item == null) throw new Error("New Window menu item was not installed")
      item.click?.(item, BrowserWindow.getFocusedWindow())
    })
    await expect.poll(() => app.windows().length).toBe(2)
    const secondWindow = app.windows().find((candidate) => candidate !== window)
    if (secondWindow === undefined) throw new Error("second Library window was not created")
    await expect(secondWindow.getByRole("heading", { name: "Library" })).toBeVisible()
    await expect(secondWindow.getByRole("listitem")).toHaveCount(2, { timeout: 30_000 })

    await acceptedEntry.getByTestId(/library-entry-details-/).click()
    await window.getByTestId("library-open-profile").selectOption(systemProfileId)
    await window.getByTestId("library-open").click()
    await app.evaluate(() => (globalThis as unknown as {
      readonly __henshinOpenPathTest: { readonly started: Promise<void> }
    }).__henshinOpenPathTest.started)
    expect(await app.evaluate(() => (globalThis as unknown as {
      readonly __henshinOpenPathTest: { readonly calls: ReadonlyArray<string> }
    }).__henshinOpenPathTest.calls)).toEqual([expectedTarget])

    const followerEntry = secondWindow.getByRole("listitem").filter({ has: secondWindow.getByText("accepted-book", { exact: true }) })
    await followerEntry.getByRole("button", { name: "Open details for accepted-book" }).click()
    const followerInFlight = secondWindow.getByTestId("library-open-result")
    await expect(followerInFlight).toHaveText(/^in-flight: .*\(action [0-9a-f-]+; reader System default reader\)$/)
    await expect(secondWindow.getByTestId("library-open-profile")).toBeDisabled()
    await expect(secondWindow.getByTestId("library-open")).toBeDisabled()
    const inFlightText = await followerInFlight.textContent()
    const actionId = inFlightText?.match(/action ([0-9a-f-]+);/)?.[1]
    if (actionId === undefined) throw new Error("follower did not render the active action ID")

    await window.close()
    await app.evaluate(() => {
      const hook = (globalThis as unknown as {
        readonly __henshinOpenPathTest: { readonly release: (error: string) => void }
      }).__henshinOpenPathTest
      hook.release("")
    })
    await expect(followerInFlight).toHaveText(new RegExp(`^accepted: .*\\(action ${actionId}; reader System default reader\\)$`))
    await expect(secondWindow.getByTestId("library-open-profile")).toBeEnabled()
    await secondWindow.getByTestId("library-open-profile").selectOption(systemProfileId)
    await expect(secondWindow.getByTestId("library-open")).toBeEnabled()
    expect(await app.evaluate(() => (globalThis as unknown as {
      readonly __henshinOpenPathTest: { readonly calls: ReadonlyArray<string> }
    }).__henshinOpenPathTest.calls)).toEqual([expectedTarget])

    await app.close()
    const db = new DatabaseSync(`${dbPath}.client`)
    try {
      const rows = db.prepare("SELECT status, event_json FROM launch_journal ORDER BY action_id").all() as Array<{ status: string; event_json: string | null }>
      const acceptedRows = rows.filter((row) => row.status === "accepted")
      expect(acceptedRows).toHaveLength(2)
      expect(rows.filter((row) => row.event_json !== null)).toHaveLength(2)
      const acceptedEvents = acceptedRows.map((row) => JSON.parse(row.event_json ?? "null") as { event_id: string; entry_id: string })
      expect(new Set(acceptedEvents.map((event) => event.event_id)).size).toBe(2)
      expect(acceptedEvents.every((event) => event.entry_id === entryId)).toBe(true)
    } finally {
      db.close()
    }
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(serverFixture, { recursive: true, force: true })
    await rm(clientFixture, { recursive: true, force: true })
  }
})

test("reopens the cached Library after a cold managed-service outage and delivers one event", async () => {
  test.skip(process.platform === "win32", "the fixture compiler command is scoped to Unix development platforms")
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-cold-offline-library-db-"))
  const serverFixture = await mkdtemp(path.join(os.tmpdir(), "henshin-cold-offline-library-server-"))
  const clientFixture = await mkdtemp(path.join(os.tmpdir(), "henshin-cold-offline-library-client-"))
  const dbPath = path.join(dbDirectory, "prototype.db")
  const markerPath = path.join(dbDirectory, "handoffs.log")
  const sourcePath = path.join(dbDirectory, "fixture-reader.c")
  const readerPath = path.join(dbDirectory, "fixture-reader")
  let ownerLock: DatabaseSync | null = null
  try {
    const serverBook = await makeBook(serverFixture, "cold-book")
    const clientBook = await makeBook(clientFixture, "cold-book")
    const observedAt = new Date("2025-02-03T04:05:06.000Z")
    await utimes(serverBook, observedAt, observedAt)
    await utimes(clientBook, observedAt, observedAt)
    const expectedTarget = await realpath(clientBook)
    await writeFile(sourcePath, fixtureReaderSource)
    await execFileAsync("cc", ["-O2", "-o", readerPath, sourcePath])

    const first = await launch(dbPath)
    await expect(first.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await first.window.getByTestId("root-preview-path").fill(serverFixture)
    await first.window.getByTestId("root-preview-submit").click()
    await first.window.getByTestId("root-label").fill("Cold outage fixture")
    await first.window.getByTestId("root-save").click()
    const savedRoot = first.window.getByTestId("root-saved").filter({ hasText: "Cold outage fixture" })
    await expect(savedRoot).toBeVisible()
    await savedRoot.getByTestId("root-saved-preview").click()
    await first.window.getByTestId("scan-hold-new-discoveries").uncheck()
    await first.window.getByRole("button", { name: "Start manual scan" }).click()
    await expect(first.window.getByTestId("library-entry")).toHaveCount(1, { timeout: 30_000 })

    await first.window.getByTestId("library-setup").click()
    await first.app.evaluate(({ dialog }, input) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [input] })
      })
    }, readerPath)
    await first.window.getByTestId("reader-profile-name").fill("Cold fixture reader")
    await first.window.getByTestId("reader-select-executable").click()
    await first.window.getByTestId("reader-format-image-directory").check()
    await first.window.getByTestId("reader-profile-arguments").fill(`${markerPath}\n{target}`)
    await first.window.getByTestId("reader-profile-save").click()
    const profile = await first.window.evaluate(() => (globalThis as unknown as {
      readonly henshinReaderProfiles: { readonly list: () => Promise<{ readonly ok: boolean; readonly data?: ReadonlyArray<{ readonly profile_id: string }> }> }
    }).henshinReaderProfiles.list())
    if (!profile.ok || profile.data === undefined || profile.data[0] === undefined) throw new Error("fixture reader profile was not saved")
    const profileId = profile.data[0].profile_id

    await first.app.evaluate(({ dialog }, selected) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [selected] })
      })
    }, clientFixture)
    await savedRoot.getByTestId("root-local-mapping").click()
    await expect(first.window.getByTestId("local-mapping-preview")).toBeVisible()
    await savedRoot.getByTestId("local-mapping-activate").click()
    await expect(savedRoot.getByTestId("local-mapping-effective")).toContainText("revision 1")

    await first.window.getByTestId("open-library").click()
    await expect(first.window.getByTestId("library-entry")).toHaveCount(1, { timeout: 30_000 })
    const entry = first.window.getByTestId("library-entry").filter({ hasText: "cold-book" })
    await entry.getByTestId(/library-entry-details-/).click()
    await first.window.getByTestId("library-open-profile").selectOption(profileId)
    await first.window.getByTestId("library-prepare-local").click()
    await expect(first.window.getByTestId("library-local-access-result")).toHaveText(/Eligible local copy verified/)
    await expect.poll(async () => {
      try { return await readFile(markerPath, "utf8") } catch { return "" }
    }).toBe("")

    await first.app.close()

    const onlineRestart = await launch(dbPath)
    await expect(onlineRestart.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await onlineRestart.window.getByTestId("open-library").click()
    await expect(onlineRestart.window.getByTestId("library-connection-status")).toHaveText("connected")
    await expect(onlineRestart.window.getByTestId("library-entry").filter({ hasText: "cold-book" })).toBeVisible()
    await onlineRestart.app.close()

    ownerLock = new DatabaseSync(path.join(dbDirectory, ".henshin-server-owner.sqlite"))
    ownerLock.exec("BEGIN IMMEDIATE")
    const cold = await launch(dbPath)
    await expect(cold.window.getByRole("heading", { name: "Library" })).toBeVisible()
    await expect(cold.window.getByTestId("cached-namespace-picker")).toBeVisible()
    const namespaceOptions = cold.window.getByTestId("cached-namespace-select").locator("option")
    await expect(namespaceOptions).toHaveCount(2)
    const namespaceId = await namespaceOptions.nth(1).getAttribute("value")
    if (namespaceId === null) throw new Error("cached namespace was not rendered")
    const wrongNamespace = await cold.window.evaluate(async () => (globalThis as unknown as {
      readonly henshinConnection: { readonly selectCachedNamespace: (input: { readonly instance_id: string }) => Promise<{ readonly ok: boolean; readonly error?: { readonly code: string } }> }
    }).henshinConnection.selectCachedNamespace({ instance_id: "00000000-0000-4000-8000-000000000000" }))
    expect(wrongNamespace).toMatchObject({ ok: false, error: { code: "cached_namespace_not_found" } })
    await expect(cold.window.getByTestId("library-entry")).toHaveCount(0)

    await cold.window.getByTestId("cached-namespace-select").selectOption(namespaceId)
    await cold.window.getByTestId("cached-namespace-select-button").click()
    await expect(cold.window.getByTestId("library-cache-status")).toContainText("partial and stale")
    const coldEntry = cold.window.getByTestId("library-entry").filter({ hasText: "cold-book" })
    await expect(coldEntry).toBeVisible()
    await coldEntry.getByTestId(/library-entry-details-/).click()
    await cold.window.getByTestId("library-open-profile").selectOption(profileId)
    await cold.window.getByTestId("library-open").click()
    await expect(cold.window.getByTestId("library-open-result")).toHaveText(/^accepted:/)
    await expect.poll(async () => {
      try { return await readFile(markerPath, "utf8") } catch { return "" }
    }).toBe(`${expectedTarget}\n`)

    ownerLock.exec("ROLLBACK")
    ownerLock.close()
    ownerLock = null
    await cold.window.getByTestId("library-reconnect").click()
    await expect(cold.window.getByTestId("library-connection-status")).toHaveText("connected", { timeout: 30_000 })
    await expect(cold.window.getByTestId("library-cache-status")).toHaveCount(0)
    await cold.window.getByTestId("library-setup").click()
    await expect(cold.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await expect(cold.window.getByTestId("root-saved")).toContainText("Cold outage fixture")

    const serverRows = (): Array<{ readonly event_id: string; readonly entry_id: string; readonly open_count: number }> => {
      const database = new DatabaseSync(dbPath)
      try {
        return database.prepare(`
          SELECT open_events.event_id, open_events.entry_id, entry_statistics.open_count
          FROM open_events
          JOIN entry_statistics ON entry_statistics.entry_id = open_events.entry_id
        `).all() as Array<{ event_id: string; entry_id: string; open_count: number }>
      } finally {
        database.close()
      }
    }
    await expect.poll(() => serverRows()).toHaveLength(1)
    expect(serverRows()[0]?.open_count).toBe(1)
    expect(await readFile(markerPath, "utf8")).toBe(`${expectedTarget}\n`)
  } finally {
    if (ownerLock !== null) {
      try { ownerLock.exec("ROLLBACK") } catch { /* no active transaction */ }
      ownerLock.close()
    }
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(serverFixture, { recursive: true, force: true })
    await rm(clientFixture, { recursive: true, force: true })
  }
})

test("delivers distinct accepted Library handoffs on the existing native connection", async () => {
  test.skip(process.platform === "win32", "the fixture compiler command is scoped to Unix development platforms")
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-open-accepted-book-db-"))
  const serverFixtureA = await mkdtemp(path.join(os.tmpdir(), "henshin-open-accepted-book-server-a-"))
  const serverFixtureB = await mkdtemp(path.join(os.tmpdir(), "henshin-open-accepted-book-server-b-"))
  const clientFixtureA = await mkdtemp(path.join(os.tmpdir(), "henshin-open-accepted-book-client-a-"))
  const clientFixtureB = await mkdtemp(path.join(os.tmpdir(), "henshin-open-accepted-book-client-b-"))
  const dbPath = path.join(dbDirectory, "prototype.db")
  const markerPath = path.join(dbDirectory, "handoffs.log")
  const sourcePath = path.join(dbDirectory, "fixture-reader.c")
  const readerPath = path.join(dbDirectory, "fixture-reader")
  try {
    await makeBook(serverFixtureA, "failed-book")
    const acceptedBookA = await makeBook(serverFixtureA, "accepted-book-a")
    const acceptedBookB = await makeBook(serverFixtureB, "accepted-book-b")
    const failedClientBook = await makeBook(clientFixtureA, "failed-book")
    const acceptedClientBookA = await makeBook(clientFixtureA, "accepted-book-a")
    const acceptedClientBookB = await makeBook(clientFixtureB, "accepted-book-b")
    const observedAt = new Date("2025-02-03T04:05:06.000Z")
    await utimes(acceptedBookA, observedAt, observedAt)
    await utimes(acceptedBookB, observedAt, observedAt)
    await utimes(acceptedClientBookA, observedAt, observedAt)
    await utimes(acceptedClientBookB, observedAt, observedAt)
    const expectedTargetA = await realpath(acceptedClientBookA)
    const expectedTargetB = await realpath(acceptedClientBookB)
    await writeFile(sourcePath, fixtureReaderSource)
    await execFileAsync("cc", ["-O2", "-o", readerPath, sourcePath])

    const { app, window } = await launch(dbPath)
    await expect(window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await window.getByTestId("root-preview-path").fill(serverFixtureA)
    await window.getByTestId("root-preview-submit").click()
    await window.getByTestId("root-label").fill("Open fixture A")
    await window.getByTestId("root-save").click()
    const savedRootA = window.getByTestId("root-saved").filter({ hasText: "Open fixture A" })
    await expect(savedRootA).toBeVisible()
    await window.getByTestId("root-preview-path").fill(serverFixtureB)
    await window.getByTestId("root-preview-submit").click()
    await window.getByTestId("root-label").fill("Open fixture B")
    await window.getByTestId("root-save").click()
    const savedRootB = window.getByTestId("root-saved").filter({ hasText: "Open fixture B" })
    await expect(savedRootB).toBeVisible()

    await savedRootA.getByTestId("root-saved-preview").click()
    await window.getByTestId("scan-hold-new-discoveries").uncheck()
    await window.getByRole("button", { name: "Start manual scan" }).click()
    await expect(window.getByTestId("library-entry")).toHaveCount(2, { timeout: 30_000 })
    await window.getByTestId("library-setup").click()
    await expect(window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await savedRootB.getByTestId("root-saved-preview").click()
    await window.getByRole("button", { name: "Start manual scan" }).click()
    await expect(window.getByTestId("library-entry")).toHaveCount(3, { timeout: 30_000 })

    await window.getByTestId("library-setup").click()
    await app.evaluate(({ dialog }, input) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [input] })
      })
    }, readerPath)
    await window.getByTestId("reader-profile-name").fill("Native fixture reader")
    await window.getByTestId("reader-select-executable").click()
    await expect(window.getByTestId("reader-selected-executable")).toHaveText("fixture-reader")
    await window.getByTestId("reader-format-image-directory").check()
    await window.getByTestId("reader-profile-arguments").fill(`${markerPath}\n{target}`)
    await window.getByTestId("reader-profile-save").click()
    const savedProfiles = window.getByTestId("reader-profile-list")
    await expect(savedProfiles).toContainText("Native fixture reader")
    await expect(savedProfiles).toContainText("executable: fixture-reader")
    const profile = await window.evaluate(() => (globalThis as unknown as {
      readonly henshinReaderProfiles: { readonly list: () => Promise<{ readonly ok: boolean; readonly data?: ReadonlyArray<{ readonly profile_id: string }> }> }
    }).henshinReaderProfiles.list())
    if (!profile.ok || profile.data === undefined || profile.data[0] === undefined) throw new Error("fixture reader profile was not saved")
    const profileId = profile.data[0].profile_id

    await app.evaluate(({ dialog }, selected) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [selected] })
      })
    }, clientFixtureA)
    await savedRootA.getByTestId("root-local-mapping").click()
    await expect(window.getByTestId("local-mapping-preview")).toBeVisible()
    await savedRootA.getByTestId("local-mapping-activate").click()
    await expect(savedRootA.getByTestId("local-mapping-effective")).toContainText("revision 1")
    await app.evaluate(({ dialog }, selected) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [selected] })
      })
    }, clientFixtureB)
    await savedRootB.getByTestId("root-local-mapping").click()
    await expect(window.getByTestId("local-mapping-preview")).toBeVisible()
    await savedRootB.getByTestId("local-mapping-activate").click()
    await expect(savedRootB.getByTestId("local-mapping-effective")).toContainText("revision 1")

    await window.getByTestId("open-library").click()
    const failedEntry = window.getByTestId("library-entry").filter({ has: window.getByText("failed-book", { exact: true }) })
    await failedEntry.getByTestId(/library-entry-details-/).click()
    await window.getByTestId("library-open-profile").selectOption(profileId)
    await rm(failedClientBook, { recursive: true, force: true })
    await window.getByTestId("library-open").click()
    await expect(window.getByTestId("library-open-result")).toHaveText(/^failed: .*?(?:missing|unavailable) on this device/)

    const acceptedEntryA = window.getByTestId("library-entry").filter({ has: window.getByText("accepted-book-a", { exact: true }) })
    await acceptedEntryA.getByTestId(/library-entry-details-/).click()
    await window.getByTestId("library-open-profile").selectOption(profileId)
    await window.getByTestId("library-open").click()
    await expect(window.getByTestId("library-open-result")).toHaveText(/^accepted:/)
    await expect.poll(async () => {
      try { return await readFile(markerPath, "utf8") } catch { return "" }
    }).toBe(`${expectedTargetA}\n`)
    const entryIdA = (await acceptedEntryA.getByTestId("library-entry-id").textContent())?.trim()
    if (!entryIdA) throw new Error("accepted entry A id was not rendered")

    const acceptedEntryB = window.getByTestId("library-entry").filter({ has: window.getByText("accepted-book-b", { exact: true }) })
    await acceptedEntryB.getByTestId(/library-entry-details-/).click()
    await window.getByTestId("library-open-profile").selectOption(profileId)
    const entryIdB = (await acceptedEntryB.getByTestId("library-entry-id").textContent())?.trim()
    if (!entryIdB) throw new Error("accepted entry B id was not rendered")
    await window.getByTestId("library-open").click()
    await expect(window.getByTestId("library-open-result")).toHaveText(/^accepted:/)
    await expect.poll(async () => {
      try { return await readFile(markerPath, "utf8") } catch { return "" }
    }).toBe(`${expectedTargetA}\n${expectedTargetB}\n`)
    expect(entryIdA).not.toBe(entryIdB)

    const serverRows = (): Array<{
      readonly event_id: string
      readonly entry_id: string
      readonly root_id: string
      readonly relative_path: string
      readonly open_count: number
      readonly last_opened_at_ms: number | null
    }> => {
      const db = new DatabaseSync(dbPath)
      try {
        return db.prepare(`
          SELECT open_events.event_id, open_events.entry_id, library_entries.root_id,
                 library_entries.relative_path, entry_statistics.open_count,
                 entry_statistics.last_opened_at_ms
          FROM open_events
          JOIN library_entries ON library_entries.entry_id = open_events.entry_id
          JOIN entry_statistics ON entry_statistics.entry_id = open_events.entry_id
          ORDER BY library_entries.relative_path
        `).all() as Array<{
          event_id: string
          entry_id: string
          root_id: string
          relative_path: string
          open_count: number
          last_opened_at_ms: number | null
        }>
      } finally {
        db.close()
      }
    }
    await expect.poll(() => serverRows()).toHaveLength(2)

    const clientRows = (): Array<{ status: string; delivery_status: string | null; event_json: string | null }> => {
      const db = new DatabaseSync(`${dbPath}.client`)
      try {
        return db.prepare("SELECT status, delivery_status, event_json FROM launch_journal ORDER BY action_id").all() as Array<{
          status: string
          delivery_status: string | null
          event_json: string | null
        }>
      } finally {
        db.close()
      }
    }
    await expect.poll(() => clientRows().filter((row) => row.status === "accepted" && row.delivery_status === "acknowledged")).toHaveLength(2)

    const db = new DatabaseSync(`${dbPath}.client`)
    try {
      const rows = db.prepare("SELECT status, delivery_status, event_json FROM launch_journal ORDER BY action_id").all() as Array<{
        status: string
        delivery_status: string | null
        event_json: string | null
      }>
      const acceptedRows = rows.filter((row) => row.status === "accepted")
      expect(acceptedRows).toHaveLength(2)
      expect(acceptedRows.every((row) => row.delivery_status === "acknowledged")).toBe(true)
      expect(rows.filter((row) => row.event_json !== null)).toHaveLength(2)
      const acceptedEvents = acceptedRows.map((row) => JSON.parse(row.event_json ?? "null") as { event_id: string; entry_id: string })
      expect(new Set(acceptedEvents.map((event) => event.event_id)).size).toBe(2)
      expect(new Set(acceptedEvents.map((event) => event.entry_id))).toEqual(new Set([entryIdA, entryIdB]))
    } finally {
      db.close()
    }
    const events = serverRows()
    expect(events.map((event) => event.entry_id)).toEqual(expect.arrayContaining([entryIdA, entryIdB]))
    expect(new Set(events.map((event) => event.root_id)).size).toBe(2)
    expect(events.map((event) => event.relative_path)).toEqual(["accepted-book-a", "accepted-book-b"])
    expect(events.every((event) => event.open_count === 1 && event.last_opened_at_ms !== null)).toBe(true)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(serverFixtureA, { recursive: true, force: true })
    await rm(serverFixtureB, { recursive: true, force: true })
    await rm(clientFixtureA, { recursive: true, force: true })
    await rm(clientFixtureB, { recursive: true, force: true })
  }
})
