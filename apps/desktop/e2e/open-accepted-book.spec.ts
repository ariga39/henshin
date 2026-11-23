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
    await makeBook(serverFixture, "failed-book")
    const acceptedBook = await makeBook(serverFixture, "accepted-book")
    const failedClientBook = await makeBook(clientFixture, "failed-book")
    const acceptedClientBook = await makeBook(clientFixture, "accepted-book")
    const observedAt = new Date("2025-02-03T04:05:06.000Z")
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
    const failedEntry = window.getByTestId("library-entry").filter({ has: window.getByText("failed-book", { exact: true }) })
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
