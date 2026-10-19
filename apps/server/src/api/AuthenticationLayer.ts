import { timingSafeEqual } from "node:crypto"
import { randomUUID } from "node:crypto"
import { Effect, Layer, Redacted } from "effect"
import { Authentication, AuthenticationRequired, RequestContext } from "@henshin/contracts"
import { AuthConfig, ServerState } from "../identity"

const constantTimeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "utf8")
  const b = Buffer.from(right, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Server-side bearer authentication. A failure deliberately omits
 * `instance_id`/`epoch`, so an unauthenticated caller cannot learn the live
 * namespace or authority epoch.
 */
export const AuthenticationLayer = Layer.effect(
  Authentication,
  Effect.gen(function*() {
    const config = yield* AuthConfig
    const _server = yield* ServerState

    return Authentication.of({
      bearer: Effect.fn("Authentication.bearer")(function*(httpEffect, { credential }) {
        const presented = Redacted.value(credential)
        if (!constantTimeEqual(presented, Redacted.value(config.token))) {
          return yield* new AuthenticationRequired({
            code: "authentication_required",
            message: "Missing or invalid bearer token",
            retryable: false,
            request_id: randomUUID()
          })
        }
        return yield* Effect.provideService(
          httpEffect,
          RequestContext,
          RequestContext.of({ request_id: randomUUID() })
        )
      })
    })
  })
)
