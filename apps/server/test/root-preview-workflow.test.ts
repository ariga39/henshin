import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { RootCommandIpcRequest, RootPreview, RootPreviewRequest, RootPreviewResult, RootRegistrationRequest, ServerRoot, SavedRootPreview } from "@henshin/contracts"
import { RootPreviewClient, type Result } from "../../desktop/src/renderer/client"
import { excludeRootPath, previewRoot, refreshRootPolicy, removeRootExclusion, saveRoot } from "../../desktop/src/renderer/workflows"
import { viewStore } from "../../desktop/src/renderer/store"

const instanceId = "11111111-1111-4111-8111-111111111111"
const epoch = "22222222-2222-4222-8222-222222222222"
const preview: RootPreview = {
  selected_server_path: "/collections/a",
  instance_id: instanceId,
  epoch,
  preview_identity: {
    canonical_server_path: "/collections/a",
    device: "1",
    inode: "2"
  },
  outcome: "empty",
  children: [],
  sample_limit: 32
}
const savedRoot: ServerRoot = {
  library_id: "33333333-3333-4333-8333-333333333333",
  root_id: "44444444-4444-4444-8444-444444444444",
  label: "Books",
  selected_server_path: "/collections/a",
  canonical_server_path: "/collections/a",
  mapping_revision: "1",
  policy_revision: "0",
  exclusions: [],
  schedule_enabled: false,
  state: "active"
}

const savedDiscovery: Extract<RootPreviewResult, { kind: "saved-root-discovery" }> = {
  kind: "saved-root-discovery",
  root_id: savedRoot.root_id,
  selected_server_path: savedRoot.selected_server_path,
  instance_id: instanceId,
  epoch,
  policy_revision: "0",
  candidates: [
    { relative_path: "book.cbz", kind: "archive", direct_image_count: 0, unsupported_direct_image_count: 0 },
    { relative_path: "book-sibling", kind: "image-directory", direct_image_count: 1, unsupported_direct_image_count: 0 }
  ],
  sample_limit: 32,
  unassigned_loose_images: [],
  unassigned_loose_image_count: 0,
  unsupported_loose_images: [],
  unsupported_loose_image_count: 0,
  coverage: {
    status: "complete",
    directories_visited: 2,
    entries_observed: 2,
    candidate_count: 2,
    candidate_sample_truncated: false,
    excluded_links: [],
    excluded_link_count: 0,
    unsupported_names: [],
    unsupported_name_count: 0,
    unsupported_directories: [],
    unsupported_directory_count: 0,
    issues: [],
    issue_count: 0
  }
}

const savedPreview = (rootId: string): SavedRootPreview => ({
  kind: "saved-root-discovery",
  root_id: rootId,
  selected_server_path: `/collections/${rootId}`,
  instance_id: instanceId,
  epoch,
  policy_revision: "0",
  candidates: [],
  sample_limit: 32,
  unassigned_loose_images: [],
  unassigned_loose_image_count: 0,
  unsupported_loose_images: [],
  unsupported_loose_image_count: 0,
  coverage: {
    status: "complete",
    directories_visited: 1,
    entries_observed: 0,
    candidate_count: 0,
    candidate_sample_truncated: false,
    excluded_links: [],
    excluded_link_count: 0,
    unsupported_names: [],
    unsupported_name_count: 0,
    unsupported_directories: [],
    unsupported_directory_count: 0,
    issues: [],
    issue_count: 0
  }
})


const deferred = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const resetView = () => {
  viewStore.set({
    root_preview_path: "",
    root_preview_selected_path: null,
    root_preview_status: "idle",
    root_preview: null,
    root_preview_request: null,
    root_preview_error: null,
    root_label: "",
    root_saved_roots: [],
    root_roots_status: "idle",
    root_roots_error: null,
    root_save_status: "idle",
    root_save_error: null,
    root_save_operation_id: null,
    root_save_target_label: null,
    root_save_target_path: null,
    root_policy_status: "idle",
    root_policy_error: null
  })
}

afterEach(resetView)

