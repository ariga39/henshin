import { link, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { EntryResolution, OpenBookIpcResult } from "@henshin/contracts"
import type { OpenEvent } from "@henshin/contracts/event"
import type { OpenJournalRow } from "../src/main/persistence/draft-worker-protocol"
import type { LocalMapping } from "../src/main/persistence/LocalMappingStore"
import type { StoredReaderProfile } from "../src/main/persistence/ReaderProfileStore"
import { ConnectionPausedError } from "../src/main/ConnectionLifecycle"
import { OpenCoordinator, type OpenCoordinatorPorts, type OpenJournalPort } from "../src/main/OpenCoordinator"
import { OpenJournalStoreFullError } from "../src/main/persistence/OpenJournalStore"

const profile = (profileId: string): StoredReaderProfile => ({
  profile_id: profileId,
  revision: "1",
  name: "Fixture reader",
  launch_mode: "explicit-executable",
  supported_formats: ["archive"],
  target_mode: "archive",
  executable_name: "fixture-reader",
  argument_tokens: ["{target}"],
  executablePath: process.execPath
})

type TestJournal = OpenJournalPort & {
  readonly rows: Map<string, OpenJournalRow>
  readonly events: Array<OpenEvent>
  readonly acceptedWriteCount: () => number
  failRecordAccepted: (count: number, error: Error) => void
  setRecordAcceptedFailure: (error: Error | undefined) => void
  failRecordFailed: (count: number, error: Error) => void
  setPrepareFailure: (error: Error | undefined) => void
}

const makeJournal = (): TestJournal => {
  const rows = new Map<string, OpenJournalRow>()
  const events: Array<OpenEvent> = []
  let acceptedWriteCount = 0
  let remainingRecordAcceptedFailures = 0
  let repeatedRecordAcceptedFailure: Error | undefined
  let recordAcceptedFailure: Error | undefined
  let remainingRecordFailedFailures = 0
  let recordFailedFailure: Error | undefined
  let prepareFailure: Error | undefined
  const key = (instanceId: string, actionId: string) => `${instanceId}:${actionId}`
  return {
    rows,
    events,
    acceptedWriteCount: () => acceptedWriteCount,
    failRecordAccepted(count, error) {
      remainingRecordAcceptedFailures = count
      repeatedRecordAcceptedFailure = error
    },
    setRecordAcceptedFailure(error) {
      recordAcceptedFailure = error
    },
    failRecordFailed(count, error) {
      remainingRecordFailedFailures = count
      recordFailedFailure = error
    },
    setPrepareFailure(error) {
      prepareFailure = error
    },
    async get(instanceId, actionId) {
      return rows.get(key(instanceId, actionId))
    },
    async findLatestByEntry(instanceId, entryId) {
      return [...rows.values()]
        .filter((row) => row.instanceId === instanceId && row.entryId === entryId)
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs || right.createdAtMs - left.createdAtMs || right.actionId.localeCompare(left.actionId))[0]
    },
    async findUnresolvedByEntry(instanceId, entryId) {
      return [...rows.values()]
        .filter((row) => row.instanceId === instanceId && row.entryId === entryId && (row.status === "prepared" || row.status === "unknown"))
        .sort((left, right) => Number(left.status === "unknown") - Number(right.status === "unknown") || right.updatedAtMs - left.updatedAtMs || right.actionId.localeCompare(left.actionId))[0]
    },
    async prepare(input) {
      if (prepareFailure !== undefined) throw prepareFailure
      const existing = rows.get(key(input.instanceId, input.actionId))
      if (existing !== undefined) return { admitted: false, entry: existing }
      const now = Date.now()
      const row: OpenJournalRow = {
        instanceId: input.instanceId,
        actionId: input.actionId,
        entryId: input.entryId,
        profileId: input.profileId ?? null,
        deviceId: input.deviceId,
        observedLocationRevision: input.observedLocationRevision,
        observedContentVersion: input.observedContentVersion,
        status: "prepared",
        event: null,
        deliveryStatus: null,
        deliveryErrorCode: null,
        deliveryErrorMessage: null,
        failureCode: null,
        failureMessage: null,
        createdAtMs: now,
        updatedAtMs: now
      }
      rows.set(key(input.instanceId, input.actionId), row)
      return { admitted: true, entry: row }
    },
    async recordAccepted(input, event) {
      acceptedWriteCount += 1
      if (remainingRecordAcceptedFailures > 0) {
        remainingRecordAcceptedFailures -= 1
        throw repeatedRecordAcceptedFailure
      }
      if (recordAcceptedFailure !== undefined) throw recordAcceptedFailure
      const current = rows.get(key(input.instanceId, input.actionId))
      if (current === undefined) throw new Error("missing journal row")
      const next = { ...current, status: "accepted" as const, event, updatedAtMs: Date.now() }
      rows.set(key(input.instanceId, input.actionId), next)
      events.push(event)
      return next
    },
    async recordFailed(input, failure) {
      if (remainingRecordFailedFailures > 0) {
        remainingRecordFailedFailures -= 1
        throw recordFailedFailure
      }
      const current = rows.get(key(input.instanceId, input.actionId))
      if (current === undefined) throw new Error("missing journal row")
      const next = { ...current, status: "failed" as const, failureCode: failure.failureCode, failureMessage: failure.failureMessage, updatedAtMs: Date.now() }
      rows.set(key(input.instanceId, input.actionId), next)
      return next
    },
    async recordUnknown(input) {
      const current = rows.get(key(input.instanceId, input.actionId))
      if (current === undefined) throw new Error("missing journal row")
      const next = { ...current, status: "unknown" as const, updatedAtMs: Date.now() }
      rows.set(key(input.instanceId, input.actionId), next)
      return next
    }
  }
}

