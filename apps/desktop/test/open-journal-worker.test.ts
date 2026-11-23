import { build } from "esbuild"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { Worker } from "node:worker_threads"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import { OpenEventHttpClient } from "@henshin/contracts"
import { deliverOpenEvents } from "../src/main/OpenEventDelivery"
import type { OpenJournalStore } from "../src/main/persistence/OpenJournalStore"
import type { OpenJournalRow } from "../src/main/persistence/draft-worker-protocol"

const repoDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const OPEN_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

interface WorkerResponse {
  readonly id: number
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
}

interface RunningWorker {
  readonly worker: Worker
  readonly call: (request: Record<string, unknown>) => Promise<unknown>
  readonly close: () => Promise<void>
}

let workerUrl: URL
let workerBuildDirectory = ""
const workerDirectories = new Set<string>()
const workers = new Set<RunningWorker>()

const startWorker = async (dbPath?: string): Promise<{ readonly running: RunningWorker; readonly dbPath: string }> => {
  const directory = dbPath === undefined ? await mkdtemp(path.join(os.tmpdir(), "henshin-open-journal-")) : undefined
  if (directory !== undefined) workerDirectories.add(directory)
  const databasePath = dbPath ?? path.join(directory!, "desktop.db")
  const worker = new Worker(workerUrl, { workerData: { dbPath: databasePath } })
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  worker.on("message", (raw: WorkerResponse) => {
    const entry = pending.get(raw.id)
    if (entry === undefined) return
    pending.delete(raw.id)
    if (raw.ok) entry.resolve(raw.value)
    else entry.reject(new Error(raw.error ?? "open journal worker request failed"))
  })
  worker.on("error", (error) => {
    const failure = error instanceof Error ? error : new Error(String(error))
    for (const entry of pending.values()) entry.reject(failure)
    pending.clear()
  })

  const call = (request: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, request })
    })
  }
  const close = async (): Promise<void> => {
    try {
      await call({ op: "close" })
    } finally {
      await worker.terminate()
    }
  }
  const running = { worker, call, close }
  workers.add(running)
  return { running, dbPath: databasePath }
}

const prepare = (running: RunningWorker, input: Record<string, unknown> = {}) =>
  running.call({
    op: "prepareOpen",
    instanceId: randomUUID(),
    actionId: randomUUID(),
    entryId: randomUUID(),
    deviceId: randomUUID(),
    observedLocationRevision: "3",
    observedContentVersion: "5",
    ...input
  })

const eventFor = (input: {
  readonly instanceId: string
  readonly actionId: string
  readonly entryId: string
  readonly deviceId: string
  readonly occurredAtMs?: number
}) => ({
  event_id: input.actionId,
  instance_id: input.instanceId,
  entry_id: input.entryId,
  device_id: input.deviceId,
  observed_location_revision: "3",
  observed_content_version: "5",
  occurred_at_ms: input.occurredAtMs ?? 1_700_000_000_000
})

beforeAll(async () => {
  workerBuildDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-open-journal-build-"))
  const workerPath = path.join(workerBuildDirectory, "draft-worker.mjs")
  await build({
    entryPoints: [path.join(repoDirectory, "apps/desktop/src/main/persistence/draft-worker.ts")],
    outfile: workerPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent"
  })
  workerUrl = pathToFileURL(workerPath)
})

afterAll(async () => {
  for (const running of workers) {
    try {
      await running.close()
    } catch {
      await running.worker.terminate()
    }
  }
  workers.clear()
  for (const directory of workerDirectories) await rm(directory, { recursive: true, force: true })
  workerDirectories.clear()
  await rm(workerBuildDirectory, { recursive: true, force: true })
})

