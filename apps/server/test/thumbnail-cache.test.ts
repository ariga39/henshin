import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { ThumbnailCache } from "../src/thumbnails/ThumbnailCache"

const directories: Array<string> = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe("thumbnail cache", () => {
  it("refreshes LRU recency when a cached cover is read", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "henshin-thumbnail-cache-"))
    directories.push(directory)

    await Effect.runPromise(Effect.gen(function*() {
      const cache = yield* ThumbnailCache
      yield* cache.publish("recent", new Uint8Array([1]))
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
      for (let index = 0; index < 63; index += 1) {
        yield* cache.publish(`other-${index}`, new Uint8Array([index + 2]))
      }
      expect(yield* cache.read("recent")).toEqual(new Uint8Array([1]))
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
      yield* cache.publish("overflow", new Uint8Array([99]))
      expect(yield* cache.read("recent")).toEqual(new Uint8Array([1]))
    }).pipe(Effect.provide(ThumbnailCache.layer(directory))))
  })

  it("continues without cache when the configured path is unavailable", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "henshin-thumbnail-cache-unavailable-"))
    directories.push(parent)
    const unavailable = path.join(parent, "thumbnail-cache")
    await writeFile(unavailable, new Uint8Array([1]))

    await Effect.runPromise(Effect.gen(function*() {
      const cache = yield* ThumbnailCache
      expect(yield* cache.read("missing")).toBeNull()
      yield* cache.publish("generated", new Uint8Array([2]))
    }).pipe(Effect.provide(ThumbnailCache.layer(unavailable))))

    await expect(readFile(unavailable)).resolves.toEqual(Buffer.from([1]))
  })
})
