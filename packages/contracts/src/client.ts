import { Context, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api"
import { PrototypeApi, ReviewApi, ServerApi, TaskApi } from "./api"
import { Authentication } from "./auth"

/**
 * Authenticated typed HTTP client for the prototype API. The bearer token is
 * captured in the layer closure and attached by the client-side middleware; it
 * is never accepted from a caller of an operation.
 */
export class PrototypeHttpClient extends Context.Service<
  PrototypeHttpClient,
  HttpApiClient.ForApi<typeof PrototypeApi>
>()("henshin/http/PrototypeHttpClient") {
  static readonly layer = (options: {
    readonly baseUrl: string
    readonly bearerToken: string
    readonly transportLayer?: Layer.Layer<HttpClient.HttpClient>
  }): Layer.Layer<PrototypeHttpClient> => {
    const AuthenticationClient = HttpApiMiddleware.layerClient(Authentication, ({ next, request }) =>
      next(HttpClientRequest.bearerToken(request, options.bearerToken))
    )

    return Layer.effect(
      PrototypeHttpClient,
      HttpApiClient.make(PrototypeApi, {
        transformClient: (client) =>
          client.pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)))
      })
    ).pipe(
      Layer.provide(AuthenticationClient),
      Layer.provide(options.transportLayer ?? FetchHttpClient.layer)
    )
  }
}

/** Authenticated typed client for the product server API. */
export class ServerHttpClient extends Context.Service<
  ServerHttpClient,
  HttpApiClient.ForApi<typeof ServerApi>
>()("henshin/http/ServerHttpClient") {
  static readonly layer = (options: {
    readonly baseUrl: string
    readonly bearerToken: string
    readonly transportLayer?: Layer.Layer<HttpClient.HttpClient>
  }): Layer.Layer<ServerHttpClient> => {
    const AuthenticationClient = HttpApiMiddleware.layerClient(Authentication, ({ next, request }) =>
      next(HttpClientRequest.bearerToken(request, options.bearerToken))
    )

    return Layer.effect(
      ServerHttpClient,
      HttpApiClient.make(ServerApi, {
        transformClient: (client) =>
          client.pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)))
      })
    ).pipe(Layer.provide(AuthenticationClient), Layer.provide(options.transportLayer ?? FetchHttpClient.layer))
  }
}

/** Authenticated task-status client for durable background work. */
export class TaskHttpClient extends Context.Service<
  TaskHttpClient,
  HttpApiClient.ForApi<typeof TaskApi>
>()("henshin/http/TaskHttpClient") {
  static readonly layer = (options: {
    readonly baseUrl: string
    readonly bearerToken: string
    readonly transportLayer?: Layer.Layer<HttpClient.HttpClient>
  }): Layer.Layer<TaskHttpClient> => {
    const AuthenticationClient = HttpApiMiddleware.layerClient(Authentication, ({ next, request }) =>
      next(HttpClientRequest.bearerToken(request, options.bearerToken))
    )
    return Layer.effect(
      TaskHttpClient,
      HttpApiClient.make(TaskApi, {
        transformClient: (client) => client.pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)))
      })
    ).pipe(Layer.provide(AuthenticationClient), Layer.provide(options.transportLayer ?? FetchHttpClient.layer))
  }
}

/** Authenticated review-queue client for staged discoveries. */
export class ReviewHttpClient extends Context.Service<
  ReviewHttpClient,
  HttpApiClient.ForApi<typeof ReviewApi>
>()("henshin/http/ReviewHttpClient") {
  static readonly layer = (options: {
    readonly baseUrl: string
    readonly bearerToken: string
    readonly transportLayer?: Layer.Layer<HttpClient.HttpClient>
  }): Layer.Layer<ReviewHttpClient> => {
    const AuthenticationClient = HttpApiMiddleware.layerClient(Authentication, ({ next, request }) =>
      next(HttpClientRequest.bearerToken(request, options.bearerToken))
    )
    return Layer.effect(
      ReviewHttpClient,
      HttpApiClient.make(ReviewApi, {
        transformClient: (client) => client.pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)))
      })
    ).pipe(Layer.provide(AuthenticationClient), Layer.provide(options.transportLayer ?? FetchHttpClient.layer))
  }
}
