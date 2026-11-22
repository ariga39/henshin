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
    await window.getByTestId("reader-format-image-directory").check()
    await window.getByTestId("reader-profile-arguments").fill(`${markerPath}\n{target}`)
    await window.getByTestId("reader-profile-save").click()
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
    }, clientFixture)
    await savedRoot.getByTestId("root-local-mapping").click()
    await expect(window.getByTestId("local-mapping-preview")).toBeVisible()
    await savedRoot.getByTestId("local-mapping-activate").click()
    await expect(savedRoot.getByTestId("local-mapping-effective")).toContainText("revision 1")

    await window.getByTestId("open-library").click()
    const failedEntry = window.getByTestId("library-entry").filter({ has: window.getByText("failed-book", { exact: true }) })
    await failedEntry.getByTestId(/library-entry-details-/).click()
    await window.getByTestId("library-open-profile").selectOption(profileId)
    await rm(failedClientBook, { recursive: true, force: true })
    await window.getByTestId("library-open").click()
    await expect(window.getByTestId("library-open-result")).toHaveText(/^failed: .*?(?:missing|unavailable) on this device/)

    const acceptedEntry = window.getByTestId("library-entry").filter({ has: window.getByText("accepted-book", { exact: true }) })
    await acceptedEntry.getByTestId(/library-entry-details-/).click()
    await window.getByTestId("library-open-profile").selectOption(profileId)
    await window.getByTestId("library-open").click()
    await expect(window.getByTestId("library-open-result")).toHaveText(/^accepted:/)
    await expect.poll(async () => {
      try { return await readFile(markerPath, "utf8") } catch { return "" }
    }).toBe(`${expectedTarget}\n`)
    const entryId = await acceptedEntry.locator("small").textContent()
    if (entryId === null) throw new Error("accepted entry id was not rendered")
    const duplicateResults = await window.evaluate(({ entryId: id, profileId: selectedProfile }) => {
      const library = (globalThis as unknown as {
        readonly henshinLibrary: {
          readonly open: (input: { readonly entry_id: string; readonly profile_id: string; readonly action_id: string }) => Promise<unknown>
        }
      }).henshinLibrary
      const first = library.open({ entry_id: id, profile_id: selectedProfile, action_id: crypto.randomUUID() })
      const duplicate = library.open({ entry_id: id, profile_id: selectedProfile, action_id: crypto.randomUUID() })
      return Promise.all([first, duplicate])
    }, { entryId, profileId })
    expect(duplicateResults[0]).toMatchObject({ ok: true, data: { status: "accepted" } })
    expect(duplicateResults[1]).toEqual(duplicateResults[0])
    await expect.poll(async () => {
      try { return await readFile(markerPath, "utf8") } catch { return "" }
    }).toBe(`${expectedTarget}\n${expectedTarget}\n`)

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
