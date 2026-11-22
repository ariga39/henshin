import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import electronPath from "electron"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
    await first.app.close()

    const restarted = await launch(dbPath)
    const reopened = restarted.window.getByTestId("reader-profile-list")
    await expect(reopened).toContainText("Disposable reader")
    await expect(reopened).toContainText(`executable: ${executableName}`)
    await expect(reopened).toContainText("--profile")
    await expect(reopened).toContainText("{target}")
    await expect(reopened).not.toContainText("stale edit")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("previews and test-launches a saved profile with a disposable target, revision recheck, and argv recording", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "henshin reader test target "))
  const targetPath = path.join(directory, "disposable target.cbz")
  const missingTargetPath = path.join(directory, "missing target.cbz")
  const recordPath = path.join(directory, "argv record.json")
  await writeFile(targetPath, "disposable fixture", "utf8")
  try {
    const first = await launch(path.join(directory, "prototype.db"))
    await expect(first.window.getByTestId("reader-settings")).toBeVisible()
    const fixtureExecutable = process.execPath
    const recorderScript = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))"
    const selections = [fixtureExecutable, missingTargetPath, targetPath]
    await first.app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [input.queuedSelections.shift() ?? input.fallback]
      })
    }, { queuedSelections: selections, fallback: targetPath })

    await first.window.getByTestId("reader-profile-name").fill("Disposable target reader")
    await first.window.getByTestId("reader-select-executable").click()
    await first.window.getByTestId("reader-profile-arguments").fill(
      `-e\n${recorderScript}\n${recordPath}\n--fixture\n{target}`
    )
    await first.window.getByTestId("reader-profile-save").click()
    const saved = first.window.getByTestId("reader-profile-list")
    await expect(saved).toContainText("Disposable target reader")
    const listed = await first.window.evaluate(() => window.henshinReaderProfiles.list())
    if (!listed.ok || listed.data.length !== 1) throw new Error("saved disposable profile was not returned")
    const profile = listed.data[0]
    if (profile === undefined) throw new Error("saved disposable profile was absent")
    const row = first.window.getByTestId(`reader-profile-${profile.profile_id}`)

    await row.getByTestId(`reader-profile-preview-${profile.profile_id}`).click()
    await expect(first.window.getByTestId("reader-profile-test-error")).toContainText("unavailable")
    await row.getByTestId(`reader-profile-preview-${profile.profile_id}`).click()
    await expect(first.window.getByTestId("reader-profile-test-target")).toHaveText(`Resolved test target: ${targetPath}`)

    const changed = await first.window.evaluate((current) => window.henshinReaderProfiles.save({
      profile_id: current.profile_id,
      expected_revision: current.revision,
      name: "Changed while previewing",
      launch_mode: current.launch_mode,
      supported_formats: current.supported_formats,
      target_mode: current.target_mode,
      argument_tokens: current.argument_tokens,
      selection_handle: null
    }), profile)
    expect(changed).toMatchObject({ ok: true, data: { revision: "2" } })
    await row.getByTestId(`reader-profile-test-${profile.profile_id}`).click()
    await expect(first.window.getByTestId("reader-profile-test-error")).toContainText("changed in another window")

    await first.window.reload()
    const corrected = await first.window.getByTestId("reader-profile-list")
    await expect(corrected).toContainText("Changed while previewing")
    const correctedProfile = (await first.window.evaluate(() => window.henshinReaderProfiles.list()))
    if (!correctedProfile.ok || correctedProfile.data[0] === undefined) throw new Error("corrected profile was absent")
    const correctedRow = first.window.getByTestId(`reader-profile-${correctedProfile.data[0].profile_id}`)
    await correctedRow.getByTestId(`reader-profile-preview-${correctedProfile.data[0].profile_id}`).click()
    await expect(first.window.getByTestId("reader-profile-test-target")).toHaveText(`Resolved test target: ${targetPath}`)
    await correctedRow.getByTestId(`reader-profile-test-${correctedProfile.data[0].profile_id}`).click()
    await expect(first.window.getByTestId("reader-profile-test-result")).toContainText("accepted")
    await expect.poll(async () => {
      try {
        return await readFile(recordPath, "utf8")
      } catch {
        return ""
      }
    }).toBe(JSON.stringify(["--fixture", targetPath]))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
