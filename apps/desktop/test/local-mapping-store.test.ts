import { build } from "esbuild"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { localPhysicalIdentity } from "../src/main/LocalMappingPreview"
import {
  LocalMappingStore,
  type LocalMappingActivationInput
} from "../src/main/persistence/LocalMappingStore"

const instanceA = "11111111-1111-4111-8111-111111111111"
const instanceB = "22222222-2222-4222-8222-222222222222"
const instanceC = "33333333-3333-4333-8333-333333333333"
const instanceD = "44444444-4444-4444-8444-444444444444"
const instanceE = "55555555-5555-4555-8555-555555555555"
const rootA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const rootB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const rootC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const rootD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const rootE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const rootF = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const rootG = "11111111-aaaa-4111-8111-111111111111"
const rootH = "22222222-aaaa-4222-8222-222222222222"
const rootI = "33333333-aaaa-4333-8333-333333333333"

const activate = (
  instanceId: string,
  rootId: string,
  selectedPath: string,
  canonicalPath: string,
  expectedMappingRevision = "0",
  protectedWritablePaths: ReadonlyArray<string> = [],
  activationDeadlineMs?: number
): LocalMappingActivationInput => ({
  instanceId,
  rootId,
  selectedPath,
  canonicalPath,
  expectedMappingRevision,
  protectedWritablePaths,
  ...(activationDeadlineMs === undefined ? {} : { activationDeadlineMs })
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
    const databaseDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-db-")))
    const fixtureDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-fixture-")))
    const linkedTargetParent = await realpath(await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-target-")))
    try {
      const renamedCollection = path.join(fixtureDirectory, "renamed-collection")
      const collectionAlias = path.join(fixtureDirectory, "collection-alias")
      const renamedAlias = path.join(fixtureDirectory, "renamed-alias")
      const physicalParent = path.join(fixtureDirectory, "physical-parent")
      const physicalChild = path.join(physicalParent, "child")
      const physicalParentAlias = path.join(fixtureDirectory, "physical-parent-alias")
      const notDirectory = path.join(fixtureDirectory, "not-directory")
      await mkdir(renamedCollection)
      await symlink(renamedCollection, collectionAlias, "dir")
      await symlink(renamedCollection, renamedAlias, "dir")
      await mkdir(physicalChild, { recursive: true })
      await symlink(physicalParent, physicalParentAlias, "dir")
      const protectedResolutionLoop = path.join(fixtureDirectory, "protected-resolution-loop")
      await symlink("protected-resolution-loop", protectedResolutionLoop, "dir")
      const linkedTargetA = path.join(linkedTargetParent, "target-a")
      const linkedTargetB = path.join(linkedTargetParent, "target-b")
      const linkedAliasParent = path.join(fixtureDirectory, "linked-alias-parent")
      const linkedAlias = path.join(linkedAliasParent, "linked-root")
      await mkdir(linkedTargetA)
      await mkdir(linkedTargetB)
      await mkdir(linkedAliasParent)
      await symlink(linkedTargetA, linkedAlias, "dir")
      await writeFile(notDirectory, "not a directory")
      const upperCaseSibling = path.join(fixtureDirectory, "Books")
      const lowerCaseSibling = path.join(fixtureDirectory, "books")
      if (process.platform === "linux") {
        await mkdir(upperCaseSibling)
        await mkdir(lowerCaseSibling)
      }

      const databasePath = path.join(databaseDirectory, "client.db")
      const program = Effect.gen(function*() {
        const store = yield* LocalMappingStore

        expect(localPhysicalIdentity({ dev: 1, ino: 0 })).toBeUndefined()
        expect(yield* store.load({ instanceId: instanceA, rootId: rootA })).toBeUndefined()
        expect(yield* store.list(instanceA)).toEqual([])

        const initial = yield* store.activate(activate(instanceA, rootA, collectionAlias, renamedCollection))
        expect(initial).toEqual({
          kind: "activated",
          mapping: {
            instanceId: instanceA,
            rootId: rootA,
            selectedPath: collectionAlias,
            canonicalPath: renamedCollection,
            mappingRevision: "1"
          }
        })
        expect(yield* store.list(instanceA)).toHaveLength(1)

        const changed = yield* store.activate(
          activate(instanceA, rootA, renamedCollection, renamedCollection, "1")
        )
        expect(changed).toMatchObject({ kind: "activated", mapping: { mappingRevision: "2" } })

        const stale = yield* store.activate(
          activate(instanceA, rootA, collectionAlias, renamedCollection, "1")
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

        const protectedResolutionRejected = yield* store.activate(
          activate(
            instanceA,
            rootA,
            renamedCollection,
            renamedCollection,
            "2",
            [protectedResolutionLoop]
          )
        ).pipe(
          Effect.match({
            onFailure: () => true,
            onSuccess: () => false
          })
        )
        expect(protectedResolutionRejected).toBe(true)
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

        const missingRootRejected = yield* store.activate(
          activate(instanceA, rootC, path.join(fixtureDirectory, "missing-root"), path.join(fixtureDirectory, "missing-root"))
        ).pipe(
          Effect.match({
            onFailure: () => true,
            onSuccess: () => false
          })
        )
        expect(missingRootRejected).toBe(true)
        const fileRootRejected = yield* store.activate(
          activate(instanceA, rootC, notDirectory, notDirectory)
        ).pipe(
          Effect.match({
            onFailure: () => true,
            onSuccess: () => false
          })
        )
        expect(fileRootRejected).toBe(true)

        const expiredRejected = yield* store.activate(
          activate(instanceA, rootC, collectionAlias, renamedCollection, "0", [], Date.now() - 1)
        ).pipe(
          Effect.match({
            onFailure: () => true,
            onSuccess: () => false
          })
        )
        expect(expiredRejected).toBe(true)
        expect(yield* store.load({ instanceId: instanceA, rootId: rootC })).toBeUndefined()

        const otherNamespace = yield* store.activate(
          activate(instanceB, rootA, renamedAlias, renamedCollection)
        )
        expect(otherNamespace).toMatchObject({ kind: "activated", mapping: { mappingRevision: "1" } })
        expect(yield* store.list(instanceA)).toHaveLength(1)
        expect(yield* store.list(instanceB)).toHaveLength(1)
        expect(yield* store.load({ instanceId: instanceA, rootId: rootA })).toMatchObject({
          selectedPath: renamedCollection,
          canonicalPath: renamedCollection,
          mappingRevision: "2"
        })
        expect(yield* store.load({ instanceId: instanceB, rootId: rootA })).toMatchObject({
          selectedPath: renamedAlias,
          canonicalPath: renamedCollection,
          mappingRevision: "1"
        })

        const parentFirst = yield* store.activate(
          activate(instanceC, rootC, physicalParentAlias, physicalParentAlias)
        )
        expect(parentFirst).toMatchObject({ kind: "activated" })
        const childAfterParent = yield* store.activate(
          activate(instanceC, rootD, physicalChild, physicalChild)
        )
        expect(childAfterParent).toEqual({ kind: "root_conflict" })

        const childFirst = yield* store.activate(
          activate(instanceD, rootE, physicalChild, physicalChild)
        )
        expect(childFirst).toMatchObject({ kind: "activated" })
        const parentAfterChild = yield* store.activate(
          activate(instanceD, rootF, physicalParentAlias, physicalParentAlias)
        )
        expect(parentAfterChild).toEqual({ kind: "root_conflict" })

        const linkedRoot = yield* store.activate(
          activate(instanceE, rootG, linkedAlias, linkedTargetA)
        )
        expect(linkedRoot).toEqual({
          kind: "activated",
          mapping: {
            instanceId: instanceE,
            rootId: rootG,
            selectedPath: linkedAlias,
            canonicalPath: linkedTargetA,
            mappingRevision: "1"
          }
        })
        const linkedAliasParentRoot = yield* store.activate(
          activate(instanceE, rootH, linkedAliasParent, linkedAliasParent)
        )
        expect(linkedAliasParentRoot).toMatchObject({ kind: "activated", mapping: { mappingRevision: "1" } })

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

      await rm(linkedAlias, { force: true })
      await symlink(linkedTargetB, linkedAlias, "dir")

      const reopened = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* LocalMappingStore
          const linkedMapping = yield* store.load({ instanceId: instanceE, rootId: rootG })
          expect(linkedMapping).toEqual({
            instanceId: instanceE,
            rootId: rootG,
            selectedPath: linkedAlias,
            canonicalPath: linkedTargetA,
            mappingRevision: "1"
          })
          const retargetedRoot = yield* store.activate(
            activate(instanceE, rootI, linkedTargetB, linkedTargetB)
          )
          expect(retargetedRoot).toEqual({ kind: "root_conflict" })
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
      await rm(linkedTargetParent, { recursive: true, force: true })
    }
  })
})
