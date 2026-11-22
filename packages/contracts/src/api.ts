import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Authentication } from "./auth"
import { SuccessEnvelope } from "./envelope"
import {
  AuthenticationRequired,
  EpochChanged,
  InstanceMismatch,
  InternalError,
  InvalidRequest,
  NoteNotFound,
  OperationExpired,
  OperationConflict,
  RevisionConflict,
  RootVerificationFailed,
  RootPreviewUnavailable,
  RootNotFound,
  TaskNotFound,
  StorageFull
} from "./errors"
import { NoteId, Uuid } from "./ids"
import { EditNotePayload, HandshakeData, Note, OperationResult } from "./note"
import {
  RootPreview,
  RootPreviewRequest,
  RootPreviewResult,
  RootCommandRequest,
  ScanTask,
  ScanTaskList,
  ScanTaskSubmission,
  StagedDiscoveryList,
  RootRegistrationRequest,
  ServerRoot,
  ServerRootList
} from "./root"

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
      HttpApiEndpoint.get("getOperation", "/operations/:id", {
        params: { id: Uuid },
        query: { instance_id: Uuid, epoch: Uuid },
        success: SuccessEnvelope(OperationResult),
        error: [
          AuthenticationRequired,
          OperationExpired,
          EpochChanged,
          InstanceMismatch,
          InternalError
        ]
      }),
      HttpApiEndpoint.put("editNote", "/note/:id", {
        params: { id: NoteId },
        payload: EditNotePayload,
        success: SuccessEnvelope(OperationResult),
        error: [
          AuthenticationRequired,
          NoteNotFound,
          RevisionConflict,
          OperationConflict,
          OperationExpired,
          StorageFull,
          EpochChanged,
          InstanceMismatch,
          InternalError
        ]
      })
    )
    .prefix("/prototype/v1")
    .middleware(Authentication)
)

/**
 * Product server API. It is separate from the synthetic prototype so the
 * prototype remains explicitly available without making its routes look like
 * production endpoints.
 */
export const ServerApi = HttpApi.make("henshin-server").add(
  HttpApiGroup.make("roots", { topLevel: true })
    .add(
      HttpApiEndpoint.get("list", "/roots", {
        success: SuccessEnvelope(ServerRootList),
        error: [AuthenticationRequired, InternalError]
      }),
      HttpApiEndpoint.post("preview", "/roots/preview", {
        payload: RootPreviewRequest,
        success: SuccessEnvelope(RootPreviewResult),
        error: [AuthenticationRequired, InvalidRequest, RootPreviewUnavailable, InternalError]
      }),
      HttpApiEndpoint.post("save", "/roots", {
        payload: RootRegistrationRequest,
        success: SuccessEnvelope(ServerRoot),
        error: [
          AuthenticationRequired,
          InvalidRequest,
          OperationConflict,
          EpochChanged,
          InstanceMismatch,
          RootVerificationFailed,
          InternalError
        ]
      }),
      HttpApiEndpoint.post("command", "/roots/:id/commands", {
        params: { id: Uuid },
        payload: RootCommandRequest,
        success: SuccessEnvelope(ScanTaskSubmission),
        error: [
          AuthenticationRequired,
          RootNotFound,
          InvalidRequest,
          OperationConflict,
          EpochChanged,
          InstanceMismatch,
          RevisionConflict,
          InternalError
        ]
      })
    )
    .prefix("/api/v1")
    .middleware(Authentication)
)

export const TaskApi = HttpApi.make("henshin-task").add(
  HttpApiGroup.make("tasks", { topLevel: true })
    .add(
      HttpApiEndpoint.get("list", "/tasks", {
        success: SuccessEnvelope(ScanTaskList),
        error: [AuthenticationRequired, InternalError]
      }),
      HttpApiEndpoint.get("get", "/tasks/:id", {
        params: { id: Uuid },
        success: SuccessEnvelope(ScanTask),
        error: [AuthenticationRequired, TaskNotFound, InternalError]
      })
    )
    .prefix("/api/v1")
    .middleware(Authentication)
)

export const ReviewApi = HttpApi.make("henshin-review").add(
  HttpApiGroup.make("review", { topLevel: true })
    .add(
      HttpApiEndpoint.get("candidates", "/review/candidates", {
        success: SuccessEnvelope(StagedDiscoveryList),
        error: [AuthenticationRequired, InternalError]
      })
    )
    .prefix("/api/v1")
    .middleware(Authentication)
)
