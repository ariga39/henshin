import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { InternalError, RequestContext, ThumbnailApi, ThumbnailMissing, ThumbnailUpdating } from "@henshin/contracts"
import { ServerState } from "../identity"
import { ThumbnailProducer } from "../thumbnails/ThumbnailProducer"

export const ThumbnailHandlers = HttpApiBuilder.group(ThumbnailApi, "thumbnails", (handlers) =>
  Effect.gen(function*() {
    const producer = yield* ThumbnailProducer
    const server = yield* ServerState
    return handlers.handle("get", ({ params }) =>
      Effect.gen(function*() {
        const context = yield* RequestContext
        const envelope = { request_id: context.request_id, instance_id: server.instanceId, epoch: server.epoch }
        const result = yield* producer.load(params.key).pipe(Effect.mapError(() =>
          new InternalError({ ...envelope, code: "internal_error", message: "Could not load the cover", retryable: false })
        ))
        switch (result.kind) {
          case "ready":
            return result.bytes
          case "missing":
            return yield* new ThumbnailMissing({
              code: "thumbnail_missing",
              message: "thumbnail is unavailable for the current accepted source",
              retryable: false,
              ...envelope
            })
          case "updating":
            return yield* new ThumbnailUpdating({
              code: "thumbnail_updating",
              message: "thumbnail generation is updating",
              retryable: true,
              ...envelope
            })
        }
      })
    )
  })
)
