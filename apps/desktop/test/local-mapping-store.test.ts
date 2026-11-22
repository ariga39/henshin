import { build } from "esbuild"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  LocalMappingStore,
  type LocalMappingActivationInput
} from "../src/main/persistence/LocalMappingStore"

const instanceA = "11111111-1111-4111-8111-111111111111"
const instanceB = "22222222-2222-4222-8222-222222222222"
const rootA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const rootB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const activate = (
  instanceId: string,
  rootId: string,
  selectedPath: string,
  canonicalPath: string,
  expectedMappingRevision = "0",
  protectedWritablePaths: ReadonlyArray<string> = []
): LocalMappingActivationInput => ({
  instanceId,
  rootId,
  selectedPath,
  canonicalPath,
  expectedMappingRevision,
  protectedWritablePaths
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
    const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-fixture-"))
    try {
      const collection = path.join(fixtureDirectory, "collection")
      const renamedCollection = path.join(fixtureDirectory, "renamed-collection")
      const collectionAlias = path.join(fixtureDirectory, "collection-alias")
      const renamedAlias = path.join(fixtureDirectory, "renamed-alias")
      await mkdir(collection)
      await mkdir(renamedCollection)
      await symlink(renamedCollection, collectionAlias, "dir")
      await symlink(renamedCollection, renamedAlias, "dir")
      const upperCaseSibling = path.join(fixtureDirectory, "Books")
      const lowerCaseSibling = path.join(fixtureDirectory, "books")
      if (process.platform === "linux") {
        await mkdir(upperCaseSibling)
        await mkdir(lowerCaseSibling)
      }

      const databasePath = path.join(databaseDirectory, "client.db")
      const program = Effect.gen(function*() {
        const store = yield* LocalMappingStore

        expect(yield* store.load({ instanceId: instanceA, rootId: rootA })).toBeUndefined()
        expect(yield* store.list(instanceA)).toEqual([])

        const initial = yield* store.activate(activate(instanceA, rootA, collection, collection))
        expect(initial).toEqual({
          kind: "activated",
          mapping: {
            instanceId: instanceA,
            rootId: rootA,
            selectedPath: collection,
            canonicalPath: collection,
            mappingRevision: "1"
          }
        })
        expect(yield* store.list(instanceA)).toHaveLength(1)

        const changed = yield* store.activate(
          activate(instanceA, rootA, renamedCollection, renamedCollection, "1")
        )
        expect(changed).toMatchObject({ kind: "activated", mapping: { mappingRevision: "2" } })

        const stale = yield* store.activate(
          activate(instanceA, rootA, collection, collection, "1")
        )
        expect(stale).toEqual({
          kind: "revision_conflict",
          currentMapping: {
            instanceId: instanceA,
            rootId: rootA,
            selectedPath: renamedCollection,
            canonicalPath: renamedCollection,
            mappingRevision: "2"
          }
        })
        expect(yield* store.load({ instanceId: instanceA, rootId: rootA })).toMatchObject({
          selectedPath: renamedCollection,
          canonicalPath: renamedCollection,
          mappingRevision: "2"
        })

        const rootOverlap = yield* store.activate(
          activate(instanceA, rootB, collectionAlias, collectionAlias)
        )
        expect(rootOverlap).toEqual({ kind: "root_conflict" })
        expect(yield* store.load({ instanceId: instanceA, rootId: rootB })).toBeUndefined()
        expect(yield* store.load({ instanceId: instanceA, rootId: rootA })).toMatchObject({
          selectedPath: renamedCollection,
          canonicalPath: renamedCollection,
          mappingRevision: "2"
        })

        const writableOverlap = yield* store.activate(
          activate(
            instanceA,
            rootA,
            renamedCollection,
            renamedCollection,
            "2",
            [path.join(renamedAlias, "future-output")]
          )
        )
        expect(writableOverlap).toEqual({ kind: "writable_overlap" })
        expect(yield* store.load({ instanceId: instanceA, rootId: rootA })).toMatchObject({
          selectedPath: renamedCollection,
          canonicalPath: renamedCollection,
          mappingRevision: "2"
        })

        const relativeRejected = yield* store.activate(
          activate(instanceA, rootB, "relative/path", "relative/path")
        ).pipe(
          Effect.match({
            onFailure: () => true,
            onSuccess: () => false
          })
        )
        expect(relativeRejected).toBe(true)

        const otherNamespace = yield* store.activate(
          activate(instanceB, rootB, renamedAlias, renamedAlias)
        )
        expect(otherNamespace).toMatchObject({ kind: "activated", mapping: { mappingRevision: "1" } })
        expect(yield* store.list(instanceA)).toHaveLength(1)
        expect(yield* store.list(instanceB)).toHaveLength(1)

        if (process.platform === "linux") {
          const firstSibling = yield* store.activate(
            activate(instanceA, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", upperCaseSibling, upperCaseSibling)
          )
          const secondSibling = yield* store.activate(
            activate(instanceA, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", lowerCaseSibling, lowerCaseSibling)
          )
          expect(firstSibling).toMatchObject({ kind: "activated" })
          expect(secondSibling).toMatchObject({ kind: "activated" })
        }
      }).pipe(Effect.provide(LocalMappingStore.layer(databasePath, workerUrl)))

      await Effect.runPromise(Effect.scoped(program))

      const reopened = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* LocalMappingStore
          return yield* store.load({ instanceId: instanceA, rootId: rootA })
        }).pipe(Effect.provide(LocalMappingStore.layer(databasePath, workerUrl)), Effect.scoped)
      )
      expect(reopened).toMatchObject({
        selectedPath: renamedCollection,
        canonicalPath: renamedCollection,
        mappingRevision: "2"
      })
    } finally {
      await rm(databaseDirectory, { recursive: true, force: true })
      await rm(fixtureDirectory, { recursive: true, force: true })
    }
  })
})
