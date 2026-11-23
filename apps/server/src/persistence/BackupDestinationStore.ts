import { Context, Effect, Layer, Option, Schema } from "effect"
import { DatabaseWorker, DatabaseWorkerError } from "./DatabaseWorker"
import { BackupDestinationRow, type BackupDestinationRow as BackupDestinationRowType } from "./worker-protocol"

const decodeDestinations = Schema.decodeUnknownOption(Schema.Array(BackupDestinationRow))

/** Reads the administrator-confirmed writable boundaries used by root setup. */
export class BackupDestinationStore extends Context.Service<
  BackupDestinationStore,
  { readonly list: () => Effect.Effect<ReadonlyArray<BackupDestinationRowType>, DatabaseWorkerError> }
>()("henshin/server/BackupDestinationStore") {
  static readonly layer: Layer.Layer<BackupDestinationStore, never, DatabaseWorker> = Layer.effect(
    BackupDestinationStore,
    Effect.gen(function*() {
      const worker = yield* DatabaseWorker
      const list = () => worker.call({ op: "listBackupDestinations" }).pipe(
        Effect.flatMap((value) => {
          const decoded = decodeDestinations(value)
          return Option.isNone(decoded)
            ? Effect.fail(new DatabaseWorkerError({ message: "invalid list-backup-destinations result" }))
            : Effect.succeed(decoded.value)
        })
      )
      return BackupDestinationStore.of({ list })
    })
  )
}
