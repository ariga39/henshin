import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Worker } from "node:worker_threads"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

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
})
