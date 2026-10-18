import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Authentication } from "./auth"
import { SuccessEnvelope } from "./envelope"
import {
  AuthenticationRequired,
  EpochChanged,
  InstanceMismatch,
  InternalError,
  NoteNotFound,
  OperationConflict,
  RevisionConflict
} from "./errors"
import { NoteId } from "./ids"
import { EditNotePayload, HandshakeData, Note } from "./note"

/**
 * Isolated synthetic prototype API. The `/prototype/v1` prefix and the
 * `henshin-prototype` id keep it clearly separate from any production surface
 * described in docs/design/api-and-tasks.md.
 */
export const PrototypeApi = HttpApi.make("henshin-prototype").add(
  HttpApiGroup.make("prototype", { topLevel: true })
    .add(
      HttpApiEndpoint.get("handshake", "/handshake", {
        success: SuccessEnvelope(HandshakeData),
        error: [AuthenticationRequired, InternalError]
      }),
      HttpApiEndpoint.get("getNote", "/note/:id", {
        params: { id: NoteId },
        success: SuccessEnvelope(Note),
        error: [AuthenticationRequired, NoteNotFound, InternalError]
      }),
      HttpApiEndpoint.put("editNote", "/note/:id", {
        params: { id: NoteId },
        payload: EditNotePayload,
        success: SuccessEnvelope(Note),
        error: [
          AuthenticationRequired,
          NoteNotFound,
          RevisionConflict,
          OperationConflict,
          EpochChanged,
          InstanceMismatch,
          InternalError
        ]
      })
    )
    .prefix("/prototype/v1")
    .middleware(Authentication)
)
