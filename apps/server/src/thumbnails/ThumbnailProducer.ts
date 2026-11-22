import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Context, Effect, Fiber, Layer, Option, Result, Schema, Stream } from "effect"
import { NodeServices } from "@effect/platform-node"
import {
  analyzeSourceManifest,
  DEFAULT_MANIFEST_LIMITS,
  readArchivePages,
  recheckSourceObservation,
  type SourceObservation
} from "../analysis/SourceManifestAnalysis"
import {
  revalidateSourceRoot,
  resolveSourceCandidate,
  resolveSourcePage
} from "../analysis/NativeSourceBoundary"
import { ScanManifest, ThumbnailKey } from "@henshin/contracts"
import { LibraryStore } from "../persistence/LibraryStore"
import { RootStore } from "../persistence/RootStore"
import { ThumbnailCache, ThumbnailCacheError, THUMBNAIL_MAX_BYTES } from "./ThumbnailCache"

export const THUMBNAIL_RENDERING_PROFILE = "default-cover-v1" as const
const MAX_SOURCE_PAGE_BYTES = 16 * 1024 * 1024
const RENDER_DEADLINE_MS = 3_000
const RENDER_REQUEST_DEADLINE_MS = 10_000
const MAX_DECODE_ATTEMPTS = 8
const MAX_CONCURRENT_RENDERS = 4
const FAILED_RENDER_TTL_MS = 30_000
const MAX_FAILED_RENDER_KEYS = 128

const verificationLimits = DEFAULT_MANIFEST_LIMITS

class ThumbnailSourceError extends Schema.TaggedError<ThumbnailSourceError>()(
  "ThumbnailSourceError",
  { message: Schema.String }
) {}

export class ThumbnailRenderError extends Schema.TaggedError<ThumbnailRenderError>()(
  "ThumbnailRenderError",
  { message: Schema.String }
) {}

export type ThumbnailLoad =
  | { readonly kind: "ready"; readonly bytes: Uint8Array }
  | { readonly kind: "missing" }
  | { readonly kind: "updating" }

const decodeManifest = Schema.decodeUnknownOption(ScanManifest)
const decodeKey = Schema.decodeUnknownOption(ThumbnailKey)

const parseKey = (input: string): { readonly entryId: string; readonly contentVersion: string } | null => {
  const key = decodeKey(input)
  if (Option.isNone(key)) return null
  const parts = key.value.split(".")
  if (parts.length !== 3 || parts[0] !== "default-v1") return null
  return { entryId: parts[1] as string, contentVersion: parts[2] as string }
}

const observationIdentity = (observation: {
  readonly kind: "directory" | "archive"
  readonly bytes: number
  readonly mtimeMs: number
  readonly entryCount: number
  readonly observationToken?: string
}) => ({
  kind: observation.kind,
  bytes: observation.bytes,
  mtime_ms: observation.mtimeMs,
  entry_count: observation.entryCount,
  observation_token: observation.observationToken
})

const normalizeObservation = (
  observation: typeof ScanManifest.Type["before"] | SourceObservation
): Parameters<typeof observationIdentity>[0] => "mtime_ms" in observation
  ? {
      kind: observation.kind,
      bytes: observation.bytes,
      mtimeMs: observation.mtime_ms,
      entryCount: observation.entry_count,
      observationToken: observation.observation_token
    }
  : observation

const manifestIdentity = (
  manifest: typeof ScanManifest.Type | {
    readonly sourceKind: "archive" | "directory"
    readonly pages: ReadonlyArray<{ readonly name: string; readonly format: string; readonly declaredBytes: number }>
    readonly before: SourceObservation
    readonly after: SourceObservation
  }
): string => JSON.stringify({
  source_kind: "source_kind" in manifest ? manifest.source_kind : manifest.sourceKind,
  pages: manifest.pages.map((page) => "declared_bytes" in page
    ? page
    : { name: page.name, format: page.format, declared_bytes: page.declaredBytes }),
  before: normalizeObservation(manifest.before),
  after: normalizeObservation(manifest.after)
})

const hasObservationEvidence = (manifest: typeof ScanManifest.Type): boolean =>
  typeof manifest.before.observation_token === "string" &&
  manifest.before.observation_token.length > 0 &&
  typeof manifest.after.observation_token === "string" &&
  manifest.after.observation_token.length > 0

const sameObservation = (
  left: Parameters<typeof observationIdentity>[0],
  right: Parameters<typeof observationIdentity>[0]
): boolean => JSON.stringify(observationIdentity(left)) === JSON.stringify(observationIdentity(right))

const sameStats = (
  left: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint; readonly mtimeNs: bigint },
  right: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint; readonly mtimeNs: bigint }
): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs

const readDirectPage = async (path: string): Promise<Uint8Array> => {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const file = await open(path, constants.O_RDONLY | noFollow)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(MAX_SOURCE_PAGE_BYTES)) throw new Error("source page exceeds limit")
    const output = new Uint8Array(Number(before.size))
    let offset = 0
    while (offset < output.byteLength) {
      const result = await file.read(output, offset, output.byteLength - offset, offset)
      if (result.bytesRead === 0) throw new Error("source page ended early")
      offset += result.bytesRead
    }
    const after = await file.stat({ bigint: true })
    if (!sameStats(before, after)) throw new Error("source page changed")
    return output
  } finally {
    await file.close().catch(() => undefined)
  }
}

