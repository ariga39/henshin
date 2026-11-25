import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { RootPreviewResult, ScanTask, ServerRoot } from "@henshin/contracts"
import { LibraryClient, RootPreviewClient, ScanReviewClient } from "../src/renderer/client"
import { startManualScan } from "../src/renderer/workflows"
import { viewStore } from "../src/renderer/store"

const instanceId = "11111111-1111-4111-8111-111111111111"
const rootId = "22222222-2222-4222-8222-222222222222"
const taskId = "33333333-3333-4333-8333-333333333333"

const root = {
  root_id: rootId,
  library_id: "44444444-4444-4444-8444-444444444444",
  label: "Books",
  selected_server_path: "/books",
  canonical_server_path: "/books",
  mapping_revision: "1",
  policy_revision: "1",
  exclusions: [],
  state: "active"
} as ServerRoot

const preview = {
  kind: "saved-root-discovery",
  root_id: rootId,
  selected_server_path: "/books",
  instance_id: instanceId,
  epoch: "55555555-5555-4555-8555-555555555555",
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
  task_id: taskId,
  root_id: rootId,
  kind: "manual-scan",
  mode: "manual",
  hold_new_discoveries: false,
  mapping_revision: "1",
  status: "running"
} as ScanTask

const layerFor = (
  listTasks: ScanReviewClient["Service"]["listTasks"],
  search: LibraryClient["Service"]["search"],
  command: RootPreviewClient["Service"]["command"] = () => Effect.succeed({ ok: true as const, data: { task } })
) => Layer.mergeAll(
  Layer.succeed(RootPreviewClient, RootPreviewClient.of({
    preview: () => Effect.succeed({ ok: true as const, data: preview }),
    list: () => Effect.succeed({ ok: true as const, data: [root] }),
    save: () => Effect.fail(new Error("unused")),
    command
  })),
  Layer.succeed(ScanReviewClient, ScanReviewClient.of({
    listTasks,
    candidates: () => Effect.succeed({ ok: true as const, data: [] }),
    release: () => Effect.fail(new Error("unused")),
    resolve: () => Effect.fail(new Error("unused"))
  })),
  Layer.succeed(LibraryClient, LibraryClient.of({
    search,
    entry: () => Effect.fail(new Error("unused")),
    note: () => Effect.fail(new Error("unused")),
    open: () => Effect.fail(new Error("unused")),
    status: () => Effect.succeed({ ok: true as const, data: null }),
    getThumbnail: () => Effect.succeed({ ok: true as const, data: new Uint8Array() })
  }))
)

const readyView = (holdNewDiscoveries: boolean) => {
  viewStore.set({
    connection_generation: 7,
    connection: { state: "connected", instance_id: instanceId, epoch: preview.epoch, reason: null },
    connection_target: { mode: "remote", base_url: "https://library.example.test", instance_id: instanceId },
    root_saved_roots: [root],
    root_preview: preview,
    root_preview_status: "ready",
    scan_hold_new_discoveries: holdNewDiscoveries,
    scan_start_status: "idle",
    scan_start_error: null,
    scan_status: "ready",
    scan_error: null,
    scan_tasks: [],
    library_entries: []
  })
}

afterEach(() => {
  viewStore.set({
    connection_generation: 0,
    connection: { state: "disconnected", instance_id: null, epoch: null, reason: null },
    root_saved_roots: [],
    root_preview: null,
    root_preview_status: "idle",
    scan_hold_new_discoveries: false,
    scan_start_status: "idle",
    scan_start_error: null,
    scan_status: "idle",
    scan_error: null,
    scan_tasks: [],
    library_entries: []
  })
})

