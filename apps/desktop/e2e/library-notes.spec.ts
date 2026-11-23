import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import electronPath from "electron"
import { Effect } from "effect"
import { LibraryHttpClient } from "@henshin/contracts"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startServer } from "../../server/test/support/server-process"

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

const bindSharedGallery = async (dbPath: string, entryIds: ReadonlyArray<string>): Promise<void> => {
  const server = await startServer(dbPath)
  try {
    const clientLayer = LibraryHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })
    for (const entryId of entryIds) {
      await Effect.runPromise(Effect.provide(
        Effect.gen(function*() {
          const client = yield* LibraryHttpClient
          return yield* client.entryCommand({
            params: { id: entryId },
            payload: {
              operation_id: randomUUID(),
              instance_id: server.instanceId,
              epoch: server.epoch,
              expected_decision_version: "1",
              command: { type: "bind", url: "https://e-hentai.org/g/24680/shared-token/" }
            }
          })
        }),
        clientLayer
      ))
    }
  } finally {
    await server.stop()
  }
}

test.afterEach(async () => {
  for (const app of launched.splice(0)) await app.close().catch(() => undefined)
})

test("keeps Library notes independent for two entries sharing a gallery through restart", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-notes-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-notes-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")

  try {
    for (const name of ["book-a", "book-b"]) {
      const book = path.join(fixtureDirectory, name)
      await mkdir(book)
      await writeFile(path.join(book, "001.png"), validPng)
    }

    const first = await launch(dbPath)
    await expect(first.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await first.window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await first.window.getByTestId("root-preview-submit").click()
    await first.window.getByTestId("root-label").fill("Private notes")
    await first.window.getByTestId("root-save").click()
    await first.window.getByTestId("root-saved-preview").click()
    await first.window.getByTestId("scan-hold-new-discoveries").uncheck()
    await first.window.getByTestId("start-held-scan").click()
    await expect(first.window.getByTestId("library-entries").locator("li")).toHaveCount(2, { timeout: 30_000 })

    const entryA = first.window.getByTestId("library-entry").filter({ hasText: "book-a" })
    const entryB = first.window.getByTestId("library-entry").filter({ hasText: "book-b" })
    const entryIds = [
      await entryA.getByTestId("library-entry-id").innerText(),
      await entryB.getByTestId("library-entry-id").innerText()
    ]
    await first.app.close()
    launched.splice(launched.indexOf(first.app), 1)
    await bindSharedGallery(dbPath, entryIds)

    const restarted = await launch(dbPath)
    await expect(restarted.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await restarted.window.getByTestId("open-library").click()
    await expect(restarted.window.getByTestId("library-entries").locator("li")).toHaveCount(2, { timeout: 30_000 })

    const restartedA = restarted.window.getByTestId("library-entry").filter({ hasText: "book-a" })
    const restartedB = restarted.window.getByTestId("library-entry").filter({ hasText: "book-b" })
    await restartedA.getByRole("button", { name: /Open details/ }).click()
    let details = restarted.window.getByTestId("library-details")
    await expect(details.getByTestId("entry-note")).toHaveValue("")
    await details.getByTestId("entry-note").fill("note for book A")
    await details.getByTestId("entry-note-save").click()
    await expect(details.getByTestId("entry-note")).toHaveValue("note for book A")

    await restartedB.getByRole("button", { name: /Open details/ }).click()
    details = restarted.window.getByTestId("library-details")
    await details.getByTestId("entry-note").fill("note for book B")
    await details.getByTestId("entry-note-save").click()
    await expect(details.getByTestId("entry-note")).toHaveValue("note for book B")

    await restartedA.getByRole("button", { name: /Open details/ }).click()
    details = restarted.window.getByTestId("library-details")
    await expect(details.getByTestId("entry-note")).toHaveValue("note for book A")
    await restartedB.getByRole("button", { name: /Open details/ }).click()
    details = restarted.window.getByTestId("library-details")
    await expect(details.getByTestId("entry-note")).toHaveValue("note for book B")
    await details.getByTestId("entry-note-clear").click()
    await expect(details.getByTestId("entry-note")).toHaveValue("")
    await details.getByTestId("entry-note").fill("note for book B reopened")
    await details.getByTestId("entry-note-save").click()

    await restarted.app.close()
    launched.splice(launched.indexOf(restarted.app), 1)
    const final = await launch(dbPath)
    await final.window.getByRole("heading", { name: "Collection setup" }).waitFor()
    await final.window.getByTestId("open-library").click()
    await expect(final.window.getByTestId("library-entries").locator("li")).toHaveCount(2, { timeout: 30_000 })
    await final.window.getByTestId("library-entry").filter({ hasText: "book-a" }).getByRole("button", { name: /Open details/ }).click()
    details = final.window.getByTestId("library-details")
    await expect(details.getByTestId("entry-note")).toHaveValue("note for book A")
    await final.window.getByTestId("library-entry").filter({ hasText: "book-b" }).getByRole("button", { name: /Open details/ }).click()
    details = final.window.getByTestId("library-details")
    await expect(details.getByTestId("entry-note")).toHaveValue("note for book B reopened")
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})
