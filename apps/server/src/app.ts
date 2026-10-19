import { createServer } from "node:http"
import { NodeHttpServerRequest, NodeStream, NodeHttpServer } from "@effect/platform-node"
import { ByteSize, Data, Effect, Layer, Schema, Stream } from "effect"
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse
} from "effect/http"
import type { ServeError } from "effect/http/HttpServerError"
import { HttpApiBuilder } from "effect/http-api"
import { PrototypeApi } from "@henshin/contracts"
import { AuthenticationLayer } from "./api/AuthenticationLayer"
import { PrototypeHandlers } from "./api/handlers"
import { AuthConfig, ServerState } from "./identity"
import { DatabaseWorker, type DatabaseWorkerError } from "./persistence/DatabaseWorker"
import { NoteStore } from "./persistence/NoteStore"
import { ServerOwnershipLayer, type ServerOwnershipError } from "./persistence/ServerOwnership"

const MAX_BODY_BYTES = 1024 * 1024
const BODIED_METHODS = new Set<string>(["PUT", "POST", "PATCH"])

class BodyTooLarge extends Data.TaggedError("BodyTooLarge")<{}> {}

interface BufferedBody {
  readonly total: number
  readonly chunks: ReadonlyArray<Uint8Array>
}

const concatChunks = (chunks: ReadonlyArray<Uint8Array>, total: number): Uint8Array => {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

const requestParseError = (
  request: HttpServerRequest.HttpServerRequest,
  description: string,
  cause: unknown
): HttpServerError.HttpServerError =>
  new HttpServerError.HttpServerError({
    reason: new HttpServerError.RequestParseError({ request, description, cause })
  })

/**
 * Reads a request body with a finite bound. Only the `BodyTooLarge` sentinel is
 * converted to `null`; any other read failure propagates unchanged, so a
 * transport error is never disguised as a size rejection.
 *
 * The underlying readable is read with `closeOnDone: false`, so stopping early
 * on an oversized body does not destroy the socket and a clean 413 can still be
 * written.
 */
const readBoundedBody = (
  request: HttpServerRequest.HttpServerRequest
): Effect.Effect<Uint8Array | null, HttpServerError.HttpServerError> => {
  const bodyStream = NodeStream.fromReadable<Uint8Array, HttpServerError.HttpServerError>({
    evaluate: () => NodeHttpServerRequest.toIncomingMessage(request),
    onError: (cause) => requestParseError(request, "failed to read request body", cause),
    closeOnDone: false
  })

  return Stream.runFoldEffect(
    () => ({ total: 0, chunks: [] as ReadonlyArray<Uint8Array> }) as BufferedBody,
    (acc: BufferedBody, chunk: Uint8Array) => {
      const total = acc.total + chunk.length
      if (total > MAX_BODY_BYTES) return Effect.fail(new BodyTooLarge())
      return Effect.succeed({ total, chunks: [...acc.chunks, chunk] })
    }
  )(bodyStream).pipe(
    Effect.map((acc) => concatChunks(acc.chunks, acc.total)),
    Effect.catchTag("BodyTooLarge", () => Effect.succeed(null))
  )
}

/**
 * Rebuilds the request view over an already-read body so the HTTP API can still
 * decode the payload. The prototype and its other accessors are preserved, and
 * the body accessors are replaced with own property descriptors so inherited
 * getter-only accessors cannot block the override.
 */
const withBufferedBody = (
  request: HttpServerRequest.HttpServerRequest,
  bytes: Uint8Array
): HttpServerRequest.HttpServerRequest => {
  const text = new TextDecoder().decode(bytes)
  const json: HttpServerRequest.HttpServerRequest["json"] =
    text.length === 0
      ? Effect.succeed(null)
      : Effect.try({
          try: () => JSON.parse(text) as Schema.Json,
          catch: (cause) => requestParseError(request, "invalid JSON body", cause)
        })

  const view = Object.create(Object.getPrototypeOf(request)) as HttpServerRequest.HttpServerRequest
  Object.defineProperties(view, {
    ...Object.getOwnPropertyDescriptors(request),
    json: { value: json, writable: true, enumerable: true, configurable: true },
    text: { value: Effect.succeed(text), writable: true, enumerable: true, configurable: true },
    arrayBuffer: {
      value: Effect.succeed(bytes.slice().buffer),
      writable: true,
      enumerable: true,
      configurable: true
    },
    stream: { value: Stream.make(bytes), writable: true, enumerable: true, configurable: true }
  })
  return view
}

/**
 * Enforces the 1 MiB JSON ceiling at HTTP parsing.
 *
 * A declared `Content-Length` over the limit is rejected before any body is
 * read. A chunked/otherwise unmeasured body is read with a finite bound and
 * rejected with a clean 413 instead of letting the platform abort the socket.
 */
const bodyLimit = <E, R>(
  httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, HttpServerRequest.HttpServerRequest | R>
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E | HttpServerError.HttpServerError,
  HttpServerRequest.HttpServerRequest | R
> =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest

    const declared = request.headers["content-length"]
    if (declared !== undefined) {
      const length = Number(declared)
      if (Number.isInteger(length) && length > MAX_BODY_BYTES) {
        return HttpServerResponse.empty({ status: 413 })
      }
      return yield* httpApp
    }

    if (!BODIED_METHODS.has(request.method)) {
      return yield* httpApp
    }

    const buffered = yield* readBoundedBody(request)
    if (buffered === null) {
      return HttpServerResponse.empty({ status: 413 })
    }

    return yield* Effect.provideService(
      httpApp,
      HttpServerRequest.HttpServerRequest,
      withBufferedBody(request, buffered)
    )
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
): Layer.Layer<never, DatabaseWorkerError | ServerOwnershipError | ServeError, never> => {
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
    // Second line of defense for any body read that bypasses the middleware.
    Layer.provide(Layer.succeed(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(1))),
    Layer.provide(ServerState.layer),
    Layer.provide(AuthConfig.layer(options.bearerToken)),
    Layer.provide(DatabaseWorker.layer(options.dbPath).pipe(Layer.provide(ServerOwnershipLayer(options.dbPath))))
  )
}
