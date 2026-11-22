import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import electronPath from "electron"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP_DIR = fileURLToPath(new URL("..", import.meta.url))
const launched: ElectronApplication[] = []

type BrowserError = { readonly code: string; readonly message: string }
type BrowserResult<A> =
  | { readonly ok: true; readonly data: A }
  | { readonly ok: false; readonly error: BrowserError }
type BrowserRootList = BrowserResult<ReadonlyArray<{ readonly label: string; readonly root_id: string }>>
type BrowserLocalPreview = BrowserResult<{
  readonly preview_token: string
  readonly preview: unknown
} | null>

const makeBook = async (rootPath: string, name: string, contents = "page"): Promise<string> => {
  const bookPath = path.join(rootPath, name)
  await mkdir(bookPath)
  const pagePath = path.join(bookPath, "001.jpg")
  await writeFile(pagePath, contents)
  return pagePath
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

const setDialogResult = async (
  app: ElectronApplication,
  result: { readonly canceled: boolean; readonly filePaths: string[] }
): Promise<void> => {
  await app.evaluate(({ dialog }, value) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => value
    })
  }, result)
}

test.afterEach(async () => {
  for (const app of launched.splice(0)) await app.close().catch(() => undefined)
})

test("compares a bounded local mapping preview and recovers after cancel or failure", async () => {
  const dbDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-path-mapping-db-"))
  const serverFixture = await mkdtemp(path.join(os.tmpdir(), "henshin-path-mapping-server-"))
  const localFixture = await mkdtemp(path.join(os.tmpdir(), "henshin-path-mapping-local-"))
  const dbPath = path.join(dbDirectory, "prototype.db")
  const serverMissing = path.join(serverFixture, "missing-book")

  try {
    const serverPage = await makeBook(serverFixture, "matching-book", "matching page")
    await makeBook(serverFixture, "missing-book", "missing page")
    const serverBytes = new Uint8Array(await readFile(serverPage))
    const localPage = await makeBook(localFixture, "matching-book")
    await writeFile(localPage, serverBytes)

    const { app, window } = await launch(dbPath)
    await expect(window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await window.getByTestId("root-preview-path").fill(serverFixture)
    await window.getByTestId("root-preview-submit").click()
    await window.getByTestId("root-label").fill("Mapping fixture")
    await window.getByTestId("root-save").click()
    const savedRoot = window.getByTestId("root-saved").filter({ hasText: "Mapping fixture" })
    await expect(savedRoot).toBeVisible()
    await savedRoot.getByTestId("root-saved-preview").click()
    await window.getByTestId("scan-hold-new-discoveries").uncheck()
    await window.getByTestId("start-held-scan").click()
    await expect(window.getByTestId("library-screen")).toBeVisible()
    await expect(window.getByTestId("library-entry")).toHaveCount(2, { timeout: 30_000 })

    await window.getByTestId("library-setup").click()
    await setDialogResult(app, { canceled: false, filePaths: [localFixture] })
    await savedRoot.getByTestId("root-local-mapping").click()
    const mapping = window.getByTestId("local-mapping-preview")
    await expect(mapping).toBeVisible()
    await expect(mapping.getByTestId("local-mapping-selected-path")).toContainText(localFixture)
    await expect(mapping.getByTestId("local-mapping-sample")).toHaveCount(2)
    await expect(mapping).toContainText("matching-book")
    await expect(mapping).toContainText("Found on this device.")
    await expect(mapping).toContainText("missing-book")
    await expect(mapping).toContainText("Missing on this device.")
    await expect(mapping.getByTestId("local-mapping-missing-explanation")).toBeVisible()
    await expect(savedRoot.getByTestId("local-mapping-activate")).toBeEnabled()
    await savedRoot.getByTestId("local-mapping-activate").click()
    await expect(savedRoot.getByTestId("local-mapping-effective")).toContainText(localFixture)
    await expect(savedRoot.getByTestId("local-mapping-effective")).toContainText("revision 1")
    expect(new Uint8Array(await readFile(serverPage))).toEqual(serverBytes)
    expect(new Uint8Array(await readFile(path.join(serverMissing, "001.jpg")))).toEqual(
      new Uint8Array(Buffer.from("missing page"))
    )

    const managedWritableRoot = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"))
    await setDialogResult(app, { canceled: false, filePaths: [managedWritableRoot] })
    await savedRoot.getByTestId("root-local-mapping").click()
    await expect(mapping).toBeVisible()
    await expect(savedRoot.getByTestId("local-mapping-activate")).toBeEnabled()
    await savedRoot.getByTestId("local-mapping-activate").click()
    await expect(savedRoot.getByTestId("local-mapping-activation-error")).toContainText("writable application path")
    await expect(savedRoot.getByTestId("local-mapping-effective")).toContainText(localFixture)
    await expect(savedRoot.getByTestId("local-mapping-effective")).toContainText("revision 1")

    const rootList = await window.evaluate(() => (globalThis as unknown as {
      readonly henshinRootPreview: { readonly list: () => Promise<BrowserRootList> }
    }).henshinRootPreview.list())
    if (!rootList.ok) throw new Error(rootList.error.message)
    const rootId = rootList.data.find((root: { readonly label: string; readonly root_id: string }) => root.label === "Mapping fixture")?.root_id
    if (rootId === undefined) throw new Error("saved mapping fixture root was not listed")
    await setDialogResult(app, { canceled: false, filePaths: [localFixture] })
    const firstPreview = await window.evaluate((id) => (globalThis as unknown as {
      readonly henshinLocalMapping: { readonly preview: (input: { readonly root_id: string }) => Promise<BrowserLocalPreview> }
    }).henshinLocalMapping.preview({ root_id: id }), rootId)
    if (!firstPreview.ok || firstPreview.data === null) throw new Error("first direct local preview failed")
    await setDialogResult(app, { canceled: false, filePaths: [serverFixture] })
    const secondPreview = await window.evaluate((id) => (globalThis as unknown as {
      readonly henshinLocalMapping: { readonly preview: (input: { readonly root_id: string }) => Promise<BrowserLocalPreview> }
    }).henshinLocalMapping.preview({ root_id: id }), rootId)
    if (!secondPreview.ok || secondPreview.data === null) throw new Error("second direct local preview failed")
    const staleActivation = await window.evaluate(
      ({ id, token }) => (globalThis as unknown as {
        readonly henshinLocalMapping: {
          readonly activate: (input: {
            readonly root_id: string
            readonly expected_mapping_revision: string
            readonly preview_token: string
          }) => Promise<BrowserResult<unknown>>
        }
      }).henshinLocalMapping.activate({ root_id: id, expected_mapping_revision: "1", preview_token: token }),
      { id: rootId, token: firstPreview.data.preview_token }
    )
    expect(staleActivation.ok).toBe(false)
    if (staleActivation.ok) throw new Error("stale activation unexpectedly succeeded")
    expect(staleActivation.error.code).toBe("local_mapping_stale")
    await expect(savedRoot.getByTestId("local-mapping-effective")).toContainText(localFixture)
    await expect(savedRoot.getByTestId("local-mapping-effective")).toContainText("revision 1")

    await setDialogResult(app, { canceled: true, filePaths: [] })
    await savedRoot.getByTestId("root-local-mapping").click()
    await expect(mapping).toBeVisible()
    await expect(savedRoot).toContainText(serverFixture)

    const inaccessible = path.join(localFixture, "does-not-exist")
    await setDialogResult(app, { canceled: false, filePaths: [inaccessible] })
    await savedRoot.getByTestId("root-local-mapping").click()
    await expect(window.getByTestId("local-mapping-error")).toContainText("could not be inspected")
    await expect(savedRoot.getByTestId("local-mapping-effective")).toContainText(localFixture)
    await window.getByTestId("open-library").click()
    await expect(window.getByTestId("library-screen")).toBeVisible()
    await expect(window.getByTestId("library-entry")).toHaveCount(2)

    await app.close()
    const restarted = await launch(dbPath)
    const restartedRoot = restarted.window.getByTestId("root-saved").filter({ hasText: "Mapping fixture" })
    await expect(restartedRoot.getByTestId("local-mapping-effective")).toContainText(localFixture)
    await expect(restartedRoot.getByTestId("local-mapping-effective")).toContainText("revision 1")
  } finally {
    await rm(dbDirectory, { recursive: true, force: true })
    await rm(serverFixture, { recursive: true, force: true })
    await rm(localFixture, { recursive: true, force: true })
  }
})
