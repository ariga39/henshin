import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
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

const launch = async (
  dbPath: string,
  clientDbPath: string
): Promise<{ readonly app: ElectronApplication; readonly window: Page }> => {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: ["."],
    cwd: APP_DIR,
    env: {
      ...process.env,
      HENSHIN_PROTOTYPE_DB: dbPath,
      HENSHIN_PROTOTYPE_CLIENT_DB: clientDbPath
    }
  })
  launched.push(app)
  return { app, window: await app.firstWindow() }
}

test.afterEach(async () => {
  for (const app of launched.splice(0)) await app.close().catch(() => undefined)
})

test("browses the exact cached namespace after disconnect with stale paging", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-cache-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-library-cache-fixture-"))
  const firstDbPath = path.join(directory, "first.db")
  const secondDbPath = path.join(directory, "second.db")
  const clientDbPath = path.join(directory, "client.db")

  try {
    for (let index = 0; index < 51; index += 1) {
      const book = path.join(fixtureDirectory, `book-${index.toString().padStart(2, "0")}`)
      await mkdir(book)
      await writeFile(path.join(book, "001.jpg"), `book-${index}`)
    }

    const first = await launch(firstDbPath, clientDbPath)
    await expect(first.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await first.window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await first.window.getByTestId("root-preview-submit").click()
    await first.window.getByTestId("root-label").fill("Cached books")
    await first.window.getByTestId("root-save").click()
    await expect(first.window.getByTestId("root-saved")).toContainText("Cached books")
    await first.window.getByTestId("root-saved-preview").click()
    await first.window.getByTestId("scan-hold-new-discoveries").uncheck()
    await first.window.getByTestId("start-held-scan").click()

    await expect(first.window.getByTestId("library-connection-status")).toHaveText("connected")
    await expect(first.window.getByTestId("library-entry")).toHaveCount(50, { timeout: 30_000 })
    await first.window.getByTestId("library-refresh").click()
    await expect(first.window.getByTestId("library-entry")).toHaveCount(50)
    await expect(first.window.getByTestId("library-load-more")).toBeVisible()
    const firstPageIds = await first.window.getByTestId("library-entry").locator("small").allTextContents()
    await first.window.getByTestId("library-load-more").click()
    await expect(first.window.getByTestId("library-entry")).toHaveCount(51)
    const allPageIds = await first.window.getByTestId("library-entry").locator("small").allTextContents()
    const secondPageId = allPageIds.find((id) => !firstPageIds.includes(id))
    if (secondPageId === undefined) throw new Error("cached test fixture did not produce a second page")
    await expect(first.window.getByText(secondPageId, { exact: true })).toHaveCount(1)
    await first.window.getByTestId("library-disconnect").click()
    await expect(first.window.getByTestId("library-connection-status")).toHaveText("disconnected")
    await first.window.getByTestId("library-refresh").click()
    await expect(first.window.getByTestId("library-cache-status")).toContainText("partial and stale")
    await expect(first.window.getByTestId("library-cache-status")).toContainText("Only previously loaded books are shown")
    await expect(first.window.getByTestId("library-entry")).toHaveCount(50)
    await expect(first.window.getByText(secondPageId, { exact: true })).toHaveCount(0)
    await first.window.getByTestId("library-load-more").click()
    await expect(first.window.getByTestId("library-entry")).toHaveCount(51)
    await expect(first.window.getByText(secondPageId, { exact: true })).toHaveCount(1)

    await first.window.getByTestId("library-reconnect").click()
    await expect(first.window.getByTestId("library-connection-status")).toHaveText("connected")
    await expect(first.window.getByTestId("library-cache-status")).toHaveCount(0)
    await expect(first.window.getByTestId("library-entry")).toHaveCount(50)

    await first.window.getByTestId("library-search").fill("book-50")
    await first.window.getByTestId("library-search-submit").click()
    await expect(first.window.getByTestId("library-entry")).toHaveCount(1)
    await expect(first.window.getByTestId("library-cache-status")).toHaveCount(0)
    await first.window.getByTestId("library-disconnect").click()
    await expect(first.window.getByTestId("library-connection-status")).toHaveText("disconnected")
    await expect(first.window.getByTestId("library-entry")).toHaveCount(0)
    await expect(first.window.getByTestId("library-no-matches")).toHaveCount(0)
    await expect(first.window.getByRole("alert")).toContainText("Filtered Library results were cleared")
    await first.window.getByTestId("library-refresh").click()
    await expect(first.window.getByRole("alert")).toContainText("cached Library is not available")
    await first.window.getByTestId("library-search").fill("")
    await first.window.getByTestId("library-search-submit").click()
    await expect(first.window.getByTestId("library-cache-status")).toContainText("partial and stale")
    await expect(first.window.getByTestId("library-entry")).toHaveCount(50)
    await first.window.getByTestId("library-reconnect").click()
    await expect(first.window.getByTestId("library-connection-status")).toHaveText("connected")
    await expect(first.window.getByTestId("library-entry")).toHaveCount(50)

    await first.app.close()
    const restarted = await launch(firstDbPath, clientDbPath)
    await expect(restarted.window.getByTestId("open-library")).toBeVisible()
    await restarted.window.getByTestId("open-library").click()
    await expect(restarted.window.getByTestId("library-connection-status")).toHaveText("connected")
    await expect(restarted.window.getByTestId("library-entry")).toHaveCount(50)
    await expect(restarted.window.getByTestId("library-reconnect")).toBeDisabled()

    await restarted.window.getByTestId("library-search").fill("book-50")
    await restarted.window.getByTestId("library-search-submit").click()
    await expect(restarted.window.getByTestId("library-entry")).toHaveCount(1)
    await restarted.window.getByTestId("library-disconnect").click()
    await expect(restarted.window.getByTestId("library-connection-status")).toHaveText("disconnected")
    await expect(restarted.window.getByTestId("library-entry")).toHaveCount(0)
    await expect(restarted.window.getByRole("alert")).toContainText("Filtered Library results were cleared")

    const serverPid = await bundledServerPid(restarted.app)
    if (serverPid === null) throw new Error("bundled server process was not found")
    process.kill(serverPid, "SIGTERM")
    await expect.poll(() => bundledServerPid(restarted.app), { timeout: 5_000 }).toBeNull()
    await restarted.window.getByTestId("library-reconnect").click()
    await expect(restarted.window.getByTestId("library-connection-status")).toHaveText("blocked")
    await expect(restarted.window.getByTestId("library-connection-error")).toContainText("Check the server and try again")
    await restarted.window.getByTestId("library-search").fill("")
    await restarted.window.getByTestId("library-search-submit").click()
    await expect(restarted.window.getByTestId("library-cache-status")).toContainText("partial and stale")
    await expect(restarted.window.getByTestId("library-entry")).toHaveCount(50)

    await restarted.app.close()
    const second = await launch(secondDbPath, clientDbPath)
    await expect(second.window.getByTestId("open-library")).toBeVisible()
    await second.window.getByTestId("open-library").click()
    await expect(second.window.getByTestId("library-connection-status")).toHaveText("connected")
    await expect(second.window.getByTestId("library-empty")).toBeVisible()
    await second.window.getByTestId("library-disconnect").click()
    await expect(second.window.getByTestId("library-connection-status")).toHaveText("disconnected")
    await second.window.getByTestId("library-refresh").click()
    await expect(second.window.getByTestId("library-cache-status")).toContainText("partial and stale")
    await expect(second.window.getByTestId("library-entry")).toHaveCount(0)
    await expect(second.window.getByTestId("library-empty")).toHaveText(
      "No cached books are available for this server. Reconnect to refresh the Library."
    )
    await expect(second.window.getByTestId("library-empty")).not.toContainText("Start a normal scan")
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})
