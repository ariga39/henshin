import { Context, Effect, Layer, Option, Schema } from "effect"
import { DatabaseWorker, DatabaseWorkerError } from "./DatabaseWorker"
import {
  RootRegistrationOutcome,
  RootReplayLookup,
  ServerRootRow,
  type RootRegistrationOutcome as RootRegistrationOutcomeType,
  type ServerRootRow as ServerRootRowType
} from "./worker-protocol"

export interface RegisterRootInput {
  readonly operationId: string
  readonly label: string
  readonly selectedPath: string
  readonly canonicalPath: string
  readonly device: string
  readonly inode: string
}

const decodeRoots = Schema.decodeUnknownOption(Schema.Array(ServerRootRow))
const decodeRegistration = Schema.decodeUnknownOption(RootRegistrationOutcome)
const decodeReplayLookup = Schema.decodeUnknownOption(RootReplayLookup)

/** Server-owned durable registration of verified native source roots. */
export class RootStore extends Context.Service<
  RootStore,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<ServerRootRowType>, DatabaseWorkerError>
    readonly register: (
      input: RegisterRootInput
    ) => Effect.Effect<RootRegistrationOutcomeType, DatabaseWorkerError>
    readonly lookup: (
      input: RegisterRootInput
    ) => Effect.Effect<import("./worker-protocol").RootReplayLookup, DatabaseWorkerError>
  }
>()("henshin/server/RootStore") {
  static readonly layer: Layer.Layer<RootStore, never, DatabaseWorker> = Layer.effect(
    RootStore,
    Effect.gen(function*() {
      const worker = yield* DatabaseWorker

      const list = () =>
        worker.call({ op: "listRoots" }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeRoots(value)
            return Option.isNone(decoded)
              ? Effect.fail(new DatabaseWorkerError({ message: "invalid list-roots result" }))
              : Effect.succeed(decoded.value)
          })
        )

      const register = (input: RegisterRootInput) =>
        worker.call({ op: "registerRoot", ...input }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeRegistration(value)
            return Option.isNone(decoded)
              ? Effect.fail(new DatabaseWorkerError({ message: "invalid register-root result" }))
              : Effect.succeed(decoded.value)
          })
        )

      const lookup = (input: RegisterRootInput) =>
        worker.call({ op: "lookupRootOperation", ...input }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeReplayLookup(value)
            return Option.isNone(decoded)
              ? Effect.fail(new DatabaseWorkerError({ message: "invalid root replay result" }))
              : Effect.succeed(decoded.value)
          })
        )

      return RootStore.of({ list, lookup, register })
    })
  )
}
