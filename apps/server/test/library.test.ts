import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { BlobWriter, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js"
import { LibraryHttpClient, ServerHttpClient, TaskHttpClient, type ScanTask } from "@henshin/contracts"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const servers: RunningServer[] = []
const dbPaths = new Set<string>()
const fixturePaths = new Set<string>()

const start = async (): Promise<RunningServer> => {
  const dbPath = await makeTempDbPath()
  dbPaths.add(dbPath)
  const server = await startServer(dbPath)
  servers.push(server)
  return server
}

const withServerClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, ServerHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, ServerHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withLibraryClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, LibraryHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, LibraryHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withTaskClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, TaskHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, TaskHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const waitForTerminal = async (server: RunningServer, taskId: string): Promise<ScanTask> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await withTaskClient(server, Effect.gen(function*() {
      const client = yield* TaskHttpClient
      return yield* client.get({ params: { id: taskId } })
    }))
    if (task.data.status !== "queued" && task.data.status !== "running") return task.data
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("normal scan did not reach a terminal state")
}

const makeZip = async (archivePath: string): Promise<void> => {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  await writer.add("001.jpg", new Uint8ArrayReader(new Uint8Array([0, 1, 2])))
  const blob = await writer.close()
  await writeFile(archivePath, Buffer.from(await blob.arrayBuffer()))
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("normal library scan", () => {
  it("accepts a CBZ and image directory with stable entries across restart and repeat scan", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-"))
    fixturePaths.add(fixture)
    const pages = path.join(fixture, "series-pages")
    await mkdir(pages)
    await writeFile(path.join(pages, "001.jpg"), "page")
    await writeFile(path.join(pages, "002.png"), "page")
    await makeZip(path.join(fixture, "archive.cbz"))

    const root = await withServerClient(server, Effect.gen(function*() {
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
    }))

    const stalePolicyScan = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const excluded = yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "exclude", exclusion: { path: "not-present", scope: "exact" } }
        }
      })
      if ("task" in excluded.data) throw new Error("expected policy response")
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          expected_policy_revision: excluded.data.policy_revision,
          command: { type: "remove-exclusion", exclusion: { path: "not-present", scope: "exact" } }
        }
      })
    }))
    if ("task" in stalePolicyScan.data) throw new Error("expected policy response")
    const currentRoot = stalePolicyScan.data

    const stale = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      }).pipe(Effect.flip)
    }))
    expect(stale._tag).toBe("RevisionConflict")

    const submit = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: currentRoot.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    if (!("task" in submit.data)) throw new Error("expected scan task submission")
    expect((await waitForTerminal(server, submit.data.task.task_id)).status).toBe("succeeded")

    const firstPage = await withLibraryClient(server, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return yield* client.search({ payload: { page_size: 1 } })
    }))
    expect(firstPage.data.entries).toHaveLength(1)
    expect(firstPage.data.has_more).toBe(true)
    const secondPage = await withLibraryClient(server, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return yield* client.search({ payload: { page_size: 1, cursor: firstPage.data.next_cursor ?? undefined } })
    }))
    const firstEntries = [...firstPage.data.entries, ...secondPage.data.entries]
    expect(firstEntries).toHaveLength(2)
    expect(new Set(firstEntries.map((entry) => entry.relative_path))).toEqual(new Set(["archive.cbz", "series-pages"]))
    expect(firstEntries.find((entry) => entry.relative_path === "archive.cbz")).toMatchObject({
      title: "archive",
      source_path: path.join(fixture, "archive.cbz"),
      kind: "archive",
      page_count: 1
    })
    expect(firstEntries.find((entry) => entry.relative_path === "series-pages")).toMatchObject({
      title: "series-pages",
      source_path: path.join(fixture, "series-pages"),
      kind: "image-directory",
      page_count: 2
    })
    const firstIds = new Map(firstEntries.map((entry) => [entry.relative_path, entry.entry_id]))

    await server.stop()
    const restarted = await startServer(server.dbPath)
    servers.push(restarted)
    const afterRestart = await withLibraryClient(restarted, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return yield* client.search({ payload: { page_size: 200 } })
    }))
    expect(afterRestart.data.entries.map((entry) => [entry.relative_path, entry.entry_id])).toEqual(
      expect.arrayContaining(Array.from(firstIds.entries()))
    )

    const repeat = await withServerClient(restarted, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: restarted.instanceId,
          epoch: restarted.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: currentRoot.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    if (!("task" in repeat.data)) throw new Error("expected repeated scan task submission")
    expect((await waitForTerminal(restarted, repeat.data.task.task_id)).status).toBe("succeeded")
    const afterRepeat = await withLibraryClient(restarted, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return yield* client.search({ payload: { page_size: 200 } })
    }))
    expect(afterRepeat.data.entries).toHaveLength(2)
    expect(new Map(afterRepeat.data.entries.map((entry) => [entry.relative_path, entry.entry_id]))).toEqual(firstIds)
  })
})
