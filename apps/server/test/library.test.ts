import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { BlobWriter, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js"
import { LibraryHttpClient, ReviewHttpClient, ServerHttpClient, TaskHttpClient, type ScanTask } from "@henshin/contracts"
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

const withReviewClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, ReviewHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, ReviewHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

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

const waitForStagedPath = async (server: RunningServer, relativePath: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const staged = await withReviewClient(server, Effect.gen(function*() {
      return yield* (yield* ReviewHttpClient).candidates()
    }))
    if (staged.data.some((candidate) => candidate.relative_path === relativePath)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`scan did not stage ${relativePath}`)
}

const makeZip = async (archivePath: string): Promise<void> => {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  await writer.add("001.jpg", new Uint8ArrayReader(new Uint8Array([0, 1, 2])))
  const blob = await writer.close()
  await writeFile(archivePath, Buffer.from(await blob.arrayBuffer()))
}

const makeImageBook = async (rootPath: string, name: string): Promise<void> => {
  const book = path.join(rootPath, name)
  await mkdir(book)
  await writeFile(path.join(book, "001.jpg"), "page")
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
    for (const entry of firstEntries) {
      const resolution = await withLibraryClient(server, Effect.gen(function*() {
        return yield* (yield* LibraryHttpClient).resolution({ params: { id: entry.entry_id }, query: {} })
      }))
      expect(resolution.data).toMatchObject({
        entry_id: entry.entry_id,
        root_id: entry.root_id,
        relative_path: entry.relative_path,
        kind: entry.kind,
        decision_version: "1",
        location_revision: "1",
        content_version: "1",
        status: "usable",
        reason: null,
        first_page: expect.objectContaining({ name: "001.jpg" }),
        sibling_claims_truncated: false
      })
      expect(resolution.data.accepted_observation.observation_token).toEqual(expect.any(String))
      expect(resolution.data.sibling_claims.map((claim) => claim.relative_path)).toEqual(
        expect.arrayContaining(firstEntries.filter((other) => other.entry_id !== entry.entry_id).map((other) => other.relative_path))
      )
      expect("source_path" in resolution.data).toBe(false)
    }
    const unknownResolution = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: randomUUID() }, query: {} }).pipe(Effect.flip)
    }))
    expect(unknownResolution._tag).toBe("EntryNotFound")
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

  it("does not accept held discoveries when a later normal scan sees the same paths", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-held-normal-"))
    fixturePaths.add(fixture)
    await makeImageBook(fixture, "held-book-a")
    await makeImageBook(fixture, "held-book-b")
    await makeImageBook(fixture, "held-book-c")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.data.instance_id,
          epoch: preview.data.epoch,
          label: "Held then normal",
          path: fixture,
          preview_identity: preview.data.preview_identity
        }
      })
    }))

    const submitHeld = () => withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: true }
        }
      })
    }))
    const held = await submitHeld()
    if (!("task" in held.data)) throw new Error("expected held scan task submission")
    expect((await waitForTerminal(server, held.data.task.task_id)).status).toBe("succeeded")

    await makeImageBook(fixture, "new-book-a")
    await makeImageBook(fixture, "new-book-b")

    const normal = await withServerClient(server, Effect.gen(function*() {
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
      })
    }))
    if (!("task" in normal.data)) throw new Error("expected normal scan task submission")
    const terminal = await waitForTerminal(server, normal.data.task.task_id)
    expect(terminal.status).toBe("succeeded")
    expect(terminal.review_needed_count).toBe(3)

    const entries = await withLibraryClient(server, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return yield* client.search({ payload: { page_size: 200 } })
    }))
    expect(entries.data.entries.map((entry) => entry.relative_path).sort()).toEqual(["new-book-a", "new-book-b"])

    const staged = await withReviewClient(server, Effect.gen(function*() {
      const client = yield* ReviewHttpClient
      return yield* client.candidates()
    }))
    expect(staged.data).toHaveLength(3)
    expect(staged.data.map((candidate) => candidate.relative_path).sort()).toEqual([
      "held-book-a",
      "held-book-b",
      "held-book-c"
    ])
    expect(staged.data.every((candidate) => candidate.hold_state === "held")).toBe(true)

    await makeImageBook(fixture, "later-discovery")
    const nextHeld = await submitHeld()
    if (!("task" in nextHeld.data)) throw new Error("expected a new held scan")
    expect(await waitForTerminal(server, nextHeld.data.task.task_id)).toMatchObject({
      status: "succeeded", candidates_analyzed: 6, review_needed_count: 4
    })
    const reviewAfterHeld = await withReviewClient(server, Effect.gen(function*() {
      return yield* (yield* ReviewHttpClient).candidates()
    }))
    expect(reviewAfterHeld.data.map((candidate) => candidate.relative_path).sort()).toEqual([
      "held-book-a", "held-book-b", "held-book-c", "later-discovery"
    ])
    expect(reviewAfterHeld.data.every((candidate) => candidate.hold_state === "held")).toBe(true)

  })

  it("keeps a changed occupied path staged without changing the accepted identity", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-replacement-"))
    fixturePaths.add(fixture)
    await makeImageBook(fixture, "book")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Replacement", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))

    const scan = async () => withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))

    const first = await scan()
    if (!("task" in first.data)) throw new Error("expected initial scan task")
    expect((await waitForTerminal(server, first.data.task.task_id)).status).toBe("succeeded")
    const before = await withLibraryClient(server, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return yield* client.search({ payload: { page_size: 200 } })
    }))
    const accepted = before.data.entries[0]
    if (accepted === undefined) throw new Error("expected accepted entry")

    await writeFile(path.join(fixture, "book", "002.jpg"), "changed page")
    const second = await scan()
    if (!("task" in second.data)) throw new Error("expected replacement scan task")
    const terminal = await waitForTerminal(server, second.data.task.task_id)
    expect(terminal.status).toBe("completed_with_errors")
    expect(terminal.readiness_error?.code).toBe("allocation_deferred")
    expect(terminal.readiness_error?.message).toContain("book")
    expect(terminal.review_needed_count).toBe(1)

    const after = await withLibraryClient(server, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return yield* client.search({ payload: { page_size: 200 } })
    }))
    expect(after.data.entries).toHaveLength(1)
    expect(after.data.entries[0]).toMatchObject({
      entry_id: accepted.entry_id,
      relative_path: "book",
      page_count: 1,
      content_version: "1",
      location_revision: "1"
    })

    const changedResolution = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: accepted.entry_id }, query: {} })
    }))
    expect(changedResolution.data).toMatchObject({
      entry_id: accepted.entry_id,
      relative_path: "book",
      status: "unresolved",
      reason: "known-change",
      decision_version: "1",
      location_revision: "1",
      content_version: "1",
      first_page: { name: "001.jpg" }
    })

    const staged = await withReviewClient(server, Effect.gen(function*() {
      const client = yield* ReviewHttpClient
      return yield* client.candidates()
    }))
    expect(staged.data).toHaveLength(1)
    expect(staged.data[0]).toMatchObject({ relative_path: "book", analysis_status: "ready" })
    expect(staged.data[0]?.manifest?.pages).toHaveLength(2)
  })

  it("keeps accepted resolution usable when the server root is unavailable", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-resolution-unavailable-"))
    fixturePaths.add(fixture)
    await makeImageBook(fixture, "book")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Unavailable resolution", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))

    const scan = await withServerClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    if (!("task" in scan.data)) throw new Error("expected initial scan task")
    expect((await waitForTerminal(server, scan.data.task.task_id)).status).toBe("succeeded")
    const entries = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
    }))
    const accepted = entries.data.entries[0]
    if (accepted === undefined) throw new Error("expected accepted entry")

    await rm(fixture, { recursive: true, force: true })
    const unavailableScan = await withServerClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    if (!("task" in unavailableScan.data)) throw new Error("expected unavailable scan task")
    expect((await waitForTerminal(server, unavailableScan.data.task.task_id)).status).toBe("failed")

    const resolution = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: accepted.entry_id }, query: {} })
    }))
    expect(resolution.data.status).toBe("usable")
    expect(resolution.data.reason).toBeNull()
  })

  it("keeps identical accepted evidence usable after a failed ordinary scan", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-resolution-staged-failure-"))
    fixturePaths.add(fixture)
    await makeImageBook(fixture, "book")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Staged failure", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))

    const scan = async () => withServerClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))

    const first = await scan()
    if (!("task" in first.data)) throw new Error("expected initial scan task")
    expect((await waitForTerminal(server, first.data.task.task_id)).status).toBe("succeeded")
    const accepted = await withLibraryClient(server, Effect.gen(function*() {
      const entries = yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
      const entry = entries.data.entries[0]
      if (entry === undefined) throw new Error("expected accepted entry")
      return entry
    }))

    const second = await scan()
    if (!("task" in second.data)) throw new Error("expected repeated scan task")
    await waitForStagedPath(server, "book")
    const policy = await withServerClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "exclude", exclusion: { path: "not-present", scope: "exact" } }
        }
      })
    }))
    if ("task" in policy.data) throw new Error("expected policy response")
    expect((await waitForTerminal(server, second.data.task.task_id)).status).toBe("failed")

    const resolution = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: accepted.entry_id }, query: {} })
    }))
    expect(resolution.data).toMatchObject({ status: "usable", reason: null })
  })

  it("keeps identical accepted evidence usable after an interrupted scan", async () => {
    const previousQuietInterval = process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS
    process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS = "1000"
    const server = await start()
    try {
      const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-resolution-interrupted-"))
      fixturePaths.add(fixture)
      await makeImageBook(fixture, "book")

      const root = await withServerClient(server, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        const preview = yield* client.preview({ payload: { path: fixture } })
        if (!("children" in preview.data)) throw new Error("expected setup preview")
        return yield* client.save({
          payload: {
            operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
            label: "Interrupted resolution", path: fixture, preview_identity: preview.data.preview_identity
          }
        })
      }))

      const startScan = () => withServerClient(server, Effect.gen(function*() {
        return yield* (yield* ServerHttpClient).command({
          params: { id: root.data.root_id },
          payload: {
            operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
            expected_mapping_revision: root.data.mapping_revision,
            expected_policy_revision: root.data.policy_revision,
            command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
          }
        })
      }))

      const first = await startScan()
      if (!("task" in first.data)) throw new Error("expected initial scan task")
      expect((await waitForTerminal(server, first.data.task.task_id)).status).toBe("succeeded")
      const accepted = await withLibraryClient(server, Effect.gen(function*() {
        const entries = yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
        const entry = entries.data.entries[0]
        if (entry === undefined) throw new Error("expected accepted entry")
        return entry
      }))

      const second = await startScan()
      if (!("task" in second.data)) throw new Error("expected repeated scan task")
      await waitForStagedPath(server, "book")
      await server.stop()
      const restarted = await startServer(server.dbPath)
      servers.push(restarted)
      expect((await waitForTerminal(restarted, second.data.task.task_id)).status).toBe("interrupted")

      const resolution = await withLibraryClient(restarted, Effect.gen(function*() {
        return yield* (yield* LibraryHttpClient).resolution({ params: { id: accepted.entry_id }, query: {} })
      }))
      expect(resolution.data).toMatchObject({ status: "usable", reason: null })
    } finally {
      if (previousQuietInterval === undefined) delete process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS
      else process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS = previousQuietInterval
    }
  })

  it("paginates complete sibling collision evidence for a large flat collection", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-resolution-siblings-"))
    fixturePaths.add(fixture)
    await makeImageBook(fixture, "BOOK-999")
    for (let index = 0; index < 130; index += 1) {
      await makeImageBook(fixture, `book-${String(index).padStart(3, "0")}`)
    }
    // APFS folds case, so the equivalent logical claim is inserted while the
    // server is stopped after the real scan has populated the collection.

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Large flat collection", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))

    const scan = await withServerClient(server, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    if (!("task" in scan.data)) throw new Error("expected scan task")
    expect((await waitForTerminal(server, scan.data.task.task_id)).status).toBe("succeeded")

    const entries = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
    }))
    const target = entries.data.entries.find((entry) => entry.relative_path === "BOOK-999")
    if (target === undefined) throw new Error("expected target entry")
    expect(entries.data.entries).toHaveLength(131)

    const beforeRestart = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: target.entry_id }, query: {} })
    }))
    expect(beforeRestart.data.sibling_claims_truncated).toBe(true)

    await server.stop()
    const db = new DatabaseSync(server.dbPath)
    const acceptedRow = db.prepare(
      "SELECT library_id, root_id, kind, manifest_json FROM library_entries WHERE entry_id = ?"
    ).get(target.entry_id) as {
      library_id: string
      root_id: string
      kind: "image-directory"
      manifest_json: string
    } | undefined
    if (acceptedRow === undefined) throw new Error("expected persisted target entry")
    const equivalentEntryId = randomUUID()
    const now = Date.now()
    db.prepare(
      "INSERT INTO library_entries(entry_id, library_id, root_id, relative_path, source_path, kind, title, page_count, state, content_version, location_revision, decision_version, manifest_json, created_at_ms, updated_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 1, 1, 1, ?, ?, ?)"
    ).run(
      equivalentEntryId,
      acceptedRow.library_id,
      acceptedRow.root_id,
      "book-999",
      path.join(fixture, "book-999"),
      acceptedRow.kind,
      "book-999",
      1,
      acceptedRow.manifest_json,
      now,
      now
    )
    db.prepare("UPDATE server_library SET change_revision = change_revision + 1 WHERE id = 1").run()
    db.close()
    const restarted = await startServer(server.dbPath)
    servers.push(restarted)

    const first = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({
        params: { id: target.entry_id },
        query: {
          sibling_cursor: beforeRestart.data.sibling_claims_next_cursor ?? undefined,
          sibling_claims_revision: beforeRestart.data.sibling_claims_revision
        }
      })
    }))
    expect(first.data).toMatchObject({
      status: "usable",
      reason: null,
      sibling_claims: expect.any(Array),
      sibling_claims_truncated: true
    })
    expect(first.data.sibling_claims_revision).not.toBe(beforeRestart.data.sibling_claims_revision)
    expect(first.data.sibling_claims).toHaveLength(128)
    expect(first.data.sibling_claims.map((claim) => claim.relative_path)).not.toContain("book-999")
    expect(first.data.sibling_claims_next_cursor).not.toBeNull()

    const second = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({
        params: { id: target.entry_id },
        query: {
          sibling_cursor: first.data.sibling_claims_next_cursor ?? undefined,
          sibling_claims_revision: first.data.sibling_claims_revision
        }
      })
    }))
    expect(second.data).toMatchObject({
      status: "usable",
      reason: null,
      sibling_claims_truncated: false,
      sibling_claims_next_cursor: null,
      sibling_claims_revision: first.data.sibling_claims_revision
    })
    expect(second.data.sibling_claims.map((claim) => claim.relative_path)).toContain("book-999")
  })

  it("defers new allocation when an accepted path is missing", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-missing-"))
    fixturePaths.add(fixture)
    await makeImageBook(fixture, "missing-book")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Missing", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))

    const scan = async () => withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))

    const first = await scan()
    if (!("task" in first.data)) throw new Error("expected initial scan task")
    expect((await waitForTerminal(server, first.data.task.task_id)).status).toBe("succeeded")
    await rm(path.join(fixture, "missing-book"), { recursive: true, force: true })

    const missingOnly = await scan()
    if (!("task" in missingOnly.data)) throw new Error("expected missing-only scan task")
    const missingOnlyTerminal = await waitForTerminal(server, missingOnly.data.task.task_id)
    expect(missingOnlyTerminal.status).toBe("completed_with_errors")
    expect(missingOnlyTerminal.readiness_error?.code).toBe("allocation_deferred")
    expect(missingOnlyTerminal.readiness_error?.message).toContain("missing-book")
    expect(missingOnlyTerminal.review_needed_count).toBe(1)

    await makeImageBook(fixture, "new-book")

    const second = await scan()
    if (!("task" in second.data)) throw new Error("expected deferred scan task")
    const terminal = await waitForTerminal(server, second.data.task.task_id)
    expect(terminal.status).toBe("completed_with_errors")
    expect(terminal.readiness_error?.code).toBe("allocation_deferred")
    expect(terminal.readiness_error?.message).toContain("missing-book")
    expect(terminal.review_needed_count).toBe(2)

    const entries = await withLibraryClient(server, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return yield* client.search({ payload: { page_size: 200 } })
    }))
    expect(entries.data.entries.map((entry) => entry.relative_path)).toEqual(["missing-book"])
    const staged = await withReviewClient(server, Effect.gen(function*() {
      const client = yield* ReviewHttpClient
      return yield* client.candidates()
    }))
    expect(staged.data.map((candidate) => candidate.relative_path)).toEqual(["new-book"])
  })

  it("does not treat an excluded accepted path as a missing claim", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-excluded-"))
    fixturePaths.add(fixture)
    await makeImageBook(fixture, "excluded-book")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Excluded", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))

    const first = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    if (!("task" in first.data)) throw new Error("expected initial scan task")
    expect((await waitForTerminal(server, first.data.task.task_id)).status).toBe("succeeded")

    const policy = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "exclude", exclusion: { path: "excluded-book", scope: "exact" } }
        }
      })
    }))
    if ("task" in policy.data) throw new Error("expected policy response")
    const policyRoot = policy.data
    await rm(path.join(fixture, "excluded-book"), { recursive: true, force: true })
    await makeImageBook(fixture, "new-book")

    const second = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: policyRoot.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    if (!("task" in second.data)) throw new Error("expected excluded scan task")
    expect((await waitForTerminal(server, second.data.task.task_id)).status).toBe("succeeded")

    const entries = await withLibraryClient(server, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return yield* client.search({ payload: { page_size: 200 } })
    }))
    expect(entries.data.entries.map((entry) => entry.relative_path).sort()).toEqual(["excluded-book", "new-book"])
  })

  it("returns bounded root-scoped indexed format and size evidence", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-mapping-samples-"))
    fixturePaths.add(fixture)
    await makeImageBook(fixture, "series-pages")
    await writeFile(path.join(fixture, "series-pages", "002.png"), "second page")
    await makeZip(path.join(fixture, "archive.cbz"))

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Mapping samples", path: fixture, preview_identity: preview.data.preview_identity
        }
      })
    }))

    const submitted = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    if (!("task" in submitted.data)) throw new Error("expected scan task")
    expect((await waitForTerminal(server, submitted.data.task.task_id)).status).toBe("succeeded")

    const samples = await withLibraryClient(server, Effect.gen(function*() {
      const client = yield* LibraryHttpClient
      return yield* client.indexedSamples({ params: { id: root.data.root_id } })
    }))

    expect(samples.data).toMatchObject({
      root_id: root.data.root_id,
      sample_limit: 32,
      sample_truncated: false,
      samples: [
        { relative_path: "archive.cbz", kind: "archive", format_evidence: ["jpeg"] },
        { relative_path: "series-pages", kind: "image-directory", format_evidence: ["jpeg", "png"] }
      ]
    })
    expect(samples.data.samples.every((sample) => sample.size_bytes !== null && sample.size_bytes > 0)).toBe(true)
  })
})
