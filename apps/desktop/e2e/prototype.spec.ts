import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from "@playwright/test"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
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

    // Recovery exposes the original result and a separately refreshed current
    // note so a later deliberate reapply is an informed choice.
    await first.window.getByTestId("load-recovery").click()
    await first.window.getByRole("article").getByRole("button", { name: "Reconcile" }).click()
    await expect(first.window.getByTestId("recovery-comparison")).toContainText("recovered result")
    await expect(first.window.getByTestId("recovery-comparison")).toContainText("persisted")
    await expect(first.window.getByTestId("recovery-comparison")).toContainText("current note")
    await expect(first.window.getByTestId("recovery-comparison")).toContainText("revision 1")
    await expect(first.window.getByTestId("recovery-comparison")).toContainText("lookup expiry")

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

test("rejects a stale direct edit after the main session epoch changes without dispatch or overwrite", async () => {
  const dbPath = await tempDbPath()
  const clientDbPath = `${dbPath}.desktop`
  let oldEpoch = ""

  const first = await launch(dbPath, clientDbPath)
  try {
    await first.window.getByTestId("load").click()
    await expect(first.window.getByTestId("note-text")).toHaveText("hello")
    oldEpoch = (await first.window.getByTestId("epoch").textContent()) ?? ""
    await first.window.getByTestId("text-input").fill("retained-from-old-epoch")
    await first.window.getByTestId("save-local-draft").click()
    await expect(first.window.getByTestId("outcome")).toContainText("local draft saved")
  } finally {
    await close(first.app)
  }

  const second = await launch(dbPath, clientDbPath)
  try {
    await second.window.getByTestId("load").click()
    await expect(second.window.getByTestId("note-text")).toHaveText("hello")
    await expect(second.window.getByTestId("epoch")).not.toHaveText(oldEpoch)
    await second.window.getByTestId("load-local-draft").click()
    await expect(second.window.getByTestId("text-input")).toHaveValue("retained-from-old-epoch")
    await expect(second.window.getByTestId("draft-status")).toContainText(`base epoch=${oldEpoch}`)

    const staleEdit = await second.window.evaluate((baseEpoch) =>
      window.henshinPrototype.editNote({
        note_id: "note-1",
        text: "must-not-overwrite",
        expected_revision: "0",
        base_epoch: baseEpoch,
        operation_id: "77777777-7777-4777-8777-777777777777"
      }), oldEpoch)
    expect(staleEdit).toEqual({
      ok: false,
      error: {
        code: "epoch_changed",
        message: "authority epoch changed; reload the current note before saving",
        retryable: true
      }
    })

    await expect(second.window.evaluate(() => window.henshinPrototype.getNote("note-1")))
      .resolves.toMatchObject({ ok: true, data: { text: "hello", revision: "0" } })
    await expect(second.window.evaluate(() => window.henshinPrototype.listCommandAttempts()))
      .resolves.toEqual({ ok: true, data: [] })
  } finally {
    await close(second.app)
  }
})