describe("desktop open journal SQLite worker", () => {
  it("keeps an accepted Open event immutable across a fresh worker restart", async () => {
    const first = await startWorker()
    const instanceId = randomUUID()
    const actionId = randomUUID()
    const entryId = randomUUID()
    const deviceId = randomUUID()
    const input = { instanceId, actionId, entryId, deviceId }
    const event = eventFor(input)

    await expect(prepare(first.running, input)).resolves.toMatchObject({
      kind: "admitted",
      entry: { status: "prepared", event: null }
    })
    await expect(first.running.call({ op: "recordOpenAccepted", instanceId, actionId, event })).resolves.toMatchObject({
      kind: "updated",
      entry: { status: "accepted", event }
    })
    await expect(first.running.call({ op: "recordOpenAccepted", instanceId, actionId, event })).resolves.toMatchObject({
      kind: "existing",
      entry: { status: "accepted", event }
    })

    await first.running.close()
    workers.delete(first.running)
    const reopened = await startWorker(first.dbPath)
    await expect(reopened.running.call({ op: "getOpenJournal", instanceId, actionId })).resolves.toMatchObject({
      status: "accepted",
      deliveryStatus: "pending",
      event: { event_id: actionId, occurred_at_ms: event.occurred_at_ms }
    })
    await expect(reopened.running.call({ op: "acknowledgeOpenEvent", instanceId, actionId })).resolves.toMatchObject({
      kind: "updated",
      entry: { status: "accepted", deliveryStatus: "acknowledged", event }
    })
    await reopened.running.close()
    workers.delete(reopened.running)
    const acknowledged = await startWorker(first.dbPath)
    await expect(acknowledged.running.call({ op: "getOpenJournal", instanceId, actionId })).resolves.toMatchObject({
      status: "accepted",
      deliveryStatus: "acknowledged"
    })
  })

  it("admits the 65th handoff after restart and replays an acknowledged action idempotently", async () => {
    const first = await startWorker()
    const instanceId = randomUUID()
    let firstInput: Record<string, string> | undefined
    let firstEvent: ReturnType<typeof eventFor> | undefined

    for (let index = 0; index < 64; index += 1) {
      const input = {
        instanceId,
        actionId: randomUUID(),
        entryId: randomUUID(),
        deviceId: randomUUID()
      }
      const event = eventFor(input)
      if (firstInput === undefined) {
        firstInput = input
        firstEvent = event
      }
      await expect(prepare(first.running, input)).resolves.toMatchObject({ kind: "admitted" })
      await expect(first.running.call({ op: "recordOpenAccepted", ...input, event })).resolves.toMatchObject({
        kind: "updated",
        entry: { deliveryStatus: "pending", event }
      })
      await expect(first.running.call({
        op: "acknowledgeOpenEvent",
        instanceId,
        actionId: input.actionId
      })).resolves.toMatchObject({ kind: "updated", entry: { deliveryStatus: "acknowledged" } })
    }

    await first.running.close()
    workers.delete(first.running)
    const reopened = await startWorker(first.dbPath)
    const nextInput = {
      instanceId,
      actionId: randomUUID(),
      entryId: randomUUID(),
      deviceId: randomUUID()
    }

    await expect(prepare(reopened.running, nextInput)).resolves.toMatchObject({ kind: "admitted" })
    await expect(prepare(reopened.running, firstInput!)).resolves.toMatchObject({
      kind: "existing",
      entry: { status: "accepted", deliveryStatus: "acknowledged", event: firstEvent }
    })
    await expect(reopened.running.call({
      op: "recordOpenAccepted",
      ...firstInput!,
      event: firstEvent
    })).resolves.toMatchObject({
      kind: "existing",
      entry: { status: "accepted", deliveryStatus: "acknowledged", event: firstEvent }
    })
    await expect(reopened.running.call({ op: "listOpenJournal", instanceId })).resolves.toHaveLength(65)
  })

  it("owns an action ID and never overwrites its entry or event attribution", async () => {
    const { running } = await startWorker()
    const instanceId = randomUUID()
    const actionId = randomUUID()
    const firstEntry = randomUUID()
    const secondEntry = randomUUID()
    const deviceId = randomUUID()

    await expect(prepare(running, { instanceId, actionId, entryId: firstEntry, deviceId })).resolves.toMatchObject({
      kind: "admitted"
    })
    await expect(prepare(running, { instanceId, actionId, entryId: secondEntry, deviceId })).resolves.toEqual({
      kind: "conflict"
    })
    await expect(running.call({
      op: "recordOpenAccepted",
      instanceId,
      actionId,
      event: eventFor({ instanceId, actionId, entryId: secondEntry, deviceId })
    })).resolves.toEqual({ kind: "conflict" })
    await expect(running.call({ op: "getOpenJournal", instanceId, actionId })).resolves.toMatchObject({
      entryId: firstEntry,
      status: "prepared",
      event: null
    })
  })

  it("records definite failure without an event and recovers an unresolved intent as unknown", async () => {
    const first = await startWorker()
    const instanceId = randomUUID()
    const failedActionId = randomUUID()
    const pendingActionId = randomUUID()
    const failedInput = { instanceId, actionId: failedActionId }
    const pendingInput = { instanceId, actionId: pendingActionId }

    await expect(prepare(first.running, failedInput)).resolves.toMatchObject({ kind: "admitted" })
    await expect(first.running.call({
      op: "recordOpenFailed",
      instanceId,
      actionId: failedActionId,
      failureCode: "reader_failed",
      failureMessage: "reader did not accept the target"
    })).resolves.toMatchObject({
      kind: "updated",
      entry: { status: "failed", event: null, failureCode: "reader_failed" }
    })
    await expect(prepare(first.running, pendingInput)).resolves.toMatchObject({ kind: "admitted" })

    await first.running.close()
    workers.delete(first.running)
    const reopened = await startWorker(first.dbPath)
    await expect(reopened.running.call({ op: "getOpenJournal", instanceId, actionId: failedActionId })).resolves.toMatchObject({
      status: "failed",
      event: null
    })
    const unknown = await reopened.running.call({ op: "getOpenJournal", instanceId, actionId: pendingActionId }) as {
      entryId: string
      deviceId: string
    }
    await expect(unknown).toMatchObject({
      status: "unknown",
      event: null
    })
    await expect(reopened.running.call({
      op: "recordOpenAccepted",
      instanceId,
      actionId: pendingActionId,
      event: eventFor({
        instanceId,
        actionId: pendingActionId,
        entryId: unknown.entryId,
        deviceId: unknown.deviceId
      })
    })).resolves.toEqual({ kind: "conflict" })
  })

  it("dismisses unknown intents and held events only after restart, without removing live rows", async () => {
    const first = await startWorker()
    const instanceId = randomUUID()
    const otherInstanceId = randomUUID()
    const unknownActionId = randomUUID()
    const heldActionId = randomUUID()
    const pendingActionId = randomUUID()
    const acknowledgedActionId = randomUUID()
    const failedActionId = randomUUID()

    const accepted = async (actionId: string) => {
      const input = { instanceId, actionId }
      const prepared = await prepare(first.running, input) as { entry: { entryId: string; deviceId: string } }
      await expect(first.running.call({
        op: "recordOpenAccepted",
        instanceId,
        actionId,
        event: eventFor({ instanceId, actionId, entryId: prepared.entry.entryId, deviceId: prepared.entry.deviceId })
      })).resolves.toMatchObject({ kind: "updated" })
    }

    await expect(prepare(first.running, { instanceId, actionId: unknownActionId })).resolves.toMatchObject({ kind: "admitted" })
    await accepted(heldActionId)
    await accepted(pendingActionId)
    await accepted(acknowledgedActionId)
    await expect(prepare(first.running, { instanceId, actionId: failedActionId })).resolves.toMatchObject({ kind: "admitted" })
    await expect(first.running.call({
      op: "recordOpenFailed",
      instanceId,
      actionId: failedActionId,
      failureCode: "reader_failed",
      failureMessage: "reader rejected the target"
    })).resolves.toMatchObject({ kind: "updated" })
    await expect(first.running.call({
      op: "acknowledgeOpenEvent",
      instanceId,
      actionId: acknowledgedActionId
    })).resolves.toMatchObject({ kind: "updated" })
    await expect(first.running.call({
      op: "holdOpenEvent",
      instanceId,
      actionId: heldActionId,
      deliveryErrorCode: "offline",
      deliveryErrorMessage: "server unavailable"
    })).resolves.toMatchObject({ kind: "updated" })

    await expect(first.running.call({
      op: "dismissUnknownOpen",
      instanceId,
      actionId: unknownActionId
    })).resolves.toEqual({ kind: "conflict" })
    await expect(first.running.call({
      op: "discardHeldOpenEvent",
      instanceId,
      actionId: pendingActionId
    })).resolves.toEqual({ kind: "conflict" })

    for (let outstanding = 3; outstanding < 64; outstanding += 1) {
      await expect(prepare(first.running, { instanceId })).resolves.toMatchObject({ kind: "admitted" })
    }

    await first.running.close()
    workers.delete(first.running)
    const reopened = await startWorker(first.dbPath)

    await expect(prepare(reopened.running, { instanceId })).resolves.toEqual({ kind: "full" })

    await expect(reopened.running.call({
      op: "dismissUnknownOpen",
      instanceId: otherInstanceId,
      actionId: unknownActionId
    })).resolves.toEqual({ kind: "not_found" })
    await expect(reopened.running.call({
      op: "getOpenJournal",
      instanceId,
      actionId: unknownActionId
    })).resolves.toMatchObject({ status: "unknown" })
    await expect(reopened.running.call({
      op: "dismissUnknownOpen",
      instanceId,
      actionId: unknownActionId
    })).resolves.toEqual({ kind: "deleted" })
    await expect(reopened.running.call({
      op: "discardHeldOpenEvent",
      instanceId,
      actionId: heldActionId
    })).resolves.toEqual({ kind: "deleted" })
    await expect(reopened.running.call({
      op: "discardHeldOpenEvent",
      instanceId,
      actionId: pendingActionId
    })).resolves.toEqual({ kind: "conflict" })
    await expect(reopened.running.call({
      op: "discardHeldOpenEvent",
      instanceId,
      actionId: acknowledgedActionId
    })).resolves.toEqual({ kind: "conflict" })
    await expect(reopened.running.call({
      op: "dismissUnknownOpen",
      instanceId,
      actionId: pendingActionId
    })).resolves.toEqual({ kind: "conflict" })
    await expect(reopened.running.call({
      op: "dismissUnknownOpen",
      instanceId,
      actionId: failedActionId
    })).resolves.toEqual({ kind: "conflict" })

    await expect(prepare(reopened.running, { instanceId })).resolves.toMatchObject({ kind: "admitted" })
    await expect(reopened.running.call({ op: "getOpenJournal", instanceId, actionId: heldActionId })).resolves.toBeNull()
    await expect(reopened.running.call({ op: "getOpenJournal", instanceId, actionId: pendingActionId })).resolves.toMatchObject({
      status: "accepted",
      deliveryStatus: "pending"
    })
    await expect(reopened.running.call({ op: "getOpenJournal", instanceId, actionId: acknowledgedActionId })).resolves.toMatchObject({
      status: "accepted",
      deliveryStatus: "acknowledged"
    })
    await expect(reopened.running.call({ op: "getOpenJournal", instanceId, actionId: failedActionId })).resolves.toMatchObject({
      status: "failed"
    })
  })

  it("blocks a new counted Open when the finite journal is full and preserves pending events", async () => {
    const { running } = await startWorker()
    const instanceId = randomUUID()
    const firstActionId = randomUUID()
    const firstInput = { instanceId, actionId: firstActionId }
    const first = await prepare(running, firstInput) as { entry: { entryId: string; deviceId: string } }
    const firstEvent = eventFor({
      instanceId,
      actionId: firstActionId,
      entryId: first.entry.entryId,
      deviceId: first.entry.deviceId
    })
    await expect(running.call({ op: "recordOpenAccepted", instanceId, actionId: firstActionId, event: firstEvent })).resolves.toMatchObject({
      kind: "updated"
    })

    for (let index = 1; index < 64; index += 1) {
      await expect(prepare(running, { instanceId })).resolves.toMatchObject({ kind: "admitted" })
    }
    const overflowActionId = randomUUID()
    await expect(prepare(running, { instanceId, actionId: overflowActionId })).resolves.toEqual({ kind: "full" })
    await expect(running.call({ op: "getOpenJournal", instanceId, actionId: overflowActionId })).resolves.toBeNull()
    await expect(running.call({ op: "getOpenJournal", instanceId, actionId: firstActionId })).resolves.toMatchObject({
      status: "accepted",
      event: firstEvent
    })
  })

  it("protects unknown, held, and pending rows while separating their allowance from replay storage", async () => {
    const first = await startWorker()
    const instanceId = randomUUID()
    const acknowledgedInputs: Array<Record<string, string>> = []

    for (let index = 0; index < 64; index += 1) {
      const input = { instanceId, actionId: randomUUID(), entryId: randomUUID(), deviceId: randomUUID() }
      acknowledgedInputs.push(input)
      const event = eventFor(input)
      await expect(prepare(first.running, input)).resolves.toMatchObject({ kind: "admitted" })
      await expect(first.running.call({ op: "recordOpenAccepted", ...input, event })).resolves.toMatchObject({ kind: "updated" })
      await expect(first.running.call({ op: "acknowledgeOpenEvent", instanceId, actionId: input.actionId })).resolves.toMatchObject({
        kind: "updated",
        entry: { deliveryStatus: "acknowledged" }
      })
    }

    const pendingInput = { instanceId, actionId: randomUUID(), entryId: randomUUID(), deviceId: randomUUID() }
    const heldInput = { instanceId, actionId: randomUUID(), entryId: randomUUID(), deviceId: randomUUID() }
    const unknownInput = { instanceId, actionId: randomUUID(), entryId: randomUUID(), deviceId: randomUUID() }
    for (const input of [pendingInput, heldInput]) {
      await expect(prepare(first.running, input)).resolves.toMatchObject({ kind: "admitted" })
      await expect(first.running.call({ op: "recordOpenAccepted", ...input, event: eventFor(input) })).resolves.toMatchObject({
        kind: "updated"
      })
    }
    await expect(prepare(first.running, unknownInput)).resolves.toMatchObject({ kind: "admitted" })
    await expect(first.running.call({
      op: "holdOpenEvent",
      instanceId,
      actionId: heldInput.actionId,
      deliveryErrorCode: "offline",
      deliveryErrorMessage: "server unavailable"
    })).resolves.toMatchObject({ kind: "updated", entry: { deliveryStatus: "held" } })

    await first.running.close()
    workers.delete(first.running)
    const reopened = await startWorker(first.dbPath)
    for (let index = 3; index < 64; index += 1) {
      await expect(prepare(reopened.running, { instanceId })).resolves.toMatchObject({ kind: "admitted" })
    }

    await expect(prepare(reopened.running, { instanceId })).resolves.toEqual({ kind: "full" })
    await expect(reopened.running.call({ op: "listOpenJournal", instanceId })).resolves.toHaveLength(128)
    await expect(reopened.running.call({ op: "getOpenJournal", instanceId, actionId: pendingInput.actionId })).resolves.toMatchObject({
      status: "accepted",
      deliveryStatus: "pending"
    })
    await expect(reopened.running.call({ op: "getOpenJournal", instanceId, actionId: heldInput.actionId })).resolves.toMatchObject({
      status: "accepted",
      deliveryStatus: "held"
    })
    await expect(reopened.running.call({ op: "getOpenJournal", instanceId, actionId: unknownInput.actionId })).resolves.toMatchObject({
      status: "unknown"
    })
    await expect(reopened.running.call({
      op: "getOpenJournal",
      instanceId,
      actionId: acknowledgedInputs[0]!.actionId
    })).resolves.toMatchObject({ status: "accepted", deliveryStatus: "acknowledged" })

    await expect(reopened.running.call({ op: "dismissUnknownOpen", instanceId, actionId: unknownInput.actionId })).resolves.toEqual({
      kind: "deleted"
    })
    await expect(prepare(reopened.running, { instanceId })).resolves.toMatchObject({ kind: "admitted" })
    await expect(reopened.running.call({ op: "discardHeldOpenEvent", instanceId, actionId: heldInput.actionId })).resolves.toEqual({
      kind: "deleted"
    })
    await expect(prepare(reopened.running, { instanceId })).resolves.toMatchObject({ kind: "admitted" })
  })

  it("bounds terminal replay storage and orders recoverable rows ahead of many acknowledgments", async () => {
    const first = await startWorker()
    await first.running.close()
    workers.delete(first.running)

    const instanceId = randomUUID()
    const pendingActionIds = Array.from({ length: 62 }, () => randomUUID())
    const heldActionId = randomUUID()
    const unknownActionId = randomUUID()
    const database = new DatabaseSync(first.dbPath)
    const insert = database.prepare(`
      INSERT INTO launch_journal(
        instance_id, action_id, entry_id, device_id,
        observed_location_revision, observed_content_version, status,
        event_json, delivery_status, delivery_error_code, delivery_error_message,
        failure_code, failure_message, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 3, 5, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `)
    const now = Date.now()
    const eventJson = (actionId: string): string => JSON.stringify({
      event_id: actionId,
      instance_id: instanceId,
      entry_id: randomUUID(),
      device_id: randomUUID(),
      observed_location_revision: "3",
      observed_content_version: "5",
      occurred_at_ms: now
    })

    try {
      database.exec("BEGIN IMMEDIATE")
      for (let index = 0; index < 8_192; index += 1) {
        const actionId = randomUUID()
        insert.run(
          instanceId,
          actionId,
          randomUUID(),
          randomUUID(),
          "accepted",
          eventJson(actionId),
          "acknowledged",
          null,
          null,
          now,
          now
        )
      }
      for (const actionId of pendingActionIds) {
        insert.run(
          instanceId,
          actionId,
          randomUUID(),
          randomUUID(),
          "accepted",
          eventJson(actionId),
          "pending",
          null,
          null,
          now,
          now
        )
      }
      insert.run(
        instanceId,
        heldActionId,
        randomUUID(),
        randomUUID(),
        "accepted",
        eventJson(heldActionId),
        "held",
        "offline",
        "server unavailable",
        now,
        now
      )
      insert.run(
        instanceId,
        unknownActionId,
        randomUUID(),
        randomUUID(),
        "prepared",
        null,
        "pending",
        null,
        null,
        now,
        now
      )
      database.exec("COMMIT")
    } catch (error) {
      try {
        database.exec("ROLLBACK")
      } catch {
        // Preserve the fixture failure.
      }
      throw error
    } finally {
      database.close()
    }

    const reopened = await startWorker(first.dbPath)
    const rows = await reopened.running.call({ op: "listOpenJournal", instanceId }) as ReadonlyArray<OpenJournalRow>
    const recoveryIds = new Set([...pendingActionIds, heldActionId, unknownActionId])
    expect(rows).toHaveLength(128)
    expect(rows.slice(0, 64).every((row) => recoveryIds.has(row.actionId))).toBe(true)
    expect(rows.slice(64).every((row) => row.status === "accepted" && row.deliveryStatus === "acknowledged")).toBe(true)
    const delivered: string[] = []
    const deliverySession = { instanceId, epoch: randomUUID() }
    const store = {
      list: () => Effect.succeed(rows),
      acknowledge: ({ actionId }: { actionId: string }) => Effect.succeed(rows.find((row) => row.actionId === actionId)!),
      hold: ({ actionId }: { actionId: string }) => Effect.succeed(rows.find((row) => row.actionId === actionId)!)
    } as unknown as OpenJournalStore["Service"]
    const client = {
      batch: ({ payload }: Parameters<OpenEventHttpClient["Service"]["batch"]>[0]) => {
        delivered.push(...payload.events.map((event) => event.event_id))
        return Effect.succeed({
          instance_id: instanceId,
          epoch: deliverySession.epoch,
          request_id: randomUUID(),
          server_time: Date.now(),
          data: {
            results: payload.events.map((event) => ({
              event_id: event.event_id,
              outcome: "accepted" as const,
              receipt_at_ms: 1
            }))
          }
        })
      }
    } as unknown as OpenEventHttpClient["Service"]
    await expect(Effect.runPromise(deliverOpenEvents(store, client, deliverySession, { batchSize: 64 }))).resolves.toMatchObject({
      attempted: 62,
      acknowledged: 62
    })
    expect(new Set(delivered)).toEqual(new Set(pendingActionIds))
    await expect(prepare(reopened.running, { instanceId })).resolves.toEqual({ kind: "full" })
  })

  it("retains acknowledged rows through the cutoff, then compacts only them after restart", async () => {
    const first = await startWorker()
    const instanceId = randomUUID()

    const acknowledged = {
      instanceId,
      actionId: randomUUID(),
      entryId: randomUUID(),
      deviceId: randomUUID(),
      observedLocationRevision: "3",
      observedContentVersion: "5"
    }
    const held = {
      instanceId,
      actionId: randomUUID(),
      entryId: randomUUID(),
      deviceId: randomUUID(),
      observedLocationRevision: "3",
      observedContentVersion: "5"
    }
    const pending = {
      instanceId,
      actionId: randomUUID(),
      entryId: randomUUID(),
      deviceId: randomUUID(),
      observedLocationRevision: "3",
      observedContentVersion: "5"
    }

    for (const input of [acknowledged, held, pending]) {
      await expect(prepare(first.running, input)).resolves.toMatchObject({ kind: "admitted" })
      await expect(first.running.call({
        op: "recordOpenAccepted",
        instanceId,
        actionId: input.actionId,
        event: eventFor(input)
      })).resolves.toMatchObject({ kind: "updated", entry: { status: "accepted", deliveryStatus: "pending" } })
    }
    await expect(first.running.call({
      op: "acknowledgeOpenEvent",
      instanceId,
      actionId: acknowledged.actionId
    })).resolves.toMatchObject({ kind: "updated", entry: { deliveryStatus: "acknowledged" } })
    await expect(first.running.call({
      op: "holdOpenEvent",
      instanceId,
      actionId: held.actionId,
      deliveryErrorCode: "offline",
      deliveryErrorMessage: "server unavailable"
    })).resolves.toMatchObject({ kind: "updated", entry: { deliveryStatus: "held" } })

    for (let index = 3; index < 64; index += 1) {
      await expect(prepare(first.running, { instanceId })).resolves.toMatchObject({ kind: "admitted" })
    }

    await first.running.close()
    workers.delete(first.running)
    const database = new DatabaseSync(first.dbPath)
    try {
      const expiredAt = Date.now() - OPEN_JOURNAL_RETENTION_MS - 1
      database
        .prepare("UPDATE launch_journal SET updated_at_ms = ? WHERE action_id IN (?, ?, ?)")
        .run(expiredAt, acknowledged.actionId, held.actionId, pending.actionId)
    } finally {
      database.close()
    }

    const reopened = await startWorker(first.dbPath)
    await expect(prepare(reopened.running, { instanceId })).resolves.toMatchObject({ kind: "admitted" })
    await expect(reopened.running.call({
      op: "getOpenJournal",
      instanceId,
      actionId: acknowledged.actionId
    })).resolves.toBeNull()
    await expect(reopened.running.call({
      op: "getOpenJournal",
      instanceId,
      actionId: held.actionId
    })).resolves.toMatchObject({ status: "accepted", deliveryStatus: "held" })
    await expect(reopened.running.call({
      op: "getOpenJournal",
      instanceId,
      actionId: pending.actionId
    })).resolves.toMatchObject({ status: "accepted", deliveryStatus: "pending" })
    await expect(reopened.running.call({ op: "listOpenJournal", instanceId })).resolves.toHaveLength(64)
  })
})
