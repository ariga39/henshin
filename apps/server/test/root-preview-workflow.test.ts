import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { RootCommandIpcRequest, RootPreview, RootPreviewResult, RootRegistrationRequest, ServerRoot } from "@henshin/contracts"
import { RootPreviewClient, type Result } from "../../desktop/src/renderer/client"
import { excludeRootPath, removeRootExclusion, saveRoot } from "../../desktop/src/renderer/workflows"
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
    root_preview_error: null,
    root_label: "",
    root_saved_roots: [],
    root_roots_status: "idle",
    root_roots_error: null,
    root_save_status: "idle",
    root_save_error: null,
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
      excludeRootPath({ rootId: savedRoot.root_id, path: "book.cbz", scope: "exact" }),
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
      removeRootExclusion({ rootId: savedRoot.root_id, path: "book.cbz", scope: "exact" }),
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
})
