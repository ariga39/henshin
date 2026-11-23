import { _electron as electron, expect } from "@playwright/test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const executablePath = process.env.HENSHIN_EXECUTABLE
if (executablePath === undefined) throw new Error("HENSHIN_EXECUTABLE is required")
if (!executablePath.includes(" ")) throw new Error("the packaged executable must be launched from a path with spaces")

const acceptanceRoot = path.join(
  process.env.RUNNER_TEMP ?? process.cwd(),
  "henshin Windows desktop acceptance data with spaces"
)
const databaseDirectory = path.join(acceptanceRoot, "managed library data")
const databasePath = path.join(databaseDirectory, "managed-library.db")
const fixtureDirectory = path.join(acceptanceRoot, "collection fixture with spaces")
const bookDirectory = path.join(fixtureDirectory, "book with spaces")
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
)

await rm(acceptanceRoot, { recursive: true, force: true })
await mkdir(databaseDirectory, { recursive: true })
await mkdir(bookDirectory, { recursive: true })
await writeFile(path.join(bookDirectory, "001.png"), validPng)

const environment = {
  ...process.env,
  HENSHIN_PROTOTYPE_DB: databasePath,
  HENSHIN_PROTOTYPE_CLIENT_DB: `${databasePath}.client`
}

const launch = () =>
  electron.launch({
    executablePath,
    env: environment,
    timeout: 120_000
  })

let app = null
try {
  app = await launch()
  const firstWindow = await app.firstWindow()
  await expect(firstWindow.getByRole("heading", { name: "Collection setup" })).toBeVisible()
  await firstWindow.getByTestId("root-preview-path").fill(fixtureDirectory)
  await firstWindow.getByTestId("root-preview-submit").click()
  await expect(firstWindow.getByTestId("root-preview-selected-path")).toHaveText(fixtureDirectory)
  await firstWindow.getByTestId("root-label").fill("Windows spaced library")
  await firstWindow.getByTestId("root-save").click()
  await expect(firstWindow.getByTestId("root-saved")).toContainText("Windows spaced library")
  await firstWindow.getByTestId("root-saved-preview").click()
  await firstWindow.getByTestId("scan-hold-new-discoveries").uncheck()
  await firstWindow.getByTestId("start-held-scan").click()
  await expect(firstWindow.getByTestId("library-entry")).toHaveCount(1, { timeout: 60_000 })
  await app.close()
  app = null

  app = await launch()
  const secondWindow = await app.firstWindow()
  await expect(secondWindow.getByTestId("root-saved")).toContainText("Windows spaced library")
  await secondWindow.getByTestId("open-library").click()
  await expect(secondWindow.getByTestId("library-entry")).toHaveCount(1, { timeout: 60_000 })
  console.log("Windows packaged desktop restart acceptance passed")
} finally {
  if (app !== null) await app.close().catch(() => undefined)
  await rm(acceptanceRoot, { recursive: true, force: true })
}
