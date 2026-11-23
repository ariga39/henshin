import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  LibraryHttpClient,
  ReviewHttpClient,
  ServerHttpClient,
  TaskHttpClient,
  type RootPreview,
  type ScanTask,
  DEFAULT_ROOT_SCHEDULE_INTERVAL_MS
} from "@henshin/contracts"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const servers: RunningServer[] = []
const dbPaths = new Set<string>()
const fixturePaths = new Set<string>()

const withServerClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, ServerHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, ServerHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withTaskClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, TaskHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, TaskHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withLibraryClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, LibraryHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, LibraryHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const withReviewClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, ReviewHttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, ReviewHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitForTerminal = async (server: RunningServer, taskId: string): Promise<ScanTask> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await withTaskClient(server, Effect.gen(function*() {
      const client = yield* TaskHttpClient
      return yield* client.get({ params: { id: taskId } })
    }))
    if (task.data.status !== "queued" && task.data.status !== "running") return task.data
    await sleep(20)
  }
  throw new Error("scheduled scan did not reach a terminal state")
}

const waitForScheduledRootScan = async (server: RunningServer, rootId: string): Promise<ScanTask> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tasks = await withTaskClient(server, Effect.gen(function*() {
      const client = yield* TaskHttpClient
      return yield* client.list()
    }))
    const task = tasks.data.find((candidate) => candidate.root_id === rootId && candidate.mode === "scheduled")
    if (task !== undefined && task.status !== "queued" && task.status !== "running") return task
    await sleep(20)
  }
  throw new Error(`scheduled scan for ${rootId} did not reach a terminal state`)
}

const waitForRootTask = async (
  server: RunningServer,
  rootId: string,
  mode: ScanTask["mode"],
  predicate: (task: ScanTask) => boolean
): Promise<ScanTask> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const tasks = await withTaskClient(server, Effect.gen(function*() {
      const client = yield* TaskHttpClient
      return yield* client.list()
    }))
    const task = tasks.data.find((candidate) => candidate.root_id === rootId && candidate.mode === mode && predicate(candidate))
    if (task !== undefined) return task
    await sleep(20)
  }
  throw new Error(`${mode} scan for ${rootId} did not reach the expected state`)
}

const addFixtureBooks = async (rootPath: string, count: number, prefix: string): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    const book = path.join(rootPath, `${prefix}-${String(index).padStart(3, "0")}`)
    await mkdir(book)
    await writeFile(path.join(book, "001.jpg"), `${prefix}-${index}`)
  }
}

const saveRoot = async (server: RunningServer, rootPath: string, label: string) => {
  const preview = await withServerClient(server, Effect.gen(function*() {
    const client = yield* ServerHttpClient
    const result = yield* client.preview({ payload: { path: rootPath } })
    if (!("children" in result.data)) throw new Error("expected setup preview")
    return result.data as RootPreview
  }))
  return withServerClient(server, Effect.gen(function*() {
    const client = yield* ServerHttpClient
    return yield* client.save({
      payload: {
        operation_id: randomUUID(),
        instance_id: preview.instance_id,
        epoch: preview.epoch,
        label,
        path: rootPath,
        preview_identity: preview.preview_identity
      }
    })
  }))
}

const listEntries = (server: RunningServer) => withLibraryClient(server, Effect.gen(function*() {
  const client = yield* LibraryHttpClient
  return yield* client.search({ payload: { page_size: 200 } })
}))

