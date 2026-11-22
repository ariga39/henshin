import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { EntryResolution, OpenBookIpcResult } from "@henshin/contracts"
import type { OpenEvent } from "@henshin/contracts/event"
import type { OpenJournalRow } from "../src/main/persistence/draft-worker-protocol"
import type { LocalMapping } from "../src/main/persistence/LocalMappingStore"
import type { StoredReaderProfile } from "../src/main/persistence/ReaderProfileStore"
import { OpenCoordinator, type OpenJournalPort } from "../src/main/OpenCoordinator"

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

const makeJournal = (): OpenJournalPort & {
  readonly rows: Map<string, OpenJournalRow>
  readonly events: Array<OpenEvent>
} => {
  const rows = new Map<string, OpenJournalRow>()
  const events: Array<OpenEvent> = []
  const key = (instanceId: string, actionId: string) => `${instanceId}:${actionId}`
  return {
    rows,
    events,
    async get(instanceId, actionId) {
      return rows.get(key(instanceId, actionId))
    },
    async prepare(input) {
      const existing = rows.get(key(input.instanceId, input.actionId))
      if (existing !== undefined) return { admitted: false, entry: existing }
      const now = Date.now()
      const row: OpenJournalRow = {
        instanceId: input.instanceId,
        actionId: input.actionId,
        entryId: input.entryId,
        deviceId: input.deviceId,
        observedLocationRevision: input.observedLocationRevision,
        observedContentVersion: input.observedContentVersion,
        status: "prepared",
        event: null,
        failureCode: null,
        failureMessage: null,
        createdAtMs: now,
        updatedAtMs: now
      }
      rows.set(key(input.instanceId, input.actionId), row)
      return { admitted: true, entry: row }
    },
    async recordAccepted(input, event) {
      const current = rows.get(key(input.instanceId, input.actionId))
      if (current === undefined) throw new Error("missing journal row")
      const next = { ...current, status: "accepted" as const, event, updatedAtMs: Date.now() }
      rows.set(key(input.instanceId, input.actionId), next)
      events.push(event)
      return next
    },
    async recordFailed(input, failure) {
      const current = rows.get(key(input.instanceId, input.actionId))
      if (current === undefined) throw new Error("missing journal row")
      const next = { ...current, status: "failed" as const, failureCode: failure.failureCode, failureMessage: failure.failureMessage, updatedAtMs: Date.now() }
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
    sibling_claims_truncated: false
  }
}

const mappingFor = (root: string, rootId: string): LocalMapping => ({
  instanceId: randomUUID(),
  rootId,
  selectedPath: root,
  canonicalPath: root,
  mappingRevision: "1"
})

describe("desktop Open coordinator", () => {
  it("records no event when the native reader rejects the handoff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-open-failure-"))
    try {
      await writeFile(path.join(root, "fixture.cbz"), "fixture")
      const canonicalRoot = await realpath(root)
      const resolution = await resolutionFor(root)
      const journal = makeJournal()
      const coordinator = new OpenCoordinator({
        journal,
        deviceId: randomUUID(),
        resolve: async () => resolution,
        loadMapping: async () => mappingFor(canonicalRoot, resolution.root_id),
        loadProfile: async (id) => profile(id),
        dispatch: async () => { throw new Error("fixture reader refused target") },
        assertCurrent: () => undefined
      })
      const result = await coordinator.open({ instanceId: randomUUID(), epoch: randomUUID(), entryId: resolution.entry_id, profileId: randomUUID(), actionId: randomUUID() })
      expect(result.status).toBe("failed")
      expect(journal.events).toHaveLength(0)
      expect([...journal.rows.values()][0]).toMatchObject({ status: "failed", event: null })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("coalesces duplicate in-flight opens and records one immutable event", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-open-duplicate-"))
    try {
      await writeFile(path.join(root, "fixture.cbz"), "fixture")
      const canonicalRoot = await realpath(root)
      const resolution = await resolutionFor(root)
      const journal = makeJournal()
      let dispatchCount = 0
      let releaseDispatch!: () => void
      const dispatchFinished = new Promise<void>((resolve) => { releaseDispatch = resolve })
      const coordinator = new OpenCoordinator({
        journal,
        deviceId: randomUUID(),
        resolve: async () => resolution,
        loadMapping: async () => mappingFor(canonicalRoot, resolution.root_id),
        loadProfile: async (id) => profile(id),
        dispatch: async () => { dispatchCount += 1; await dispatchFinished },
        assertCurrent: () => undefined
      })
      const input = { instanceId: randomUUID(), epoch: randomUUID(), entryId: resolution.entry_id, profileId: randomUUID(), actionId: randomUUID() }
      const first = coordinator.open(input)
      await new Promise((resolve) => setImmediate(resolve))
      const duplicate = coordinator.open({ ...input, actionId: randomUUID(), profileId: randomUUID() })
      releaseDispatch()
      const results = await Promise.all([first, duplicate])
      expect(results[0]).toEqual(results[1])
      expect(results[0]).toMatchObject({ status: "accepted", event_durable: true })
      expect(dispatchCount).toBe(1)
      expect(journal.events).toHaveLength(1)
      const retained = journal.events[0]
      expect(retained).toBeDefined()
      const replay = await coordinator.open(input)
      expect(replay).toEqual(results[0])
      expect(journal.events[0]).toEqual(retained)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps a successful handoff unknown when accepted-event persistence fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-open-persistence-"))
    try {
      await writeFile(path.join(root, "fixture.cbz"), "fixture")
      const canonicalRoot = await realpath(root)
      const resolution = await resolutionFor(root)
      const journal = makeJournal()
      const failingJournal: OpenJournalPort = {
        ...journal,
        recordAccepted: async () => { throw new Error("journal unavailable") }
      }
      let dispatchCount = 0
      const coordinator = new OpenCoordinator({
        journal: failingJournal,
        deviceId: randomUUID(),
        resolve: async () => resolution,
        loadMapping: async () => mappingFor(canonicalRoot, resolution.root_id),
        loadProfile: async (id) => profile(id),
        dispatch: async () => { dispatchCount += 1 },
        assertCurrent: () => undefined
      })
      const result = await coordinator.open({ instanceId: randomUUID(), epoch: randomUUID(), entryId: resolution.entry_id, profileId: randomUUID(), actionId: randomUUID() })
      expect(result).toMatchObject({ status: "unknown", event_durable: false })
      expect(dispatchCount).toBe(1)
      expect([...journal.rows.values()][0]).toMatchObject({ status: "prepared", event: null })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects an action ID reused for a different entry without dispatching", async () => {
    const journal = makeJournal()
    const instanceId = randomUUID()
    const actionId = randomUUID()
    const firstEntryId = randomUUID()
    const secondEntryId = randomUUID()
    await journal.prepare({
      instanceId,
      actionId,
      entryId: firstEntryId,
      deviceId: randomUUID(),
      observedLocationRevision: "1",
      observedContentVersion: "1"
    })
    let dispatchCount = 0
    const coordinator = new OpenCoordinator({
      journal,
      deviceId: randomUUID(),
      resolve: async () => { throw new Error("resolution should not be requested") },
      loadMapping: async () => undefined,
      loadProfile: async () => undefined,
      dispatch: async () => { dispatchCount += 1 },
      assertCurrent: () => undefined
    })
    const result = await coordinator.open({ instanceId, epoch: randomUUID(), entryId: secondEntryId, profileId: randomUUID(), actionId })
    expect(result).toMatchObject({ status: "failed", entry_id: secondEntryId })
    expect(result.message).toContain("another entry")
    expect(dispatchCount).toBe(0)
  })

  it("fails before dispatch when the effective mapping revision changes during preparation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-open-authority-"))
    try {
      await writeFile(path.join(root, "fixture.cbz"), "fixture")
      const canonicalRoot = await realpath(root)
      const resolution = await resolutionFor(root)
      const journal = makeJournal()
      let mappingReads = 0
      let dispatchCount = 0
      const coordinator = new OpenCoordinator({
        journal,
        deviceId: randomUUID(),
        resolve: async () => resolution,
        loadMapping: async () => {
          mappingReads += 1
          return { ...mappingFor(canonicalRoot, resolution.root_id), mappingRevision: mappingReads === 1 ? "1" : "2" }
        },
        loadProfile: async (id) => profile(id),
        dispatch: async () => { dispatchCount += 1 },
        assertCurrent: () => undefined
      })
      const result = await coordinator.open({ instanceId: randomUUID(), epoch: randomUUID(), entryId: resolution.entry_id, profileId: randomUUID(), actionId: randomUUID() })
      expect(result.status).toBe("failed")
      expect(dispatchCount).toBe(0)
      expect([...journal.rows.values()][0]).toMatchObject({ status: "failed", event: null })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
