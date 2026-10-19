import { Worker } from "node:worker_threads"
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
})
