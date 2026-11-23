import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
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

  it("blocks Open resolution for a pending changed occupied path without changing accepted identity", async () => {
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

    const scan = async (activeServer: RunningServer = server) => withServerClient(activeServer, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: activeServer.instanceId, epoch: activeServer.epoch,
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

    await rm(path.join(fixture, "book"), { recursive: true, force: true })
    await makeImageBook(fixture, "book")
    await writeFile(path.join(fixture, "book", "001.jpg"), "edit")
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
      state: "replacement-pending",
      page_count: 1,
      content_version: "1",
      location_revision: "1"
    })
    expect(after.data.entries[0]?.replacement).toMatchObject({
      candidate_observation: { analysis_status: "ready" }
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

    await server.stop()
    const db = new DatabaseSync(server.dbPath)
    const acceptedRow = db.prepare(
      "SELECT manifest_json FROM library_entries WHERE entry_id = ?"
    ).get(accepted.entry_id) as { manifest_json: string } | undefined
    if (acceptedRow === undefined) throw new Error("expected accepted manifest")
    db.prepare(
      "UPDATE staged_discoveries SET analysis_status = 'ready', manifest_json = ?, analysis_error_json = NULL WHERE root_id = ? AND relative_path = ?"
    ).run(acceptedRow.manifest_json, root.data.root_id, "book")
    db.close()

    const restarted = await startServer(server.dbPath)
    servers.push(restarted)
    const restoredResolution = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: accepted.entry_id }, query: {} })
    }))
    expect(restoredResolution.data).toMatchObject({ status: "unresolved", reason: "known-change" })

    await rm(path.join(fixture, "book", "001.jpg"))
    const failedRescan = await scan(restarted)
    if (!("task" in failedRescan.data)) throw new Error("expected failed replacement scan task")
    expect((await waitForTerminal(restarted, failedRescan.data.task.task_id)).status).toBe("completed_with_errors")
    const afterReadFailure = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: accepted.entry_id }, query: {} })
    }))
    expect(afterReadFailure.data).toMatchObject({ status: "unresolved", reason: "known-change" })

    const staged = await withReviewClient(restarted, Effect.gen(function*() {
      const client = yield* ReviewHttpClient
      return yield* client.candidates()
    }))
    expect(staged.data).toHaveLength(1)
    expect(staged.data[0]).toMatchObject({ relative_path: "book", analysis_status: "ready" })
    expect(staged.data[0]?.manifest?.pages).toHaveLength(1)
  })

  it("keeps an accepted archive usable after a transient server source failure", async () => {
    const previousQuietInterval = process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS
    process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS = "1000"
    const server = await start()
    try {
      const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-resolution-archive-transient-"))
      fixturePaths.add(fixture)
      const archive = path.join(fixture, "archive.cbz")
      await makeZip(archive)

      const root = await withServerClient(server, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        const preview = yield* client.preview({ payload: { path: fixture } })
        if (!("children" in preview.data)) throw new Error("expected setup preview")
        return yield* client.save({
          payload: {
            operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
            label: "Transient archive source", path: fixture, preview_identity: preview.data.preview_identity
          }
        })
      }))

      const scan = () => withServerClient(server, Effect.gen(function*() {
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
        if (entry === undefined) throw new Error("expected accepted archive")
        return entry
      }))
      expect(accepted.kind).toBe("archive")

      const second = await scan()
      if (!("task" in second.data)) throw new Error("expected repeated scan task")
      await waitForStagedPath(server, "archive.cbz")
      await rm(archive)
      const terminal = await waitForTerminal(server, second.data.task.task_id)
      expect(terminal.status).toBe("completed_with_errors")
      expect(terminal.readiness_error?.code).toBe("allocation_deferred")
      await makeZip(archive)

      const resolution = await withLibraryClient(server, Effect.gen(function*() {
        return yield* (yield* LibraryHttpClient).resolution({ params: { id: accepted.entry_id }, query: {} })
      }))
      expect(resolution.data).toMatchObject({
        entry_id: accepted.entry_id,
        kind: "archive",
        status: "usable",
        reason: null,
        first_page: { name: "001.jpg" }
      })
    } finally {
      if (previousQuietInterval === undefined) delete process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS
      else process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS = previousQuietInterval
    }
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

  it("persists complete-scan availability and restores the same claim after reappearance", async () => {
    const previousQuietInterval = process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-availability-"))
    fixturePaths.add(fixture)
    await makeImageBook(fixture, "book")
    const hiddenFixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-availability-hidden-"))
    fixturePaths.add(hiddenFixture)
    const hiddenBook = path.join(hiddenFixture, "book")

    try {
      const root = await withServerClient(server, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        const preview = yield* client.preview({ payload: { path: fixture } })
        if (!("children" in preview.data)) throw new Error("expected setup preview")
        return yield* client.save({
          payload: {
            operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
            label: "Availability", path: fixture, preview_identity: preview.data.preview_identity
          }
        })
      }))

      const scan = (activeServer: RunningServer = server) => withServerClient(activeServer, Effect.gen(function*() {
        return yield* (yield* ServerHttpClient).command({
          params: { id: root.data.root_id },
          payload: {
            operation_id: randomUUID(), instance_id: activeServer.instanceId, epoch: activeServer.epoch,
            expected_mapping_revision: root.data.mapping_revision,
            expected_policy_revision: root.data.policy_revision,
            command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
          }
        })
      }))

      const first = await scan()
      if (!("task" in first.data)) throw new Error("expected initial availability scan")
      expect((await waitForTerminal(server, first.data.task.task_id)).status).toBe("succeeded")
      const initial = await withLibraryClient(server, Effect.gen(function*() {
        const entries = yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
        const entry = entries.data.entries.find((candidate) => candidate.relative_path === "book")
        if (entry === undefined) throw new Error("expected accepted availability entry")
        return entry
      }))
      expect(initial.availability).toMatchObject({ status: "present", observed_at_ms: expect.any(Number) })
      const initialObservation = initial.availability.observed_at_ms
      if (initialObservation === null) throw new Error("expected initial availability time")

      process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS = "1000"
      const interrupted = await scan()
      if (!("task" in interrupted.data)) throw new Error("expected interrupted availability scan")
      await waitForStagedPath(server, "book")
      await server.stop()
      const restarted = await startServer(server.dbPath)
      servers.push(restarted)
      expect((await waitForTerminal(restarted, interrupted.data.task.task_id)).status).toBe("interrupted")
      const afterInterrupted = await withLibraryClient(restarted, Effect.gen(function*() {
        return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
      }))
      expect(afterInterrupted.data.entries).toHaveLength(1)
      expect(afterInterrupted.data.entries[0]).toMatchObject({
        entry_id: initial.entry_id,
        availability: { status: "present", observed_at_ms: initialObservation }
      })

      delete process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS
      const resumed = await scan(restarted)
      if (!("task" in resumed.data)) throw new Error("expected resumed availability scan")
      expect((await waitForTerminal(restarted, resumed.data.task.task_id)).status).toBe("succeeded")

      await rename(path.join(fixture, "book"), hiddenBook)
      const disappeared = await scan(restarted)
      if (!("task" in disappeared.data)) throw new Error("expected disappearance scan")
      expect((await waitForTerminal(restarted, disappeared.data.task.task_id)).status).toBe("succeeded")
      const missing = await withLibraryClient(restarted, Effect.gen(function*() {
        return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
      }))
      expect(missing.data.entries).toHaveLength(1)
      expect(missing.data.entries[0]).toMatchObject({
        entry_id: initial.entry_id,
        relative_path: "book",
        availability: { status: "missing", observed_at_ms: expect.any(Number) }
      })
      const missingObservation = missing.data.entries[0]?.availability.observed_at_ms
      if (missingObservation === null || missingObservation === undefined) throw new Error("expected missing availability time")

      await restarted.stop()
      const persisted = await startServer(server.dbPath)
      servers.push(persisted)
      const afterRestart = await withLibraryClient(persisted, Effect.gen(function*() {
        return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
      }))
      expect(afterRestart.data.entries[0]).toMatchObject({
        entry_id: initial.entry_id,
        availability: { status: "missing", observed_at_ms: missingObservation }
      })

      const unavailableRoot = `${fixture}-${randomUUID()}`
      await rename(fixture, unavailableRoot)
      try {
        const failed = await scan(persisted)
        if (!("task" in failed.data)) throw new Error("expected inaccessible-scope scan")
        expect((await waitForTerminal(persisted, failed.data.task.task_id)).status).toBe("failed")
        const afterFailed = await withLibraryClient(persisted, Effect.gen(function*() {
          return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
        }))
        expect(afterFailed.data.entries[0]).toMatchObject({
          entry_id: initial.entry_id,
          availability: { status: "missing", observed_at_ms: missingObservation }
        })
      } finally {
        await rename(unavailableRoot, fixture)
      }

      await rename(hiddenBook, path.join(fixture, "book"))
      const reappeared = await scan(persisted)
      if (!("task" in reappeared.data)) throw new Error("expected reappearance scan")
      expect((await waitForTerminal(persisted, reappeared.data.task.task_id)).status).toBe("succeeded")
      const restored = await withLibraryClient(persisted, Effect.gen(function*() {
        return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
      }))
      expect(restored.data.entries).toHaveLength(1)
      expect(restored.data.entries[0]).toMatchObject({
        entry_id: initial.entry_id,
        relative_path: "book",
        availability: { status: "present", observed_at_ms: expect.any(Number) }
      })
      expect(restored.data.entries[0]?.availability.observed_at_ms).toBeGreaterThan(missingObservation)
    } finally {
      if (previousQuietInterval === undefined) delete process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS
      else process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS = previousQuietInterval
    }
  })

  it("keeps identical accepted evidence usable after a failed ordinary scan", async () => {
    const previousQuietInterval = process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS
    process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS = "1000"
    const server = await start()
    try {
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
    } finally {
      if (previousQuietInterval === undefined) delete process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS
      else process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS = previousQuietInterval
    }
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

  it("refreshes legacy accepted observations through an equivalent rescan", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-resolution-legacy-observation-"))
    fixturePaths.add(fixture)
    await makeImageBook(fixture, "book")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Legacy observation", path: fixture, preview_identity: preview.data.preview_identity
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

    const accepted = await withLibraryClient(server, Effect.gen(function*() {
      const entries = yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
      const entry = entries.data.entries.find((candidate) => candidate.relative_path === "book")
      if (entry === undefined) throw new Error("expected accepted entry")
      return entry
    }))

    await server.stop()
    const db = new DatabaseSync(server.dbPath)
    const acceptedRow = db.prepare(
      "SELECT manifest_json FROM library_entries WHERE entry_id = ?"
    ).get(accepted.entry_id) as { manifest_json: string } | undefined
    if (acceptedRow === undefined) throw new Error("expected persisted accepted entry")
    const legacyManifest = JSON.parse(acceptedRow.manifest_json) as {
      before: { observation_token?: string }
      after: { observation_token?: string }
    }
    delete legacyManifest.before.observation_token
    delete legacyManifest.after.observation_token
    db.prepare("UPDATE library_entries SET manifest_json = ? WHERE entry_id = ?").run(
      JSON.stringify(legacyManifest),
      accepted.entry_id
    )
    db.close()

    const restarted = await startServer(server.dbPath)
    servers.push(restarted)
    const beforeRescan = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: accepted.entry_id }, query: {} })
    }))
    expect(beforeRescan.data).toMatchObject({
      entry_id: accepted.entry_id,
      status: "usable",
      reason: null
    })
    expect(beforeRescan.data.accepted_observation.observation_token).toBeUndefined()

    const rescan = await withServerClient(restarted, Effect.gen(function*() {
      return yield* (yield* ServerHttpClient).command({
        params: { id: root.data.root_id },
        payload: {
          operation_id: randomUUID(), instance_id: restarted.instanceId, epoch: restarted.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: root.data.policy_revision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))
    if (!("task" in rescan.data)) throw new Error("expected legacy rescan task")
    expect((await waitForTerminal(restarted, rescan.data.task.task_id)).status).toBe("succeeded")

    const afterRescan = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: accepted.entry_id }, query: {} })
    }))
    expect(afterRescan.data).toMatchObject({
      entry_id: accepted.entry_id,
      status: "usable",
      reason: null,
      decision_version: beforeRescan.data.decision_version,
      location_revision: beforeRescan.data.location_revision,
      content_version: beforeRescan.data.content_version,
      first_page: expect.objectContaining({ name: "001.jpg" })
    })
    expect(afterRescan.data.accepted_observation.observation_token).toEqual(expect.any(String))
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

    await writeFile(path.join(fixture, "book-127", "001.jpg"), "changed")
    const replacementScan = await withServerClient(server, Effect.gen(function*() {
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
    if (!("task" in replacementScan.data)) throw new Error("expected replacement scan task")
    expect((await waitForTerminal(server, replacementScan.data.task.task_id)).status).toBe("completed_with_errors")

    const beforeRestart = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: target.entry_id }, query: {} })
    }))
    expect(beforeRestart.data.sibling_claims_truncated).toBe(true)
    expect(beforeRestart.data.sibling_claims.at(-1)?.relative_path).toBe("book-127")

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

    const staleCursor = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({
        params: { id: target.entry_id },
        query: {
          sibling_cursor: beforeRestart.data.sibling_claims_next_cursor ?? undefined,
          sibling_claims_revision: beforeRestart.data.sibling_claims_revision
        }
      }).pipe(Effect.flip)
    }))
    expect(staleCursor._tag).toBe("InvalidRequest")

    const first = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: target.entry_id }, query: {} })
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
    expect(first.data.sibling_claims.at(-1)?.relative_path).toBe("book-127")
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
    expect(second.data.sibling_claims.map((claim) => claim.relative_path)).toContain("book-128")
  })

  it("pages nested mixed-case and normalization-equivalent sibling claims through HTTP", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-resolution-nested-siblings-"))
    fixturePaths.add(fixture)
    await makeImageBook(fixture, "seed")

    const root = await withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(), instance_id: preview.data.instance_id, epoch: preview.data.epoch,
          label: "Nested sibling claims", path: fixture, preview_identity: preview.data.preview_identity
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

    const seed = await withLibraryClient(server, Effect.gen(function*() {
      const entries = yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
      const entry = entries.data.entries.find((candidate) => candidate.relative_path === "seed")
      if (entry === undefined) throw new Error("expected seed entry")
      return entry
    }))

    await server.stop()
    const db = new DatabaseSync(server.dbPath)
    const acceptedRow = db.prepare(
      "SELECT library_id, root_id, kind, manifest_json FROM library_entries WHERE entry_id = ?"
    ).get(seed.entry_id) as {
      library_id: string
      root_id: string
      kind: "image-directory"
      manifest_json: string
    } | undefined
    if (acceptedRow === undefined) throw new Error("expected persisted seed entry")
    const now = Date.now()
    const insertAccepted = (entryId: string, relativePath: string): void => {
      db.prepare(
        "INSERT INTO library_entries(entry_id, library_id, root_id, relative_path, source_path, kind, title, page_count, state, content_version, location_revision, decision_version, manifest_json, created_at_ms, updated_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 1, 1, 1, ?, ?, ?)"
      ).run(
        entryId,
        acceptedRow.library_id,
        acceptedRow.root_id,
        relativePath,
        path.join(fixture, relativePath),
        acceptedRow.kind,
        path.basename(relativePath),
        1,
        acceptedRow.manifest_json,
        now,
        now
      )
    }

    const mixedTargetId = randomUUID()
    insertAccepted(mixedTargetId, "books/Book.zip")
    for (let index = 0; index < 128; index += 1) {
      insertAccepted(randomUUID(), `Books/a-${String(index).padStart(3, "0")}`)
    }
    const mixedEquivalentId = randomUUID()
    insertAccepted(mixedEquivalentId, "Books/book.zip")
    const win32SpaceEquivalentId = randomUUID()
    const win32DotEquivalentId = randomUUID()
    insertAccepted(win32SpaceEquivalentId, "Books /book.zip")
    insertAccepted(win32DotEquivalentId, "Books./book.zip")

    const normalizedTargetId = randomUUID()
    const normalizedEquivalentId = randomUUID()
    const normalizedTarget = "Café/Book.zip"
    const normalizedEquivalent = "Cafe\u0301/book.zip"
    insertAccepted(normalizedTargetId, normalizedTarget)
    insertAccepted(normalizedEquivalentId, normalizedEquivalent)
    const greekTargetId = randomUUID()
    const greekEquivalentId = randomUUID()
    insertAccepted(greekTargetId, "ΟΣ/Book.zip")
    insertAccepted(greekEquivalentId, "ος/book.zip")
    const sharpSTargetId = randomUUID()
    const sharpSEquivalentId = randomUUID()
    insertAccepted(sharpSTargetId, "Straße/Book.zip")
    insertAccepted(sharpSEquivalentId, "STRASSE/book.zip")
    const longSTargetId = randomUUID()
    const longSEquivalentId = randomUUID()
    insertAccepted(longSTargetId, "ſigma/Book.zip")
    insertAccepted(longSEquivalentId, "SIGMA/book.zip")
    db.prepare("UPDATE server_library SET change_revision = change_revision + 1 WHERE id = 1").run()
    db.close()

    const restarted = await startServer(server.dbPath)
    servers.push(restarted)
    const first = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: mixedTargetId }, query: {} })
    }))
    expect(first.data.sibling_claims).toHaveLength(128)
    expect(first.data.sibling_claims_truncated).toBe(true)
    expect(first.data.sibling_claims.map((claim) => claim.relative_path)).not.toContain("Books/book.zip")
    expect(first.data.sibling_claims_next_cursor).not.toBeNull()

    const second = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({
        params: { id: mixedTargetId },
        query: {
          sibling_cursor: first.data.sibling_claims_next_cursor ?? undefined,
          sibling_claims_revision: first.data.sibling_claims_revision
        }
      })
    }))
    expect(second.data.sibling_claims_truncated).toBe(false)
    expect(second.data.sibling_claims_next_cursor).toBeNull()
    const siblingPaths = [...first.data.sibling_claims, ...second.data.sibling_claims]
      .map((claim) => claim.relative_path)
    expect(siblingPaths).toContain("Books/book.zip")
    expect(siblingPaths).toContain("Books /book.zip")
    expect(siblingPaths).toContain("Books./book.zip")

    const crossTargetCursor = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({
        params: { id: mixedEquivalentId },
        query: {
          sibling_cursor: first.data.sibling_claims_next_cursor ?? undefined,
          sibling_claims_revision: first.data.sibling_claims_revision
        }
      }).pipe(Effect.flip)
    }))
    expect(crossTargetCursor._tag).toBe("InvalidRequest")

    const normalized = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: normalizedTargetId }, query: {} })
    }))
    expect(normalized.data.sibling_claims.map((claim) => claim.relative_path)).toContain(normalizedEquivalent)

    const greek = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: greekTargetId }, query: {} })
    }))
    expect(greek.data.sibling_claims.map((claim) => claim.relative_path)).toContain("ος/book.zip")

    const sharpS = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: sharpSTargetId }, query: {} })
    }))
    expect(sharpS.data.sibling_claims.map((claim) => claim.relative_path)).toContain("STRASSE/book.zip")

    const longS = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({ params: { id: longSTargetId }, query: {} })
    }))
    expect(longS.data.sibling_claims.map((claim) => claim.relative_path)).toContain("SIGMA/book.zip")

    const unknownCursor = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({
        params: { id: mixedTargetId },
        query: { sibling_cursor: randomUUID(), sibling_claims_revision: first.data.sibling_claims_revision }
      }).pipe(Effect.flip)
    }))
    expect(unknownCursor._tag).toBe("InvalidRequest")

    const wrongParentCursor = await withLibraryClient(restarted, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).resolution({
        params: { id: mixedTargetId },
        query: { sibling_cursor: normalizedEquivalentId, sibling_claims_revision: first.data.sibling_claims_revision }
      }).pipe(Effect.flip)
    }))
    expect(wrongParentCursor._tag).toBe("InvalidRequest")
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

  it("truncates persisted indexed samples at the public limit and leaves small roots complete", async () => {
    const server = await start()
    const largeFixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-sample-limit-large-"))
    const smallFixture = await mkdtemp(path.join(os.tmpdir(), "henshin-library-sample-limit-small-"))
    fixturePaths.add(largeFixture)
    fixturePaths.add(smallFixture)
    for (let index = 0; index < 33; index += 1) {
      await makeImageBook(largeFixture, `book-${index.toString().padStart(2, "0")}`)
    }
    await makeImageBook(smallFixture, "small-book")

    const register = (fixture: string, label: string) => withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      const preview = yield* client.preview({ payload: { path: fixture } })
      if (!("children" in preview.data)) throw new Error("expected setup preview")
      return yield* client.save({
        payload: {
          operation_id: randomUUID(),
          instance_id: preview.data.instance_id,
          epoch: preview.data.epoch,
          label,
          path: fixture,
          preview_identity: preview.data.preview_identity
        }
      })
    }))
    const scan = (rootId: string, mappingRevision: string, policyRevision: string) => withServerClient(server, Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.command({
        params: { id: rootId },
        payload: {
          operation_id: randomUUID(),
          instance_id: server.instanceId,
          epoch: server.epoch,
          expected_mapping_revision: mappingRevision,
          expected_policy_revision: policyRevision,
          command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
        }
      })
    }))

    const largeRoot = await register(largeFixture, "Large sample root")
    const largeScan = await scan(
      largeRoot.data.root_id,
      largeRoot.data.mapping_revision,
      largeRoot.data.policy_revision
    )
    if (!("task" in largeScan.data)) throw new Error("expected large scan task")
    expect((await waitForTerminal(server, largeScan.data.task.task_id)).status).toBe("succeeded")

    const largeSamples = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).indexedSamples({ params: { id: largeRoot.data.root_id } })
    }))
    expect(largeSamples.data).toMatchObject({
      sample_limit: 32,
      sample_truncated: true
    })
    expect(largeSamples.data.samples).toHaveLength(32)
    expect(largeSamples.data.samples[0]?.relative_path).toBe("book-00")
    expect(largeSamples.data.samples[31]?.relative_path).toBe("book-31")

    const smallRoot = await register(smallFixture, "Small sample root")
    const smallScan = await scan(
      smallRoot.data.root_id,
      smallRoot.data.mapping_revision,
      smallRoot.data.policy_revision
    )
    if (!("task" in smallScan.data)) throw new Error("expected small scan task")
    expect((await waitForTerminal(server, smallScan.data.task.task_id)).status).toBe("succeeded")

    const smallSamples = await withLibraryClient(server, Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).indexedSamples({ params: { id: smallRoot.data.root_id } })
    }))
    expect(smallSamples.data).toMatchObject({
      sample_limit: 32,
      sample_truncated: false
    })
    expect(smallSamples.data.samples).toHaveLength(1)
  })
})

