import { Worker } from "node:worker_threads"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"

const workerUrl = new URL("../../desktop/dist/draft-worker.mjs", import.meta.url)

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

const tempDirectories = new Set<string>()
const workers = new Set<RunningWorker>()
const COMMAND_ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const startWorker = async (): Promise<{ readonly running: RunningWorker; readonly dbPath: string }> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "henshin-draft-worker-"))
  tempDirectories.add(directory)
  const dbPath = path.join(directory, "desktop.db")
  const worker = new Worker(workerUrl, { workerData: { dbPath } })
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  worker.on("message", (raw: WorkerResponse) => {
    const entry = pending.get(raw.id)
    if (entry === undefined) return
    pending.delete(raw.id)
    if (raw.ok) entry.resolve(raw.value)
    else entry.reject(new Error(raw.error ?? "draft worker request failed"))
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
  return { running, dbPath }
}

const key = (instanceId: string, noteId: string) => ({
  instanceId,
  noteId,
  formId: "synthetic-note"
})

const save = (running: RunningWorker, input: Record<string, unknown>) =>
  running.call({
    op: "save",
    text: "draft",
    expectedLocalRevision: "0",
    baseServerRevision: "0",
    baseEpoch: randomUUID(),
    ...input
  })

const admit = (running: RunningWorker, input: Record<string, unknown>) =>
  running.call({
    op: "admitCommand",
    instanceId: randomUUID(),
    operationId: randomUUID(),
    noteId: "note-1",
    intentText: "intent",
    baseRevision: "0",
    epoch: randomUUID(),
    ...input
  })

afterEach(async () => {
  for (const running of workers) {
    try {
      await running.close()
    } catch {
      await running.worker.terminate()
    }
  }
  workers.clear()
  for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true })
  tempDirectories.clear()
})

