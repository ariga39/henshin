import { createServer } from "node:http"
import path from "node:path"
import { NodeHttpServerRequest, NodeStream, NodeHttpServer, NodeServices } from "@effect/platform-node"
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
import { EhApi, LibraryApi, OpenEventApi, PrototypeApi, ReviewApi, ServerApi, TaskApi, ThumbnailApi } from "@henshin/contracts"
import { AuthenticationLayer } from "./api/AuthenticationLayer"
import { PrototypeHandlers } from "./api/handlers"
import { RootHandlers } from "./api/root-preview"
import { ReviewHandlers, TaskHandlers } from "./api/scan"
import { LibraryHandlers } from "./api/library"
import { ThumbnailHandlers } from "./api/thumbnails"
import { OpenEventHandlers } from "./api/open-events"
import { EhHandlers } from "./api/eh"
import { AuthConfig, ServerState } from "./identity"
import { DatabaseWorker, type DatabaseWorkerError } from "./persistence/DatabaseWorker"
import { NoteStore } from "./persistence/NoteStore"
import { RootStore } from "./persistence/RootStore"
import { BackupDestinationStore } from "./persistence/BackupDestinationStore"
import { ScanStore } from "./persistence/ScanStore"
import { LibraryStore } from "./persistence/LibraryStore"
import { OpenEventStore } from "./persistence/OpenEventStore"
import { ServerOwnershipLayer, type ServerOwnershipError } from "./persistence/ServerOwnership"
import { ThumbnailCache } from "./thumbnails/ThumbnailCache"
import { ThumbnailProducer } from "./thumbnails/ThumbnailProducer"
import type { DatabaseSync } from "node:sqlite"

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
  readonly auth:
    | { readonly kind: "bootstrap"; readonly token: string }
    | { readonly kind: "owner"; readonly verifier: string }
  readonly port: number
  readonly ownershipGuard?: DatabaseSync
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
  const RootPreviewHandlersLayer = RootHandlers(path.dirname(options.dbPath)).pipe(
    Layer.provide(Layer.mergeAll(AuthenticationLayer, RootStore.layer, BackupDestinationStore.layer, ScanStore.layer))
  )
  const RootPreviewRoutesLayer = HttpApiBuilder.layer(ServerApi).pipe(
    // The product API has its own route namespace but shares the authenticated
    // server state and HTTP server with the synthetic prototype.
    Layer.provide(RootPreviewHandlersLayer)
  )
  const TaskHandlersLayer = TaskHandlers.pipe(Layer.provide(Layer.mergeAll(AuthenticationLayer, ScanStore.layer)))
  const TaskRoutesLayer = HttpApiBuilder.layer(TaskApi).pipe(Layer.provide(TaskHandlersLayer))
  const ReviewHandlersLayer = ReviewHandlers.pipe(
    Layer.provide(Layer.mergeAll(AuthenticationLayer, RootStore.layer, ScanStore.layer, LibraryStore.layer))
  )
  const ReviewRoutesLayer = HttpApiBuilder.layer(ReviewApi).pipe(Layer.provide(ReviewHandlersLayer))
  const LibraryHandlersLayer = LibraryHandlers.pipe(
    Layer.provide(Layer.mergeAll(AuthenticationLayer, RootStore.layer, LibraryStore.layer))
  )
  const LibraryRoutesLayer = HttpApiBuilder.layer(LibraryApi).pipe(Layer.provide(LibraryHandlersLayer))
  const ThumbnailHandlersLayer = ThumbnailHandlers.pipe(
    Layer.provide(ThumbnailProducer.layer),
    Layer.provide(
      Layer.mergeAll(
        AuthenticationLayer,
        LibraryStore.layer,
        RootStore.layer,
        ThumbnailCache.layer(path.join(path.dirname(options.dbPath), "thumbnail-cache")),
        NodeServices.layer
      )
    )
  )
  const ThumbnailRoutesLayer = HttpApiBuilder.layer(ThumbnailApi).pipe(Layer.provide(ThumbnailHandlersLayer))
  const OpenEventHandlersLayer = OpenEventHandlers.pipe(
    Layer.provide(Layer.mergeAll(AuthenticationLayer, OpenEventStore.layer))
  )
  const OpenEventRoutesLayer = HttpApiBuilder.layer(OpenEventApi).pipe(Layer.provide(OpenEventHandlersLayer))
  const EhHandlersLayer = EhHandlers.pipe(Layer.provide(Layer.mergeAll(AuthenticationLayer)))
  const EhRoutesLayer = HttpApiBuilder.layer(EhApi).pipe(Layer.provide(EhHandlersLayer))
  const AllRoutes = Layer.mergeAll(
    RoutesLayer,
    RootPreviewRoutesLayer,
    TaskRoutesLayer,
    ReviewRoutesLayer,
    LibraryRoutesLayer,
    ThumbnailRoutesLayer,
    OpenEventRoutesLayer,
    EhRoutesLayer
  )

  const ReadyLayer = Layer.effectDiscard(
    Effect.gen(function*() {
      const httpServer = yield* HttpServer.HttpServer
      const state = yield* ServerState
      const scans = yield* ScanStore
      yield* scans.recoverInterrupted()
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

  return Layer.mergeAll(HttpRouter.serve(AllRoutes, { middleware: bodyLimit }), ReadyLayer).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: options.port })),
    // Second line of defense for any body read that bypasses the middleware.
    Layer.provide(Layer.succeed(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(1))),
    Layer.provide(ServerState.layer),
    Layer.provide(ScanStore.layer),
    Layer.provide(LibraryStore.layer),
    Layer.provide(OpenEventStore.layer),
    Layer.provide(AuthConfig.layer(options.auth)),
    Layer.provide(
      DatabaseWorker.layer(options.dbPath).pipe(
        Layer.provide(ServerOwnershipLayer(options.dbPath, options.ownershipGuard))
      )
    )
  )
}
