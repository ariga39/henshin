import { Effect } from "effect"
import {
  EpochChanged,
  InstanceMismatch,
  InternalError,
  OpenEventApi,
  OpenEventBatchResult,
  RequestContext
} from "@henshin/contracts"
import { HttpApiBuilder } from "effect/http-api"
import { ServerState } from "../identity"
import { OpenEventStore } from "../persistence/OpenEventStore"

const errorBase = (server: ServerState["Service"], requestId: string) => ({
  request_id: requestId,
  instance_id: server.instanceId,
  epoch: server.epoch
})

export const OpenEventHandlers = HttpApiBuilder.group(OpenEventApi, "openEvents", (handlers) =>
  Effect.gen(function*() {
    const server = yield* ServerState
    const events = yield* OpenEventStore
    return handlers.handle("batch", ({ payload }) =>
      Effect.gen(function*() {
        const context = yield* RequestContext
        const base = errorBase(server, context.request_id)
        if (payload.epoch !== server.epoch) {
          return yield* new EpochChanged({
            code: "epoch_changed",
            message: "authority epoch changed; refresh before delivering open events",
            retryable: true,
            ...base
          })
        }
        if (payload.events.some((event) => event.instance_id !== server.instanceId)) {
          return yield* new InstanceMismatch({
            code: "instance_mismatch",
            message: "open event belongs to another server instance",
            retryable: false,
            ...base
          })
        }
        const result = yield* events.accept(payload.events).pipe(
          Effect.mapError(() => new InternalError({
            code: "internal_error",
            message: "internal error",
            retryable: true,
            ...base
          }))
        )
        return {
          ...base,
          server_time: Date.now(),
          data: result satisfies typeof OpenEventBatchResult.Type
        }
      })
    )
  })
)
