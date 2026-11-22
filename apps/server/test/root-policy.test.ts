import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { ServerHttpClient } from "@henshin/contracts"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const servers: RunningServer[] = []
const dbPaths = new Set<string>()
const fixturePaths = new Set<string>()

const start = async (dbPath?: string): Promise<RunningServer> => {
  const actualPath = dbPath ?? (await makeTempDbPath())
  dbPaths.add(actualPath)
  const server = await startServer(actualPath)
  servers.push(server)
  return server
}

const withClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, ServerHttpClient>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, ServerHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken }))
  )

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("saved root scan policy", () => {
  it("persists exact and subtree exclusions, keeps prefix siblings, and rejects stale context", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-root-policy-"))
    fixturePaths.add(fixture)
    await mkdir(path.join(fixture, "series"))
    await mkdir(path.join(fixture, "series-extra"))
    await mkdir(path.join(fixture, "series-extra-sibling"))
    const source = path.join(fixture, "series", "book.cbz")
    await writeFile(source, "source-bytes")
    await writeFile(path.join(fixture, "series-extra", "001.jpg"), "page")
    await writeFile(path.join(fixture, "series-extra-sibling", "001.jpg"), "page")
    const sourceBefore = await readFile(source)

    const saved = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        const preview = yield* client.preview({ payload: { path: fixture } })
        if (!("children" in preview.data)) throw new Error("expected setup preview")
        return yield* client.save({
          payload: {
            operation_id: randomUUID(),
            instance_id: preview.data.instance_id,
            epoch: preview.data.epoch,
            label: "Books",
            path: fixture,
            preview_identity: preview.data.preview_identity
          }
        })
      })
    )

    const exactOperationId = randomUUID()
    const exact = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: saved.data.root_id },
          payload: {
            operation_id: exactOperationId,
            instance_id: server.instanceId,
            epoch: server.epoch,
            expected_policy_revision: saved.data.policy_revision,
            command: { type: "exclude", exclusion: { path: "series/book.cbz", scope: "exact" } }
          }
        })
      })
    )
    expect(exact.data.policy_revision).toBe("1")
    expect(exact.data.exclusions).toEqual([{ path: "series/book.cbz", scope: "exact" }])

    const subtree = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: saved.data.root_id },
          payload: {
            operation_id: randomUUID(),
            instance_id: server.instanceId,
            epoch: server.epoch,
            expected_policy_revision: exact.data.policy_revision,
            command: { type: "exclude", exclusion: { path: "series-extra", scope: "subtree" } }
          }
        })
      })
    )
    expect(subtree.data.policy_revision).toBe("2")
    expect(subtree.data.exclusions).toEqual([
      { path: "series/book.cbz", scope: "exact" },
      { path: "series-extra", scope: "subtree" }
    ])

    const discovery = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.preview({ payload: { kind: "saved-root", root_id: saved.data.root_id } })
      })
    )
    expect(discovery.data).toMatchObject({
      kind: "saved-root-discovery",
      policy_revision: "2",
      candidates: [{ relative_path: "series-extra-sibling", kind: "image-directory" }]
    })
    expect(discovery.data).not.toMatchObject({
      candidates: expect.arrayContaining([
        { relative_path: "series/book.cbz" },
        { relative_path: "series-extra" }
      ])
    })

    const restored = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: saved.data.root_id },
          payload: {
            operation_id: randomUUID(),
            instance_id: server.instanceId,
            epoch: server.epoch,
            expected_policy_revision: subtree.data.policy_revision,
            command: { type: "remove-exclusion", exclusion: { path: "series/book.cbz", scope: "exact" } }
          }
        })
      })
    )
    expect(restored.data.policy_revision).toBe("3")
    expect(restored.data.exclusions).toEqual([{ path: "series-extra", scope: "subtree" }])

    const restoredDiscovery = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.preview({ payload: { kind: "saved-root", root_id: saved.data.root_id } })
      })
    )
    if (!("kind" in restoredDiscovery.data)) throw new Error("expected saved-root discovery")
    expect(restoredDiscovery.data.candidates.map((candidate) => candidate.relative_path).sort()).toEqual([
      "series-extra-sibling",
      "series/book.cbz"
    ])
    expect(restoredDiscovery.data.candidates).toHaveLength(2)

    const replay = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: saved.data.root_id },
          payload: {
            operation_id: exactOperationId,
            instance_id: server.instanceId,
            epoch: server.epoch,
            expected_policy_revision: saved.data.policy_revision,
            command: { type: "exclude", exclusion: { path: "series/book.cbz", scope: "exact" } }
          }
        })
      })
    )
    expect(replay.data).toEqual(exact.data)

    const stale = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client
          .command({
            params: { id: saved.data.root_id },
            payload: {
              operation_id: randomUUID(),
              instance_id: server.instanceId,
              epoch: server.epoch,
              expected_policy_revision: "0",
              command: { type: "exclude", exclusion: { path: "series-extra", scope: "subtree" } }
            }
          })
          .pipe(Effect.flip)
      })
    )
    expect(stale._tag).toBe("RevisionConflict")

    const wrongInstance = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client
          .command({
            params: { id: saved.data.root_id },
            payload: {
              operation_id: randomUUID(),
              instance_id: randomUUID(),
              epoch: server.epoch,
              expected_policy_revision: "2",
              command: { type: "exclude", exclusion: { path: "series-extra", scope: "subtree" } }
            }
          })
          .pipe(Effect.flip)
      })
    )
    expect(wrongInstance._tag).toBe("InstanceMismatch")

    const wrongEpoch = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client
          .command({
            params: { id: saved.data.root_id },
            payload: {
              operation_id: randomUUID(),
              instance_id: server.instanceId,
              epoch: randomUUID(),
              expected_policy_revision: "2",
              command: { type: "exclude", exclusion: { path: "series-extra", scope: "subtree" } }
            }
          })
          .pipe(Effect.flip)
      })
    )
    expect(wrongEpoch._tag).toBe("EpochChanged")

    const wrongRoot = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client
          .command({
            params: { id: randomUUID() },
            payload: {
              operation_id: randomUUID(),
              instance_id: server.instanceId,
              epoch: server.epoch,
              expected_policy_revision: "2",
              command: { type: "exclude", exclusion: { path: "series-extra", scope: "subtree" } }
            }
          })
          .pipe(Effect.flip)
      })
    )
    expect(wrongRoot._tag).toBe("RootNotFound")

    expect(await readFile(source)).toEqual(sourceBefore)
    const listedBeforeRestart = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.list()
      })
    )
    expect(listedBeforeRestart.data[0]?.exclusions).toEqual(restored.data.exclusions)

    await server.stop()
    const restarted = await startServer(server.dbPath)
    servers.push(restarted)
    const listedAfterRestart = await withClient(
      restarted,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.list()
      })
    )
    expect(listedAfterRestart.data[0]?.policy_revision).toBe("3")
    expect(listedAfterRestart.data[0]?.exclusions).toEqual(restored.data.exclusions)
  })
})
