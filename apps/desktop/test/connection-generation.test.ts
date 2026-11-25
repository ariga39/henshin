import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type {
  ConnectionStatusView,
  ConnectionTargetView,
  DeviceRootMapping,
  LibraryEntry,
  LibraryEntryDetails,
  RemoteConnectionCandidateView,
  ReaderProfile,
  RootPreviewResult,
  ScanTask,
  ServerRoot,
  StagedDiscovery
} from "@henshin/contracts"
import {
  ConnectionClient,
  LibraryClient,
  LocalMappingClient,
  OpenJournalClient,
  RootPreviewClient,
  ScanReviewClient
} from "../src/renderer/client"
import {
  cancelRemote,
  confirmRemote,
  connectRemote,
  dismissUnknownOpenJournal,
  activateLocalMapping,
  detachMissingEntry,
  excludeRootPath,
  handleConnectionStatusChanged,
  loadConnectionWorkspace,
  loadLibraryEntry,
  reconnectNormal,
  releaseHeldDiscovery,
  resolveReplacement,
  updateLibraryNote,
  useManagedConnection
} from "../src/renderer/workflows"
import { viewStore } from "../src/renderer/store"

const instanceId = "11111111-1111-4111-8111-111111111111"
const otherInstanceId = "66666666-6666-4666-8666-666666666666"
const rootId = "22222222-2222-4222-8222-222222222222"
const candidateId = "33333333-3333-4333-8333-333333333333"
const entryId = "44444444-4444-4444-8444-444444444444"
const epoch = "55555555-5555-4555-8555-555555555555"

const connected = (id = instanceId, currentEpoch = epoch): ConnectionStatusView => ({
  state: "connected", instance_id: id, epoch: currentEpoch, reason: null
})
const remoteTarget: ConnectionTargetView = {
  mode: "remote", base_url: "https://library.example.test", instance_id: instanceId
}
const nextTarget: ConnectionTargetView = {
  mode: "remote", base_url: "https://next.example.test", instance_id: otherInstanceId
}
const candidate = {
  candidate_id: candidateId,
  base_url: remoteTarget.base_url,
  instance_id: instanceId,
  epoch
} as RemoteConnectionCandidateView
const root = {
  root_id: rootId,
  library_id: "77777777-7777-4777-8777-777777777777",
  label: "Books",
  selected_server_path: "/books",
  canonical_server_path: "/books",
  mapping_revision: "1",
  policy_revision: "1",
  exclusions: [],
  state: "active"
} as ServerRoot
const savedPreview = {
  kind: "saved-root-discovery",
  root_id: rootId,
  selected_server_path: "/books",
  instance_id: instanceId,
  epoch,
  policy_revision: "1",
  candidates: [],
  sample_limit: 20,
  unassigned_loose_images: [],
  unassigned_loose_image_count: 0,
  unsupported_loose_images: [],
  unsupported_loose_image_count: 0,
  coverage: {}
} as unknown as RootPreviewResult
const task = {
  task_id: "88888888-8888-4888-8888-888888888888",
  root_id: rootId,
  kind: "manual-scan",
  mode: "manual",
  hold_new_discoveries: false,
  mapping_revision: "1",
  status: "running"
} as ScanTask
const staged = {
  candidate_id: candidateId,
  root_id: rootId,
  relative_path: "book.cbz",
  candidate_version: 1,
  hold_state: "held",
  analysis_status: "ready",
  manifest: {}
} as unknown as StagedDiscovery
const replacementEntry = {
  entry_id: entryId,
  root_id: rootId,
  relative_path: "book.cbz",
  state: "replacement-pending",
  location_revision: "1",
  replacement: { candidate_id: candidateId, candidate_version: 1, decision_version: "1" }
} as unknown as LibraryEntry
const entryDetails = {
  ...replacementEntry,
  decision_version: "1",
  availability: { status: "available" },
  note: null
} as unknown as LibraryEntryDetails

