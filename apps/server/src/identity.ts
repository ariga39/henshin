import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Uuid } from "@henshin/contracts/ids"
import { DatabaseWorker, DatabaseWorkerError } from "./persistence/DatabaseWorker"

const decodeInstanceId = Schema.decodeUnknownOption(Uuid)

/**
 * Per-process authority. The instance id is persisted in SQLite; the epoch is
 * generated fresh on every process start and is never restored from storage.
 */
export class ServerState extends Context.Service<
  ServerState,
  { readonly instanceId: string; readonly epoch: string }
>()("henshin/server/ServerState") {
  static readonly layer: Layer.Layer<ServerState, DatabaseWorkerError, DatabaseWorker> = Layer.effect(
    ServerState,
    Effect.gen(function*() {
      const worker = yield* DatabaseWorker
      const value = yield* worker.call({ op: "init" })
      const decoded = decodeInstanceId(value)
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(
          new DatabaseWorkerError({ message: "database worker returned an invalid instance id" })
        )
      }
      return ServerState.of({ instanceId: decoded.value, epoch: randomUUID() })
    })
  )
}

/**
 * Bearer token for this process. Supplied over the private bootstrap channel,
 * never as a command-line argument or log line.
 */
export class AuthConfig extends Context.Service<AuthConfig, { readonly token: Redacted.Redacted<string> }>()(
  "henshin/server/AuthConfig"
) {
  static readonly layer = (token: string): Layer.Layer<AuthConfig> =>
    Layer.succeed(AuthConfig, AuthConfig.of({ token: Redacted.make(token) }))
}
