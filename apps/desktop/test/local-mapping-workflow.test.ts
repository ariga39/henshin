import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type {
  DeviceRootMapping,
  LocalMappingPreview,
  LocalMappingPreviewIpcResult,
  PublicError
} from "@henshin/contracts"
import { LocalMappingClient, type Result } from "../src/renderer/client"
import {
  activateLocalMapping,
  loadLocalMappings,
  previewLocalMapping
} from "../src/renderer/workflows"
import { viewStore } from "../src/renderer/store"

const rootId = "44444444-4444-4444-8444-444444444444"

const preview = (selectedPath: string): LocalMappingPreview => ({
  root_id: rootId,
  selected_local_path: selectedPath,
  canonical_local_path: selectedPath,
  samples: [{
    relative_path: "book.cbz",
    indexed_kind: "archive",
    indexed_format_evidence: ["cbz"],
    indexed_size_bytes: 4,
    status: "found",
    collision_kind: null,
    local_kind: "archive",
    local_format_evidence: ["cbz"],
    local_size_bytes: 4,
    local_evidence_status: "complete",
    local_error: null
  }],
  sample_limit: 32,
  sample_truncated: false,
  local_budget_exhausted: false
})

const mapping = (selectedPath: string, mappingRevision: string): DeviceRootMapping => ({
  root_id: rootId,
  selected_local_path: selectedPath,
  canonical_local_path: selectedPath,
  mapping_revision: mappingRevision,
  state: "active"
})

const resultError = (message: string, code = "transport"): Result<never> => ({
  ok: false,
  error: { code, message, retryable: true } satisfies PublicError
})

const run = <A>(effect: Effect.Effect<A, unknown, LocalMappingClient>, client: LocalMappingClient["Service"]) =>
  Effect.runPromise(Effect.provide(effect, Layer.succeed(LocalMappingClient, client)))

const resetView = () => {
  viewStore.set({
    local_mapping_root_id: null,
    local_mapping_status: "idle",
    local_mapping_preview: null,
    local_mapping_preview_token: null,
    local_mapping_error: null,
    local_mapping_list_status: "idle",
    local_mapping_list_error: null,
    local_mapping_activation_status: "idle",
    local_mapping_activation_error: null,
    local_mappings: []
  })
}

afterEach(resetView)

describe("local mapping renderer workflow", () => {
  it("disables confirmation during a second check and clears the old preview after failure", async () => {
    let previewCalls = 0
    let activateCalls = 0
    let resolveSecond!: (value: Result<LocalMappingPreviewIpcResult>) => void
    const second = new Promise<Result<LocalMappingPreviewIpcResult>>((resolve) => { resolveSecond = resolve })
    const client = LocalMappingClient.of({
      preview: () => {
        previewCalls += 1
        return previewCalls === 1
          ? Effect.succeed({ ok: true as const, data: { preview: preview("/books/a"), preview_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } })
          : Effect.promise(() => second)
      },
      list: () => Effect.succeed({ ok: true as const, data: [] }),
      activate: () => {
        activateCalls += 1
        return Effect.succeed({ ok: true as const, data: mapping("/books/a", "1") })
      }
    })
    viewStore.set({ local_mapping_list_status: "ready" })

    await run(previewLocalMapping(rootId), client)
    const pending = run(previewLocalMapping(rootId), client)
    expect(viewStore.getState().local_mapping_status).toBe("loading")
    await run(activateLocalMapping(rootId), client)
    expect(activateCalls).toBe(0)

    resolveSecond(resultError("the selected local directory could not be inspected", "local_mapping_unavailable"))
    await pending
    expect(viewStore.getState()).toMatchObject({
      local_mapping_status: "error",
      local_mapping_preview: null,
      local_mapping_preview_token: null,
      local_mapping_error: "the selected local directory could not be inspected"
    })
  })

  it("keeps the last mapping when an old preview token is rejected after a newer preview", async () => {
    const calls: Array<{ readonly preview_token: string }> = []
    const client = LocalMappingClient.of({
      preview: (root) => Effect.succeed({
        ok: true as const,
        data: root === rootId
          ? { preview: preview("/books/new"), preview_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
          : null
      }),
      list: () => Effect.succeed({ ok: true as const, data: [mapping("/books/old", "3")] }),
      activate: (input) => {
        calls.push({ preview_token: input.preview_token })
        return Effect.succeed(resultError("the preview is stale", "local_mapping_stale"))
      }
    })
    viewStore.set({
      local_mapping_list_status: "ready",
      local_mappings: [mapping("/books/old", "3")]
    })
    await run(previewLocalMapping(rootId), client)
    await run(activateLocalMapping(rootId), client)

    expect(calls).toEqual([{ preview_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }])
    expect(viewStore.getState()).toMatchObject({
      local_mapping_activation_status: "error",
      local_mapping_activation_error: "the preview is stale",
      local_mappings: [mapping("/books/old", "3")]
    })
  })

  it("surfaces mapping-list failure, retries it, and never activates with revision zero", async () => {
    let listCalls = 0
    let activationInput: { readonly expected_mapping_revision: string } | undefined
    const client = LocalMappingClient.of({
      preview: () => Effect.succeed({
        ok: true as const,
        data: { preview: preview("/books/new"), preview_token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }
      }),
      list: () => {
        listCalls += 1
        return listCalls === 1
          ? Effect.succeed(resultError("mapping worker unavailable"))
          : Effect.succeed({ ok: true as const, data: [mapping("/books/old", "7")] })
      },
      activate: (input) => {
        activationInput = input
        return Effect.succeed({ ok: true as const, data: mapping("/books/new", "8") })
      }
    })

    expect(await run(loadLocalMappings, client)).toBe(false)
    expect(viewStore.getState()).toMatchObject({
      local_mapping_list_status: "error",
      local_mapping_list_error: "mapping worker unavailable"
    })
    await run(previewLocalMapping(rootId), client)
    await run(activateLocalMapping(rootId), client)
    expect(activationInput?.expected_mapping_revision).toBe("7")
    expect(viewStore.getState().local_mapping_list_status).toBe("ready")
  })
})
