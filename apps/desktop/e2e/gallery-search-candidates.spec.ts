import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import electronPath from "electron"
import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP_DIR = fileURLToPath(new URL("..", import.meta.url))
const launched: ElectronApplication[] = []
const upstreams: Server[] = []
const resultsHtml = `
<div class="itg">
  <div class="gl1t" data-gid="12345" data-token="Alpha_9">
    <div class="glink"><a href="https://e-hentai.org/g/12345/Alpha_9/">Synthetic Public Fixture — Alpha</a></div>
    <div class="glsub">English</div><div class="glpage">42 pages</div><div class="glrating">4.75</div>
  </div>
  <div class="gl1t" data-gid="67890" data-token="Beta-7">
    <div class="glink"><a href="https://exhentai.org/g/67890/Beta-7/">Synthetic Public Fixture — Beta</a></div>
    <div class="glsub">English</div><div class="glpage">84 pages</div><div class="glrating">4.25</div>
  </div>
</div>`

const launch = async (dbPath: string, ehSearchUrl: string): Promise<{ app: ElectronApplication; window: Page }> => {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: ["."],
    cwd: APP_DIR,
    env: {
      ...process.env,
      HENSHIN_PROTOTYPE_DB: dbPath,
      HENSHIN_PROTOTYPE_CLIENT_DB: `${dbPath}.client`,
      HENSHIN_EH_SEARCH_URL: ehSearchUrl
    }
  })
  launched.push(app)
  return { app, window: await app.firstWindow() }
}

test.afterEach(async () => {
  for (const app of launched.splice(0)) await app.close().catch(() => undefined)
  for (const upstream of upstreams.splice(0)) await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

test("reviews synthetic gallery candidates before binding and distinguishes cancellation and upstream states", async () => {
  let mode: "delay" | "results" | "failure" | "rate_limited" | "layout" = "results"
  const requests: string[] = []
  const upstream = createServer((request, reply) => {
    requests.push(request.url ?? "")
    const respond = () => {
      if (mode === "failure") {
        reply.writeHead(503)
        reply.end("temporary failure")
        return
      }
      if (mode === "rate_limited") {
        reply.writeHead(429, { "retry-after": "0" })
        reply.end("slow down")
        return
      }
      if (mode === "layout") {
        reply.writeHead(200, { "content-type": "text/html" })
        reply.end("<html><body>layout changed</body></html>")
        return
      }
      reply.writeHead(200, { "content-type": "text/html" })
      reply.end(resultsHtml)
    }
    if (mode === "delay") setTimeout(respond, 1_000)
    else respond()
  })
  upstreams.push(upstream)
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject)
    upstream.listen(0, "127.0.0.1", () => resolve())
  })
  const address = upstream.address()
  if (address === null || typeof address === "string") throw new Error("upstream did not expose a port")

  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-gallery-search-db-"))
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-gallery-search-fixture-"))
  const dbPath = path.join(dbDirectory, "prototype.db")
  try {
    const book = path.join(fixtureDirectory, "synthetic-local-book")
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), "synthetic page")
    const { window } = await launch(dbPath, `http://127.0.0.1:${address.port}/`)
    await expect(window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await window.getByTestId("root-preview-path").fill(fixtureDirectory)
    await window.getByTestId("root-preview-submit").click()
    await window.getByTestId("root-label").fill("Synthetic gallery search")
    await window.getByTestId("root-save").click()
    await window.getByTestId("root-saved-preview").click()
    await window.getByTestId("scan-hold-new-discoveries").uncheck()
    await window.getByTestId("start-held-scan").click()
    await expect(window.getByTestId("library-entry")).toHaveCount(1, { timeout: 30_000 })

    await window.getByTestId(/library-entry-details-/).click()
    await expect(window.getByTestId("gallery-search-panel")).toBeVisible()
    await expect(window.getByTestId("gallery-binding-status")).toContainText("Unbound")
    await window.getByTestId("gallery-search-title").fill("Synthetic Public Fixture")
    await window.getByTestId("gallery-search-author").fill("Fixture Author")
    await window.getByTestId("gallery-search-language").fill("English")

    mode = "delay"
    await window.getByTestId("gallery-search-submit").click()
    await expect(window.getByTestId("gallery-search-cancel")).toBeVisible()
    await window.getByTestId("gallery-search-cancel").click()
    await expect(window.getByTestId("gallery-search-cancelled")).toBeVisible()
    await expect(window.getByTestId("gallery-candidates")).toHaveCount(0)

    mode = "failure"
    await window.getByTestId("gallery-search-submit").click()
    await expect(window.getByTestId("gallery-search-access-failed")).toBeVisible({ timeout: 15_000 })
    mode = "rate_limited"
    await window.getByTestId("gallery-search-submit").click()
    await expect(window.getByTestId("gallery-search-rate-limited")).toBeVisible({ timeout: 15_000 })
    mode = "layout"
    await window.getByTestId("gallery-search-submit").click()
    await expect(window.getByTestId("gallery-search-unrecognized")).toBeVisible({ timeout: 15_000 })

    mode = "results"
    await window.getByTestId("gallery-search-submit").click()
    await expect(window.getByTestId("gallery-candidate")).toHaveCount(2, { timeout: 15_000 })
    await expect(window.getByTestId("gallery-binding-status")).toContainText("Unbound")
    await window.getByTestId("gallery-candidate").nth(1).locator("input").check()
    const confirm = window.getByTestId("gallery-confirm")
    const controlsDuringBind = confirm.evaluate((element) => new Promise<boolean>((resolve) => {
      const button = element as HTMLButtonElement
      const panel = button.closest("section")!
      const changes = new MutationObserver(() => {
        if (button.textContent !== "Binding…") return
        changes.disconnect()
        const controls = panel.querySelectorAll("form input, form button, input[type=radio]")
        resolve(controls.length > 0 && Array.from(controls).every((control) => control.matches(":disabled")))
      })
      changes.observe(panel, { childList: true, characterData: true, attributes: true, subtree: true })
      button.click()
    }))
    await expect(controlsDuringBind).resolves.toBe(true)
    await expect(window.getByTestId("gallery-bind-confirmed")).toBeVisible()
    await expect(window.getByTestId("gallery-binding-status")).toContainText("https://exhentai.org/g/67890/Beta-7/")
    expect(requests.some((request) => request.includes("synthetic-local-book"))).toBe(false)
    expect(requests.some((request) => request.includes("Synthetic+Public+Fixture+Fixture+Author+English"))).toBe(true)
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})
