import { Context, Effect, Layer, Option, Schema } from "effect"
import { LocalDatabaseWorker, LocalDatabaseWorkerError } from "./LocalDatabaseWorker"
import {
  LocalMappingActivationOutcome as LocalMappingActivationOutcomeSchema,
  LocalMappingReadResult,
  LocalMappingRows,
  type LocalMappingRow,
  type DraftWorkerRequest
} from "./draft-worker-protocol"

export type LocalMapping = LocalMappingRow

export interface LocalMappingKey {
  readonly instanceId: string
  readonly rootId: string
}

export interface LocalMappingActivationInput extends LocalMappingKey {
  readonly selectedPath: string
  readonly canonicalPath: string
  readonly expectedMappingRevision: string
  readonly protectedWritablePaths: ReadonlyArray<string>
  readonly activationDeadlineMs?: number
}

export type LocalMappingActivationOutcome =
  typeof LocalMappingActivationOutcomeSchema.Type

const decodeRead = Schema.decodeUnknownOption(LocalMappingReadResult)
const decodeRows = Schema.decodeUnknownOption(LocalMappingRows)
const decodeActivation = Schema.decodeUnknownOption(LocalMappingActivationOutcomeSchema)
const ACTIVATION_DEADLINE_GUARD_MS = 4_000

export class LocalMappingStore extends Context.Service<
  LocalMappingStore,
  {
    readonly load: (
      key: LocalMappingKey
    ) => Effect.Effect<LocalMapping | undefined, LocalDatabaseWorkerError>
    readonly list: (
      instanceId: string
    ) => Effect.Effect<ReadonlyArray<LocalMapping>, LocalDatabaseWorkerError>
    readonly activate: (
      input: LocalMappingActivationInput
    ) => Effect.Effect<LocalMappingActivationOutcome, LocalDatabaseWorkerError>
  }
>()("henshin/desktop/LocalMappingStore") {
  static readonly layerFromWorker: Layer.Layer<LocalMappingStore, never, LocalDatabaseWorker> = Layer.effect(
    LocalMappingStore,
    Effect.gen(function*() {
      const worker = yield* LocalDatabaseWorker
      const call = (request: DraftWorkerRequest): Effect.Effect<unknown, LocalDatabaseWorkerError> =>
        worker.call(request)

      const load = (key: LocalMappingKey): Effect.Effect<LocalMapping | undefined, LocalDatabaseWorkerError> =>
        call({ op: "loadLocalMapping", ...key }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeRead(value)
            if (Option.isNone(decoded)) {
              return Effect.fail(new LocalDatabaseWorkerError({ message: "invalid local mapping read result" }))
            }
            return Effect.succeed(decoded.value ?? undefined)
          })
        )

      const list = (instanceId: string): Effect.Effect<ReadonlyArray<LocalMapping>, LocalDatabaseWorkerError> =>
        call({ op: "listLocalMappings", instanceId }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeRows(value)
            return Option.isNone(decoded)
              ? Effect.fail(new LocalDatabaseWorkerError({ message: "invalid local mapping list result" }))
              : Effect.succeed(decoded.value)
          })
        )

      const activate = (
        input: LocalMappingActivationInput
      ): Effect.Effect<LocalMappingActivationOutcome, LocalDatabaseWorkerError> =>
        call({
          op: "activateLocalMapping",
          ...input,
          activationDeadlineMs: input.activationDeadlineMs ?? Date.now() + ACTIVATION_DEADLINE_GUARD_MS
        }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeActivation(value)
            return Option.isNone(decoded)
              ? Effect.fail(new LocalDatabaseWorkerError({ message: "invalid local mapping activation result" }))
              : Effect.succeed(decoded.value)
          })
        )

      return LocalMappingStore.of({ load, list, activate })
    })
  )

  static readonly layer = (dbPath: string, workerUrl: URL): Layer.Layer<LocalMappingStore> =>
    LocalMappingStore.layerFromWorker.pipe(
      Layer.provide(LocalDatabaseWorker.layer(dbPath, { workerUrl }))
    )
}
