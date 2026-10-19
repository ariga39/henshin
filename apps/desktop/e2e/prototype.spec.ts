import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from "@playwright/test"
import electronPath from "electron"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP_DIR = fileURLToPath(new URL("..", import.meta.url))
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Launched {
  readonly app: ElectronApplication
  readonly window: Page
}

// Every launched app is tracked so a failing assertion can never leave a window
// or an owned server child running.
const launched: ElectronApplication[] = []

const launch = async (dbPath: string, clientDbPath = `${dbPath}.client`): Promise<Launched> => {
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
  const window = await app.firstWindow()
  return { app, window }
}

const close = async (app: ElectronApplication): Promise<void> => {
  const index = launched.indexOf(app)
  if (index >= 0) launched.splice(index, 1)
  await app.close()
}

const tempDbPath = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "henshin-e2e-"))
  return path.join(dir, "prototype.db")
}

test.afterEach(async () => {
  for (const app of launched.splice(0)) {
    try {
      await app.close()
    } catch {
      // Best-effort teardown of a leaked app.
    }
  }
})

test("a synthetic conditional edit commits, persists across restart, and reports a stale conflict without writing", async () => {
  const dbPath = await tempDbPath()
  const observed: {
    firstInstance?: string
    firstEpoch?: string
    secondInstance?: string
    secondEpoch?: string
  } = {}

  const first = await launch(dbPath)
  try {
    await first.window.getByTestId("load").click()
    await expect(first.window.getByTestId("committed-revision")).toHaveText("0")
    await expect(first.window.getByTestId("base-revision")).toHaveText("0")
    observed.firstInstance = (await first.window.getByTestId("instance").textContent()) ?? ""
    observed.firstEpoch = (await first.window.getByTestId("epoch").textContent()) ?? ""

    await first.window.getByTestId("text-input").fill("persisted")
    await first.window.getByTestId("save").click()
    await expect(first.window.getByTestId("outcome")).toContainText("committed revision=1")
    await expect(first.window.getByTestId("committed-revision")).toHaveText("1")

    // A second save from the same captured revision is a stale conflict and must
    // not change committed state.
    await first.window.getByTestId("text-input").fill("conflicting")
    await first.window.getByTestId("save").click()
    await expect(first.window.getByTestId("outcome")).toContainText("conflict current_revision=1")
    await expect(first.window.getByTestId("committed-revision")).toHaveText("1")
  } finally {
    await close(first.app)
  }

  const second = await launch(dbPath)
  try {
    await second.window.getByTestId("load").click()
    await expect(second.window.getByTestId("note-text")).toHaveText("persisted")
    await expect(second.window.getByTestId("committed-revision")).toHaveText("1")
    observed.secondInstance = (await second.window.getByTestId("instance").textContent()) ?? ""
    observed.secondEpoch = (await second.window.getByTestId("epoch").textContent()) ?? ""
  } finally {
    await close(second.app)
  }

  // Both namespace identifiers are real UUIDs, not placeholder text.
  expect(observed.firstInstance).toMatch(UUID_PATTERN)
  expect(observed.firstEpoch).toMatch(UUID_PATTERN)
  expect(observed.secondInstance).toMatch(UUID_PATTERN)
  expect(observed.secondEpoch).toMatch(UUID_PATTERN)

  // Same namespace, fresh authority epoch after restart.
  expect(observed.secondInstance).toBe(observed.firstInstance)
  expect(observed.secondEpoch).not.toBe(observed.firstEpoch)
})