const success = <A>(data: A) => ({ ok: true as const, data })
const failure = (message = "old request failed") => ({
  ok: false as const,
  error: { code: "ipc_failed", message, retryable: true }
})
const deferred = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((complete) => { resolve = complete })
  return { promise, resolve }
}
const markStarted = () => {
  let start!: () => void
  const started = new Promise<void>((resolve) => { start = resolve })
  return { started, start }
}

const reset = (): void => {
  viewStore.resetConnectionTarget({ mode: "managed", base_url: null, instance_id: null })
  viewStore.set({
    screen: "setup",
    connection_generation: 0,
    connection: { state: "disconnected", instance_id: null, epoch: null, reason: null },
    reader_profiles: [],
    reader_profiles_status: "idle",
    reader_profiles_error: null
  })
}

const ready = (generation = 10): void => {
  viewStore.set({
    screen: "library",
    connection_generation: generation,
    connection: connected(),
    connection_target: remoteTarget,
    root_saved_roots: [root],
    root_preview: savedPreview,
    root_preview_status: "ready",
    local_mapping_list_status: "ready",
    scan_status: "ready",
    scan_tasks: [],
    staged_discoveries: [],
    library_status: "ready",
    library_entries: []
  })
}

const connectionLayer = (overrides: Record<string, unknown> = {}) => Layer.succeed(
  ConnectionClient,
  ConnectionClient.of({
    onStatusChanged: () => () => undefined,
    onRemoteCandidateInvalidated: () => () => undefined,
    onChanged: () => () => undefined,
    status: () => Effect.succeed(success(connected())),
    target: () => Effect.succeed(success(remoteTarget)),
    reconnect: () => Effect.succeed(success(connected())),
    disconnect: () => Effect.succeed(success({ state: "disconnected", instance_id: instanceId, epoch, reason: null })),
    connectRemote: () => Effect.succeed(success(candidate)),
    confirmRemote: () => Effect.succeed(success(connected())),
    cancelRemote: () => Effect.succeed(success({ state: "disconnected", instance_id: instanceId, epoch, reason: null })),
    useManaged: () => Effect.succeed(success(connected())),
    ...overrides
  } as unknown as ConnectionClient["Service"])
)

const rootLayer = (overrides: Record<string, unknown> = {}) => Layer.succeed(
  RootPreviewClient,
  RootPreviewClient.of({
    preview: () => Effect.succeed(success(savedPreview)),
    list: () => Effect.succeed(success([root])),
    save: () => Effect.succeed(success(root)),
    command: () => Effect.succeed(success(root)),
    ...overrides
  } as unknown as RootPreviewClient["Service"])
)

const localLayer = (overrides: Record<string, unknown> = {}) => Layer.succeed(
  LocalMappingClient,
  LocalMappingClient.of({
    preview: () => Effect.succeed(success(null)),
    list: () => Effect.succeed(success([])),
    activate: () => Effect.succeed(success({ root_id: rootId })),
    ...overrides
  } as unknown as LocalMappingClient["Service"])
)

const scanLayer = (overrides: Record<string, unknown> = {}) => Layer.succeed(
  ScanReviewClient,
  ScanReviewClient.of({
    listTasks: () => Effect.succeed(success([])),
    candidates: () => Effect.succeed(success([])),
    release: () => Effect.succeed(success({ candidate: staged })),
    resolve: () => Effect.succeed(success({ candidate: staged })),
    ...overrides
  } as unknown as ScanReviewClient["Service"])
)

