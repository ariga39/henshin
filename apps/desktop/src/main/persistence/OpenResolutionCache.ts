import { Context, Effect, Layer, Option, Schema } from "effect"
import type { EntryResolution } from "@henshin/contracts"
import { LocalDatabaseWorker, LocalDatabaseWorkerError } from "./LocalDatabaseWorker"
import {
  OpenResolutionCacheReadResult,
  type DraftWorkerRequest
} from "./draft-worker-protocol"

export interface CachedOpenResolution {
  readonly instanceId: string
  readonly entryId: string
  readonly epoch: string
  readonly resolution: EntryResolution
  readonly cachedAtMs: number
}

const decodeRead = Schema.decodeUnknownOption(OpenResolutionCacheReadResult)

export class OpenResolutionCache extends Context.Service<
  OpenResolutionCache,
  {
    readonly get: (input: {
      readonly instanceId: string
      readonly entryId: string
    }) => Effect.Effect<CachedOpenResolution | undefined, LocalDatabaseWorkerError>
    readonly save: (input: {
      readonly instanceId: string
      readonly entryId: string
      readonly epoch: string
      readonly resolution: EntryResolution
    }) => Effect.Effect<CachedOpenResolution, LocalDatabaseWorkerError>
  }
>()("henshin/desktop/OpenResolutionCache") {
  static readonly layerFromWorker: Layer.Layer<OpenResolutionCache, never, LocalDatabaseWorker> = Layer.effect(
    OpenResolutionCache,
    Effect.gen(function*() {
      const worker = yield* LocalDatabaseWorker
      const call = (request: DraftWorkerRequest): Effect.Effect<unknown, LocalDatabaseWorkerError> => worker.call(request)

      const read = (value: unknown): Effect.Effect<CachedOpenResolution | undefined, LocalDatabaseWorkerError> => {
        const decoded = decodeRead(value)
        if (Option.isNone(decoded)) return Effect.fail(new LocalDatabaseWorkerError({ message: "invalid open resolution cache read" }))
        return Effect.succeed(decoded.value === null ? undefined : decoded.value)
      }

      const get = (input: { readonly instanceId: string; readonly entryId: string }) =>
        call({ op: "getOpenResolution", ...input }).pipe(Effect.flatMap(read))

      const save = (input: {
        readonly instanceId: string
        readonly entryId: string
        readonly epoch: string
        readonly resolution: EntryResolution
      }) =>
        call({ op: "saveOpenResolution", ...input }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeRead(value)
            return Option.isNone(decoded) || decoded.value === null
              ? Effect.fail(new LocalDatabaseWorkerError({ message: "invalid open resolution cache write" }))
              : Effect.succeed(decoded.value)
          })
        )

      return OpenResolutionCache.of({ get, save })
    })
  )

  static readonly layer = (dbPath: string, workerUrl: URL): Layer.Layer<OpenResolutionCache> =>
    OpenResolutionCache.layerFromWorker.pipe(
      Layer.provide(LocalDatabaseWorker.layer(dbPath, { workerUrl }))
    )
}