describe("literal library search", () => {
  it("normalizes stored book names, preserves literals and pages beyond the first result", async () => {
    const server = await start()
    await server.stop()

    const db = new DatabaseSync(server.dbPath)
    const library = db.prepare("SELECT library_id FROM server_library WHERE id = 1").get() as { library_id: string }
    const rootId = randomUUID()
    db.prepare(
      "INSERT INTO server_roots(library_id, root_id, label, selected_path, canonical_path, device, inode, mapping_revision, policy_revision, exclusions, state) VALUES(?, ?, ?, ?, ?, ?, ?, 1, 0, '[]', 'active')"
    ).run(library.library_id, rootId, "Search fixture", "/search", "/search", "device", "inode")

    const fixtureEntries = [
      { relativePath: "Book 0", title: "Book 0" },
      { relativePath: "Book 1", title: "Book 1" },
      { relativePath: "Book 2", title: "Book 2" },
      { relativePath: "Book 3", title: "Book 3" },
      { relativePath: "Archive.cbz", title: "Archive" },
      { relativePath: "ＡＢＣ", title: "ＡＢＣ" },
      { relativePath: "怪談", title: "怪談" },
      { relativePath: "literal%_book", title: "literal%_book" },
      { relativePath: "sharp-book", title: "Straße" },
      { relativePath: "alpha", title: "Beta" }
    ]
    const insert = db.prepare(
      "INSERT INTO library_entries(entry_id, library_id, root_id, relative_path, source_path, kind, title, title_search, basename_search, page_count, state, content_version, location_revision, decision_version, manifest_json, created_at_ms, updated_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'accepted', 1, 1, 1, '{}', 0, 0)"
    )
    for (const entry of fixtureEntries) {
      const normalizedTitle = entry.title.normalize("NFKC").toLowerCase().normalize("NFC")
      const normalizedBasename = entry.relativePath.normalize("NFKC").toLowerCase().normalize("NFC")
      insert.run(
        randomUUID(), library.library_id, rootId, entry.relativePath, `/search/${entry.relativePath}`,
        entry.relativePath.endsWith(".cbz") ? "archive" : "image-directory", entry.title,
        normalizedTitle, normalizedBasename
      )
    }
    db.prepare("UPDATE server_library SET change_revision = change_revision + 1 WHERE id = 1").run()
    db.close()

    const restarted = await startServer(server.dbPath)
    servers.push(restarted)
    const client = <A, E>(program: Effect.Effect<A, E, LibraryHttpClient>) => withLibraryClient(restarted, program)

    const empty = await client(Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { page_size: 200 } })
    }))
    expect(empty.data.entries).toHaveLength(fixtureEntries.length)

    const searchAllPages = async (query: string) => {
      const pages = []
      let cursor: string | undefined
      for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
        const page = await client(Effect.gen(function*() {
          return yield* (yield* LibraryHttpClient).search({
            payload: { query, page_size: 1, ...(cursor === undefined ? {} : { cursor }) }
          })
        }))
        pages.push(page.data)
        if (!page.data.has_more) return pages
        expect(page.data.next_cursor).not.toBeNull()
        cursor = page.data.next_cursor ?? undefined
      }
      throw new Error("search did not finish within the page bound")
    }

    const bookPages = await searchAllPages("  ＢＯＯＫ  ")
    const bookEntries = bookPages.flatMap((page) => page.entries)
    expect(bookPages.length).toBe(6)
    expect(new Set(bookEntries.map((entry) => entry.title))).toEqual(new Set([
      "Book 0", "Book 1", "Book 2", "Book 3", "literal%_book", "Straße"
    ]))
    expect(Object.fromEntries(bookEntries.map((entry) => [entry.title, entry.match_fields]))).toEqual({
      "Book 0": ["title", "basename"],
      "Book 1": ["title", "basename"],
      "Book 2": ["title", "basename"],
      "Book 3": ["title", "basename"],
      "literal%_book": ["title", "basename"],
      "Straße": ["basename"]
    })
    expect(bookPages.at(-1)?.has_more).toBe(false)

    const first = bookPages[0]
    if (first === undefined || first.next_cursor === null) throw new Error("expected a paged search cursor")
    const firstCursor = first.next_cursor

    const fenced = await client(Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({
        payload: { query: "archive", page_size: 1, cursor: firstCursor }
      }).pipe(Effect.flip)
    }))
    expect(fenced._tag).toBe("InvalidRequest")

    const punctuation = await client(Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { query: "%_" } })
    }))
    expect(punctuation.data.entries.map((entry) => entry.title)).toEqual(["literal%_book"])

    const archiveExtension = await client(Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { query: "cbz" } })
    }))
    expect(archiveExtension.data.entries[0]).toMatchObject({ title: "Archive", match_fields: ["basename"] })

    const cjk = await client(Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { query: "怪" } })
    }))
    expect(cjk.data.entries.map((entry) => entry.title)).toEqual(["怪談"])

    const width = await client(Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { query: "abc" } })
    }))
    expect(width.data.entries.map((entry) => entry.title)).toEqual(["ＡＢＣ"])

    const sharpS = await client(Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { query: "strasse" } })
    }))
    expect(sharpS.data.entries).toHaveLength(0)

    const boundary = await client(Effect.gen(function*() {
      return yield* (yield* LibraryHttpClient).search({ payload: { query: "alpha beta" } })
    }))
    expect(boundary.data.entries).toHaveLength(0)
  })
})
