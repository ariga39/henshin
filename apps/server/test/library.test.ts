import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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

    const held = await withServerClient(server, Effect.gen(function*() {
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

    const staged = await withReviewClient(server, Effect.gen(function*() {
      const client = yield* ReviewHttpClient
      return yield* client.candidates()
    }))
    expect(staged.data).toHaveLength(1)
    expect(staged.data[0]).toMatchObject({ relative_path: "book", analysis_status: "ready" })
    expect(staged.data[0]?.manifest?.pages).toHaveLength(2)
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
