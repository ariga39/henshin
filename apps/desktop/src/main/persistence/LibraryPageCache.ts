import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  LibraryPageCacheReadResult,
  LibraryPageCacheNamespaces,
  type DraftWorkerRequest,
  type LibraryPageCacheRow
} from "./draft-worker-protocol"
import { LocalDatabaseWorker, LocalDatabaseWorkerError } from "./LocalDatabaseWorker"

export interface CachedLibraryPage {
  readonly instanceId: string
  readonly epoch: string
  readonly pageSize: number
  readonly cursor: string | null
  readonly page: LibraryPageCacheRow["page"]
  readonly observedAtMs: number
}

const decode = Schema.decodeUnknownOption(LibraryPageCacheReadResult)

export class LibraryPageCache extends Context.Service<
  LibraryPageCache,
  {
    readonly get: (input: {
      readonly instanceId: string
      readonly pageSize: number
      readonly cursor: string | null
    }) => Effect.Effect<CachedLibraryPage | undefined, LocalDatabaseWorkerError>
    readonly save: (input: {
      readonly instanceId: string
      readonly epoch: string
      readonly pageSize: number
      readonly cursor: string | null
      readonly page: LibraryPageCacheRow["page"]
      readonly observedAtMs: number
    }) => Effect.Effect<CachedLibraryPage, LocalDatabaseWorkerError>
    readonly listNamespaces: () => Effect.Effect<ReadonlyArray<{
      readonly instanceId: string
      readonly epoch: string
      readonly lastObservedAtMs: number
    }>, LocalDatabaseWorkerError>
  }
>()("henshin/desktop/LibraryPageCache") {
  static readonly layerFromWorker: Layer.Layer<LibraryPageCache, never, LocalDatabaseWorker> = Layer.effect(
    LibraryPageCache,
    Effect.gen(function*() {
      const worker = yield* LocalDatabaseWorker
      const call = (request: DraftWorkerRequest) => worker.call(request)
      const toCached = (value: unknown): Effect.Effect<CachedLibraryPage | undefined, LocalDatabaseWorkerError> => {
        const decoded = decode(value)
        if (Option.isNone(decoded)) {
          return Effect.fail(new LocalDatabaseWorkerError({ message: "invalid library page cache read" }))
        }
        if (decoded.value === null) return Effect.succeed(undefined)
        const row = decoded.value
        return Effect.succeed({
          instanceId: row.instanceId,
          epoch: row.epoch,
          pageSize: row.pageSize,
          cursor: row.cursorKey === "" ? null : row.cursorKey,
          page: row.page,
          observedAtMs: row.observedAtMs
        })
      }

      const get = (input: { readonly instanceId: string; readonly pageSize: number; readonly cursor: string | null }) =>
        call({
          op: "getLibraryPage",
          instanceId: input.instanceId,
          pageSize: input.pageSize,
          cursorKey: input.cursor ?? ""
        }).pipe(Effect.flatMap(toCached))

      const save = (input: {
        readonly instanceId: string
        readonly epoch: string
        readonly pageSize: number
        readonly cursor: string | null
        readonly page: LibraryPageCacheRow["page"]
        readonly observedAtMs: number
      }) =>
        call({
          op: "saveLibraryPage",
          instanceId: input.instanceId,
          epoch: input.epoch,
          pageSize: input.pageSize,
          cursorKey: input.cursor ?? "",
          page: input.page,
          observedAtMs: input.observedAtMs
        }).pipe(
          Effect.flatMap(toCached),
          Effect.flatMap((value) => value === undefined
            ? Effect.fail(new LocalDatabaseWorkerError({ message: "saved library page was not readable" }))
            : Effect.succeed(value))
        )

      const listNamespaces = () => call({ op: "listLibraryNamespaces" }).pipe(
        Effect.flatMap((value) => {
          const decoded = Schema.decodeUnknownOption(LibraryPageCacheNamespaces)(value)
          return Option.isNone(decoded)
            ? Effect.fail(new LocalDatabaseWorkerError({ message: "invalid cached namespace read" }))
            : Effect.succeed(decoded.value)
        })
      )

      return LibraryPageCache.of({ get, save, listNamespaces })
    })
  )
}
