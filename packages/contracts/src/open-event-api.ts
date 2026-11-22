import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Authentication } from "./auth"
import { SuccessEnvelope } from "./envelope"
import {
  AuthenticationRequired,
  EpochChanged,
  InstanceMismatch,
  InternalError,
  InvalidRequest
} from "./errors"
import { OpenEventBatchRequest, OpenEventBatchResult } from "./event"

export const OpenEventApi = HttpApi.make("henshin-open-events").add(
  HttpApiGroup.make("openEvents", { topLevel: true })
    .add(
      HttpApiEndpoint.post("batch", "/open-events/batch", {
        payload: OpenEventBatchRequest,
        success: SuccessEnvelope(OpenEventBatchResult),
        error: [AuthenticationRequired, InvalidRequest, EpochChanged, InstanceMismatch, InternalError]
      })
    )
    .prefix("/api/v1")
    .middleware(Authentication)
)
