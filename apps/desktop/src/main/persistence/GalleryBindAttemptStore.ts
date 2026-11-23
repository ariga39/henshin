import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { LocalDatabaseWorker, LocalDatabaseWorkerError } from "./LocalDatabaseWorker"
import {
  GalleryBindAttemptMutation,
  GalleryBindAttemptPreparation,
  GalleryBindAttemptRow,
  GalleryBindAttemptRows,
  type DraftWorkerRequest
} from "./draft-worker-protocol"

export interface GalleryBindAttemptInput {
  readonly instanceId: string
  readonly operationId: string
  readonly entryId: string
  readonly url: string
  readonly expectedDecisionVersion: string
  readonly epoch: string
}

export class GalleryBindAttemptConflictError extends Data.TaggedError("GalleryBindAttemptConflictError")<{}> {}
export class GalleryBindAttemptStoreFullError extends Data.TaggedError("GalleryBindAttemptStoreFullError")<{}> {}
export class GalleryBindAttemptNotFoundError extends Data.TaggedError("GalleryBindAttemptNotFoundError")<{}> {}

const decodePreparation = Schema.decodeUnknownOption(GalleryBindAttemptPreparation)
const decodeMutation = Schema.decodeUnknownOption(GalleryBindAttemptMutation)
const decodeRows = Schema.decodeUnknownOption(GalleryBindAttemptRows)

export class GalleryBindAttemptStore extends Context.Service<
  GalleryBindAttemptStore,
  {
    readonly prepare: (
      input: GalleryBindAttemptInput
    ) => Effect.Effect<
      { readonly prepared: boolean; readonly attempt: GalleryBindAttemptRow },
      LocalDatabaseWorkerError | GalleryBindAttemptConflictError | GalleryBindAttemptStoreFullError
    >
    readonly markSubmitted: (
      key: Pick<GalleryBindAttemptInput, "instanceId" | "operationId"> & Pick<GalleryBindAttemptInput, "epoch">
    ) => Effect.Effect<GalleryBindAttemptRow, LocalDatabaseWorkerError | GalleryBindAttemptNotFoundError>
    readonly markUnresolved: (
      key: Pick<GalleryBindAttemptInput, "instanceId" | "operationId">
    ) => Effect.Effect<GalleryBindAttemptRow, LocalDatabaseWorkerError | GalleryBindAttemptNotFoundError>
    readonly markCompleted: (
      key: Pick<GalleryBindAttemptInput, "instanceId" | "operationId">
    ) => Effect.Effect<GalleryBindAttemptRow, LocalDatabaseWorkerError | GalleryBindAttemptNotFoundError>
    readonly markRejected: (
      key: Pick<GalleryBindAttemptInput, "instanceId" | "operationId">
    ) => Effect.Effect<GalleryBindAttemptRow, LocalDatabaseWorkerError | GalleryBindAttemptNotFoundError>
    readonly listPending: (instanceId: string) => Effect.Effect<ReadonlyArray<GalleryBindAttemptRow>, LocalDatabaseWorkerError>
  }
>()("henshin/desktop/GalleryBindAttemptStore") {
  static readonly layerFromWorker: Layer.Layer<GalleryBindAttemptStore, never, LocalDatabaseWorker> = Layer.effect(
    GalleryBindAttemptStore,
    Effect.gen(function*() {
      const worker = yield* LocalDatabaseWorker
      const call = (request: DraftWorkerRequest): Effect.Effect<unknown, LocalDatabaseWorkerError> => worker.call(request)

      const prepare = (input: GalleryBindAttemptInput): Effect.Effect<
        { readonly prepared: boolean; readonly attempt: GalleryBindAttemptRow },
        LocalDatabaseWorkerError | GalleryBindAttemptConflictError | GalleryBindAttemptStoreFullError
      > => call({ op: "prepareGalleryBind", ...input }).pipe(
        Effect.flatMap((value): Effect.Effect<
          { readonly prepared: boolean; readonly attempt: GalleryBindAttemptRow },
          LocalDatabaseWorkerError | GalleryBindAttemptConflictError | GalleryBindAttemptStoreFullError
        > => {
          const decoded = decodePreparation(value)
          if (Option.isNone(decoded)) return Effect.fail(new LocalDatabaseWorkerError({ message: "invalid gallery bind preparation result" }))
          switch (decoded.value.kind) {
            case "prepared":
              return Effect.succeed({ prepared: true, attempt: decoded.value.attempt })
            case "existing":
              return Effect.succeed({ prepared: false, attempt: decoded.value.attempt })
            case "conflict":
              return Effect.fail(new GalleryBindAttemptConflictError())
            case "full":
              return Effect.fail(new GalleryBindAttemptStoreFullError())
          }
        })
      )

      const mutation = (
        request: DraftWorkerRequest,
        operation: string
      ): Effect.Effect<GalleryBindAttemptRow, LocalDatabaseWorkerError | GalleryBindAttemptNotFoundError> =>
        call(request).pipe(
          Effect.flatMap((value): Effect.Effect<
            GalleryBindAttemptRow,
            LocalDatabaseWorkerError | GalleryBindAttemptNotFoundError
          > => {
            const decoded = decodeMutation(value)
            if (Option.isNone(decoded)) return Effect.fail(new LocalDatabaseWorkerError({ message: `invalid ${operation} result` }))
            return decoded.value.kind === "not_found"
              ? Effect.fail(new GalleryBindAttemptNotFoundError())
              : Effect.succeed(decoded.value.attempt)
          })
        )

      const markSubmitted = (key: Pick<GalleryBindAttemptInput, "instanceId" | "operationId" | "epoch">) =>
        mutation({ op: "markGalleryBindSubmitted", ...key }, "gallery bind submitted")
      const markUnresolved = (key: Pick<GalleryBindAttemptInput, "instanceId" | "operationId">) =>
        mutation({ op: "markGalleryBindUnresolved", ...key }, "gallery bind unresolved")
      const markCompleted = (key: Pick<GalleryBindAttemptInput, "instanceId" | "operationId">) =>
        mutation({ op: "markGalleryBindCompleted", ...key }, "gallery bind completed")
      const markRejected = (key: Pick<GalleryBindAttemptInput, "instanceId" | "operationId">) =>
        mutation({ op: "markGalleryBindRejected", ...key }, "gallery bind rejected")

      const listPending = (instanceId: string): Effect.Effect<ReadonlyArray<GalleryBindAttemptRow>, LocalDatabaseWorkerError> => call({ op: "listPendingGalleryBinds", instanceId }).pipe(
        Effect.flatMap((value): Effect.Effect<ReadonlyArray<GalleryBindAttemptRow>, LocalDatabaseWorkerError> => {
          const decoded = decodeRows(value)
          return Option.isNone(decoded)
            ? Effect.fail(new LocalDatabaseWorkerError({ message: "invalid pending gallery bind list" }))
            : Effect.succeed(decoded.value)
        })
      )

      return GalleryBindAttemptStore.of({ prepare, markSubmitted, markUnresolved, markCompleted, markRejected, listPending })
    })
  )
}