const downgradeToPreviousRootAndTaskSchema = (dbPath: string): void => {
  const database = new DatabaseSync(dbPath)
  database.exec("PRAGMA foreign_keys = OFF")
  database.exec("BEGIN IMMEDIATE")
  try {
    database.exec(`
      ALTER TABLE server_roots DROP COLUMN schedule_interval_ms;
      CREATE TABLE scan_tasks_previous (
        task_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        epoch TEXT NOT NULL,
        root_id TEXT NOT NULL REFERENCES server_roots(root_id),
        mapping_revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'completed_with_errors', 'failed', 'interrupted')),
        hold_new_discoveries INTEGER NOT NULL CHECK (hold_new_discoveries IN (0, 1)),
        directories_visited INTEGER NOT NULL,
        candidates_discovered INTEGER NOT NULL,
        candidates_analyzed INTEGER NOT NULL,
        analysis_error_count INTEGER NOT NULL,
        review_needed_count INTEGER NOT NULL,
        coverage_json TEXT,
        readiness_error_code TEXT,
        readiness_error_message TEXT,
        error_code TEXT,
        error_message TEXT,
        command_payload TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (epoch, operation_id)
      );
      INSERT INTO scan_tasks_previous(
        task_id, operation_id, epoch, root_id, mapping_revision, status,
        hold_new_discoveries, directories_visited, candidates_discovered,
        candidates_analyzed, analysis_error_count, review_needed_count,
        coverage_json, readiness_error_code, readiness_error_message,
        error_code, error_message, command_payload, created_at_ms, updated_at_ms
      )
      SELECT task_id, operation_id, epoch, root_id, mapping_revision, status,
        hold_new_discoveries, directories_visited, candidates_discovered,
        candidates_analyzed, analysis_error_count, review_needed_count,
        coverage_json, readiness_error_code, readiness_error_message,
        error_code, error_message, command_payload, created_at_ms, updated_at_ms
      FROM scan_tasks;
      DROP TABLE scan_tasks;
      ALTER TABLE scan_tasks_previous RENAME TO scan_tasks;
      UPDATE server_state SET schema_version = 9 WHERE id = 1;
    `)
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  } finally {
    database.exec("PRAGMA foreign_keys = ON")
    database.close()
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("scheduled root discovery", () => {
  it("persists one enabled root across restart, disables future work, and keeps manual scans available", async () => {
    const previousPoll = process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
    process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = "20"
    try {
      const dbPath = await makeTempDbPath()
      dbPaths.add(dbPath)
      const server = await startServer(dbPath)
      servers.push(server)
      const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-scheduled-roots-"))
      fixturePaths.add(fixture)
      const rootAPath = path.join(fixture, "books-a")
      const rootBPath = path.join(fixture, "books-b")
      await mkdir(rootAPath)
      await mkdir(rootBPath)

      const rootA = await saveRoot(server, rootAPath, "Books A")
      const rootB = await saveRoot(server, rootBPath, "Books B")
      expect(rootA.data.schedule_enabled).toBe(false)
      expect(rootB.data.schedule_enabled).toBe(false)

      const enabled = await withServerClient(server, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: rootA.data.root_id },
          payload: {
            operation_id: randomUUID(),
            instance_id: server.instanceId,
            epoch: server.epoch,
            expected_policy_revision: rootA.data.policy_revision,
            command: { type: "set-schedule", enabled: true, interval_ms: 100 }
          }
        })
      }))
      if ("task" in enabled.data) throw new Error("expected a root settings response")
      expect(enabled.data.schedule_enabled).toBe(true)
      expect(enabled.data.schedule_interval_ms).toBe(100)
      expect(enabled.data.policy_revision).toBe("0")

      await server.stop()
      const restarted = await startServer(dbPath)
      servers.push(restarted)
      const listed = await withServerClient(restarted, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.list()
      }))
      expect(listed.data.find((root) => root.root_id === rootA.data.root_id)?.schedule_enabled).toBe(true)
      expect(listed.data.find((root) => root.root_id === rootA.data.root_id)?.schedule_interval_ms).toBe(100)
      expect(listed.data.find((root) => root.root_id === rootB.data.root_id)?.schedule_enabled).toBe(false)

      const aBook = path.join(rootAPath, "scheduled-book")
      const bBook = path.join(rootBPath, "unscheduled-book")
      await mkdir(aBook)
      await mkdir(bBook)
      const aPage = Buffer.from("scheduled page")
      const bPage = Buffer.from("unscheduled page")
      await writeFile(path.join(aBook, "001.jpg"), aPage)
      await writeFile(path.join(bBook, "001.jpg"), bPage)

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const entries = await listEntries(restarted)
        if (entries.data.entries.some((entry) => entry.relative_path === "scheduled-book")) break
        await sleep(20)
      }
      const afterScheduled = await listEntries(restarted)
      expect(afterScheduled.data.entries.map((entry) => entry.relative_path)).toEqual(["scheduled-book"])
      const tasks = await withTaskClient(restarted, Effect.gen(function*() {
        const client = yield* TaskHttpClient
        return yield* client.list()
      }))
      expect(tasks.data.some((task) => task.root_id === rootA.data.root_id && task.mode === "scheduled")).toBe(true)
      expect(await readFile(path.join(aBook, "001.jpg"))).toEqual(aPage)
      expect(await readFile(path.join(bBook, "001.jpg"))).toEqual(bPage)

      const currentRootA = listed.data.find((root) => root.root_id === rootA.data.root_id)
      if (currentRootA === undefined) throw new Error("enabled root was not retained")
      const disabled = await withServerClient(restarted, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: currentRootA.root_id },
          payload: {
            operation_id: randomUUID(),
            instance_id: restarted.instanceId,
            epoch: restarted.epoch,
            expected_policy_revision: currentRootA.policy_revision,
            command: { type: "set-schedule", enabled: false }
          }
        })
      }))
      if ("task" in disabled.data) throw new Error("expected a root settings response")
      const disabledRoot = disabled.data
      expect(disabledRoot.schedule_enabled).toBe(false)

      const laterBook = path.join(rootAPath, "manual-book")
      await mkdir(laterBook)
      const laterPage = Buffer.from("manual page")
      await writeFile(path.join(laterBook, "001.jpg"), laterPage)
      await sleep(220)
      expect((await listEntries(restarted)).data.entries.map((entry) => entry.relative_path)).toEqual(["scheduled-book"])

      const manual = await withServerClient(restarted, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: disabledRoot.root_id },
          payload: {
            operation_id: randomUUID(),
            instance_id: restarted.instanceId,
            epoch: restarted.epoch,
            expected_mapping_revision: disabledRoot.mapping_revision,
            expected_policy_revision: disabledRoot.policy_revision,
            command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
          }
        })
      }))
      if (!("task" in manual.data)) throw new Error("expected a manual scan task")
      expect((await waitForTerminal(restarted, manual.data.task.task_id)).status).toBe("succeeded")
      expect((await listEntries(restarted)).data.entries.map((entry) => entry.relative_path).sort()).toEqual([
        "manual-book",
        "scheduled-book"
      ])
      expect(await readFile(path.join(laterBook, "001.jpg"))).toEqual(laterPage)
      expect(await readFile(path.join(bBook, "001.jpg"))).toEqual(bPage)
    } finally {
      if (previousPoll === undefined) delete process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
      else process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = previousPoll
    }
  })

  it("uses independent persisted cadences for two enabled roots", async () => {
    const previousPoll = process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
    process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = "20"
    try {
      const dbPath = await makeTempDbPath()
      dbPaths.add(dbPath)
      const server = await startServer(dbPath)
      servers.push(server)
      const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-scheduled-cadences-"))
      fixturePaths.add(fixture)
      const rootAPath = path.join(fixture, "books-a")
      const rootBPath = path.join(fixture, "books-b")
      await mkdir(rootAPath)
      await mkdir(rootBPath)

      const rootA = await saveRoot(server, rootAPath, "Books A")
      const rootB = await saveRoot(server, rootBPath, "Books B")
      const enable = async (root: typeof rootA.data, interval_ms: number) => withServerClient(server, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: root.root_id },
          payload: {
            operation_id: randomUUID(),
            instance_id: server.instanceId,
            epoch: server.epoch,
            expected_policy_revision: root.policy_revision,
            command: { type: "set-schedule", enabled: true, interval_ms }
          }
        })
      }))
      const enabledA = await enable(rootA.data, 120)
      const enabledB = await enable(rootB.data, 420)
      if ("task" in enabledA.data || "task" in enabledB.data) throw new Error("expected root settings responses")
      expect(enabledA.data.schedule_interval_ms).toBe(120)
      expect(enabledB.data.schedule_interval_ms).toBe(420)

      await waitForScheduledRootScan(server, rootA.data.root_id)
      await waitForScheduledRootScan(server, rootB.data.root_id)

      const aBook = path.join(rootAPath, "cadence-a")
      const bBook = path.join(rootBPath, "cadence-b")
      await mkdir(aBook)
      await mkdir(bBook)
      await writeFile(path.join(aBook, "001.jpg"), "cadence a")
      await writeFile(path.join(bBook, "001.jpg"), "cadence b")

      await sleep(220)
      const first = await listEntries(server)
      expect(first.data.entries.map((entry) => entry.relative_path)).toContain("cadence-a")
      expect(first.data.entries.map((entry) => entry.relative_path)).not.toContain("cadence-b")

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await listEntries(server)).data.entries.some((entry) => entry.relative_path === "cadence-b")) break
        await sleep(20)
      }
      expect((await listEntries(server)).data.entries.map((entry) => entry.relative_path).sort()).toEqual(["cadence-a", "cadence-b"])
    } finally {
      if (previousPoll === undefined) delete process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
      else process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = previousPoll
    }
  })

  it("upgrades real prior root and task data, defaults old settings, and preserves restored holds", async () => {
    const previousPoll = process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
    process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = "20"
    try {
      const dbPath = await makeTempDbPath()
      dbPaths.add(dbPath)
      const server = await startServer(dbPath)
      servers.push(server)
      const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-scheduled-upgrade-"))
      fixturePaths.add(fixture)
      const book = path.join(fixture, "held-book")
      await mkdir(book)
      await writeFile(path.join(book, "001.jpg"), "held page")
      const root = await saveRoot(server, fixture, "Upgrade books")
      expect(root.data.schedule_interval_ms).toBe(DEFAULT_ROOT_SCHEDULE_INTERVAL_MS)

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
      if (!("task" in held.data)) throw new Error("expected the prior scan task")
      const priorTask = held.data.task
      expect((await waitForTerminal(server, priorTask.task_id)).status).toBe("succeeded")
      const priorCandidates = await withReviewClient(server, Effect.gen(function*() {
        const client = yield* ReviewHttpClient
        return yield* client.candidates()
      }))
      expect(priorCandidates.data).toEqual([expect.objectContaining({ relative_path: "held-book", hold_state: "held" })])

      await server.stop()
      downgradeToPreviousRootAndTaskSchema(dbPath)
      const restarted = await startServer(dbPath)
      servers.push(restarted)

      const listed = await withServerClient(restarted, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.list()
      }))
      const restoredRoot = listed.data.find((candidate) => candidate.root_id === root.data.root_id)
      if (restoredRoot === undefined) throw new Error("expected migrated root")
      expect(restoredRoot.schedule_enabled).toBe(false)
      expect(restoredRoot.schedule_interval_ms).toBe(DEFAULT_ROOT_SCHEDULE_INTERVAL_MS)

      const tasks = await withTaskClient(restarted, Effect.gen(function*() {
        const client = yield* TaskHttpClient
        return yield* client.list()
      }))
      expect(tasks.data.find((task) => task.task_id === priorTask.task_id)).toMatchObject({ mode: "manual" })

      const oldClientEnable = await withServerClient(restarted, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: restoredRoot.root_id },
          payload: {
            operation_id: randomUUID(),
            instance_id: restarted.instanceId,
            epoch: restarted.epoch,
            expected_policy_revision: restoredRoot.policy_revision,
            command: { type: "set-schedule", enabled: true }
          }
        })
      }))
      if ("task" in oldClientEnable.data) throw new Error("expected migrated root settings")
      const enabledRoot = oldClientEnable.data
      expect(enabledRoot.schedule_interval_ms).toBe(DEFAULT_ROOT_SCHEDULE_INTERVAL_MS)

      const scheduled = await waitForScheduledRootScan(restarted, restoredRoot.root_id)
      expect(scheduled.mode).toBe("scheduled")

      const heldCandidates = await withReviewClient(restarted, Effect.gen(function*() {
        const client = yield* ReviewHttpClient
        return yield* client.candidates()
      }))
      expect(heldCandidates.data).toEqual([expect.objectContaining({ relative_path: "held-book", hold_state: "held" })])

      const manualInvalid = await fetch(`${restarted.baseUrl}/api/v1/roots/${restoredRoot.root_id}/commands`, {
        method: "POST",
        headers: { authorization: `Bearer ${restarted.bearerToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          operation_id: randomUUID(), instance_id: restarted.instanceId, epoch: restarted.epoch,
          expected_mapping_revision: restoredRoot.mapping_revision,
          expected_policy_revision: oldClientEnable.data.policy_revision,
          command: { type: "start-scan", mode: "scheduled", hold_new_discoveries: false }
        })
      })
      expect(manualInvalid.status).toBe(400)

      const disabled = await withServerClient(restarted, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: restoredRoot.root_id },
          payload: {
            operation_id: randomUUID(), instance_id: restarted.instanceId, epoch: restarted.epoch,
            expected_policy_revision: enabledRoot.policy_revision,
            command: { type: "set-schedule", enabled: false }
          }
        })
      }))
      if ("task" in disabled.data) throw new Error("expected disabled root settings")
      const disabledRoot = disabled.data
      const manual = await withServerClient(restarted, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: restoredRoot.root_id },
          payload: {
            operation_id: randomUUID(), instance_id: restarted.instanceId, epoch: restarted.epoch,
            expected_mapping_revision: restoredRoot.mapping_revision,
            expected_policy_revision: disabledRoot.policy_revision,
            command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
          }
        })
      }))
      if (!("task" in manual.data)) throw new Error("expected manual scan task")
      expect((await waitForTerminal(restarted, manual.data.task.task_id)).status).toBe("succeeded")
      const afterManual = await withReviewClient(restarted, Effect.gen(function*() {
        const client = yield* ReviewHttpClient
        return yield* client.candidates()
      }))
      expect(afterManual.data).toEqual([expect.objectContaining({ relative_path: "held-book", hold_state: "held" })])
    } finally {
      if (previousPoll === undefined) delete process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
      else process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = previousPoll
    }
  })

  it("replays a manual retry after it joins an active scheduled scan", async () => {
    const previousPoll = process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
    process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = "20"
    try {
      const dbPath = await makeTempDbPath()
      dbPaths.add(dbPath)
      const server = await startServer(dbPath)
      servers.push(server)
      const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-scheduled-retry-"))
      fixturePaths.add(fixture)
      await addFixtureBooks(fixture, 256, "scheduled")
      const root = await saveRoot(server, fixture, "Scheduled retry")

      const enabled = await withServerClient(server, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: root.data.root_id },
          payload: {
            operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
            expected_policy_revision: root.data.policy_revision,
            command: { type: "set-schedule", enabled: true, interval_ms: 2000 }
          }
        })
      }))
      if ("task" in enabled.data) throw new Error("expected schedule settings")
      const scheduled = await waitForRootTask(server, root.data.root_id, "scheduled", (task) => task.status === "running")
      const operation_id = randomUUID()
      const payload = {
        params: { id: root.data.root_id },
        payload: {
          operation_id,
          instance_id: server.instanceId,
          epoch: server.epoch,
          expected_mapping_revision: root.data.mapping_revision,
          expected_policy_revision: enabled.data.policy_revision,
          command: { type: "start-scan" as const, mode: "manual" as const, hold_new_discoveries: false }
        }
      }

      const retried = await withServerClient(server, Effect.result(Effect.gen(function*() {
        const client = yield* ServerHttpClient
        const first = yield* client.command(payload)
        const second = yield* client.command(payload)
        return [first, second] as const
      })))
      expect(retried._tag).toBe("Success")
      if (retried._tag === "Success") {
        expect(retried.success[0].data).toMatchObject({ task: { task_id: scheduled.task_id, mode: "scheduled" } })
        expect(retried.success[1].data).toMatchObject({ task: { task_id: scheduled.task_id, mode: "scheduled" } })
      }
    } finally {
      if (previousPoll === undefined) delete process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
      else process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = previousPoll
    }
  })

  it("does not fence a running scan when only cadence changes", async () => {
    const previousPoll = process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
    process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = "20"
    try {
      const dbPath = await makeTempDbPath()
      dbPaths.add(dbPath)
      const server = await startServer(dbPath)
      servers.push(server)
      const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-cadence-edit-"))
      fixturePaths.add(fixture)
      await addFixtureBooks(fixture, 256, "running")
      const root = await saveRoot(server, fixture, "Cadence edit")

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
      if (!("task" in submitted.data)) throw new Error("expected manual scan task")
      const manualTask = submitted.data.task
      await waitForRootTask(server, root.data.root_id, "manual", (task) => task.task_id === manualTask.task_id && task.status === "running")

      const edited = await withServerClient(server, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: root.data.root_id },
          payload: {
            operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
            expected_policy_revision: root.data.policy_revision,
            command: { type: "set-schedule", enabled: false, interval_ms: 420 }
          }
        })
      }))
      if ("task" in edited.data) throw new Error("expected cadence settings")
      expect(edited.data.policy_revision).toBe(root.data.policy_revision)
      expect(edited.data.schedule_interval_ms).toBe(420)
      expect((await waitForTerminal(server, manualTask.task_id)).status).toBe("succeeded")
    } finally {
      if (previousPoll === undefined) delete process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
      else process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = previousPoll
    }
  })

  it("retries a scheduled start after an active manual conflict", async () => {
    const previousPoll = process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
    process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = "20"
    try {
      const dbPath = await makeTempDbPath()
      dbPaths.add(dbPath)
      const server = await startServer(dbPath)
      servers.push(server)
      const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-scheduled-conflict-"))
      fixturePaths.add(fixture)
      const initialBookCount = 512
      await addFixtureBooks(fixture, initialBookCount, "held")
      const root = await saveRoot(server, fixture, "Scheduled conflict")

      const submitted = await withServerClient(server, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: root.data.root_id },
          payload: {
            operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
            expected_mapping_revision: root.data.mapping_revision,
            expected_policy_revision: root.data.policy_revision,
            command: { type: "start-scan", mode: "manual", hold_new_discoveries: true }
          }
        })
      }))
      if (!("task" in submitted.data)) throw new Error("expected held manual scan task")
      const heldTask = submitted.data.task
      await waitForRootTask(server, root.data.root_id, "manual", (task) => task.task_id === heldTask.task_id && task.status === "running")

      const enabled = await withServerClient(server, Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.command({
          params: { id: root.data.root_id },
          payload: {
            operation_id: randomUUID(), instance_id: server.instanceId, epoch: server.epoch,
            expected_policy_revision: root.data.policy_revision,
            command: { type: "set-schedule", enabled: true, interval_ms: 2000 }
          }
        })
      }))
      if ("task" in enabled.data) throw new Error("expected schedule settings")
      await sleep(100)
      const duringManual = await withTaskClient(server, Effect.gen(function*() {
        const client = yield* TaskHttpClient
        return yield* client.list()
      }))
      expect(duringManual.data.some((task) => task.root_id === root.data.root_id && task.mode === "scheduled")).toBe(false)

      await waitForRootTask(server, root.data.root_id, "manual", (task) =>
        task.task_id === heldTask.task_id && task.status === "running" && task.candidates_discovered >= initialBookCount
      )
      const afterConflictBook = path.join(fixture, "after-conflict")
      await mkdir(afterConflictBook)
      await writeFile(path.join(afterConflictBook, "001.jpg"), "after conflict")
      expect((await waitForTerminal(server, heldTask.task_id)).status).toBe("succeeded")

      const retryStartedAt = Date.now()
      const scheduled = await waitForRootTask(server, root.data.root_id, "scheduled", (task) => task.status === "succeeded")
      expect(Date.now() - retryStartedAt).toBeLessThan(1200)
      expect(scheduled.mode).toBe("scheduled")
      expect((await listEntries(server)).data.entries.map((entry) => entry.relative_path)).toContain("after-conflict")
    } finally {
      if (previousPoll === undefined) delete process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS
      else process.env.HENSHIN_SCHEDULE_POLL_INTERVAL_MS = previousPoll
    }
  })
})