const libraryLayer = (overrides: Record<string, unknown> = {}) => Layer.succeed(
  LibraryClient,
  LibraryClient.of({
    search: () => Effect.succeed(success({ entries: [], has_more: false, next_cursor: null, library_change_revision: "1" })),
    entry: () => Effect.succeed(success(entryDetails)),
    note: () => Effect.succeed(success({ operation_id: "op", entry: entryDetails })),
    open: () => Effect.succeed(success({ action_id: "action", entry_id: entryId, profile_id: null, status: "accepted", message: null, event_durable: true })),
    status: () => Effect.succeed(success(null)),
    command: () => Effect.succeed(success({ operation_id: "op", entry: entryDetails })),
    getThumbnail: () => Effect.succeed(success(new Uint8Array())),
    ...overrides
  } as unknown as LibraryClient["Service"])
)

const journalLayer = (overrides: Record<string, unknown> = {}) => Layer.succeed(
  OpenJournalClient,
  OpenJournalClient.of({
    list: () => Effect.succeed(success([])),
    recover: () => Effect.succeed(success(null)),
    ...overrides
  } as unknown as OpenJournalClient["Service"])
)

const workspaceLayers = (connection: Record<string, unknown> = {}, library: Record<string, unknown> = {}) =>
  Layer.mergeAll(connectionLayer(connection), rootLayer(), localLayer(), scanLayer(), libraryLayer(library))

afterEach(reset)