interface OutputState {
  readonly chunks: ReadonlyArray<Uint8Array>
  readonly total: number
}

const collectBounded = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<Uint8Array, unknown> =>
  stream.pipe(
    Stream.runFoldEffect<OutputState, Uint8Array, ThumbnailRenderError, never>(
      () => ({ chunks: [] as ReadonlyArray<Uint8Array>, total: 0 }),
      (state, chunk) => {
        const total = state.total + chunk.byteLength
        if (total > THUMBNAIL_MAX_BYTES) return Effect.fail(new ThumbnailRenderError({ message: "decoder output exceeds limit" }))
        return Effect.succeed({ chunks: [...state.chunks, chunk], total })
      }
    ),
    Effect.map((state) => {
      const output = new Uint8Array(state.total)
      let offset = 0
      for (const chunk of state.chunks) {
        output.set(chunk, offset)
        offset += chunk.byteLength
      }
      return output
    })
  )

export class ThumbnailProducer extends Context.Service<ThumbnailProducer, {
  readonly load: (key: string) => Effect.Effect<ThumbnailLoad, ThumbnailRenderError | ThumbnailCacheError>
}>()("henshin/server/ThumbnailProducer") {
  static readonly layer: Layer.Layer<
    ThumbnailProducer,
    never,
    LibraryStore | RootStore | ThumbnailCache | ChildProcessSpawner.ChildProcessSpawner
  > = Layer.effect(
    ThumbnailProducer,
    Effect.gen(function*() {
      const library = yield* LibraryStore
      const roots = yield* RootStore
      const cache = yield* ThumbnailCache
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const decoderPath = fileURLToPath(new URL("./thumbnail-decoder.mjs", import.meta.url))
      const inFlight = new Set<string>()
      const failedUntil = new Map<string, number>()

      const decode = (input: Uint8Array): Effect.Effect<Uint8Array | null, ThumbnailRenderError> =>
        Effect.scoped(
          Effect.gen(function*() {
            const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [decoderPath])).pipe(
              Effect.mapError(() => new ThumbnailRenderError({ message: "thumbnail decoder could not start" }))
            )
            const outputFiber = yield* Effect.forkChild(
              collectBounded(handle.stdout).pipe(
                Effect.mapError(() => new ThumbnailRenderError({ message: "thumbnail decoder output failed" }))
              )
            )
            yield* Stream.fromIterable([input]).pipe(
              Stream.run(handle.stdin),
              Effect.mapError(() => new ThumbnailRenderError({ message: "thumbnail decoder input failed" }))
            )
            const output = yield* Fiber.join(outputFiber)
            const exitCode = yield* handle.exitCode.pipe(
              Effect.mapError(() => new ThumbnailRenderError({ message: "thumbnail decoder exit status unavailable" }))
            )
            if (exitCode !== ChildProcessSpawner.ExitCode(0) || output.byteLength === 0) return null
            return output
          }).pipe(Effect.timeoutOrElse({
            duration: RENDER_DEADLINE_MS,
            orElse: () => Effect.fail(new ThumbnailRenderError({ message: "thumbnail decoder timed out" }))
          }))
        )

      const render = Effect.fnUntraced(function*(key: string): Effect.fn.Return<Uint8Array | null, ThumbnailRenderError | ThumbnailCacheError> {
        const parsed = parseKey(key)
        if (parsed === null) return null
        const accepted = yield* library.acceptedThumbnailEntry(parsed.entryId).pipe(
          Effect.mapError(() => new ThumbnailRenderError({ message: "accepted thumbnail entry is unavailable" }))
        )
        if (accepted === null || accepted.content_version !== parsed.contentVersion) return null

        const persistedManifest = yield* Effect.sync(() => {
          try {
            return JSON.parse(accepted.manifest_json) as unknown
          } catch {
            return undefined
          }
        })
        if (persistedManifest === undefined) return null
        const decoded = decodeManifest(persistedManifest)
        if (Option.isNone(decoded) || decoded.value.pages.length === 0) return null
        const acceptedManifest = decoded.value
        if (!hasObservationEvidence(acceptedManifest)) return null
        if (
          (accepted.kind === "archive" && acceptedManifest.source_kind !== "archive") ||
          (accepted.kind === "image-directory" && acceptedManifest.source_kind !== "directory")
        ) return null

        const root = (yield* roots.list().pipe(
          Effect.mapError(() => new ThumbnailRenderError({ message: "accepted thumbnail root is unavailable" }))
        )).find((candidate) => candidate.rootId === accepted.root_id)
        if (root === undefined) return null
        const rootObservation = {
          selectedPath: root.selectedPath,
          canonicalPath: root.canonicalPath,
          identity: { device: root.device, inode: root.inode }
        }
        const currentRoot = yield* Effect.promise(() => revalidateSourceRoot(rootObservation))
        if (!currentRoot.ok) return null
        const candidate = yield* Effect.promise(() => resolveSourceCandidate(currentRoot.value, accepted.relative_path))
        if (!candidate.ok || candidate.value.kind !== accepted.kind) return null

        const freshResult = yield* Effect.result(analyzeSourceManifest({
          sourcePath: candidate.value.nativePath,
          limits: verificationLimits
        }))
        if (Result.isFailure(freshResult)) return null
        if (manifestIdentity(freshResult.success) !== manifestIdentity(acceptedManifest)) return null
        const cached = yield* cache.read(key)
        if (cached !== null) return cached

        const readPage = (page: typeof acceptedManifest.pages[number]): Effect.Effect<Uint8Array, ThumbnailSourceError> =>
          accepted.kind === "archive"
            ? Effect.fail(new ThumbnailSourceError({ message: "archive pages are read in one pass" }))
            : Effect.promise(() => resolveSourcePage(candidate.value, page.name)).pipe(
                Effect.flatMap((resolved) => resolved.ok
                  ? Effect.tryPromise({
                      try: () => readDirectPage(resolved.value.nativePath),
                      catch: () => new ThumbnailSourceError({ message: "accepted image page is unavailable" })
                    })
                  : Effect.fail(new ThumbnailSourceError({ message: "accepted image page is unavailable" })))
              )

        const candidatePages = acceptedManifest.pages.slice(0, MAX_DECODE_ATTEMPTS)
        let archivePages: ReadonlyMap<string, Uint8Array> = new Map()
        let archiveAfter = freshResult.success.after
        if (accepted.kind === "archive") {
          const archiveRead = yield* Effect.result(Effect.tryPromise({
            try: () => readArchivePages(candidate.value.nativePath, candidatePages.map((page) => page.name), {
              limits: verificationLimits,
              maxPageBytes: MAX_SOURCE_PAGE_BYTES
            }),
            catch: () => new ThumbnailSourceError({ message: "accepted archive pages are unavailable" })
          }))
          if (Result.isFailure(archiveRead)) return null
          archivePages = archiveRead.success.pages
          archiveAfter = archiveRead.success.after
        }
        let rendered: Uint8Array | null = null
        for (const page of candidatePages) {
          let input: Uint8Array | undefined
          if (accepted.kind === "archive") {
            input = archivePages.get(page.name)
          } else {
            const pageResult = yield* Effect.result(readPage(page))
            if (Result.isSuccess(pageResult)) input = pageResult.success
          }
          if (input === undefined) continue
          const output = yield* decode(input)
          if (output !== null) {
            rendered = output
            break
          }
        }
        if (rendered === null) return null

        if (accepted.kind === "image-directory") {
          const afterResult = yield* Effect.result(Effect.tryPromise({
            try: () => recheckSourceObservation(
              candidate.value.nativePath,
              "directory",
              freshResult.success.after.entryCount,
              verificationLimits
            ),
            catch: () => new ThumbnailSourceError({ message: "accepted image directory changed" })
          }))
          if (Result.isFailure(afterResult) || !sameObservation(afterResult.success, freshResult.success.after)) return null
        } else if (!sameObservation(archiveAfter, freshResult.success.after)) {
          return null
        }

        const afterRoot = yield* Effect.promise(() => revalidateSourceRoot(rootObservation))
        if (!afterRoot.ok) return null
        const afterCandidate = yield* Effect.promise(() => resolveSourceCandidate(afterRoot.value, accepted.relative_path))
        if (!afterCandidate.ok || afterCandidate.value.kind !== accepted.kind) return null

        yield* cache.publish(key, rendered)
        return rendered
      })

      const load = (key: string): Effect.Effect<ThumbnailLoad, ThumbnailRenderError | ThumbnailCacheError> =>
        Effect.suspend(() => {
          if (inFlight.has(key) || inFlight.size >= MAX_CONCURRENT_RENDERS) {
            return Effect.succeed({ kind: "updating" } as ThumbnailLoad)
          }
          const failedExpiry = failedUntil.get(key)
          if (failedExpiry !== undefined) {
            if (failedExpiry > Date.now()) return Effect.succeed({ kind: "missing" } as ThumbnailLoad)
            failedUntil.delete(key)
          }
          inFlight.add(key)
          return render(key).pipe(
            Effect.timeoutOrElse({
              duration: RENDER_REQUEST_DEADLINE_MS,
              orElse: () => Effect.fail(new ThumbnailRenderError({ message: "thumbnail render timed out" }))
            }),
            Effect.map((bytes) => {
              if (bytes !== null) return { kind: "ready", bytes } as const
              failedUntil.set(key, Date.now() + FAILED_RENDER_TTL_MS)
              while (failedUntil.size > MAX_FAILED_RENDER_KEYS) {
                const oldest = failedUntil.keys().next().value
                if (oldest === undefined) break
                failedUntil.delete(oldest)
              }
              return { kind: "missing" } as const
            }),
            Effect.ensuring(Effect.sync(() => inFlight.delete(key)))
          )
        })

      return ThumbnailProducer.of({ load })
    })
  ).pipe(Layer.provide(NodeServices.layer))
}
