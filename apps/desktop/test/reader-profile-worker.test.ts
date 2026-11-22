import { build } from "esbuild"
import { Effect, Layer, ManagedRuntime } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ReaderProfileStore, ReaderProfileConflictError } from "../src/main/persistence/ReaderProfileStore"
import { LocalDatabaseWorker } from "../src/main/persistence/LocalDatabaseWorker"
import { validateExecutablePath, validateReaderProfile } from "../src/main/reader-profile-validation"

const repoDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
let workerDirectory = ""
let workerUrl: URL
let runtime: ManagedRuntime.ManagedRuntime<ReaderProfileStore, never>
let databasePath = ""

const profileInput = {
  profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  expectedRevision: "0",
  name: "Development reader",
  launchMode: "explicit-executable" as const,
  supportedFormats: ["archive"] as const,
  targetMode: "archive" as const,
  executablePath: process.execPath,
  argumentTokens: ["--safe", "{target}"] as const
}

beforeAll(async () => {
  workerDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-reader-profile-worker-"))
  const workerPath = path.join(workerDirectory, "draft-worker.mjs")
  await build({
    entryPoints: [path.join(repoDirectory, "apps/desktop/src/main/persistence/draft-worker.ts")],
    outfile: workerPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent"
  })
  workerUrl = pathToFileURL(workerPath)
  databasePath = path.join(workerDirectory, "profiles.db")
  const localWorker = LocalDatabaseWorker.layer(databasePath, { workerUrl })
  runtime = ManagedRuntime.make(ReaderProfileStore.layerFromWorker.pipe(Layer.provide(localWorker)))
})

afterAll(async () => {
  await runtime.dispose()
  await rm(workerDirectory, { recursive: true, force: true })
})

describe("reader profile persistence", () => {
  it("round-trips profiles through the real local worker and rejects stale saves", async () => {
    const saved = await runtime.runPromise(Effect.gen(function*() {
      const store = yield* ReaderProfileStore
      return yield* store.save(profileInput)
    }))
    expect(saved).toMatchObject({
      profile_id: profileInput.profileId,
      revision: "1",
      name: profileInput.name,
      executablePath: process.execPath,
      argument_tokens: profileInput.argumentTokens
    })

    await expect(runtime.runPromise(Effect.gen(function*() {
      const store = yield* ReaderProfileStore
      return yield* store.save({ ...profileInput, name: "stale", expectedRevision: "0" })
    }))).rejects.toBeInstanceOf(ReaderProfileConflictError)

    const reopened = await runtime.runPromise(Effect.gen(function*() {
      const store = yield* ReaderProfileStore
      return yield* store.get(profileInput.profileId)
    }))
    expect(reopened).toMatchObject({ revision: "1", name: profileInput.name, argument_tokens: profileInput.argumentTokens })
  })
})

describe("reader profile validation", () => {
  it("rejects first-image profiles that also claim archive support", () => {
    expect(() => validateReaderProfile({
      name: "invalid",
      launch_mode: "system-association",
      supported_formats: ["archive", "image-directory"],
      target_mode: "first-image",
      argument_tokens: []
    }, null)).toThrow("only compatible with image-directory")
  })

  it("accepts a native executable and rejects a missing selection", async () => {
    await expect(validateExecutablePath(process.execPath)).resolves.toBeUndefined()
    await expect(validateExecutablePath(path.join(workerDirectory, "missing-reader"))).rejects.toThrow("unavailable")
  })
})
