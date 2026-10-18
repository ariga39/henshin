import { Context } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"
import { AuthenticationRequired } from "./errors"

/**
 * Per-request context the server authentication middleware provides to
 * handlers. The request id is generated once per authenticated request.
 */
export class RequestContext extends Context.Service<RequestContext, { readonly request_id: string }>()(
  "henshin/http/RequestContext"
) {}

/**
 * Bearer authentication middleware. Every prototype route requires it, even on
 * loopback. Clients must supply a token implementation (`requiredForClient`).
 */
export class Authentication extends HttpApiMiddleware.Service<Authentication, {
  provides: RequestContext
  requires: never
}>()("henshin/http/Authentication", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: AuthenticationRequired
}) {}
