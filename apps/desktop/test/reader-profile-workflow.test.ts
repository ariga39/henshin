import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { ReaderProfile } from "@henshin/contracts"
import { ReaderProfileClient, type Result } from "../src/renderer/client"
import { loadReaderProfiles } from "../src/renderer/workflows"
import { viewStore } from "../src/renderer/store"

const profile: ReaderProfile = {
  profile_id: "11111111-1111-4111-8111-111111111111",
  revision: "1",
  name: "Test reader",
  launch_mode: "system-association",
  supported_formats: ["image-directory"],
  target_mode: "directory",
  executable_name: null,
  argument_tokens: []
}

const run = <A>(effect: Effect.Effect<A, unknown, ReaderProfileClient>, client: ReaderProfileClient["Service"]) =>
  Effect.runPromise(Effect.provide(effect, Layer.succeed(ReaderProfileClient, client)))

afterEach(() => {
  viewStore.set({
    reader_profiles: [],
    reader_profiles_status: "idle",
    reader_profiles_error: null
  })
})

describe("reader profile list workflow", () => {
  it("surfaces a list failure and supports an explicit retry", async () => {
    let calls = 0
    const client = ReaderProfileClient.of({
      list: () => {
        calls += 1
        return calls === 1
          ? Effect.succeed({ ok: false as const, error: { code: "ipc_failed", message: "profile store unavailable", retryable: true } })
          : Effect.succeed({ ok: true as const, data: [profile] })
      },
      selectExecutable: () => Effect.succeed({ ok: true as const, data: null }),
      save: () => Effect.succeed({ ok: true as const, data: profile }),
      selectTestTarget: () => Effect.succeed({ ok: true as const, data: null }),
      test: () => Effect.succeed({ ok: true as const, data: {
        handoff: "accepted" as const,
        launch_mode: "system-association" as const,
        resolved_target: "/books/test-reader",
        message: "accepted"
      } })
    })

    await run(loadReaderProfiles, client)
    expect(viewStore.getState()).toMatchObject({
      reader_profiles_status: "error",
      reader_profiles_error: "profile store unavailable",
      reader_profiles: []
    })

    await run(loadReaderProfiles, client)
    expect(viewStore.getState()).toMatchObject({
      reader_profiles_status: "ready",
      reader_profiles_error: null,
      reader_profiles: [profile]
    })
    expect(calls).toBe(2)
  })
})
