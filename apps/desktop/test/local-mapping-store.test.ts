import { build } from "esbuild"
import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Effect } from "effect"
import type { EntryResolution } from "@henshin/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { StoredReaderProfile } from "../src/main/persistence/ReaderProfileStore"
import { resolveAcceptedTarget } from "../src/main/open-target"
import {
  LocalMappingStore,
  type LocalMappingActivationInput
} from "../src/main/persistence/LocalMappingStore"

const instanceA = "11111111-1111-4111-8111-111111111111"
const instanceB = "22222222-2222-4222-8222-222222222222"
const instanceC = "33333333-3333-4333-8333-333333333333"
const instanceD = "44444444-4444-4444-8444-444444444444"
const instanceE = "55555555-5555-4555-8555-555555555555"
const instanceF = "66666666-6666-4666-8666-666666666666"
const rootA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const rootB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const rootC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const rootD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const rootE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const rootF = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const rootG = "11111111-aaaa-4111-8111-111111111111"
const rootH = "22222222-aaaa-4222-8222-222222222222"
const rootI = "33333333-aaaa-4333-8333-333333333333"
const rootJ = "44444444-aaaa-4444-8444-444444444444"
const rootK = "55555555-aaaa-4555-8555-555555555555"

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

const admittedIdentity = async (directory: string): Promise<string | null> => {
  const stats = await stat(directory, { bigint: true })
  return stats.dev === 0n || stats.ino === 0n ? null : `${stats.dev.toString()}:${stats.ino.toString()}`
}

const readerProfile: StoredReaderProfile = {
  profile_id: randomUUID(),
  revision: "1",
  name: "Fixture archive reader",
  launch_mode: "explicit-executable",
  supported_formats: ["archive"],
  target_mode: "archive",
  executable_name: "fixture-reader",
  argument_tokens: ["{target}"],
  executablePath: process.execPath
}

