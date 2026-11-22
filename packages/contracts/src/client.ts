import { Context, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api"
import { PrototypeApi } from "./api"
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