const resolutionFor = async (root: string): Promise<EntryResolution> => {
  const book = path.join(root, "fixture.cbz")
  const metadata = await stat(book)
  return {
    entry_id: randomUUID(),
    root_id: randomUUID(),
    relative_path: "fixture.cbz",
    kind: "archive",
    decision_version: "2",
    location_revision: "3",
    content_version: "4",
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
    sibling_claims_revision: "5"
  }
}

const mappingFor = async (root: string, rootId: string): Promise<LocalMapping> => {
  const metadata = await stat(root, { bigint: true })
  return {
    instanceId: randomUUID(),
    rootId,
    selectedPath: root,
    canonicalPath: root,
    admittedRootIdentity: `${metadata.dev}:${metadata.ino}`,
    mappingRevision: "1"
  }
}

type CoordinatorFixture = {
  readonly root: string
  readonly canonicalRoot: string
  readonly resolution: EntryResolution
  readonly journal: TestJournal
  readonly input: {
    readonly instanceId: string
    readonly epoch: string
    readonly entryId: string
    readonly profileId: string
    readonly actionId: string
  }
  readonly ports: OpenCoordinatorPorts
}

const withCoordinatorFixture = async <A>(
  name: string,
  run: (fixture: CoordinatorFixture) => Promise<A>
): Promise<A> => {
  const root = await mkdtemp(path.join(os.tmpdir(), `henshin-open-${name}-`))
  try {
    await writeFile(path.join(root, "fixture.cbz"), "fixture")
    const canonicalRoot = await realpath(root)
    const resolution = await resolutionFor(root)
    const journal = makeJournal()
    const input = {
      instanceId: randomUUID(),
      epoch: randomUUID(),
      entryId: resolution.entry_id,
      profileId: randomUUID(),
      actionId: randomUUID()
    }
    const ports: OpenCoordinatorPorts = {
      journal,
      deviceId: randomUUID(),
      resolve: async () => resolution,
      loadMapping: async () => mappingFor(canonicalRoot, resolution.root_id),
      loadProfile: async (id) => profile(id),
      dispatch: async () => undefined,
      assertCurrent: () => undefined
    }
    return await run({ root, canonicalRoot, resolution, journal, input, ports })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const makeCoordinator = (
  fixture: CoordinatorFixture,
  overrides: Partial<OpenCoordinatorPorts> = {}
): OpenCoordinator => new OpenCoordinator({ ...fixture.ports, ...overrides })

const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("desktop Open coordinator", () => {
  it("checks and caches eligible local access without launching or journaling", async () => {
    await withCoordinatorFixture("prepare-local", async (fixture) => {
      let dispatchCount = 0
      let cacheWrites = 0
      const coordinator = makeCoordinator(fixture, {
        dispatch: async () => { dispatchCount += 1 },
        saveCachedResolution: async (input) => {
          cacheWrites += 1
          expect(input.instanceId).toBe(fixture.input.instanceId)
          expect(input.entryId).toBe(fixture.input.entryId)
          expect(input.epoch).toBe(fixture.input.epoch)
        }
      })
      await expect(coordinator.prepareLocal(fixture.input)).resolves.toMatchObject({
        entry_id: fixture.input.entryId,
        profile_id: fixture.input.profileId,
        status: "eligible"
      })
      expect(cacheWrites).toBe(1)
      expect(dispatchCount).toBe(0)
      expect(fixture.journal.rows.size).toBe(0)
    })
  })

  it("records no event when the native reader rejects the handoff", async () => {
    await withCoordinatorFixture("failure", async (fixture) => {
      const coordinator = makeCoordinator(fixture, {
        dispatch: async () => { throw new Error("fixture reader refused target") }
      })
      const result = await coordinator.open(fixture.input)
      expect(result.status).toBe("failed")
      expect(fixture.journal.events).toHaveLength(0)
      expect([...fixture.journal.rows.values()][0]).toMatchObject({ status: "failed", event: null })
    })
  })

  it("retries a failed journal terminal write so no prepared row is orphaned", async () => {
    await withCoordinatorFixture("failed-write-recovery", async (fixture) => {
      fixture.journal.failRecordFailed(2, new Error("temporary journal failure"))
      const coordinator = makeCoordinator(fixture, {
        dispatch: async () => { throw new Error("fixture reader refused target") }
      })
      const result = await coordinator.open(fixture.input)
      expect(result).toMatchObject({ status: "failed", event_durable: false })
      expect([...fixture.journal.rows.values()][0]).toMatchObject({ status: "failed", event: null })
    })
  })

  it("converts an unwriteable definite failure to a recoverable unknown", async () => {
    await withCoordinatorFixture("failed-write-unknown", async (fixture) => {
      fixture.journal.failRecordFailed(3, new Error("journal unavailable"))
      const coordinator = makeCoordinator(fixture, {
        dispatch: async () => { throw new Error("fixture reader refused target") }
      })
      const result = await coordinator.open(fixture.input)
      expect(result).toMatchObject({ status: "unknown", event_durable: false })
      expect([...fixture.journal.rows.values()][0]).toMatchObject({ status: "unknown", event: null })
      const deliberateRetry = await coordinator.open({ ...fixture.input, actionId: randomUUID() })
      expect(deliberateRetry.status).toBe("failed")
    })
  })

  it("returns the active action and shares its eventual success", async () => {
    await withCoordinatorFixture("duplicate", async (fixture) => {
      let dispatchCount = 0
      let releaseDispatch!: () => void
      const dispatchFinished = new Promise<void>((resolve) => { releaseDispatch = resolve })
      const coordinator = makeCoordinator(fixture, {
        dispatch: async () => { dispatchCount += 1; await dispatchFinished },
      })
      const first = coordinator.open(fixture.input)
      await new Promise((resolve) => setImmediate(resolve))
      const sameAction = coordinator.open(fixture.input)
      expect(sameAction).toBe(first)
      const differentProfile = await coordinator.open({ ...fixture.input, profileId: randomUUID() })
      expect(differentProfile).toMatchObject({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        status: "failed",
        message: "this action ID is already attributed to another reader profile"
      })
      const duplicateActionId = randomUUID()
      const duplicate = coordinator.open({ ...fixture.input, actionId: duplicateActionId, profileId: randomUUID() })
      const duplicateResult = await duplicate
      expect(duplicateResult).toEqual({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        profile_id: fixture.input.profileId,
        status: "in-flight",
        message: "another reader handoff is already opening this entry; follow the active action",
        event_durable: false
      })
      const reusedAction = await coordinator.open({ ...fixture.input, entryId: randomUUID() })
      expect(reusedAction).toMatchObject({
        action_id: fixture.input.actionId,
        status: "failed",
        message: "this action ID is already attributed to another entry"
      })
      releaseDispatch()
      const result = await first
      expect(result).toMatchObject({ action_id: fixture.input.actionId, status: "accepted", event_durable: true })
      if (duplicateResult.profile_id === null) throw new Error("active action did not identify its reader profile")
      const followed = await coordinator.open({
        ...fixture.input,
        actionId: duplicateResult.action_id,
        profileId: duplicateResult.profile_id
      })
      expect(followed).toEqual(result)
      expect(dispatchCount).toBe(1)
      expect(fixture.journal.events).toHaveLength(1)
      const retained = fixture.journal.events[0]
      expect(retained).toBeDefined()
      const replay = await coordinator.open(fixture.input)
      expect(replay).toEqual(result)
      expect(fixture.journal.events[0]).toEqual(retained)
    })
  })

  it("reports active and terminal status without dispatching", async () => {
    await withCoordinatorFixture("status", async (fixture) => {
      let dispatchCount = 0
      let releaseDispatch!: () => void
      const dispatchFinished = new Promise<void>((resolve) => { releaseDispatch = resolve })
      const coordinator = makeCoordinator(fixture, {
        dispatch: async () => {
          dispatchCount += 1
          await dispatchFinished
        }
      })

      const opening = coordinator.open(fixture.input)
      await new Promise((resolve) => setImmediate(resolve))
      await expect(coordinator.status(fixture.input.instanceId, { entryId: fixture.input.entryId })).resolves.toEqual({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        profile_id: fixture.input.profileId,
        status: "in-flight",
        message: "another reader handoff is already opening this entry; follow the active action",
        event_durable: false
      })
      await expect(coordinator.status(fixture.input.instanceId, { actionId: fixture.input.actionId })).resolves.toEqual({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        profile_id: fixture.input.profileId,
        status: "in-flight",
        message: "another reader handoff is already opening this entry; follow the active action",
        event_durable: false
      })
      expect(dispatchCount).toBe(0)

      releaseDispatch()
      await expect(opening).resolves.toMatchObject({ status: "accepted", action_id: fixture.input.actionId })
      await expect(coordinator.status(fixture.input.instanceId, { actionId: fixture.input.actionId })).resolves.toMatchObject({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        profile_id: fixture.input.profileId,
        status: "accepted",
        event_durable: true
      })
      await expect(coordinator.status(fixture.input.instanceId, { entryId: fixture.input.entryId })).resolves.toMatchObject({
        action_id: fixture.input.actionId,
        status: "accepted",
        event_durable: true
      })
      expect(dispatchCount).toBe(1)
    })
  })

  it("returns the active action and shares its eventual failure without attribution drift", async () => {
    await withCoordinatorFixture("duplicate-failure", async (fixture) => {
      let releaseDispatch!: () => void
      const dispatchFinished = new Promise<void>((resolve) => { releaseDispatch = resolve })
      const coordinator = makeCoordinator(fixture, {
        dispatch: async () => {
          await dispatchFinished
          throw new Error("fixture reader refused target")
        }
      })
      const first = coordinator.open(fixture.input)
      await new Promise((resolve) => setImmediate(resolve))
      const duplicate = await coordinator.open({ ...fixture.input, actionId: randomUUID(), profileId: randomUUID() })
      expect(duplicate).toMatchObject({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        profile_id: fixture.input.profileId,
        status: "in-flight"
      })
      const followed = coordinator.open({
        ...fixture.input,
        actionId: duplicate.action_id,
        profileId: fixture.input.profileId
      })
      releaseDispatch()
      await expect(first).resolves.toMatchObject({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        profile_id: fixture.input.profileId,
        status: "failed"
      })
      await expect(followed).resolves.toEqual(await first)
      expect(fixture.journal.events).toHaveLength(0)
      expect([...fixture.journal.rows.values()][0]).toMatchObject({ status: "failed", event: null })
    })
  })

  it("retains an accepted event in memory and retries persistence without redispatch", async () => {
    await withCoordinatorFixture("persistence", async (fixture) => {
      fixture.journal.setRecordAcceptedFailure(new Error("journal unavailable"))
      let dispatchCount = 0
      const coordinator = makeCoordinator(fixture, {
        dispatch: async () => { dispatchCount += 1 },
      })
      const result = await coordinator.open(fixture.input)
      expect(result).toMatchObject({ status: "unknown", event_durable: false })
      expect(dispatchCount).toBe(1)
      expect([...fixture.journal.rows.values()][0]).toMatchObject({ status: "prepared", event: null })
      await expect(coordinator.status(fixture.input.instanceId, { entryId: fixture.input.entryId })).resolves.toMatchObject({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        status: "unknown",
        event_durable: false
      })
      const otherAction = await coordinator.open({ ...fixture.input, actionId: randomUUID() })
      expect(otherAction).toMatchObject({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        status: "unknown",
        event_durable: false
      })
      expect(dispatchCount).toBe(1)
      const mismatchedPending = await coordinator.open({ ...fixture.input, entryId: randomUUID() })
      expect(mismatchedPending).toMatchObject({
        action_id: fixture.input.actionId,
        status: "failed",
        message: "this action ID is already attributed to another entry"
      })
      const mismatchedProfile = await coordinator.open({ ...fixture.input, profileId: randomUUID() })
      expect(mismatchedProfile).toMatchObject({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        status: "failed",
        message: "this action ID is already attributed to another reader profile"
      })
      expect(dispatchCount).toBe(1)
      const secondFailure = await coordinator.open(fixture.input)
      expect(secondFailure).toMatchObject({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        status: "unknown",
        event_durable: false,
        message: "The operating system accepted the reader handoff, but local history is not durable yet. Do not relaunch; persistence will be retried."
      })
      expect(dispatchCount).toBe(1)
      fixture.journal.setRecordAcceptedFailure(undefined)
      await coordinator.drainPendingAccepted()
      expect(dispatchCount).toBe(1)
      expect(fixture.journal.events).toHaveLength(1)
      expect([...fixture.journal.rows.values()][0]).toMatchObject({ status: "accepted", event: fixture.journal.events[0] })
      expect(await coordinator.open(fixture.input)).toMatchObject({ status: "accepted", event_durable: true })
    })
  })

  it("recovers a transient accepted-event write without resubmitting Open", async () => {
    await withCoordinatorFixture("live-retry", async (fixture) => {
      fixture.journal.failRecordAccepted(3, new Error("temporary journal failure"))
      let dispatchCount = 0
      let deliveryWakeups = 0
      const coordinator = makeCoordinator(fixture, {
        dispatch: async () => { dispatchCount += 1 },
        onAcceptedEventDurable: () => { deliveryWakeups += 1 }
      })

      const result = await coordinator.open(fixture.input)
      expect(result).toMatchObject({ status: "unknown", event_durable: false })
      await waitFor(() => fixture.journal.events.length === 1)
      expect(fixture.journal.acceptedWriteCount()).toBe(4)
      expect(dispatchCount).toBe(1)
      expect(deliveryWakeups).toBe(1)
      expect(fixture.journal.events).toHaveLength(1)
      expect([...fixture.journal.rows.values()][0]).toMatchObject({ status: "accepted", event: fixture.journal.events[0] })
    })
  })

  it("waits for an admitted Open promise before the final persistence drain", async () => {
    await withCoordinatorFixture("shutdown-wait", async (fixture) => {
      let releaseDispatch!: () => void
      const dispatchFinished = new Promise<void>((resolve) => { releaseDispatch = resolve })
      let dispatchStarted!: () => void
      const dispatchAdmitted = new Promise<void>((resolve) => { dispatchStarted = resolve })
      const coordinator = makeCoordinator(fixture, {
        dispatch: async () => { dispatchStarted(); await dispatchFinished },
      })
      const openPromise = coordinator.open(fixture.input)
      await dispatchAdmitted
      let waited = false
      const waitPromise = coordinator.waitForInFlight().then(() => { waited = true })
      await new Promise((resolve) => setImmediate(resolve))
      expect(waited).toBe(false)
      coordinator.closeAdmissions()
      await expect(coordinator.open({ ...fixture.input, actionId: randomUUID() })).resolves.toMatchObject({
        status: "failed",
        message: "the application is shutting down; this Open request was not started"
      })
      releaseDispatch()
      await expect(openPromise).resolves.toMatchObject({ status: "accepted" })
      await waitPromise
      expect(waited).toBe(true)
      expect(fixture.journal.events).toHaveLength(1)
    })
  })

  it("drains a known accepted handoff during bounded teardown after storage recovers", async () => {
    await withCoordinatorFixture("shutdown-recovery", async (fixture) => {
      fixture.journal.setRecordAcceptedFailure(new Error("journal unavailable"))
      let dispatchCount = 0
      const coordinator = makeCoordinator(fixture, {
        dispatch: async () => { dispatchCount += 1 }
      })
      await expect(coordinator.open(fixture.input)).resolves.toMatchObject({ status: "unknown", event_durable: false })
      expect(dispatchCount).toBe(1)
      coordinator.closeAdmissions()
      fixture.journal.setRecordAcceptedFailure(undefined)
      await coordinator.waitForInFlight(1_000)
      await coordinator.drainPendingAccepted(1_000)
      expect(dispatchCount).toBe(1)
      expect(fixture.journal.events).toHaveLength(1)
      expect([...fixture.journal.rows.values()][0]).toMatchObject({ status: "accepted", event: fixture.journal.events[0] })
    })
  })

  it("fences a prepared Open when shutdown closes admissions before dispatch", async () => {
    await withCoordinatorFixture("shutdown-fence", async (fixture) => {
      let profileLoads = 0
      let dispatchCount = 0
      const coordinator = makeCoordinator(fixture, {
        loadProfile: async (profileId) => {
          profileLoads += 1
          if (profileLoads === 2) coordinator.closeAdmissions()
          return profile(profileId)
        },
        dispatch: async () => { dispatchCount += 1 }
      })
      const result = await coordinator.open(fixture.input)
      expect(result).toMatchObject({
        status: "failed",
        message: "the application is shutting down; this Open request was not dispatched"
      })
      expect(dispatchCount).toBe(0)
      expect([...fixture.journal.rows.values()][0]).toMatchObject({ status: "failed", event: null })
    })
  })

  it("preserves unknown when dispatch does not settle and never redispatches", async () => {
    vi.useFakeTimers()
    try {
      await withCoordinatorFixture("dispatch-timeout", async (fixture) => {
        let dispatchCount = 0
        let started!: () => void
        let releaseDispatch!: () => void
        const dispatchStarted = new Promise<void>((resolve) => { started = resolve })
        const dispatchFinished = new Promise<void>((resolve) => { releaseDispatch = resolve })
        const coordinator = makeCoordinator(fixture, {
          dispatch: async () => {
            dispatchCount += 1
            started()
            await dispatchFinished
          }
        })
        const opening = coordinator.open(fixture.input)
        await dispatchStarted
        await vi.advanceTimersByTimeAsync(4_000)
        await expect(opening).resolves.toMatchObject({
          status: "unknown",
          message: "The reader handoff outcome is unknown; the operating system may have opened the target. Do not retry this action automatically; review local history before opening again.",
          event_durable: false
        })
        expect(dispatchCount).toBe(1)
        expect([...fixture.journal.rows.values()][0]).toMatchObject({ status: "unknown", event: null })
        releaseDispatch()
        await Promise.resolve()
        await Promise.resolve()
        expect(fixture.journal.events).toHaveLength(0)
        await expect(coordinator.open(fixture.input)).resolves.toMatchObject({ status: "unknown" })
        expect(dispatchCount).toBe(1)

        const deliberateRetry = await coordinator.open({ ...fixture.input, actionId: randomUUID() })
        expect(deliberateRetry).toMatchObject({
          status: "accepted",
          event_durable: true
        })
        expect(dispatchCount).toBe(2)
        expect(fixture.journal.rows.get(`${fixture.input.instanceId}:${fixture.input.actionId}`)).toMatchObject({
          actionId: fixture.input.actionId,
          status: "unknown",
          event: null
        })
        expect(fixture.journal.events).toHaveLength(1)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("opens offline from the cached server-scoped resolution and records durable local history", async () => {
    await withCoordinatorFixture("offline-cache", async (fixture) => {
      let resolveCount = 0
      let dispatchCount = 0
      const coordinator = makeCoordinator(fixture, {
        resolve: async () => {
          resolveCount += 1
          throw new Error("offline Open must not query the server")
        },
        loadCachedResolution: async (instanceId, entryId) => {
          expect(instanceId).toBe(fixture.input.instanceId)
          expect(entryId).toBe(fixture.input.entryId)
          return { epoch: fixture.input.epoch, resolution: fixture.resolution }
        },
        assertCurrent: () => { throw new Error("offline Open must not require a live lease") },
        dispatch: async () => { dispatchCount += 1 }
      })
      const result = await coordinator.open({ ...fixture.input, offline: true })
      expect(result).toMatchObject({ status: "accepted", event_durable: true })
      expect(resolveCount).toBe(0)
      expect(dispatchCount).toBe(1)
      expect(fixture.journal.events).toHaveLength(1)
    })
  })

  it("blocks offline Open when the cached resolution belongs to another server epoch", async () => {
    await withCoordinatorFixture("offline-stale-cache", async (fixture) => {
      let dispatchCount = 0
      const coordinator = makeCoordinator(fixture, {
        loadCachedResolution: async () => ({ epoch: randomUUID(), resolution: fixture.resolution }),
        dispatch: async () => { dispatchCount += 1 }
      })
      const result = await coordinator.open({ ...fixture.input, offline: true })
      expect(result).toMatchObject({
        status: "failed",
        message: "offline Open is unavailable because this entry has no cached accepted server resolution"
      })
      expect(dispatchCount).toBe(0)
      expect(fixture.journal.rows.size).toBe(0)
    })
  })

  it("reports that an offline accepted handoff used stale cached server evidence", async () => {
    await withCoordinatorFixture("offline-stale-evidence", async (fixture) => {
      const coordinator = makeCoordinator(fixture, {
        resolve: async () => { throw new Error("offline Open must not query the server") },
        loadCachedResolution: async () => ({ epoch: fixture.input.epoch, resolution: fixture.resolution }),
        dispatch: async () => undefined
      })
      await expect(coordinator.open({ ...fixture.input, offline: true })).resolves.toMatchObject({
        status: "accepted",
        message: "The operating system accepted the reader handoff using stale cached server evidence; local mapping and target checks passed."
      })
    })
  })

  it("reports the latest terminal status for an entry after an older unknown", async () => {
    await withCoordinatorFixture("entry-status-order", async (fixture) => {
      const olderActionId = fixture.input.actionId
      await fixture.journal.prepare({
        instanceId: fixture.input.instanceId,
        actionId: olderActionId,
        entryId: fixture.input.entryId,
        profileId: fixture.input.profileId,
        deviceId: fixture.ports.deviceId,
        observedLocationRevision: fixture.resolution.location_revision,
        observedContentVersion: fixture.resolution.content_version
      })
      await fixture.journal.recordUnknown({ instanceId: fixture.input.instanceId, actionId: olderActionId })
      await new Promise((resolve) => setTimeout(resolve, 2))
      const newerActionId = randomUUID()
      await fixture.journal.prepare({
        instanceId: fixture.input.instanceId,
        actionId: newerActionId,
        entryId: fixture.input.entryId,
        profileId: fixture.input.profileId,
        deviceId: fixture.ports.deviceId,
        observedLocationRevision: fixture.resolution.location_revision,
        observedContentVersion: fixture.resolution.content_version
      })
      await fixture.journal.recordFailed(
        { instanceId: fixture.input.instanceId, actionId: newerActionId },
        { failureCode: "open_failed", failureMessage: "the later target was unavailable" }
      )
      const coordinator = makeCoordinator(fixture)
      await expect(coordinator.status(fixture.input.instanceId, { entryId: fixture.input.entryId })).resolves.toMatchObject({
        action_id: newerActionId,
        status: "failed",
        message: "the later target was unavailable"
      })
    })
  })

  it("rejects an action ID reused for a different entry without dispatching", async () => {
    await withCoordinatorFixture("action-reuse", async (fixture) => {
      await fixture.journal.prepare({
        instanceId: fixture.input.instanceId,
        actionId: fixture.input.actionId,
        entryId: fixture.input.entryId,
        deviceId: randomUUID(),
        observedLocationRevision: "1",
        observedContentVersion: "1"
      })
      const secondEntryId = randomUUID()
      let dispatchCount = 0
      const coordinator = makeCoordinator(fixture, {
        resolve: async () => { throw new Error("resolution should not be requested") },
        loadMapping: async () => undefined,
        loadProfile: async () => undefined,
        dispatch: async () => { dispatchCount += 1 }
      })
      const result = await coordinator.open({ ...fixture.input, entryId: secondEntryId })
      expect(result).toMatchObject({ status: "failed", entry_id: secondEntryId })
      expect(result.message).toContain("another entry")
      expect(dispatchCount).toBe(0)
    })
  })

  it("does not redispatch or claim a profile for a retained legacy intent", async () => {
    await withCoordinatorFixture("legacy-intent", async (fixture) => {
      await fixture.journal.prepare({
        instanceId: fixture.input.instanceId,
        actionId: fixture.input.actionId,
        entryId: fixture.input.entryId,
        profileId: undefined,
        deviceId: randomUUID(),
        observedLocationRevision: "1",
        observedContentVersion: "1"
      })
      let dispatchCount = 0
      let resolveCount = 0
      const coordinator = makeCoordinator(fixture, {
        resolve: async () => {
          resolveCount += 1
          throw new Error("legacy retained intent must not be resolved")
        },
        loadMapping: async () => undefined,
        loadProfile: async () => undefined,
        dispatch: async () => { dispatchCount += 1 }
      })

      await expect(coordinator.open(fixture.input)).resolves.toMatchObject({
        status: "unknown",
        message: "The retained reader handoff has no recorded reader profile; it was not redispatched.",
        event_durable: false
      })
      expect(resolveCount).toBe(0)
      expect(dispatchCount).toBe(0)
    })
  })

  it("replays retained legacy accepted and failed status without redispatch", async () => {
    await withCoordinatorFixture("legacy-terminal", async (fixture) => {
      const event: OpenEvent = {
        event_id: fixture.input.actionId,
        instance_id: fixture.input.instanceId,
        entry_id: fixture.input.entryId,
        device_id: fixture.ports.deviceId,
        observed_location_revision: fixture.resolution.location_revision,
        observed_content_version: fixture.resolution.content_version,
        occurred_at_ms: Date.now()
      }
      await fixture.journal.prepare({
        instanceId: fixture.input.instanceId,
        actionId: fixture.input.actionId,
        entryId: fixture.input.entryId,
        profileId: undefined,
        deviceId: fixture.ports.deviceId,
        observedLocationRevision: fixture.resolution.location_revision,
        observedContentVersion: fixture.resolution.content_version
      })
      await fixture.journal.recordAccepted({
        instanceId: fixture.input.instanceId,
        actionId: fixture.input.actionId
      }, event)
      let dispatchCount = 0
      const coordinator = makeCoordinator(fixture, {
        resolve: async () => { throw new Error("legacy terminal row must not be resolved") },
        dispatch: async () => { dispatchCount += 1 }
      })

      await expect(coordinator.open(fixture.input)).resolves.toEqual({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        profile_id: null,
        status: "accepted",
        message: "The operating system accepted the reader handoff.",
        event_durable: true
      })
      await expect(coordinator.status(fixture.input.instanceId, { actionId: fixture.input.actionId })).resolves.toEqual({
        action_id: fixture.input.actionId,
        entry_id: fixture.input.entryId,
        profile_id: null,
        status: "accepted",
        message: "The operating system accepted the reader handoff.",
        event_durable: true
      })
      expect(dispatchCount).toBe(0)

      const failedActionId = randomUUID()
      await fixture.journal.prepare({
        instanceId: fixture.input.instanceId,
        actionId: failedActionId,
        entryId: fixture.input.entryId,
        profileId: undefined,
        deviceId: fixture.ports.deviceId,
        observedLocationRevision: fixture.resolution.location_revision,
        observedContentVersion: fixture.resolution.content_version
      })
      await fixture.journal.recordFailed(
        { instanceId: fixture.input.instanceId, actionId: failedActionId },
        { failureCode: "open_failed", failureMessage: "the fixture target disappeared" }
      )
      await expect(coordinator.status(fixture.input.instanceId, { actionId: failedActionId })).resolves.toEqual({
        action_id: failedActionId,
        entry_id: fixture.input.entryId,
        profile_id: null,
        status: "failed",
        message: "the fixture target disappeared",
        event_durable: false
      })
      expect(dispatchCount).toBe(0)
    })
  })

  it("fails before dispatch when the effective mapping revision changes during preparation", async () => {
    await withCoordinatorFixture("authority", async (fixture) => {
      let mappingReads = 0
      let dispatchCount = 0
      const coordinator = makeCoordinator(fixture, {
        loadMapping: async () => {
          mappingReads += 1
          return { ...(await mappingFor(fixture.canonicalRoot, fixture.resolution.root_id)), mappingRevision: mappingReads === 1 ? "1" : "2" }
        },
        dispatch: async () => { dispatchCount += 1 }
      })
      const result = await coordinator.open(fixture.input)
      expect(result.status).toBe("failed")
      expect(dispatchCount).toBe(0)
      expect([...fixture.journal.rows.values()][0]).toMatchObject({ status: "failed", event: null })
    })
  })

  it("reports actionable journal-full and paused-connection failures before dispatch", async () => {
    await withCoordinatorFixture("admission-errors", async (fixture) => {
      fixture.journal.setPrepareFailure(new OpenJournalStoreFullError())
      let dispatchCount = 0
      const fullCoordinator = makeCoordinator(fixture, { dispatch: async () => { dispatchCount += 1 } })
      const fullResult = await fullCoordinator.open(fixture.input)
      expect(fullResult).toMatchObject({
        status: "failed",
        message: "local Open history is full; no reader was launched. Use Open recovery to dismiss an unknown intent or discard a held event, or wait for acknowledged/failed history to become eligible for compaction; pending, unknown, and held history is retained."
      })
      expect(dispatchCount).toBe(0)
      expect(fixture.journal.rows.size).toBe(0)

      fixture.journal.setPrepareFailure(undefined)
      const pausedCoordinator = makeCoordinator(fixture, {
        assertCurrent: () => { throw new ConnectionPausedError({ state: "disconnected" }) }
      })
      const pausedResult = await pausedCoordinator.open({ ...fixture.input, actionId: randomUUID() })
      expect(pausedResult).toMatchObject({
        status: "failed",
        message: "the server connection is paused; reconnect before opening"
      })
      expect(dispatchCount).toBe(0)
    })
  })

  it("keeps coordinator configuration causes actionable while redacting unexpected failures", async () => {
    await withCoordinatorFixture("safe-errors", async (fixture) => {
      const missingMapping = makeCoordinator(fixture, {
        loadMapping: async () => undefined
      })
      await expect(missingMapping.open(fixture.input)).resolves.toMatchObject({
        status: "failed",
        message: "configure a compatible local mapping before opening"
      })

      const missingProfile = makeCoordinator(fixture, {
        loadProfile: async () => undefined
      })
      await expect(missingProfile.open({ ...fixture.input, actionId: randomUUID() })).resolves.toMatchObject({
        status: "failed",
        message: "the selected reader profile is no longer configured"
      })

      const unexpected = makeCoordinator(fixture, {
        resolve: async () => { throw new Error("secret worker detail") }
      })
      const unexpectedResult = await unexpected.open({ ...fixture.input, actionId: randomUUID() })
      expect(unexpectedResult.status).toBe("failed")
      expect(unexpectedResult.message).not.toContain("secret worker detail")
      expect(unexpectedResult.message).toBe("the reader handoff could not be completed; check the reader profile and local mapping, then retry")
    })
  })

  it("fetches continuation claims past 128 siblings before native dispatch", async () => {
    await withCoordinatorFixture("pagination", async (fixture) => {
      const targetPath = path.join(fixture.root, "a.cbz")
      const siblingPath = path.join(fixture.root, "A.cbz")
      await writeFile(targetPath, "fixture")
      await link(targetPath, siblingPath).catch(async () => {
        await stat(siblingPath)
      })
      const targetMetadata = await stat(targetPath)
      const cursor = randomUUID()
      const first: EntryResolution = {
        ...fixture.resolution,
        relative_path: "a.cbz",
        accepted_observation: {
          ...fixture.resolution.accepted_observation,
          bytes: targetMetadata.size,
          mtime_ms: targetMetadata.mtimeMs
        },
        sibling_claims: Array.from({ length: 128 }, (_, index) => ({
          entry_id: randomUUID(),
          relative_path: `missing-${index.toString().padStart(3, "0")}.cbz`
        })),
        sibling_claims_truncated: true,
        sibling_claims_next_cursor: cursor,
        sibling_claims_revision: "5"
      }
      const second: EntryResolution = {
        ...first,
        sibling_claims: [{ entry_id: randomUUID(), relative_path: "A.cbz" }],
        sibling_claims_truncated: false,
        sibling_claims_next_cursor: null
      }
      const queries: Array<{ readonly siblingCursor?: string; readonly siblingClaimsRevision?: string } | undefined> = []
      let dispatchCount = 0
      const coordinator = makeCoordinator(fixture, {
        resolve: async (_, query) => {
          queries.push(query)
          return query === undefined ? first : second
        },
        loadMapping: async () => mappingFor(fixture.canonicalRoot, first.root_id),
        dispatch: async () => { dispatchCount += 1 }
      })

      const result = await coordinator.open({ ...fixture.input, entryId: first.entry_id })
      expect(result.status).toBe("failed")
      expect(result.message).toContain("ambiguous with another entry")
      expect(queries).toEqual([undefined, { siblingCursor: cursor, siblingClaimsRevision: "5" }])
      expect(dispatchCount).toBe(0)
      expect(fixture.journal.rows.size).toBe(0)
    })
  })

  it("consumes more than 64 sibling pages before dispatch", async () => {
    await withCoordinatorFixture("pagination-long", async (fixture) => {
      const targetPath = path.join(fixture.root, "a.cbz")
      const siblingPath = path.join(fixture.root, "A.cbz")
      await writeFile(targetPath, "fixture")
      await link(targetPath, siblingPath).catch(async () => {
        await stat(siblingPath)
      })
      const targetMetadata = await stat(targetPath)
      const firstCursor = randomUUID()
      const cursors = [firstCursor, ...Array.from({ length: 64 }, () => randomUUID())]
      const first: EntryResolution = {
        ...fixture.resolution,
        relative_path: "a.cbz",
        accepted_observation: {
          ...fixture.resolution.accepted_observation,
          bytes: targetMetadata.size,
          mtime_ms: targetMetadata.mtimeMs
        },
        sibling_claims: [],
        sibling_claims_truncated: true,
        sibling_claims_next_cursor: firstCursor,
        sibling_claims_revision: "5"
      }
      const pages = cursors.map((_, index): EntryResolution => ({
        ...first,
        sibling_claims: [{
          entry_id: randomUUID(),
          relative_path: index === cursors.length - 1 ? "A.cbz" : `missing-${index}.cbz`
        }],
        sibling_claims_truncated: index !== cursors.length - 1,
        sibling_claims_next_cursor: index === cursors.length - 1 ? null : cursors[index + 1]
      }))
      let dispatchCount = 0
      let queryCount = 0
      const coordinator = makeCoordinator(fixture, {
        resolve: async (_, query) => {
          queryCount += 1
          if (query === undefined) return first
          const pageIndex = cursors.indexOf(query.siblingCursor ?? "")
          if (pageIndex < 0) throw new Error("unexpected sibling cursor")
          return pages[pageIndex]
        },
        loadMapping: async () => mappingFor(fixture.canonicalRoot, first.root_id),
        dispatch: async () => { dispatchCount += 1 }
      })
      const result = await coordinator.open({ ...fixture.input, entryId: first.entry_id })
      expect(result.status).toBe("failed")
      expect(result.message).toContain("ambiguous with another entry")
      expect(queryCount).toBe(66)
      expect(dispatchCount).toBe(0)
      expect(fixture.journal.rows.size).toBe(0)
    })
  })

  it("rejects a cyclic sibling cursor with actionable evidence guidance", async () => {
    await withCoordinatorFixture("pagination-cycle", async (fixture) => {
      const cursor = randomUUID()
      const page: EntryResolution = {
        ...fixture.resolution,
        sibling_claims_truncated: true,
        sibling_claims_next_cursor: cursor,
        sibling_claims_revision: "5"
      }
      let dispatchCount = 0
      let queryCount = 0
      const coordinator = makeCoordinator(fixture, {
        resolve: async (_, query) => {
          queryCount += 1
          return query === undefined ? page : page
        },
        loadMapping: async () => mappingFor(fixture.canonicalRoot, fixture.resolution.root_id),
        dispatch: async () => { dispatchCount += 1 }
      })
      const result = await coordinator.open(fixture.input)
      expect(result).toMatchObject({
        status: "failed",
        message: "sibling identity evidence could not be completed; refresh the entry before opening"
      })
      expect(queryCount).toBe(2)
      expect(dispatchCount).toBe(0)
      expect(fixture.journal.rows.size).toBe(0)
    })
  })
})