describe("desktop draft SQLite worker", () => {
  it("counts tombstones toward the finite 64-key capacity and preserves existing rows on overflow", async () => {
    const { running } = await startWorker()
    const instanceId = randomUUID()

    for (let index = 0; index < 64; index += 1) {
      await expect(
        save(running, { ...key(instanceId, `note-${index}`), text: `draft-${index}` })
      ).resolves.toMatchObject({ kind: "saved", draft: { localRevision: "1" } })
    }

    await expect(
      running.call({
        op: "discard",
        ...key(instanceId, "note-0"),
        expectedLocalRevision: "1"
      })
    ).resolves.toMatchObject({ kind: "discarded", localRevision: "2" })

    await expect(
      save(running, { ...key(instanceId, "note-overflow"), text: "must-not-fit" })
    ).resolves.toEqual({ kind: "full" })

    await expect(
      running.call({ op: "load", ...key(instanceId, "note-1") })
    ).resolves.toMatchObject({ text: "draft-1", localRevision: "1", present: true })
    await expect(
      running.call({ op: "load", ...key(instanceId, "note-overflow") })
    ).resolves.toBeNull()
    await expect(
      running.call({ op: "load", ...key(instanceId, "note-0") })
    ).resolves.toMatchObject({ kind: "absent", localRevision: "2" })
  })

  it("rejects a nonzero expected revision for a missing key without creating it", async () => {
    const { running } = await startWorker()
    const input = key(randomUUID(), "missing")

    await expect(save(running, { ...input, expectedLocalRevision: "7" })).resolves.toEqual({
      kind: "conflict",
      currentLocalRevision: "0"
    })
    await expect(running.call({ op: "load", ...input })).resolves.toBeNull()
  })

  it("retains an absent tombstone revision across worker restart before recreation", async () => {
    const first = await startWorker()
    const instanceId = randomUUID()
    const input = key(instanceId, "restart")

    await expect(save(first.running, { ...input, text: "before-discard" })).resolves.toMatchObject({
      kind: "saved",
      draft: { localRevision: "1" }
    })
    await expect(
      first.running.call({ op: "discard", ...input, expectedLocalRevision: "1" })
    ).resolves.toMatchObject({ kind: "discarded", localRevision: "2" })
    await first.running.close()
    workers.delete(first.running)

    const worker = new Worker(workerUrl, { workerData: { dbPath: first.dbPath } })
    let nextId = 1
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
    worker.on("message", (raw: WorkerResponse) => {
      const entry = pending.get(raw.id)
      if (entry === undefined) return
      pending.delete(raw.id)
      if (raw.ok) entry.resolve(raw.value)
      else entry.reject(new Error(raw.error ?? "draft worker request failed"))
    })
    const call = (request: Record<string, unknown>): Promise<unknown> => {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, request })
      })
    }
    try {
      await expect(call({ op: "load", ...input })).resolves.toMatchObject({
        kind: "absent",
        localRevision: "2"
      })
      await expect(
        call({
          op: "save",
          ...input,
          text: "after-restart",
          expectedLocalRevision: "2",
          baseServerRevision: "0",
          baseEpoch: randomUUID()
        })
      ).resolves.toMatchObject({ kind: "saved", draft: { text: "after-restart", localRevision: "3" } })
    } finally {
      try {
        await call({ op: "close" })
      } finally {
        await worker.terminate()
      }
    }
  })

  it("bounds command attempts without evicting unresolved rows and isolates namespaces", async () => {
    const { running } = await startWorker()
    const firstInstance = randomUUID()
    const secondInstance = randomUUID()
    const operationId = randomUUID()
    const epoch = randomUUID()

    await expect(
      admit(running, { instanceId: firstInstance, operationId, epoch, intentText: "preserved" })
    ).resolves.toMatchObject({ kind: "admitted", attempt: { status: "prepared" } })
    await expect(
      admit(running, { instanceId: firstInstance, operationId, epoch, intentText: "preserved" })
    ).resolves.toMatchObject({ kind: "existing", attempt: { status: "prepared" } })
    await expect(
      admit(running, { instanceId: firstInstance, operationId, epoch, intentText: "changed" })
    ).resolves.toEqual({ kind: "conflict" })
    await expect(
      running.call({ op: "listCommandAttempts", instanceId: secondInstance })
    ).resolves.toEqual([])

    for (let index = 1; index < 64; index += 1) {
      await expect(admit(running, { instanceId: firstInstance })).resolves.toMatchObject({ kind: "admitted" })
    }
    await expect(admit(running, { instanceId: firstInstance })).resolves.toEqual({ kind: "full" })
    await expect(running.call({ op: "getCommandAttempt", instanceId: firstInstance, operationId })).resolves.toMatchObject({
      status: "prepared",
      intentText: "preserved",
      dismissed: false
    })
  })

  it("preserves an SQLite auto-rollback failure instead of attempting a second rollback", async () => {
    const { running, dbPath } = await startWorker()
    await expect(running.call({ op: "listCommandAttempts", instanceId: randomUUID() })).resolves.toEqual([])

    const database = new DatabaseSync(dbPath)
    try {
      database.exec(`
        CREATE TRIGGER delete_admitted_attempt
        BEFORE INSERT ON command_attempts
        BEGIN
          SELECT RAISE(ROLLBACK, 'trigger rejected admission');
        END
      `)
    } finally {
      database.close()
    }

    const operationId = randomUUID()
    await expect(admit(running, { operationId })).rejects.toThrow("trigger rejected admission")

    const cleanup = new DatabaseSync(dbPath)
    try {
      cleanup.exec("DROP TRIGGER delete_admitted_attempt")
    } finally {
      cleanup.close()
    }
    await expect(admit(running, {})).resolves.toMatchObject({ kind: "admitted" })
  })

  it("hides dismissed attempts while retaining them until seven-day compaction", async () => {
    const { running, dbPath } = await startWorker()
    const instanceId = randomUUID()
    const dismissedOperationId = randomUUID()
    const rejectedOperationId = randomUUID()
    const succeededOperationId = randomUUID()
    const unresolvedOperationId = randomUUID()

    await expect(admit(running, { instanceId, operationId: dismissedOperationId })).resolves.toMatchObject({ kind: "admitted" })
    await expect(running.call({ op: "markCommandUnresolved", instanceId, operationId: dismissedOperationId })).resolves.toMatchObject({
      kind: "updated",
      attempt: { status: "unresolved" }
    })
    await expect(running.call({ op: "dismissCommand", instanceId, operationId: dismissedOperationId })).resolves.toMatchObject({
      kind: "updated",
      attempt: { dismissed: true }
    })

    await expect(admit(running, { instanceId, operationId: rejectedOperationId })).resolves.toMatchObject({ kind: "admitted" })
    await expect(running.call({
      op: "markCommandRejected",
      instanceId,
      operationId: rejectedOperationId,
      errorCode: "revision_conflict",
      errorMessage: "stale revision",
      currentRevision: "1"
    })).resolves.toMatchObject({ kind: "updated", attempt: { status: "rejected" } })

    await expect(admit(running, { instanceId, operationId: succeededOperationId })).resolves.toMatchObject({ kind: "admitted" })
    await expect(running.call({
      op: "markCommandSucceeded",
      instanceId,
      operationId: succeededOperationId,
      resultNote: { note_id: "note-1", text: "saved", revision: "1" },
      expiresAtMs: Date.now() + 60_000
    })).resolves.toMatchObject({ kind: "updated", attempt: { status: "succeeded" } })

    await expect(admit(running, { instanceId, operationId: unresolvedOperationId })).resolves.toMatchObject({ kind: "admitted" })
    await expect(running.call({ op: "markCommandUnresolved", instanceId, operationId: unresolvedOperationId })).resolves.toMatchObject({
      kind: "updated",
      attempt: { status: "unresolved", dismissed: false }
    })

    for (let index = 0; index < 60; index += 1) {
      await expect(admit(running, { instanceId })).resolves.toMatchObject({ kind: "admitted" })
    }

    await expect(admit(running, { instanceId })).resolves.toEqual({ kind: "full" })
    await expect(running.call({ op: "listCommandAttempts", instanceId })).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ operationId: dismissedOperationId })])
    )
    await expect(running.call({ op: "getCommandAttempt", instanceId, operationId: dismissedOperationId })).resolves.toMatchObject({
      operationId: dismissedOperationId,
      status: "unresolved",
      dismissed: true
    })
    await expect(running.call({ op: "getCommandAttempt", instanceId, operationId: rejectedOperationId })).resolves.toMatchObject({
      operationId: rejectedOperationId,
      status: "rejected"
    })

    const database = new DatabaseSync(dbPath)
    try {
      const oldTimestamp = Date.now() - COMMAND_ATTEMPT_RETENTION_MS - 1
      database
        .prepare("UPDATE command_attempts SET updated_at_ms = ? WHERE operation_id IN (?, ?, ?, ?)")
        .run(oldTimestamp, dismissedOperationId, rejectedOperationId, succeededOperationId, unresolvedOperationId)
    } finally {
      database.close()
    }

    const admittedAfterCompaction = await admit(running, { instanceId })
    expect(admittedAfterCompaction).toMatchObject({ kind: "admitted" })
    await expect(running.call({ op: "getCommandAttempt", instanceId, operationId: dismissedOperationId })).resolves.toBeNull()
    await expect(running.call({ op: "getCommandAttempt", instanceId, operationId: rejectedOperationId })).resolves.toBeNull()
    await expect(running.call({ op: "getCommandAttempt", instanceId, operationId: succeededOperationId })).resolves.toBeNull()
    await expect(running.call({ op: "getCommandAttempt", instanceId, operationId: unresolvedOperationId })).resolves.toMatchObject({
      operationId: unresolvedOperationId,
      status: "unresolved",
      dismissed: false
    })
  })

  it("retains command attempts across a worker restart", async () => {
    const first = await startWorker()
    const instanceId = randomUUID()
    const operationId = randomUUID()
    await expect(
      admit(first.running, { instanceId, operationId, intentText: "restart-intent" })
    ).resolves.toMatchObject({ kind: "admitted" })
    await first.running.close()
    workers.delete(first.running)

    const worker = new Worker(workerUrl, { workerData: { dbPath: first.dbPath } })
    let nextId = 1
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
    worker.on("message", (raw: WorkerResponse) => {
      const entry = pending.get(raw.id)
      if (entry === undefined) return
      pending.delete(raw.id)
      if (raw.ok) entry.resolve(raw.value)
      else entry.reject(new Error(raw.error ?? "draft worker request failed"))
    })
    const call = (request: Record<string, unknown>): Promise<unknown> => {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, request })
      })
    }
    try {
      await expect(call({ op: "getCommandAttempt", instanceId, operationId })).resolves.toMatchObject({
        status: "prepared",
        intentText: "restart-intent"
      })
    } finally {
      try {
        await call({ op: "close" })
      } finally {
        await worker.terminate()
      }
    }
  })
})
