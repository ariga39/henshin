import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { InternalError, ThumbnailApi, ThumbnailMissing, ThumbnailUpdating } from "@henshin/contracts"
import { ServerState } from "../identity"
import { ThumbnailProducer } from "../thumbnails/ThumbnailProducer"

export const ThumbnailHandlers = HttpApiBuilder.group(ThumbnailApi, "thumbnails", (handlers) =>
  Effect.gen(function*() {
    const producer = yield* ThumbnailProducer
    const server = yield* ServerState
    return handlers.handle("get", ({ params }) =>
      Effect.gen(function*() {
        const result = yield* producer.load(params.key).pipe(
          Effect.catchTag("ThumbnailCacheError", () =>
            Effect.fail(new ThumbnailUpdating({
              code: "thumbnail_updating",
              message: "thumbnail generation is updating",
              retryable: true,
              request_id: randomUUID(),
              instance_id: server.instanceId,
              epoch: server.epoch
            }))
          )
        )
        switch (result.kind) {
          case "ready":
            return result.bytes
          case "missing":
            return yield* new ThumbnailMissing({
              code: "thumbnail_missing",
              message: "thumbnail is unavailable for the current accepted source",
              retryable: false,
              request_id: randomUUID(),
              instance_id: server.instanceId,
              epoch: server.epoch
            })
          case "updating":
            return yield* new ThumbnailUpdating({
              code: "thumbnail_updating",
              message: "thumbnail generation is updating",
              retryable: true,
              request_id: randomUUID(),
              instance_id: server.instanceId,
              epoch: server.epoch
            })
        }
      }).pipe(
        Effect.catchTag("ThumbnailRenderError", () =>
          Effect.fail(new InternalError({
            code: "internal_error",
            message: "internal error",
            retryable: false,
            request_id: randomUUID(),
            instance_id: server.instanceId,
            epoch: server.epoch
          }))
        )
      )
    )
  })
)