describe("connection generation fences renderer workflows", () => {
  it("records a remote probe candidate without replacing a live status broadcast", async () => {
    const response = deferred<ReturnType<typeof success<RemoteConnectionCandidateView>>>()
    const started = markStarted()
    let statusReads = 0
    let targetReads = 0
    let probeReads = 0
    ready()
    const pending = Effect.runPromise(Effect.provide(connectRemote("https://candidate.test", "token"), connectionLayer({
      connectRemote: () => {
        probeReads += 1
        return Effect.promise(async () => { started.start(); return await response.promise })
      },
      status: () => { statusReads += 1; return Effect.succeed(success(connected())) },
      target: () => { targetReads += 1; return Effect.succeed(success(remoteTarget)) }
    })))
    await started.started
    expect(viewStore.getState()).toMatchObject({ connection: connected(), remote_probe_status: "loading" })
    await expect(Effect.runPromise(Effect.provide(connectRemote("https://duplicate.test", "token"), connectionLayer()))).resolves.toBe(false)
    await Effect.runPromise(handleConnectionStatusChanged({ state: "blocked", instance_id: instanceId, epoch: null, reason: "current broadcast" }))
    response.resolve(success(candidate))
    await expect(pending).resolves.toBe(true)
    expect(statusReads).toBe(0)
    expect(targetReads).toBe(0)
    expect(probeReads).toBe(1)
    expect(viewStore.getState()).toMatchObject({
      connection: { state: "blocked", reason: "current broadcast" },
      pending_remote_connection: candidate,
      remote_probe_status: "idle"
    })
  })

  it("ignores a remote probe error after target invalidation", async () => {
    const response = deferred<ReturnType<typeof failure>>()
    const started = markStarted()
    ready()
    const pending = Effect.runPromise(Effect.provide(connectRemote("https://candidate.test", "token"), connectionLayer({
      connectRemote: () => Effect.promise(async () => { started.start(); return await response.promise })
    })))
    await started.started
    viewStore.resetConnectionTarget(nextTarget)
    viewStore.set({ outcome: { kind: "error", message: "new target result" } })
    response.resolve(failure())
    await expect(pending).resolves.toBe(false)
    expect(viewStore.getState()).toMatchObject({
      connection_target: nextTarget,
      remote_probe_status: "idle",
      outcome: { kind: "error", message: "new target result" },
      pending_remote_connection: null
    })
  })

  it("restores the authoritative status after current confirmation failure", async () => {
    ready()
    viewStore.set({ pending_remote_connection: candidate })
    let statusReads = 0
    const result = await Effect.runPromise(Effect.provide(confirmRemote, connectionLayer({
      confirmRemote: () => Effect.succeed(failure("confirmation failed")),
      status: () => { statusReads += 1; return Effect.succeed(success(connected())) }
    })))
    expect(result).toBe(false)
    expect(statusReads).toBe(1)
    expect(viewStore.getState()).toMatchObject({
      connection: connected(),
      connection_target: remoteTarget,
      pending_remote_connection: null,
      outcome: { kind: "error", message: "confirmation failed" }
    })
  })

  it("does not publish a confirmation failure after invalidation while reading status", async () => {
    const statusResponse = deferred<ReturnType<typeof success<ConnectionStatusView>>>()
    const started = markStarted()
    ready()
    viewStore.set({ pending_remote_connection: candidate })
    const pending = Effect.runPromise(Effect.provide(confirmRemote, connectionLayer({
      confirmRemote: () => Effect.succeed(failure("confirmation failed")),
      status: () => Effect.promise(async () => { started.start(); return await statusResponse.promise })
    })))
    await started.started
    viewStore.resetConnectionTarget(nextTarget)
    viewStore.set({ connection: { state: "disconnected", instance_id: null, epoch: null, reason: null }, outcome: null })
    statusResponse.resolve(success(connected()))
    await expect(pending).resolves.toBe(false)
    expect(viewStore.getState()).toMatchObject({ connection_target: nextTarget, connection: { state: "disconnected" }, outcome: null })
  })

  it("does not read or navigate a newly selected library after workspace target changes", async () => {
    const targetResult = deferred<ReturnType<typeof success<ConnectionTargetView>>>()
    const started = markStarted()
    let statusReads = 0
    let libraryReads = 0
    ready()
    const pending = Effect.runPromise(Effect.provide(loadConnectionWorkspace, workspaceLayers({
      target: () => Effect.promise(async () => { started.start(); return await targetResult.promise }),
      status: () => { statusReads += 1; return Effect.succeed(success(connected())) }
    }, {
      search: () => { libraryReads += 1; return Effect.succeed(success({ entries: [], has_more: false, next_cursor: null, library_change_revision: "1" })) }
    })))
    await started.started
    viewStore.resetConnectionTarget(nextTarget)
    viewStore.set({ screen: "setup" })
    targetResult.resolve(success(remoteTarget))
    await pending
    expect(statusReads).toBe(0)
    expect(libraryReads).toBe(0)
    expect(viewStore.getState()).toMatchObject({ connection_target: nextTarget, screen: "setup", library_entries: [] })
  })

  it("loads one current workspace and navigates after a confirmed connection", async () => {
    const searchInputs: Array<{ readonly state?: "replacement-pending" }> = []
    const layers = workspaceLayers({}, {
      search: (input: { readonly state?: "replacement-pending" }) => {
        searchInputs.push(input)
        return Effect.succeed(success({ entries: [], has_more: false, next_cursor: null, library_change_revision: "1" }))
      }
    })
    ready()
    viewStore.set({ pending_remote_connection: candidate })
    await expect(Effect.runPromise(Effect.provide(confirmRemote, layers))).resolves.toBe(true)
    expect(searchInputs).toHaveLength(2)
    expect(viewStore.getState()).toMatchObject({ screen: "library", connection: connected(), connection_target: remoteTarget })
  })

  it.each([
    ["managed connection", useManagedConnection, "useManaged"],
    ["normal reconnect", reconnectNormal, "reconnect"]
  ] as const)("does not load or navigate a new workspace after %s goes stale", async (_label, workflow, method) => {
    const targetResponse = deferred<ReturnType<typeof success<ConnectionTargetView>>>()
    const started = markStarted()
    let libraryReads = 0
    ready()
    const pending = Effect.runPromise(Effect.provide(workflow, workspaceLayers({
      [method]: () => Effect.succeed(success(connected())),
      target: () => Effect.promise(async () => { started.start(); return await targetResponse.promise })
    }, {
      search: () => { libraryReads += 1; return Effect.succeed(success({ entries: [], has_more: false, next_cursor: null, library_change_revision: "1" })) }
    })))
    await started.started
    viewStore.resetConnectionTarget(nextTarget)
    viewStore.set({ screen: "setup" })
    targetResponse.resolve(success(remoteTarget))
    await pending
    expect(libraryReads).toBe(0)
    expect(viewStore.getState()).toMatchObject({ connection_target: nextTarget, screen: "setup", library_entries: [] })
  })

  it("preserves current managed status when the transition fails without a status broadcast", async () => {
    ready()
    const blocked: ConnectionStatusView = { state: "blocked", instance_id: instanceId, epoch: null, reason: "service unavailable" }
    await expect(Effect.runPromise(Effect.provide(useManagedConnection, connectionLayer({
      useManaged: () => Effect.succeed(failure("managed service could not start")),
      status: () => Effect.succeed(success(blocked))
    })))).resolves.toBe(false)
    expect(viewStore.getState()).toMatchObject({
      connection: blocked,
      outcome: { kind: "error", message: "managed service could not start" }
    })
  })

  it("ignores a stale cancellation result without clearing a newer candidate", async () => {
    const response = deferred<ReturnType<typeof success<ConnectionStatusView>>>()
    const started = markStarted()
    ready()
    viewStore.set({ pending_remote_connection: candidate })
    const pending = Effect.runPromise(Effect.provide(cancelRemote, connectionLayer({
      cancelRemote: () => Effect.promise(async () => { started.start(); return await response.promise })
    })))
    await started.started
    viewStore.resetConnectionTarget(nextTarget)
    const nextCandidate = { ...candidate, candidate_id: "99999999-9999-4999-8999-999999999999", instance_id: otherInstanceId }
    viewStore.set({ pending_remote_connection: nextCandidate })
    response.resolve(success({ state: "disconnected", instance_id: instanceId, epoch, reason: null }))
    await pending
    expect(viewStore.getState().pending_remote_connection).toEqual(nextCandidate)
  })

  it("ignores a held-discovery error after a target switch without refreshing the new server", async () => {
    const response = deferred<ReturnType<typeof failure>>()
    const started = markStarted()
    let rootReads = 0
    let scanReads = 0
    ready()
    viewStore.set({ staged_discoveries: [staged], scan_release_candidate_id: candidateId, scan_release_root_id: rootId })
    const pending = Effect.runPromise(Effect.provide(releaseHeldDiscovery(candidateId), Layer.mergeAll(
      scanLayer({ release: () => Effect.promise(async () => { started.start(); return await response.promise }) , listTasks: () => { scanReads += 1; return Effect.succeed(success([])) } }),
      rootLayer({ list: () => { rootReads += 1; return Effect.succeed(success([root])) } })
    )))
    await started.started
    viewStore.resetConnectionTarget(nextTarget)
    viewStore.set({ scan_release_status: "idle", scan_release_error: null })
    response.resolve(failure("old conflict"))
    await pending
    expect(rootReads).toBe(0)
    expect(scanReads).toBe(0)
    expect(viewStore.getState()).toMatchObject({ scan_release_status: "idle", scan_release_error: null, staged_discoveries: [] })
  })

  it("does not reload or publish a replacement resolved by the retired server", async () => {
    const response = deferred<ReturnType<typeof success<{ candidate: StagedDiscovery }>>>()
    const started = markStarted()
    let taskReads = 0
    let libraryReads = 0
    ready()
    viewStore.set({ staged_discoveries: [staged], pending_replacement_entries: [replacementEntry] })
    const pending = Effect.runPromise(Effect.provide(resolveReplacement(candidateId, entryId, "keep"), Layer.mergeAll(
      scanLayer({
        resolve: () => Effect.promise(async () => { started.start(); return await response.promise }),
        listTasks: () => { taskReads += 1; return Effect.succeed(success([])) }
      }),
      libraryLayer({ search: () => { libraryReads += 1; return Effect.succeed(success({ entries: [], has_more: false, next_cursor: null, library_change_revision: "1" })) } })
    )))
    await started.started
    viewStore.resetConnectionTarget(nextTarget)
    viewStore.set({ scan_resolution_status: "idle", scan_resolution_error: null })
    response.resolve(success({ candidate: { ...staged, candidate_version: 2 } as StagedDiscovery }))
    await pending
    expect(taskReads).toBe(0)
    expect(libraryReads).toBe(0)
    expect(viewStore.getState()).toMatchObject({ scan_resolution_status: "idle", scan_resolution_error: null, staged_discoveries: [] })
  })

  it("does not surface a retired server's detach result or reload its library", async () => {
    const response = deferred<ReturnType<typeof success<{ operation_id: string; entry: LibraryEntryDetails }>>>()
    const started = markStarted()
    let libraryReads = 0
    const missingEntry = { ...entryDetails, availability: { status: "missing" } } as LibraryEntry
    ready()
    const pending = Effect.runPromise(Effect.provide(detachMissingEntry(missingEntry), libraryLayer({
      command: () => Effect.promise(async () => { started.start(); return await response.promise }),
      search: () => { libraryReads += 1; return Effect.succeed(success({ entries: [], has_more: false, next_cursor: null, library_change_revision: "1" })) }
    })))
    await started.started
    viewStore.resetConnectionTarget(nextTarget)
    viewStore.set({ library_command_status: "idle", library_command_error: null })
    response.resolve(success({ operation_id: "old-op", entry: entryDetails }))
    await pending
    expect(libraryReads).toBe(0)
    expect(viewStore.getState()).toMatchObject({ library_command_status: "idle", library_command_error: null, library_entries: [] })
  })

  it("fences detail reads and note writes that return for an identical entry id on a new target", async () => {
    const detailResponse = deferred<ReturnType<typeof success<LibraryEntryDetails>>>()
    const detailStarted = markStarted()
    ready()
    viewStore.set({ library_selected_entry_id: entryId, library_entry_status: "loading" })
    const detailPending = Effect.runPromise(Effect.provide(loadLibraryEntry(entryId), libraryLayer({
      entry: () => Effect.promise(async () => { detailStarted.start(); return await detailResponse.promise })
    })))
    await detailStarted.started
    viewStore.resetConnectionTarget(nextTarget)
    viewStore.set({ library_selected_entry_id: entryId, library_entry: null, library_entry_status: "loading", library_entry_error: null })
    detailResponse.resolve(success(entryDetails))
    await detailPending
    expect(viewStore.getState()).toMatchObject({ library_entry: null, library_entry_status: "loading", library_entry_error: null })

    const noteResponse = deferred<ReturnType<typeof failure>>()
    const noteStarted = markStarted()
    viewStore.set({
      connection_generation: 20,
      library_selected_entry_id: entryId,
      library_entry: entryDetails,
      library_note_status: "loading",
      library_note_error: null
    })
    const notePending = Effect.runPromise(Effect.provide(updateLibraryNote("new text"), libraryLayer({
      note: () => Effect.promise(async () => { noteStarted.start(); return await noteResponse.promise })
    })))
    await noteStarted.started
    viewStore.resetConnectionTarget(nextTarget)
    viewStore.set({
      connection_generation: 21,
      library_selected_entry_id: entryId,
      library_entry: entryDetails,
      library_note_status: "idle",
      library_note_error: null
    })
    noteResponse.resolve(failure("old note error"))
    await notePending
    expect(viewStore.getState()).toMatchObject({ library_note_status: "idle", library_note_error: null })
  })

  it("does not publish a retired journal command failure", async () => {
    const response = deferred<ReturnType<typeof failure>>()
    const started = markStarted()
    ready()
    const pending = Effect.runPromise(Effect.provide(dismissUnknownOpenJournal({ instanceId, actionId: "old-action" }), journalLayer({
      recover: () => Effect.promise(async () => { started.start(); return await response.promise })
    })))
    await started.started
    viewStore.resetConnectionTarget(nextTarget)
    viewStore.set({ open_journal_error: null })
    response.resolve(failure("old journal error"))
    await pending
    expect(viewStore.getState()).toMatchObject({ open_journal_error: null, open_journal: [] })
  })

  it("does not reload the current journal for a retired journal command success", async () => {
    const response = deferred<ReturnType<typeof success<null>>>()
    const started = markStarted()
    let listReads = 0
    ready()
    const pending = Effect.runPromise(Effect.provide(dismissUnknownOpenJournal({ instanceId, actionId: "old-action" }), journalLayer({
      recover: () => Effect.promise(async () => { started.start(); return await response.promise }),
      list: () => { listReads += 1; return Effect.succeed(success([])) }
    })))
    await started.started
    viewStore.resetConnectionTarget(nextTarget)
    const currentJournal = []
    const currentError = "current journal state"
    viewStore.set({ open_journal: currentJournal, open_journal_error: currentError })
    response.resolve(success(null))
    await pending
    expect(listReads).toBe(0)
    expect(viewStore.getState()).toMatchObject({ open_journal: currentJournal, open_journal_error: currentError })
  })

  it("does not apply a retired local mapping activation to a new workspace", async () => {
    const response = deferred<ReturnType<typeof success<DeviceRootMapping>>>()
    const started = markStarted()
    const oldMapping = { root_id: rootId, selected_local_path: "/old", canonical_local_path: "/old" } as DeviceRootMapping
    const newMapping = { root_id: rootId, selected_local_path: "/new", canonical_local_path: "/new" } as DeviceRootMapping
    ready()
    viewStore.set({
      local_mapping_preview: { root_id: rootId, selected_local_path: "/old", canonical_local_path: "/old", samples: [], sample_limit: 32, sample_truncated: false, local_budget_exhausted: false },
      local_mapping_preview_token: "old-preview",
      local_mapping_status: "ready",
      local_mapping_list_status: "ready",
      local_mappings: []
    })
    const pending = Effect.runPromise(Effect.provide(activateLocalMapping(rootId), localLayer({
      activate: () => Effect.promise(async () => { started.start(); return await response.promise })
    })))
    await started.started
    viewStore.resetConnectionTarget(nextTarget)
    viewStore.set({ local_mappings: [newMapping] })
    response.resolve(success(oldMapping))
    await pending
    expect(viewStore.getState().local_mappings).toEqual([newMapping])
  })

  it("does not publish a retired root-policy command into an identically keyed new root", async () => {
    const response = deferred<ReturnType<typeof success<ServerRoot>>>()
    const started = markStarted()
    const newRoot = { ...root, label: "New server root", policy_revision: "2" } as ServerRoot
    ready()
    const pending = Effect.runPromise(Effect.provide(excludeRootPath({
      rootId,
      path: "ignored",
      scope: "exact",
      expectedPolicyRevision: "1"
    }), rootLayer({
      command: () => Effect.promise(async () => { started.start(); return await response.promise })
    })))
    await started.started
    viewStore.resetConnectionTarget(nextTarget)
    viewStore.set({ root_saved_roots: [newRoot], root_policy_status: "idle", root_policy_error: null })
    response.resolve(success(root))
    await pending
    expect(viewStore.getState()).toMatchObject({ root_saved_roots: [newRoot], root_policy_status: "idle", root_policy_error: null })
  })

  it("resets retired library command state and view while preserving local reader profiles", () => {
    const profile = { profile_id: "profile", name: "Local reader" } as ReaderProfile
    ready()
    viewStore.set({
      library_view: "detached",
      library_command_status: "loading",
      library_command_error: "old command",
      reader_profiles: [profile]
    })
    viewStore.resetConnectionTarget(nextTarget)
    expect(viewStore.getState()).toMatchObject({
      library_view: "normal",
      library_command_status: "idle",
      library_command_error: null,
      reader_profiles: [profile]
    })
  })
})
