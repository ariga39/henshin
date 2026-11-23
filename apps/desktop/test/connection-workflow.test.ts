import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { RootPreviewResult, ServerRoot } from "@henshin/contracts"
import { RootPreviewClient } from "../src/renderer/client"
import { handleRemoteCandidateInvalidated, saveRoot } from "../src/renderer/workflows"
import { viewStore } from "../src/renderer/store"

const instanceId = "11111111-1111-4111-8111-111111111111"
const epoch = "22222222-2222-4222-8222-222222222222"
const otherInstanceId = "33333333-3333-4333-8333-333333333333"
const rootId = "44444444-4444-4444-8444-444444444444"

const preview: RootPreviewResult = {
  selected_server_path: "/old-server/books",
  instance_id: instanceId,
  epoch,
  preview_identity: { canonical_server_path: "/old-server/books", device: "device", inode: "inode" },
  outcome: "selected",
  children: [{ name: "book", kind: "directory" }],
  sample_limit: 10
}

const savedRoot: ServerRoot = {
  library_id: "55555555-5555-4555-8555-555555555555",
  root_id: rootId,
  label: "Old server",
  selected_server_path: "/old-server/books",
  canonical_server_path: "/old-server/books",
  mapping_revision: "1",
  policy_revision: "1",
  exclusions: [],
  state: "active"
}

const run = (effect: Effect.Effect<unknown, unknown, RootPreviewClient>, client: RootPreviewClient["Service"]) =>
  Effect.runPromise(Effect.provide(effect, Layer.succeed(RootPreviewClient, client)))

afterEach(() => {
  viewStore.set({
    connection_generation: 0,
    connection: { state: "disconnected", instance_id: null, epoch: null, reason: null },
    root_preview: null,
    root_preview_status: "idle",
    root_preview_path: "",
    root_label: "",
    root_saved_roots: [],
    root_save_status: "idle",
    root_save_operation_id: null,
    root_save_error: null,
    root_save_target_label: null,
    root_save_target_path: null
  })
})

describe("connection-scoped root workflow", () => {
  it("clears only the pending candidate that was invalidated by another window", async () => {
    const candidate = { candidate_id: "candidate-current", base_url: "https://same.example.test", instance_id: instanceId }
    viewStore.set({ pending_remote_connection: candidate })

    await Effect.runPromise(handleRemoteCandidateInvalidated("candidate-retired"))
    expect(viewStore.getState().pending_remote_connection).toEqual(candidate)

    await Effect.runPromise(handleRemoteCandidateInvalidated(candidate.candidate_id))
    expect(viewStore.getState().pending_remote_connection).toBeNull()
  })

  it("does not apply a root save response after the connection target changes", async () => {
    let resolveSave!: (result: { readonly ok: true; readonly data: ServerRoot }) => void
    let markSaveStarted!: () => void
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve })
    const delayedSave = new Promise<{ readonly ok: true; readonly data: ServerRoot }>((resolve) => {
      resolveSave = resolve
    })
    const client = RootPreviewClient.of({
      preview: () => Effect.succeed({ ok: false as const, error: { code: "unused", message: "unused", retryable: false } }),
      list: () => Effect.succeed({ ok: true as const, data: [] }),
      save: () => Effect.promise(async () => {
        markSaveStarted()
        return await delayedSave
      }),
      command: () => Effect.succeed({ ok: false as const, error: { code: "unused", message: "unused", retryable: false } })
    })

    viewStore.set({
      connection_generation: 7,
      connection: { state: "connected", instance_id: instanceId, epoch, reason: null },
      root_preview: preview,
      root_preview_status: "ready",
      root_preview_path: preview.selected_server_path,
      root_label: "Old server",
      root_saved_roots: []
    })

    const pending = run(saveRoot, client)
    await saveStarted
    viewStore.resetConnectionTarget({ mode: "remote", base_url: "https://new.example.test", instance_id: otherInstanceId, saved: false })
    resolveSave({ ok: true, data: savedRoot })
    await pending

    expect(viewStore.getState().root_saved_roots).toEqual([])
    expect(viewStore.getState().root_save_status).toBe("idle")
    expect(viewStore.getState().root_save_target_label).toBeNull()
  })
})
