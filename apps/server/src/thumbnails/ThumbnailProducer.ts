import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Context, Effect, Fiber, Layer, Option, Result, Schema, Stream } from "effect"
import { NodeServices } from "@effect/platform-node"
import { analyzeSourceManifest, readArchivePage } from "../analysis/SourceManifestAnalysis"
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

const sourceLimits = {
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntryCount: 100_000,
  maxPageCount: 20_000,
  maxNameAndMetadataBytes: 32 * 1024 * 1024,
  maxCentralDirectoryBytes: 64 * 1024 * 1024,
  maxDeclaredUncompressedBytes: 2 * 1024 ** 3,
  maxMemberUncompressedBytes: MAX_SOURCE_PAGE_BYTES,
  deadlineMs: 1_500
} as const

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

const manifestIdentity = (
  manifest: typeof ScanManifest.Type | {
    readonly sourceKind: "archive" | "directory"
    readonly pages: ReadonlyArray<{ readonly name: string; readonly format: string; readonly declaredBytes: number }>
  }
): string => JSON.stringify({
  source_kind: "source_kind" in manifest ? manifest.source_kind : manifest.sourceKind,
  pages: manifest.pages.map((page) => "declared_bytes" in page
    ? page
    : { name: page.name, format: page.format, declared_bytes: page.declaredBytes })
})

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

      const decode = (input: Uint8Array): Effect.Effect<Uint8Array, ThumbnailRenderError> =>
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
            if (exitCode !== ChildProcessSpawner.ExitCode(0) || output.byteLength === 0) {
              return yield* new ThumbnailRenderError({ message: "thumbnail decoder failed" })
            }
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
          limits: sourceLimits
        }))
        if (Result.isFailure(freshResult)) return null
        if (manifestIdentity(freshResult.success) !== manifestIdentity(acceptedManifest)) return null
        const cached = yield* cache.read(key)
        if (cached !== null) return cached

        const readPage = (page: typeof acceptedManifest.pages[number]): Effect.Effect<Uint8Array, ThumbnailRenderError> =>
          accepted.kind === "archive"
            ? Effect.tryPromise({
                try: () => readArchivePage(candidate.value.nativePath, page.name, sourceLimits),
                catch: () => new ThumbnailRenderError({ message: "accepted archive page is unavailable" })
              })
            : Effect.promise(() => resolveSourcePage(candidate.value, page.name)).pipe(
                Effect.flatMap((resolved) => resolved.ok
                  ? Effect.tryPromise({
                      try: () => readDirectPage(resolved.value.nativePath),
                      catch: () => new ThumbnailRenderError({ message: "accepted image page is unavailable" })
                    })
                  : Effect.fail(new ThumbnailRenderError({ message: "accepted image page is unavailable" })))
              )

        let rendered: Uint8Array | null = null
        for (const page of acceptedManifest.pages) {
          if (page.declared_bytes > MAX_SOURCE_PAGE_BYTES) continue
          const input = yield* Effect.result(readPage(page))
          if (Result.isFailure(input)) continue
          const output = yield* Effect.result(decode(input.success))
          if (Result.isSuccess(output)) {
            rendered = output.success
            break
          }
        }
        if (rendered === null) return null

        const afterRoot = yield* Effect.promise(() => revalidateSourceRoot(rootObservation))
        if (!afterRoot.ok) return null
        const afterCandidate = yield* Effect.promise(() => resolveSourceCandidate(afterRoot.value, accepted.relative_path))
        if (!afterCandidate.ok || afterCandidate.value.kind !== accepted.kind) return null

        yield* cache.publish(key, rendered)
        return rendered
      })

      const load = (key: string): Effect.Effect<ThumbnailLoad, ThumbnailRenderError | ThumbnailCacheError> =>
        Effect.suspend(() => {
          if (inFlight.has(key)) return Effect.succeed({ kind: "updating" } as const)
          inFlight.add(key)
          return render(key).pipe(
            Effect.map((bytes) => bytes === null ? { kind: "missing" } as const : { kind: "ready", bytes } as const),
            Effect.catchTag("ThumbnailRenderError", () => Effect.succeed({ kind: "updating" } as const)),
            Effect.ensuring(Effect.sync(() => inFlight.delete(key)))
          )
        })

      return ThumbnailProducer.of({ load })
    })
  ).pipe(Layer.provide(NodeServices.layer))
}
