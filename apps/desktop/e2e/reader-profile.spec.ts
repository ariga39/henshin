import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import electronPath from "electron"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP_DIR = fileURLToPath(new URL("..", import.meta.url))
const launched: ElectronApplication[] = []

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

test("saves a picked local reader profile across restart and preserves the saved value after invalid edits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "henshin-reader-profile-e2e-"))
  const dbPath = path.join(directory, "prototype.db")
  try {
    const first = await launch(dbPath)
    await expect(first.window.getByTestId("reader-settings")).toBeVisible()
    const executablePath = await first.app.evaluate(() => process.execPath)
    const executableName = path.basename(executablePath)

    await first.app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.execPath] })
    })
    await first.window.getByTestId("reader-profile-name").fill("Disposable reader")
    await first.window.getByTestId("reader-select-executable").click()
    await expect(first.window.getByTestId("reader-selected-executable")).toHaveText(executableName)
    await first.window.getByTestId("reader-profile-arguments").fill("--profile\n{target}")
    await first.window.getByTestId("reader-profile-save").click()
    const saved = first.window.getByTestId("reader-profile-list")
    await expect(saved).toContainText("Disposable reader")
    await expect(saved).toContainText(`executable: ${executableName}`)
    await expect(saved).toContainText("--profile")
    await expect(saved).toContainText("{target}")

    const profile = await first.window.evaluate(() => window.henshinReaderProfiles.list())
    if (!profile.ok || profile.data.length !== 1) throw new Error("saved reader profile was not returned")
    const current = profile.data[0]
    if (current === undefined) throw new Error("saved reader profile was absent")
    const stale = await first.window.evaluate((input) => window.henshinReaderProfiles.save(input), {
      profile_id: current.profile_id,
      expected_revision: "0",
      name: "stale edit",
      launch_mode: current.launch_mode,
      supported_formats: current.supported_formats,
      target_mode: current.target_mode,
      argument_tokens: current.argument_tokens,
      selection_handle: null
    })
    expect(stale).toMatchObject({ ok: false, error: { code: "reader_profile_conflict" } })
    await expect(saved).toContainText("Disposable reader")
    await expect(saved).not.toContainText("stale edit")

    await saved.getByRole("button", { name: "Edit" }).click()
    await first.window.getByTestId("reader-profile-target-mode").selectOption("first-image")
    await first.window.getByTestId("reader-profile-save").click()
    await expect(first.window.getByTestId("reader-profile-error")).toContainText("only compatible")
    await expect(saved).toContainText("Disposable reader")
    await expect(saved).toContainText("Archive")

    await first.window.getByTestId("open-library").click()
    await expect(first.window.getByTestId("library-screen")).toBeVisible()
    await first.window.getByTestId("library-setup").click()
    await expect(first.window.getByTestId("reader-settings")).toBeVisible()
    await expect(first.window.getByTestId("reader-profile-list")).toContainText("Disposable reader")

    await first.app.close()

    const restarted = await launch(dbPath)
    const reopened = restarted.window.getByTestId("reader-profile-list")
    await expect(reopened).toContainText("Disposable reader")
    await expect(reopened).toContainText(`executable: ${executableName}`)
    await expect(reopened).toContainText("--profile")
    await expect(reopened).toContainText("{target}")
    await expect(reopened).not.toContainText("stale edit")
    await reopened.getByRole("button", { name: "Edit" }).click()
    await expect(restarted.window.getByTestId("reader-profile-name")).toHaveValue("Disposable reader")
    await expect(restarted.window.getByTestId("reader-selected-executable")).toHaveText(executableName)
    await expect(restarted.window.getByTestId("reader-profile-arguments")).toHaveValue("--profile\n{target}")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