test("retains an unresolved command across Electron restart and shows epoch-change comparison without replay", async () => {
  const dbPath = await tempDbPath()
  const clientDbPath = `${dbPath}.desktop`
  const operationId = randomUUID()
  let instanceId = ""
  let oldEpoch = ""

  const first = await launch(dbPath, clientDbPath)
  try {
    await first.window.getByTestId("load").click()
    await expect(first.window.getByTestId("note-text")).toHaveText("hello")
    // Initialize the real desktop SQLite schema before seeding its durable row.
    await expect(
      first.window.evaluate(() => window.henshinPrototype.loadDraft({ note_id: "note-1", form_id: "synthetic-note" }))
    ).resolves.toMatchObject({ ok: true, data: null })
    instanceId = (await first.window.getByTestId("instance").textContent()) ?? ""
    oldEpoch = (await first.window.getByTestId("epoch").textContent()) ?? ""
  } finally {
    await close(first.app)
  }

  // Seed only the unresolved durable row after the first real Electron run has
  // created the production SQLite schema. The second run exercises main IPC,
  // the real local worker, the fresh server epoch, and the Recovery UI.
  const localDb = new DatabaseSync(clientDbPath)
  const now = Date.now()
  localDb.prepare(`
    INSERT INTO command_attempts(
      instance_id, operation_id, note_id, intent_text, base_revision, epoch,
      status, created_at_ms, updated_at_ms, result_note, expires_at_ms,
      error_code, error_message, current_revision, dismissed
    ) VALUES(?, ?, ?, ?, ?, ?, 'submitted', ?, ?, NULL, NULL, NULL, NULL, NULL, 0)
  `).run(instanceId, operationId, "note-1", "restart-intent", 0, oldEpoch, now, now)
  localDb.close()

  const second = await launch(dbPath, clientDbPath)
  try {
    await second.window.getByTestId("load").click()
    await second.window.getByTestId("load-recovery").click()
    const recovery = second.window.getByTestId(`recovery-${operationId}`)
    await expect(recovery).toContainText("restart-intent")
    await expect(recovery).toContainText("from revision 0")
    await recovery.getByRole("button", { name: "Reconcile" }).click()

    const comparison = second.window.getByTestId("recovery-comparison")
    await expect(comparison).toContainText("original intent: “restart-intent” from revision 0")
    await expect(comparison).toContainText("recovered result: unavailable or expired")
    await expect(comparison).toContainText("current note: “hello” at revision 0")
    await expect(comparison).toContainText("authority epoch changed")
    await expect(second.window.getByTestId("epoch")).not.toHaveText(oldEpoch)

    const note = await second.window.evaluate(() => window.henshinPrototype.getNote("note-1"))
    expect(note).toMatchObject({ ok: true, data: { text: "hello", revision: "0" } })
  } finally {
    await close(second.app)
  }
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
    await expect(first.window.getByTestId("note-text")).toHaveText("hello")
    await first.window.getByTestId("text-input").fill("instance-one")
    await first.window.getByTestId("save-local-draft").click()
    await expect(first.window.getByTestId("outcome")).toContainText("local draft saved revision=1")
  } finally {
    await close(first.app)
  }

  const second = await launch(secondServerDb, clientDbPath)
  try {
    await second.window.getByTestId("load").click()
    await expect(second.window.getByTestId("note-text")).toHaveText("hello")
    await second.window.getByTestId("load-local-draft").click()
    await expect(second.window.getByTestId("outcome")).toHaveText("error no saved local draft")
    await expect(second.window.getByTestId("text-input")).toHaveValue("hello")
  } finally {
    await close(second.app)
  }

  const firstAgain = await launch(firstServerDb, clientDbPath)
  try {
    await firstAgain.window.getByTestId("load").click()
    await expect(firstAgain.window.getByTestId("note-text")).toHaveText("hello")
    await firstAgain.window.getByTestId("load-local-draft").click()
    await expect(firstAgain.window.getByTestId("text-input")).toHaveValue("instance-one")
  } finally {
    await close(firstAgain.app)
  }
})

test("pauses direct server IPC while retaining local recovery and form state across reconnect", async () => {
  const dbPath = await tempDbPath()
  const clientDbPath = `${dbPath}.desktop`
  const app = await launch(dbPath, clientDbPath)

  try {
    await app.window.getByTestId("load").click()
    await expect(app.window.getByTestId("connection-status")).toHaveText("connected")
    await expect(app.window.getByTestId("note-text")).toHaveText("hello")
    await app.window.getByTestId("text-input").fill("retained while disconnected")
    await app.window.getByTestId("save-local-draft").click()
    await expect(app.window.getByTestId("outcome")).toContainText("local draft saved")

    await app.window.getByTestId("disconnect").click()
    await expect(app.window.getByTestId("connection-status")).toHaveText("disconnected")
    await expect(app.window.getByTestId("save")).toBeDisabled()
    await expect(app.window.getByTestId("load")).toBeDisabled()
    await expect(app.window.getByTestId("text-input")).toHaveValue("retained while disconnected")
    await expect(app.window.getByTestId("save-local-draft")).toBeEnabled()
    await expect(app.window.getByTestId("load-recovery")).toBeEnabled()

    const disconnectedCalls = await app.window.evaluate(async () => ({
      note: await window.henshinPrototype.getNote("note-1"),
      draft: await window.henshinPrototype.loadDraft({ note_id: "note-1", form_id: "synthetic-note" }),
      attempts: await window.henshinPrototype.listCommandAttempts(),
      dismiss: await window.henshinPrototype.dismissCommand("11111111-1111-4111-8111-111111111111")
    }))
    expect(disconnectedCalls.note).toMatchObject({ ok: false, error: { code: "connection_paused" } })
    expect(disconnectedCalls.draft).toMatchObject({ ok: true, data: { text: "retained while disconnected" } })
    expect(disconnectedCalls.attempts).toEqual({ ok: true, data: [] })
    expect(disconnectedCalls.dismiss).toMatchObject({ ok: false })
    expect((disconnectedCalls.dismiss as { error: { code: string } }).error.code).not.toBe("connection_paused")

    await app.window.getByTestId("reconnect").click()
    await expect(app.window.getByTestId("connection-status")).toHaveText("connected")
    await expect(app.window.getByTestId("note-text")).toHaveText("hello")
    await expect(app.window.getByTestId("base-revision")).toHaveText("0")
    await expect(app.window.getByTestId("text-input")).toHaveValue("retained while disconnected")
  } finally {
    await close(app.app)
  }
})
