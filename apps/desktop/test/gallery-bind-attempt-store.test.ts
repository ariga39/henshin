import { build } from "esbuild"
import { Effect, Layer, ManagedRuntime } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { GalleryBindAttemptStore, GalleryBindAttemptStoreFullError } from "../src/main/persistence/GalleryBindAttemptStore"
import { LocalDatabaseWorker } from "../src/main/persistence/LocalDatabaseWorker"

const instanceId = "11111111-1111-4111-8111-111111111111"
const entryId = "22222222-2222-4222-8222-222222222222"
const epoch = "33333333-3333-4333-8333-333333333333"
const nextEpoch = "44444444-4444-4444-8444-444444444444"
const operationA = "55555555-5555-4555-8555-555555555555"
const operationB = "66666666-6666-4666-8666-666666666666"

describe("gallery bind attempt persistence", () => {
  let workerDirectory = ""
  let workerUrl: URL
  let databasePath = ""
  let runtime: ManagedRuntime.ManagedRuntime<GalleryBindAttemptStore, never>

  const openRuntime = () => ManagedRuntime.make(
    GalleryBindAttemptStore.layerFromWorker.pipe(
      Layer.provide(LocalDatabaseWorker.layer(databasePath, { workerUrl }))
    )
  )

  beforeAll(async () => {
    workerDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-gallery-bind-attempt-"))
    const workerPath = path.join(workerDirectory, "draft-worker.mjs")
    await build({
      entryPoints: [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/main/persistence/draft-worker.ts")],
      outfile: workerPath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent"
    })
    workerUrl = pathToFileURL(workerPath)
    databasePath = path.join(workerDirectory, "client.db")
    runtime = openRuntime()
  })

  afterAll(async () => {
    await runtime.dispose()
    await rm(workerDirectory, { recursive: true, force: true })
  })

  it("persists the pending operation, reuses identical intent, and fences changed intent by entry", async () => {
    const first = await runtime.runPromise(Effect.gen(function*() {
      const store = yield* GalleryBindAttemptStore
      return yield* store.prepare({
        instanceId,
        operationId: operationA,
        entryId,
        url: "https://e-hentai.org/g/123/token/",
        expectedDecisionVersion: "7",
        epoch
      })
    }))
    expect(first.prepared).toBe(true)

    const sameIntent = await runtime.runPromise(Effect.gen(function*() {
      const store = yield* GalleryBindAttemptStore
      return yield* store.prepare({
        instanceId,
        operationId: operationB,
        entryId,
        url: "https://e-hentai.org/g/123/token/",
        expectedDecisionVersion: "7",
        epoch: nextEpoch
      })
    }))
    expect(sameIntent.prepared).toBe(false)
    expect(sameIntent.attempt.operationId).toBe(operationA)

    await runtime.dispose()
    runtime = openRuntime()
    const reopened = await runtime.runPromise(Effect.gen(function*() {
      const store = yield* GalleryBindAttemptStore
      return yield* store.listPending(instanceId)
    }))
    expect(reopened).toHaveLength(1)
    expect(reopened[0]).toMatchObject({ operationId: operationA, entryId, url: "https://e-hentai.org/g/123/token/" })

    const changedIntent = await runtime.runPromise(Effect.gen(function*() {
      const store = yield* GalleryBindAttemptStore
      return yield* store.prepare({
        instanceId,
        operationId: operationB,
        entryId,
        url: "https://e-hentai.org/g/456/new-token/",
        expectedDecisionVersion: "7",
        epoch: nextEpoch
      })
    }))
    expect(changedIntent.prepared).toBe(true)
    expect(changedIntent.attempt.operationId).toBe(operationB)
    expect(await runtime.runPromise(Effect.gen(function*() {
      const store = yield* GalleryBindAttemptStore
      return yield* store.markSubmitted({ instanceId, operationId: operationB, epoch: nextEpoch })
    }))).toMatchObject({ status: "submitted", epoch: nextEpoch })

    for (let index = 0; index < 62; index += 1) {
      const suffix = (index + 1).toString(16).padStart(12, "0")
      await runtime.runPromise(Effect.gen(function*() {
        const store = yield* GalleryBindAttemptStore
        return yield* store.prepare({
          instanceId,
          operationId: `00000000-0000-4000-8000-${suffix}`,
          entryId: `00000000-0000-4000-9000-${suffix}`,
          url: `https://e-hentai.org/g/${index + 1}/capacity/`,
          expectedDecisionVersion: "1",
          epoch
        })
      }))
    }

    await expect(runtime.runPromise(Effect.gen(function*() {
      const store = yield* GalleryBindAttemptStore
      return yield* store.prepare({
        instanceId,
        operationId: "77777777-7777-4777-8777-777777777777",
        entryId,
        url: "https://e-hentai.org/g/999/capacity-rejected/",
        expectedDecisionVersion: "7",
        epoch: nextEpoch
      })
    }))).rejects.toBeInstanceOf(GalleryBindAttemptStoreFullError)

    expect(await runtime.runPromise(Effect.gen(function*() {
      const store = yield* GalleryBindAttemptStore
      return yield* store.listPending(instanceId)
    }))).toContainEqual(expect.objectContaining({
      operationId: operationB,
      status: "submitted",
      url: "https://e-hentai.org/g/456/new-token/"
    }))
  })
})
