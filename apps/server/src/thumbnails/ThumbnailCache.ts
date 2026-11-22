import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Schema, Context } from "effect"

export const THUMBNAIL_MAX_BYTES = 512 * 1024
export const THUMBNAIL_CACHE_CAPACITY = 64
export const THUMBNAIL_CACHE_MAX_BYTES = 32 * 1024 * 1024

export class ThumbnailCacheError extends Schema.TaggedError<ThumbnailCacheError>()(
  "ThumbnailCacheError",
  { message: Schema.String }
) {}

const cacheFilename = (key: string): string =>
  `${createHash("sha256").update(key, "utf8").digest("hex")}.webp`

interface CacheFile {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

const listFiles = async (directory: string): Promise<ReadonlyArray<CacheFile>> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: Array<CacheFile> = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".webp")) continue
    const path = join(directory, entry.name)
    try {
      const info = await stat(path)
      if (info.isFile()) files.push({ path, size: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // A concurrent eviction or failed publication is not a cache read error.
    }
  }
  return files
}

const reclaim = async (directory: string): Promise<void> => {
  const files = [...await listFiles(directory)].sort((left, right) => left.mtimeMs - right.mtimeMs)
  let total = files.reduce((sum, file) => sum + file.size, 0)
  while (files.length > THUMBNAIL_CACHE_CAPACITY || total > THUMBNAIL_CACHE_MAX_BYTES) {
    const oldest = files.shift()
    if (oldest === undefined) break
    try {
      await unlink(oldest.path)
      total -= oldest.size
    } catch {
      // A missing cache artifact is already evicted; a transient failure leaves
      // the bounded publication policy to the next cache operation.
    }
  }
}

export class ThumbnailCache extends Context.Service<ThumbnailCache, {
  readonly read: (key: string) => Effect.Effect<Uint8Array | null, ThumbnailCacheError>
  readonly publish: (key: string, bytes: Uint8Array) => Effect.Effect<void, ThumbnailCacheError>
}>()("henshin/server/ThumbnailCache") {
  static readonly layer = (directory: string): Layer.Layer<ThumbnailCache> => Layer.effect(
    ThumbnailCache,
    Effect.gen(function*() {
      const available = yield* Effect.tryPromise({
        try: () => mkdir(directory, { recursive: true }),
        catch: () => new ThumbnailCacheError({ message: "thumbnail cache is unavailable" })
      }).pipe(
        Effect.as(true),
        Effect.catchTag("ThumbnailCacheError", () =>
          Effect.logWarning("thumbnail cache is unavailable; continuing without cache").pipe(Effect.as(false))
        )
      )

      let tail = Promise.resolve()
      const enqueue = <A>(work: () => Promise<A>): Promise<A> => {
        const result = tail.then(work, work)
        tail = result.then(() => undefined, () => undefined)
        return result
      }

      const read = (key: string) => available
        ? Effect.tryPromise({
            try: () => enqueue(async () => {
              const path = join(directory, cacheFilename(key))
              try {
                const info = await stat(path)
                if (!info.isFile() || info.size > THUMBNAIL_MAX_BYTES) {
                  await unlink(path)
                  return null
                }
                const bytes = new Uint8Array(await readFile(path))
                const now = new Date()
                await utimes(path, now, now)
                return bytes
              } catch (error) {
                if (isNotFound(error)) return null
                throw error
              }
            }),
            catch: () => new ThumbnailCacheError({ message: "thumbnail cache read failed" })
          })
        : Effect.succeed(null)

      const publish = (key: string, bytes: Uint8Array) => available
        ? Effect.tryPromise({
            try: () => enqueue(async () => {
              if (bytes.byteLength === 0 || bytes.byteLength > THUMBNAIL_MAX_BYTES) {
                throw new Error("thumbnail output exceeds the cache limit")
              }
              const temporary = join(directory, `.${randomUUID()}.tmp`)
              const target = join(directory, cacheFilename(key))
              try {
                await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
                await rename(temporary, target)
                await reclaim(directory)
              } finally {
                await unlink(temporary).catch(() => undefined)
              }
            }),
            catch: () => new ThumbnailCacheError({ message: "thumbnail cache publication failed" })
          })
        : Effect.void

      return ThumbnailCache.of({ read, publish })
    })
  )
}