const archiveResolution = async (root: string): Promise<EntryResolution> => {
  const metadata = await stat(path.join(root, "book.cbz"))
  return {
    entry_id: randomUUID(),
    root_id: rootA,
    relative_path: "book.cbz",
    kind: "archive",
    decision_version: "1",
    location_revision: "1",
    content_version: "1",
    status: "usable",
    reason: null,
    accepted_observation: {
      kind: "archive",
      bytes: metadata.size,
      mtime_ms: metadata.mtimeMs,
      entry_count: 1,
      observation_token: "fixture"
    },
    first_page: null,
    sibling_claims: [],
    sibling_claims_truncated: false,
    sibling_claims_next_cursor: null,
    sibling_claims_revision: "1"
  }
}

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
      const renamedRoot = path.join(fixtureDirectory, "renamed-root")
      const movedRoot = path.join(fixtureDirectory, "moved-root")
      const movedRootAlias = path.join(fixtureDirectory, "moved-root-alias")
      await mkdir(linkedTargetA)
      await mkdir(linkedTargetB)
      await mkdir(linkedAliasParent)
      await symlink(linkedTargetA, linkedAlias, "dir")
      await mkdir(renamedRoot)
      await writeFile(notDirectory, "not a directory")
      const renamedCollectionIdentity = await admittedIdentity(renamedCollection)
      const linkedTargetAIdentity = await admittedIdentity(linkedTargetA)
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

        const initial = yield* store.activate(activate(instanceA, rootA, collectionAlias, renamedCollection))
        expect(initial).toEqual({
          kind: "activated",
          mapping: {
            instanceId: instanceA,
            rootId: rootA,
            selectedPath: collectionAlias,
            canonicalPath: renamedCollection,
            admittedRootIdentity: renamedCollectionIdentity,
            mappingRevision: "1",
            requiresReauthorization: false
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
            admittedRootIdentity: renamedCollectionIdentity,
            mappingRevision: "2",
            requiresReauthorization: false
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
            admittedRootIdentity: linkedTargetAIdentity,
            mappingRevision: "1",
            requiresReauthorization: false
          }
        })
        const linkedAliasParentRoot = yield* store.activate(
          activate(instanceE, rootH, linkedAliasParent, linkedAliasParent)
        )
        expect(linkedAliasParentRoot).toMatchObject({ kind: "activated", mapping: { mappingRevision: "1" } })

        const renamedRootMapping = yield* store.activate(
          activate(instanceF, rootJ, renamedRoot, renamedRoot)
        )
        expect(renamedRootMapping).toMatchObject({ kind: "activated", mapping: { mappingRevision: "1" } })

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

      const replacedRenamedCollection = path.join(fixtureDirectory, "renamed-collection-replaced")
      await rename(renamedCollection, replacedRenamedCollection)
      await mkdir(renamedCollection)
      const replacementIdentity = await admittedIdentity(renamedCollection)
      expect(replacementIdentity).not.toBe(renamedCollectionIdentity)

      await rm(linkedAlias, { force: true })
      await symlink(linkedTargetB, linkedAlias, "dir")
      await rename(renamedRoot, movedRoot)
      await symlink(movedRoot, movedRootAlias, "dir")

      const reopened = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* LocalMappingStore
          const linkedMapping = yield* store.load({ instanceId: instanceE, rootId: rootG })
          expect(linkedMapping).toEqual({
            instanceId: instanceE,
            rootId: rootG,
            selectedPath: linkedAlias,
            canonicalPath: linkedTargetA,
            admittedRootIdentity: linkedTargetAIdentity,
            mappingRevision: "1",
            requiresReauthorization: false
          })
          const retargetedRoot = yield* store.activate(
            activate(instanceE, rootI, linkedTargetB, linkedTargetB)
          )
          expect(retargetedRoot).toEqual({ kind: "root_conflict" })
          const renamedAliasRoot = yield* store.activate(
            activate(instanceF, rootK, movedRootAlias, movedRoot)
          )
          expect(renamedAliasRoot).toEqual({ kind: "root_conflict" })
          expect(yield* store.load({ instanceId: instanceA, rootId: rootA })).toMatchObject({
            admittedRootIdentity: renamedCollectionIdentity,
            mappingRevision: "2"
          })
          const replaced = yield* store.activate(
            activate(instanceA, rootA, renamedCollection, renamedCollection, "2")
          )
          expect(replaced).toMatchObject({
            kind: "activated",
            mapping: {
              admittedRootIdentity: replacementIdentity,
              mappingRevision: "3"
            }
          })
          return yield* store.load({ instanceId: instanceA, rootId: rootA })
        }).pipe(Effect.provide(LocalMappingStore.layer(databasePath, workerUrl)), Effect.scoped)
      )
      expect(reopened).toMatchObject({
        selectedPath: renamedCollection,
        canonicalPath: renamedCollection,
        admittedRootIdentity: replacementIdentity,
        mappingRevision: "3"
      })
    } finally {
      await rm(databaseDirectory, { recursive: true, force: true })
      await rm(fixtureDirectory, { recursive: true, force: true })
      await rm(linkedTargetParent, { recursive: true, force: true })
    }
  })

  it("returns null admitted identity for legacy mapping rows", async () => {
    const databaseDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-legacy-db-")))
    const databasePath = path.join(databaseDirectory, "client.db")
    const database = new DatabaseSync(databasePath)
    database.exec(`
      CREATE TABLE client_mappings (
        instance_id TEXT NOT NULL,
        root_id TEXT NOT NULL,
        selected_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        mapping_revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state = 'active'),
        PRIMARY KEY (instance_id, root_id)
      )
    `)
    database.prepare(`
      INSERT INTO client_mappings(
        instance_id, root_id, selected_path, canonical_path, mapping_revision, state
      ) VALUES(?, ?, ?, ?, ?, 'active')
    `).run(instanceA, rootA, "/legacy/selected", "/legacy/canonical", 4n)
    database.close()

    try {
      const legacy = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* LocalMappingStore
          return yield* store.load({ instanceId: instanceA, rootId: rootA })
        }).pipe(Effect.provide(LocalMappingStore.layer(databasePath, workerUrl)), Effect.scoped)
      )
      expect(legacy).toEqual({
        instanceId: instanceA,
        rootId: rootA,
        selectedPath: "/legacy/selected",
        canonicalPath: "/legacy/canonical",
        admittedRootIdentity: null,
        mappingRevision: "4",
        requiresReauthorization: false
      })
    } finally {
      await rm(databaseDirectory, { recursive: true, force: true })
    }
  })

  it("requires remapping after a same-path directory replacement before resolving a book", async () => {
    const databaseDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-reconfirm-db-")))
    const fixtureDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-reconfirm-fixture-")))
    const mappedDirectory = path.join(fixtureDirectory, "library")
    const replacementDirectory = path.join(fixtureDirectory, "replacement")
    const databasePath = path.join(databaseDirectory, "client.db")
    const book = Buffer.from("otherwise indistinguishable book")

    try {
      await mkdir(mappedDirectory)
      await writeFile(path.join(mappedDirectory, "book.cbz"), book)
      await mkdir(replacementDirectory)
      await writeFile(path.join(replacementDirectory, "book.cbz"), book)

      const initial = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* LocalMappingStore
          return yield* store.activate(activate(instanceA, rootA, mappedDirectory, mappedDirectory))
        }).pipe(Effect.provide(LocalMappingStore.layer(databasePath, workerUrl)), Effect.scoped)
      )
      expect(initial.kind).toBe("activated")
      if (initial.kind !== "activated") throw new Error("fixture mapping was not activated")

      const persisted = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* LocalMappingStore
          return yield* store.load({ instanceId: instanceA, rootId: rootA })
        }).pipe(Effect.provide(LocalMappingStore.layer(databasePath, workerUrl)), Effect.scoped)
      )
      expect(persisted).not.toBeUndefined()
      if (persisted === undefined) throw new Error("fixture mapping was not persisted")
      const originalResolution = await archiveResolution(mappedDirectory)
      await expect(resolveAcceptedTarget(persisted, originalResolution, readerProfile)).resolves.toBe(
        path.join(mappedDirectory, "book.cbz")
      )

      const originalIdentity = persisted.admittedRootIdentity
      await rename(mappedDirectory, path.join(fixtureDirectory, "original"))
      await rename(replacementDirectory, mappedDirectory)
      expect(await admittedIdentity(mappedDirectory)).not.toBe(originalIdentity)

      await expect(resolveAcceptedTarget(persisted, originalResolution, readerProfile)).rejects.toThrow(
        "configured local mapping root changed"
      )

      const reconfirmed = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* LocalMappingStore
          return yield* store.activate(activate(instanceA, rootA, mappedDirectory, mappedDirectory, "1"))
        }).pipe(Effect.provide(LocalMappingStore.layer(databasePath, workerUrl)), Effect.scoped)
      )
      expect(reconfirmed).toMatchObject({
        kind: "activated",
        mapping: { mappingRevision: "2" }
      })
      if (reconfirmed.kind !== "activated") throw new Error("replacement mapping was not activated")
      const replacementResolution = await archiveResolution(mappedDirectory)
      await expect(resolveAcceptedTarget(reconfirmed.mapping, replacementResolution, readerProfile)).resolves.toBe(
        path.join(mappedDirectory, "book.cbz")
      )
    } finally {
      await rm(databaseDirectory, { recursive: true, force: true })
      await rm(fixtureDirectory, { recursive: true, force: true })
    }
  })
})