describe("connection-scoped manual scan workflow", () => {
  it.each([false, true])("ignores an old scan completion after the connection changes (hold=%s)", async (holdNewDiscoveries) => {
    let resolveTasks!: (result: { readonly ok: true; readonly data: ReadonlyArray<ScanTask> }) => void
    let markListStarted!: () => void
    const listStarted = new Promise<void>((resolve) => { markListStarted = resolve })
    const delayedTasks = new Promise<{ readonly ok: true; readonly data: ReadonlyArray<ScanTask> }>((resolve) => {
      resolveTasks = resolve
    })
    let libraryReads = 0
    readyView(holdNewDiscoveries)

    const pending = Effect.runPromise(Effect.provide(
      startManualScan(rootId),
      layerFor(
        () => Effect.promise(async () => {
          markListStarted()
          return await delayedTasks
        }),
        () => {
          libraryReads += 1
          return Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } })
        }
      )
    ))
    await listStarted

    viewStore.resetConnectionTarget({
      mode: "remote",
      base_url: "https://other.example.test",
      instance_id: "66666666-6666-4666-8666-666666666666"
    })
    viewStore.set({
      scan_start_status: "error",
      scan_start_error: "new connection marker",
      library_scan_status: "error",
      library_scan_error: "new connection marker",
      library_scan_task: null,
      library_entries: []
    })
    resolveTasks({ ok: true, data: [task] })
    await pending

    expect(libraryReads).toBe(0)
    expect(viewStore.getState()).toMatchObject({
      connection_generation: 8,
      scan_start_status: "error",
      scan_start_error: "new connection marker",
      library_scan_status: "error",
      library_scan_error: "new connection marker",
      library_scan_task: null
    })
  })

  it("ignores a manual scan command failure returned after the connection changes", async () => {
    let resolveCommand!: (result: { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } }) => void
    let markCommandStarted!: () => void
    const commandStarted = new Promise<void>((resolve) => { markCommandStarted = resolve })
    const delayedCommand = new Promise<{ readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } }>((resolve) => {
      resolveCommand = resolve
    })
    let libraryReads = 0
    readyView(false)

    const pending = Effect.runPromise(Effect.provide(
      startManualScan(rootId),
      layerFor(
        () => Effect.succeed({ ok: true as const, data: [] }),
        () => {
          libraryReads += 1
          return Effect.succeed({ ok: true as const, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } })
        },
        () => Effect.promise(async () => {
          markCommandStarted()
          return await delayedCommand
        })
      )
    ))
    await commandStarted

    viewStore.resetConnectionTarget({ mode: "remote", base_url: "https://other.example.test", instance_id: instanceId })
    viewStore.set({ scan_start_status: "error", scan_start_error: "new connection marker" })
    resolveCommand({ ok: false, error: { code: "revision_conflict", message: "old server failed", retryable: false } })
    await pending

    expect(libraryReads).toBe(0)
    expect(viewStore.getState()).toMatchObject({ scan_start_status: "error", scan_start_error: "new connection marker" })
  })

  it("stops the normal scan failure recovery if its library reload crosses a connection change", async () => {
    let resolveSearch!: (result: { readonly ok: true; readonly data: { readonly entries: []; readonly has_more: false; readonly next_cursor: null; readonly library_change_revision: string } }) => void
    let markSearchStarted!: () => void
    const searchStarted = new Promise<void>((resolve) => { markSearchStarted = resolve })
    const delayedSearch = new Promise<{ readonly ok: true; readonly data: { readonly entries: []; readonly has_more: false; readonly next_cursor: null; readonly library_change_revision: string } }>((resolve) => {
      resolveSearch = resolve
    })
    let searchCalls = 0
    readyView(false)

    const pending = Effect.runPromise(Effect.provide(
      startManualScan(rootId),
      layerFor(
        () => Effect.succeed({ ok: false as const, error: { code: "ipc_failed", message: "scan results unavailable", retryable: true } }),
        () => {
          searchCalls += 1
          markSearchStarted()
          return Effect.promise(async () => await delayedSearch)
        }
      )
    ))
    await searchStarted

    viewStore.resetConnectionTarget({ mode: "remote", base_url: "https://other.example.test", instance_id: instanceId })
    viewStore.set({
      scan_start_status: "error",
      scan_start_error: "new connection marker",
      library_scan_status: "error",
      library_scan_error: "new connection marker"
    })
    resolveSearch({ ok: true, data: { entries: [], has_more: false, next_cursor: null, library_change_revision: "1" } })
    await pending

    expect(searchCalls).toBe(1)
    expect(viewStore.getState()).toMatchObject({
      scan_start_status: "error",
      scan_start_error: "new connection marker",
      library_scan_status: "error",
      library_scan_error: "new connection marker"
    })
  })
})
