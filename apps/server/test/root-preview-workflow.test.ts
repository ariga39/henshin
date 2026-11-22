import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { RootPreview, RootRegistrationRequest, ServerRoot } from "@henshin/contracts"
import { RootPreviewClient, type Result } from "../../desktop/src/renderer/client"
import { saveRoot } from "../../desktop/src/renderer/workflows"
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
    root_save_operation_id: null,
    root_save_target_label: null,
    root_save_target_path: null
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
      }
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
      }
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

  it("keeps an in-flight completion attached to the confirmed path", async () => {
    const pending = deferred<Result<ServerRoot>>()
    let request: RootRegistrationRequest | undefined
    const client = RootPreviewClient.of({
      preview: () => Effect.succeed({ ok: true, data: preview }),
      list: () => Effect.succeed({ ok: true, data: [] }),
      save: (input) => {
        request = input
        return Effect.promise(() => pending.promise)
      }
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
})
