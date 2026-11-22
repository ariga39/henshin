import { build } from "esbuild"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { LocalMappingStore } from "../src/main/persistence/LocalMappingStore"

const instanceA = "11111111-1111-4111-8111-111111111111"
const instanceB = "22222222-2222-4222-8222-222222222222"
const rootA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const rootB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const activate = (input: Partial<Parameters<LocalMappingStore["Service"]["activate"]>[0]> = {}) => ({
  instanceId: instanceA,
  rootId: rootA,
  selectedPath: "/library/books",
  canonicalPath: "/mnt/books",
  expectedMappingRevision: "0",
  protectedWritablePaths: [],
  ...input
})

describe("local mapping store", () => {
  let workerDirectory: string
  let workerUrl: URL

  beforeAll(async () => {
    workerDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-worker-"))
    const workerPath = path.join(workerDirectory, "draft-worker.mjs")
    await build({
      entryPoints: [fileURLToPath(new URL("../src/main/persistence/draft-worker.ts", import.meta.url))],
      outfile: workerPath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      logLevel: "silent"
    })
    workerUrl = pathToFileURL(workerPath)
  })

  afterAll(async () => {
    await rm(workerDirectory, { recursive: true, force: true })
  })

  it("persists active mappings with revision and namespace fences", async () => {
    const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-db-"))
    try {
      const databasePath = path.join(databaseDirectory, "client.db")
      const program = Effect.gen(function*() {
        const store = yield* LocalMappingStore

        expect(yield* store.load({ instanceId: instanceA, rootId: rootA })).toBeUndefined()
        expect(yield* store.list(instanceA)).toEqual([])

        const initial = yield* store.activate(activate())
        expect(initial).toEqual({
          kind: "activated",
          mapping: {
            instanceId: instanceA,
            rootId: rootA,
            selectedPath: "/library/books",
            canonicalPath: "/mnt/books",
            mappingRevision: "1"
          }
        })
        expect(yield* store.list(instanceA)).toHaveLength(1)

        const changed = yield* store.activate(activate({
          selectedPath: "/library/renamed-books",
          canonicalPath: "/mnt/renamed-books",
          expectedMappingRevision: "1"
        }))
        expect(changed).toMatchObject({ kind: "activated", mapping: { mappingRevision: "2" } })

        const stale = yield* store.activate(activate({
          selectedPath: "/library/stale-books",
          canonicalPath: "/mnt/stale-books",
          expectedMappingRevision: "1"
        }))
        expect(stale).toEqual({
          kind: "revision_conflict",
          currentMapping: {
            instanceId: instanceA,
            rootId: rootA,
            selectedPath: "/library/renamed-books",
            canonicalPath: "/mnt/renamed-books",
            mappingRevision: "2"
          }
        })
        expect(yield* store.load({ instanceId: instanceA, rootId: rootA })).toMatchObject({
          selectedPath: "/library/renamed-books",
          canonicalPath: "/mnt/renamed-books",
          mappingRevision: "2"
        })

        const rootOverlap = yield* store.activate(activate({
          rootId: rootB,
          selectedPath: "/library/renamed-books/child",
          canonicalPath: "/mnt/renamed-books/child"
        }))
        expect(rootOverlap).toEqual({ kind: "root_conflict" })
        expect(yield* store.load({ instanceId: instanceA, rootId: rootB })).toBeUndefined()
        expect(yield* store.load({ instanceId: instanceA, rootId: rootA })).toMatchObject({
          selectedPath: "/library/renamed-books",
          canonicalPath: "/mnt/renamed-books",
          mappingRevision: "2"
        })

        const writableOverlap = yield* store.activate(activate({
          selectedPath: "/library/renamed-books",
          canonicalPath: "/mnt/renamed-books",
          expectedMappingRevision: "2",
          protectedWritablePaths: ["/library/renamed-books/cache"]
        }))
        expect(writableOverlap).toEqual({ kind: "writable_overlap" })
        expect(yield* store.load({ instanceId: instanceA, rootId: rootA })).toMatchObject({
          selectedPath: "/library/renamed-books",
          canonicalPath: "/mnt/renamed-books",
          mappingRevision: "2"
        })

        const otherNamespace = yield* store.activate(activate({
          instanceId: instanceB,
          selectedPath: "/library/renamed-books/child",
          canonicalPath: "/mnt/renamed-books/child"
        }))
        expect(otherNamespace).toMatchObject({ kind: "activated", mapping: { mappingRevision: "1" } })
        expect(yield* store.list(instanceA)).toHaveLength(1)
        expect(yield* store.list(instanceB)).toHaveLength(1)
      }).pipe(Effect.provide(LocalMappingStore.layer(databasePath, workerUrl)))

      await Effect.runPromise(Effect.scoped(program))

      const reopened = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* LocalMappingStore
          return yield* store.load({ instanceId: instanceA, rootId: rootA })
        }).pipe(Effect.provide(LocalMappingStore.layer(databasePath, workerUrl)), Effect.scoped)
      )
      expect(reopened).toMatchObject({
        selectedPath: "/library/renamed-books",
        canonicalPath: "/mnt/renamed-books",
        mappingRevision: "2"
      })
    } finally {
      await rm(databaseDirectory, { recursive: true, force: true })
    }
  })
})