describe("root confirmation workflow", () => {
  it("does not save a preview for A after the path is edited to B", async () => {
    let calls = 0
    const client = RootPreviewClient.of({
      preview: () => Effect.succeed({ ok: true, data: preview }),
      list: () => Effect.succeed({ ok: true, data: [] }),
      save: () => {
        calls += 1
        return Effect.succeed({ ok: true, data: savedRoot })
      },
      command: () => Effect.succeed({ ok: true, data: savedRoot })
    })
    viewStore.set({
      root_preview_path: "/collections/b",
      root_preview_selected_path: preview.selected_server_path,
      root_preview_status: "ready",
      root_preview: preview,
      root_label: "Books"
    })

    await Effect.runPromise(Effect.provide(saveRoot, Layer.succeed(RootPreviewClient, client)))

    expect(calls).toBe(0)
    expect(viewStore.getState().root_saved_roots).toEqual([])
  })

  it("replays a confirmation when its reply is lost and stops sending after success", async () => {
    const operations: string[] = []
    const client = RootPreviewClient.of({
      preview: () => Effect.succeed({ ok: true, data: preview }),
      list: () => Effect.succeed({ ok: true, data: [] }),
      save: (input) => {
        operations.push(input.operation_id)
        return operations.length === 1
          ? Effect.succeed({ ok: false, error: { code: "transport", message: "Reply lost", retryable: true } })
          : Effect.succeed({ ok: true, data: savedRoot })
      },
      command: () => Effect.succeed({ ok: true, data: savedRoot })
    })
    viewStore.set({
      root_preview: preview,
      root_preview_status: "ready",
      root_preview_path: preview.selected_server_path,
      root_label: savedRoot.label
    })
    const confirm = () => Effect.runPromise(Effect.provide(saveRoot, Layer.succeed(RootPreviewClient, client)))
    await confirm()
    expect(viewStore.getState().root_save_status).toBe("error")
    await confirm()
    await confirm()
    expect(operations).toEqual([expect.any(String), operations[0]])
    expect(viewStore.getState().root_saved_roots).toEqual([savedRoot])
  })

  it.each(["Books", "New label"])("recovers the stored root after a lost reply and fresh confirmation as %s", async (label) => {
    let listCalls = 0
    let stored: ServerRoot | undefined
    const offline = { ok: false, error: { code: "transport", message: "Reply lost", retryable: true } } as const
    const client = RootPreviewClient.of({
      preview: () => Effect.succeed({ ok: true, data: preview }),
      list: () => Effect.succeed(++listCalls === 1 || !stored ? offline : { ok: true, data: [stored] }),
      save: () => {
        if (stored) return Effect.succeed({ ok: false, error: { code: "overlap", message: "Root overlaps", retryable: false } })
        stored = savedRoot
        return Effect.succeed(offline)
      },
      command: () => Effect.succeed({ ok: true, data: savedRoot })
    })
    const layer = Layer.succeed(RootPreviewClient, client)
    const refresh = () => Effect.runPromise(Effect.provide(previewRoot({ path: preview.selected_server_path }), layer))
    const save = () => Effect.runPromise(Effect.provide(saveRoot, layer))
    await refresh()
    viewStore.set({ root_label: savedRoot.label })
    await save()
    expect(viewStore.getState().root_save_status).toBe("error")
    await refresh()
    viewStore.set({ root_label: label })
    await save()
    expect(viewStore.getState().root_saved_roots).toEqual([savedRoot])
    expect(viewStore.getState().root_save_status).toBe(label === savedRoot.label ? "ready" : "error")
    if (label !== savedRoot.label) expect(viewStore.getState().root_save_error).toContain("already saved as Books")
  })

  it("keeps an in-flight completion attached to the confirmed path", async () => {
    const pending = deferred<Result<ServerRoot>>()
    let request: RootRegistrationRequest | undefined
    const client = RootPreviewClient.of({
      preview: () => Effect.succeed({ ok: true, data: preview }),
      list: () => Effect.succeed({ ok: true, data: [] }),
      save: (input) => {
        request = input
        return Effect.promise(() => pending.promise)
      },
      command: () => Effect.succeed({ ok: true, data: savedRoot })
    })
    viewStore.set({
      root_preview_path: preview.selected_server_path,
      root_preview_selected_path: preview.selected_server_path,
      root_preview_status: "ready",
      root_preview: preview,
      root_label: "Books"
    })

    const saving = Effect.runPromise(Effect.provide(saveRoot, Layer.succeed(RootPreviewClient, client)))
    await Promise.resolve()
    viewStore.set({ root_preview_path: "/collections/b" })
    pending.resolve({ ok: true, data: savedRoot })
    await saving

    expect(request?.path).toBe("/collections/a")
    expect(viewStore.getState()).toMatchObject({
      root_preview_path: "/collections/b",
      root_preview_selected_path: "/collections/a",
      root_save_status: "ready",
      root_save_target_label: "Books",
      root_save_target_path: "/collections/a",
      root_saved_roots: [savedRoot]
    })
  })

  it("saves an exclusion from a saved discovery and refreshes the candidates", async () => {
    const excludedRoot: ServerRoot = {
      ...savedRoot,
      policy_revision: "1",
      exclusions: [{ path: "book.cbz", scope: "exact" }]
    }
    const refreshed: typeof savedDiscovery = {
      ...savedDiscovery,
      policy_revision: "1",
      candidates: [savedDiscovery.candidates[1]]
    }
    let previewCalls = 0
    let commandInput: RootCommandIpcRequest | undefined
    const client = RootPreviewClient.of({
      preview: () => {
        previewCalls += 1
        return Effect.succeed({ ok: true, data: refreshed })
      },
      list: () => Effect.succeed({ ok: true, data: [savedRoot] }),
      save: () => Effect.succeed({ ok: true, data: savedRoot }),
      command: (input) => {
        commandInput = input
        return Effect.succeed({ ok: true, data: excludedRoot })
      }
    })
    viewStore.set({
      root_preview_selected_path: savedDiscovery.selected_server_path,
      root_preview_status: "ready",
      root_preview: savedDiscovery,
      root_saved_roots: [savedRoot]
    })

    await Effect.runPromise(Effect.provide(
      excludeRootPath({ rootId: savedRoot.root_id, path: "book.cbz", scope: "exact", expectedPolicyRevision: "0" }),
      Layer.succeed(RootPreviewClient, client)
    ))

    expect(commandInput).toMatchObject({
      root_id: savedRoot.root_id,
      expected_policy_revision: "0",
      command: { type: "exclude", exclusion: { path: "book.cbz", scope: "exact" } }
    })
    expect(previewCalls).toBe(1)
    expect(viewStore.getState()).toMatchObject({
      root_saved_roots: [excludedRoot],
      root_preview: refreshed,
      root_policy_status: "idle"
    })
  })

  it("removes a saved exclusion and refreshes the candidate", async () => {
    const excludedRoot: ServerRoot = {
      ...savedRoot,
      policy_revision: "1",
      exclusions: [{ path: "book.cbz", scope: "exact" }]
    }
    const refreshed: typeof savedDiscovery = {
      ...savedDiscovery,
      policy_revision: "2"
    }
    let commandInput: RootCommandIpcRequest | undefined
    const client = RootPreviewClient.of({
      preview: () => Effect.succeed({ ok: true, data: refreshed }),
      list: () => Effect.succeed({ ok: true, data: [excludedRoot] }),
      save: () => Effect.succeed({ ok: true, data: savedRoot }),
      command: (input) => {
        commandInput = input
        return Effect.succeed({ ok: true, data: savedRoot })
      }
    })
    viewStore.set({
      root_preview_selected_path: savedDiscovery.selected_server_path,
      root_preview_status: "ready",
      root_preview: { ...savedDiscovery, policy_revision: "1", candidates: [savedDiscovery.candidates[1]] },
      root_saved_roots: [excludedRoot]
    })

    await Effect.runPromise(Effect.provide(
      removeRootExclusion({ rootId: savedRoot.root_id, path: "book.cbz", scope: "exact", expectedPolicyRevision: "1" }),
      Layer.succeed(RootPreviewClient, client)
    ))

    expect(commandInput).toMatchObject({
      expected_policy_revision: "1",
      command: { type: "remove-exclusion", exclusion: { path: "book.cbz", scope: "exact" } }
    })
    expect(viewStore.getState()).toMatchObject({
      root_saved_roots: [savedRoot],
      root_preview: refreshed,
      root_policy_status: "idle"
    })
  })

  it("fetches the clicked root context before removing a listed exclusion", async () => {
    const excludedRoot: ServerRoot = {
      ...savedRoot,
      policy_revision: "6",
      exclusions: [{ path: "book.cbz", scope: "exact" }]
    }
    const otherRoot = savedPreview("root-b")
    const fresh = { ...savedDiscovery, policy_revision: "7" }
    const previewRequests: RootPreviewRequest[] = []
    let commandInput: RootCommandIpcRequest | undefined
    let previewCount = 0
    const client = RootPreviewClient.of({
      preview: (input) => {
        previewRequests.push(input)
        previewCount += 1
        return Effect.succeed({ ok: true, data: fresh })
      },
      list: () => Effect.succeed({ ok: true, data: [excludedRoot] }),
      save: () => Effect.succeed({ ok: true, data: savedRoot }),
      command: (input) => {
        commandInput = input
        return Effect.succeed({
          ok: false,
          error: { code: "revision_conflict", message: "stale root policy revision", retryable: false, current_revision: "7" }
        })
      }
    })
    viewStore.set({
      root_preview_status: "ready",
      root_preview: otherRoot,
      root_saved_roots: [excludedRoot]
    })

    await Effect.runPromise(Effect.provide(
      removeRootExclusion({ rootId: savedRoot.root_id, path: "book.cbz", scope: "exact", expectedPolicyRevision: excludedRoot.policy_revision }),
      Layer.succeed(RootPreviewClient, client)
    ))

    expect(previewRequests).toEqual([
      { kind: "saved-root", root_id: savedRoot.root_id }
    ])
    expect(commandInput).toMatchObject({
      root_id: savedRoot.root_id,
      instance_id: fresh.instance_id,
      epoch: fresh.epoch,
      expected_policy_revision: "6",
      command: { type: "remove-exclusion", exclusion: { path: "book.cbz", scope: "exact" } }
    })
    expect(viewStore.getState()).toMatchObject({
      root_preview: otherRoot,
      root_saved_roots: [excludedRoot],
      root_policy_status: "error"
    })
  })

  it("refreshes the roots list after a policy conflict", async () => {
    const excludedRoot: ServerRoot = {
      ...savedRoot,
      policy_revision: "1",
      exclusions: [{ path: "book.cbz", scope: "exact" }]
    }
    const updatedRoot = { ...savedRoot, policy_revision: "2", exclusions: [] }
    const refreshed = { ...savedDiscovery, policy_revision: "2" }
    let listCalls = 0
    let previewCalls = 0
    const client = RootPreviewClient.of({
      preview: () => {
        previewCalls += 1
        return Effect.succeed({ ok: true, data: refreshed })
      },
      list: () => {
        listCalls += 1
        return Effect.succeed({ ok: true, data: [updatedRoot] })
      },
      save: () => Effect.succeed({ ok: true, data: savedRoot }),
      command: () => Effect.succeed({
        ok: false,
        error: { code: "revision_conflict", message: "stale root policy revision", retryable: false, current_revision: "2" }
      })
    })
    viewStore.set({
      root_preview_status: "idle",
      root_preview: null,
      root_preview_request: null,
      root_saved_roots: [excludedRoot]
    })

    await Effect.runPromise(Effect.provide(
      removeRootExclusion({ rootId: savedRoot.root_id, path: "book.cbz", scope: "exact", expectedPolicyRevision: "1" }),
      Layer.succeed(RootPreviewClient, client)
    ))
    expect(viewStore.getState().root_policy_status).toBe("error")

    await Effect.runPromise(Effect.provide(refreshRootPolicy, Layer.succeed(RootPreviewClient, client)))

    expect(previewCalls).toBe(1)
    expect(listCalls).toBe(1)
    expect(viewStore.getState()).toMatchObject({
      root_preview: null,
      root_saved_roots: [updatedRoot],
      root_policy_status: "idle"
    })
  })

  it("does not replace a newer selected preview when policy completion is delayed", async () => {
    const excludedRoot: ServerRoot = {
      ...savedRoot,
      policy_revision: "1",
      exclusions: [{ path: "book.cbz", scope: "exact" }]
    }
    const pending = deferred<Result<ServerRoot>>()
    const commandStarted = deferred<void>()
    const rootB = { ...savedRoot, root_id: "55555555-5555-4555-8555-555555555555", selected_server_path: "/collections/b", canonical_server_path: "/collections/b" }
    const previewRequests: RootPreviewRequest[] = []
    const client = RootPreviewClient.of({
      preview: (input) => {
        previewRequests.push(input)
        return Effect.succeed({ ok: true, data: savedPreview(rootB.root_id) })
      },
      list: () => Effect.succeed({ ok: true, data: [savedRoot, rootB] }),
      save: () => Effect.succeed({ ok: true, data: savedRoot }),
      command: () => {
        commandStarted.resolve()
        return Effect.promise(() => pending.promise)
      }
    })
    viewStore.set({
      root_preview_status: "ready",
      root_preview: { ...savedDiscovery, policy_revision: "1" },
      root_saved_roots: [excludedRoot, rootB]
    })

    const removing = Effect.runPromise(Effect.provide(
      removeRootExclusion({ rootId: savedRoot.root_id, path: "book.cbz", scope: "exact", expectedPolicyRevision: "1" }),
      Layer.succeed(RootPreviewClient, client)
    ))
    await commandStarted.promise
    const selectingB = Effect.runPromise(Effect.provide(
      previewRoot({ kind: "saved-root", root_id: rootB.root_id }),
      Layer.succeed(RootPreviewClient, client)
    ))
    await selectingB
    pending.resolve({ ok: true, data: savedRoot })
    await removing

    expect(previewRequests).toEqual([{ kind: "saved-root", root_id: rootB.root_id }])
    expect(viewStore.getState()).toMatchObject({
      root_preview: savedPreview(rootB.root_id),
      root_preview_request: { kind: "saved-root", root_id: rootB.root_id },
      root_saved_roots: [savedRoot, rootB]
    })
  })

  it("publishes only the latest saved-root preview response", async () => {
    const first = deferred<Result<RootPreviewResult>>()
    const second = deferred<Result<RootPreviewResult>>()
    const client = RootPreviewClient.of({
      preview: (input) => Effect.promise(() => "kind" in input && input.root_id === "root-a"
        ? first.promise
        : second.promise),
      list: () => Effect.succeed({ ok: true, data: [] }),
      save: () => Effect.succeed({ ok: true, data: savedRoot }),
      command: () => Effect.succeed({ ok: true, data: savedRoot })
    })
    const run = (input: RootPreviewRequest) =>
      Effect.runPromise(Effect.provide(previewRoot(input), Layer.succeed(RootPreviewClient, client)))
    const firstRun = run({ kind: "saved-root", root_id: "root-a" })
    await Promise.resolve()
    const secondRun = run({ kind: "saved-root", root_id: "root-b" })
    second.resolve({ ok: true, data: savedPreview("root-b") })
    await secondRun
    first.resolve({ ok: true, data: savedPreview("root-a") })
    await firstRun

    expect(viewStore.getState().root_preview).toEqual(savedPreview("root-b"))
    expect(viewStore.getState().root_preview_request).toEqual({ kind: "saved-root", root_id: "root-b" })
  })

  it("retries the full failed saved-root preview request", async () => {
    const requests: Array<{ kind: "saved-root"; root_id: string }> = []
    const request = { kind: "saved-root" as const, root_id: "root-a" }
    const client = RootPreviewClient.of({
      preview: (input) => {
        requests.push(input as typeof request)
        return requests.length === 1
          ? Effect.succeed({ ok: false, error: { code: "transport", message: "Reply lost", retryable: true } })
          : Effect.succeed({ ok: true, data: savedPreview(request.root_id) })
      },
      list: () => Effect.succeed({ ok: true, data: [] }),
      save: () => Effect.succeed({ ok: true, data: savedRoot }),
      command: () => Effect.succeed({ ok: true, data: savedRoot })
    })
    const run = (input: RootPreviewRequest) =>
      Effect.runPromise(Effect.provide(previewRoot(input), Layer.succeed(RootPreviewClient, client)))

    await run(request)
    expect(viewStore.getState().root_preview_status).toBe("error")
    const retry = viewStore.getState().root_preview_request
    expect(retry).toEqual(request)
    if (retry === null) throw new Error("expected a retained preview request")
    await run(retry)

    expect(requests).toEqual([request, request])
    expect(viewStore.getState().root_preview).toEqual(savedPreview(request.root_id))
  })
})
