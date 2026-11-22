import { Context, Effect, Layer, Option, Schema } from "effect"
import { DatabaseWorker, DatabaseWorkerError } from "./DatabaseWorker"
import {
  RootRegistrationOutcome,
  RootReplayLookup,
  RootPolicyCommandOutcome,
  ServerRootRow,
  type RootRegistrationOutcome as RootRegistrationOutcomeType,
  type ServerRootRow as ServerRootRowType
} from "./worker-protocol"
import type { RootPolicyCommand } from "@henshin/contracts/root"

export interface RegisterRootInput {
  readonly operationId: string
  readonly label: string
  readonly selectedPath: string
  readonly canonicalPath: string
  readonly device: string
  readonly inode: string
}

export interface CommitRootPolicyInput {
  readonly rootId: string
  readonly operationId: string
  readonly epoch: string
  readonly expectedPolicyRevision: string
  readonly command: RootPolicyCommand
}

const decodeRoots = Schema.decodeUnknownOption(Schema.Array(ServerRootRow))
const decodeRegistration = Schema.decodeUnknownOption(RootRegistrationOutcome)
const decodeReplayLookup = Schema.decodeUnknownOption(RootReplayLookup)
const decodePolicyCommand = Schema.decodeUnknownOption(RootPolicyCommandOutcome)

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
    readonly commitPolicy: (
      input: CommitRootPolicyInput
    ) => Effect.Effect<import("./worker-protocol").RootPolicyCommandOutcome, DatabaseWorkerError>
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

      const commitPolicy = (input: CommitRootPolicyInput) =>
        worker.call({ op: "commitRootPolicy", ...input }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodePolicyCommand(value)
            return Option.isNone(decoded)
              ? Effect.fail(new DatabaseWorkerError({ message: "invalid root-policy result" }))
              : Effect.succeed(decoded.value)
          })
        )

      return RootStore.of({ commitPolicy, list, lookup, register })
    })
  )
}
