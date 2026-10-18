import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { ByteSize, Effect, Layer } from "effect"
import { HttpIncomingMessage, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { ServeError } from "effect/http/HttpServerError"
import { HttpApiBuilder } from "effect/http-api"
import { PrototypeApi } from "@henshin/contracts"
import { AuthenticationLayer } from "./api/AuthenticationLayer"
import { PrototypeHandlers } from "./api/handlers"
import { AuthConfig, ServerState } from "./identity"
import { DatabaseWorker, type DatabaseWorkerError } from "./persistence/DatabaseWorker"
import { NoteStore } from "./persistence/NoteStore"

const MAX_BODY_BYTES = 1024 * 1024

/**
 * Rejects an over-limit declared body before any body is read or decoded, so
 * the 1 MiB JSON ceiling is enforced at HTTP parsing with a clean 413.
 */
const bodyLimit = <E, R>(
  httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, HttpServerRequest.HttpServerRequest | R>
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, HttpServerRequest.HttpServerRequest | R> =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const declared = request.headers["content-length"]
    if (declared !== undefined) {
      const length = Number(declared)
      if (Number.isInteger(length) && length > MAX_BODY_BYTES) {
        return HttpServerResponse.empty({ status: 413 })
      }
    }
    return yield* httpApp
  })

export interface AppOptions {
  readonly dbPath: string
  readonly bearerToken: string
}

/**
 * Full server composition: one runtime at the process edge, routes served over
 * an OS-assigned loopback port, SQLite isolated behind the worker thread, and a
 * readiness line written only after the server can serve.
 */
export const makeAppLayer = (
  options: AppOptions
): Layer.Layer<never, DatabaseWorkerError | ServeError, never> => {
  const HandlersLayer = PrototypeHandlers.pipe(
    Layer.provide(Layer.mergeAll(NoteStore.layer, AuthenticationLayer))
  )
  const RoutesLayer = HttpApiBuilder.layer(PrototypeApi).pipe(Layer.provide(HandlersLayer))

  const ReadyLayer = Layer.effectDiscard(
    Effect.gen(function*() {
      const httpServer = yield* HttpServer.HttpServer
      const state = yield* ServerState
      const address = httpServer.address
      const port =
        address._tag === "InetAddressV4" || address._tag === "InetAddressV6" ? address.port : 0
      process.stdout.write(
        JSON.stringify({
          event: "ready",
          port,
          instance_id: state.instanceId,
          epoch: state.epoch
        }) + "\n"
      )
    })
  )

  return Layer.mergeAll(HttpRouter.serve(RoutesLayer, { middleware: bodyLimit }), ReadyLayer).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    // Enforce the documented finite JSON body ceiling at HTTP parsing, before
    // any schema decoding runs.
    Layer.provide(Layer.succeed(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(1))),
    Layer.provide(ServerState.layer),
    Layer.provide(AuthConfig.layer(options.bearerToken)),
    Layer.provide(DatabaseWorker.layer(options.dbPath))
  )
}
