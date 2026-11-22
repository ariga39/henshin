import { Context, Effect, Layer, Option, Schema } from "effect"
import { OpenEvent, OpenEventBatchResult } from "@henshin/contracts/event"
import { DatabaseWorker, DatabaseWorkerError } from "./DatabaseWorker"
import { OpenEventBatchOutcome } from "./worker-protocol"

const decodeResult = Schema.decodeUnknownOption(OpenEventBatchOutcome)

export class OpenEventStore extends Context.Service<
  OpenEventStore,
  {
    readonly accept: (events: ReadonlyArray<typeof OpenEvent.Type>) =>
      Effect.Effect<typeof OpenEventBatchResult.Type, DatabaseWorkerError>
  }
>()("henshin/server/OpenEventStore") {
  static readonly layer: Layer.Layer<OpenEventStore, never, DatabaseWorker> = Layer.effect(
    OpenEventStore,
    Effect.gen(function*() {
      const worker = yield* DatabaseWorker
      const accept = (events: ReadonlyArray<typeof OpenEvent.Type>) => worker.call({
        op: "acceptOpenEvents",
        events
      }).pipe(
        Effect.flatMap((value) => {
          const decoded = decodeResult(value)
          return Option.isNone(decoded)
            ? Effect.fail(new DatabaseWorkerError({ message: "invalid open event batch result" }))
            : Effect.succeed(decoded.value)
        }),
        Effect.flatMap((value) => Effect.try({
          try: () => Schema.decodeUnknownSync(OpenEventBatchResult)(value),
          catch: () => new DatabaseWorkerError({ message: "invalid open event result" })
        }))
      )
      return OpenEventStore.of({ accept })
    })
  )
}