test("saves a bounded local draft across restart and preserves ABA CAS conflicts", async () => {
  const dbPath = await tempDbPath()
  const clientDbPath = `${dbPath}.desktop`

  const first = await launch(dbPath, clientDbPath)
  try {
    await first.window.getByTestId("load").click()
    await expect(first.window.getByTestId("note-text")).toHaveText("hello")
    const epoch = (await first.window.getByTestId("epoch").textContent()) ?? ""

    await first.window.getByTestId("text-input").fill("local-one")
    await first.window.getByTestId("save-local-draft").click()
    await expect(first.window.getByTestId("outcome")).toContainText("local draft saved revision=1")

    const staleSave = await first.window.evaluate(async (baseEpoch) =>
      window.henshinPrototype.saveDraft({
        note_id: "note-1",
        form_id: "synthetic-note",
        text: "stale-save",
        expected_local_revision: "0",
        base_server_revision: "0",
        base_epoch: baseEpoch
      }), epoch)
    expect(staleSave).toEqual({
      ok: false,
      error: {
        code: "draft_conflict",
        message: "saved draft changed in another window",
        retryable: false,
        current_local_revision: "1"
      }
    })

    const staleDiscard = await first.window.evaluate(() =>
      window.henshinPrototype.discardDraft({
        note_id: "note-1",
        form_id: "synthetic-note",
        expected_local_revision: "0"
      }))
    expect(staleDiscard).toEqual({
      ok: false,
      error: {
        code: "draft_conflict",
        message: "saved draft changed in another window",
        retryable: false,
        current_local_revision: "1"
      }
    })

    const preserved = await first.window.evaluate(() =>
      window.henshinPrototype.loadDraft({ note_id: "note-1", form_id: "synthetic-note" }))
    expect(preserved).toMatchObject({ ok: true, data: { text: "local-one", local_revision: "1" } })

    await first.window.getByTestId("discard-local-draft").click()
    await expect(first.window.getByTestId("outcome")).toContainText("local draft discarded revision=2")
    const tombstone = await first.window.evaluate(() =>
      window.henshinPrototype.loadDraft({ note_id: "note-1", form_id: "synthetic-note" }))
    expect(tombstone).toMatchObject({
      ok: true,
      data: { local_revision: "2" }
    })
    expect((tombstone as { data: Record<string, unknown> }).data.text).toBeUndefined()

    await first.window.getByTestId("text-input").fill("local-two")
    await first.window.getByTestId("save-local-draft").click()
    await expect(first.window.getByTestId("outcome")).toContainText("local draft saved revision=3")

    const staleAfterRecreate = await first.window.evaluate(async (baseEpoch) => {
      const save = await window.henshinPrototype.saveDraft({
        note_id: "note-1",
        form_id: "synthetic-note",
        text: "aba-overwrite",
        expected_local_revision: "1",
        base_server_revision: "0",
        base_epoch: baseEpoch
      })
      const discard = await window.henshinPrototype.discardDraft({
        note_id: "note-1",
        form_id: "synthetic-note",
        expected_local_revision: "1"
      })
      return { save, discard }
    }, epoch)
    expect(staleAfterRecreate.save).toMatchObject({ ok: false, error: { code: "draft_conflict", current_local_revision: "3" } })
    expect(staleAfterRecreate.discard).toMatchObject({ ok: false, error: { code: "draft_conflict", current_local_revision: "3" } })

    const invalid = await first.window.evaluate(() =>
      window.henshinPrototype.saveDraft({
        note_id: "",
        form_id: "synthetic-note",
        text: "invalid",
        expected_local_revision: "0",
        base_server_revision: "0",
        base_epoch: "not-an-epoch"
      }))
    expect(invalid).toEqual({ ok: false, error: { code: "invalid_request", message: "invalid IPC request", retryable: false } })
  } finally {
    await close(first.app)
  }

  const second = await launch(dbPath, clientDbPath)
  try {
    await second.window.getByTestId("load").click()
    // Local draft operations never touched the authoritative server note.
    await expect(second.window.getByTestId("note-text")).toHaveText("hello")
    await second.window.getByTestId("load-local-draft").click()
    await expect(second.window.getByTestId("text-input")).toHaveValue("local-two")
    await expect(second.window.getByTestId("draft-status")).toContainText("local revision=3")
    await second.window.getByTestId("discard-local-draft").click()
    await expect(second.window.getByTestId("outcome")).toContainText("local draft discarded revision=4")
  } finally {
    await close(second.app)
  }
})

test("does not cross-read a saved draft between verified server instances", async () => {
  const firstServerDb = await tempDbPath()
  const secondServerDb = await tempDbPath()
  const clientDbPath = `${firstServerDb}.desktop`

  const first = await launch(firstServerDb, clientDbPath)
  try {
    await first.window.getByTestId("load").click()
    await first.window.getByTestId("text-input").fill("instance-one")
    await first.window.getByTestId("save-local-draft").click()
    await expect(first.window.getByTestId("outcome")).toContainText("local draft saved revision=1")
  } finally {
    await close(first.app)
  }

  const second = await launch(secondServerDb, clientDbPath)
  try {
    await second.window.getByTestId("load").click()
    await second.window.getByTestId("load-local-draft").click()
    await expect(second.window.getByTestId("outcome")).toHaveText("error no saved local draft")
    await expect(second.window.getByTestId("text-input")).toHaveValue("hello")
  } finally {
    await close(second.app)
  }

  const firstAgain = await launch(firstServerDb, clientDbPath)
  try {
    await firstAgain.window.getByTestId("load").click()
    await firstAgain.window.getByTestId("load-local-draft").click()
    await expect(firstAgain.window.getByTestId("text-input")).toHaveValue("instance-one")
  } finally {
    await close(firstAgain.app)
  }
})
