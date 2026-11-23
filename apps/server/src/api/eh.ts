import { Effect } from "effect"
import { EhApi, InternalError, InvalidRequest, RequestContext } from "@henshin/contracts"
import { HttpApiBuilder } from "effect/http-api"
import { ServerState } from "../identity"
import { searchEhCandidates } from "../eh-search"

const errorBase = (server: ServerState["Service"], requestId: string) => ({
  request_id: requestId,
  instance_id: server.instanceId,
  epoch: server.epoch
})

export const EhHandlers = HttpApiBuilder.group(EhApi, "eh", (handlers) =>
  Effect.gen(function*() {
    const server = yield* ServerState
    return handlers.handle("candidates", ({ payload }) =>
      Effect.gen(function*() {
        const context = yield* RequestContext
        if (payload.title.trim().length === 0) {
          return yield* new InvalidRequest({
            code: "invalid_request",
            message: "title query must not be empty",
            retryable: false,
            details: { field: "title" },
            ...errorBase(server, context.request_id)
          })
        }
        return yield* Effect.tryPromise({
          try: (signal) => searchEhCandidates(payload, signal),
          catch: () => new InternalError({
            code: "internal_error",
            message: "gallery search failed",
            retryable: true,
            ...errorBase(server, context.request_id)
          })
        }).pipe(Effect.map((data) => ({ ...errorBase(server, context.request_id), server_time: Date.now(), data })))
      })
    )
  })
)
