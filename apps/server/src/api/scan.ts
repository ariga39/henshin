import { Effect } from "effect"
import {
  CandidateNotFound,
  EpochChanged,
  InstanceMismatch,
  InternalError,
  InvalidRequest,
  OperationConflict,
  OperationExpired,
  RequestContext,
  RevisionConflict,
  ReviewApi,
  StorageFull,
  TaskApi,
  TaskNotFound
} from "@henshin/contracts"
import { HttpApiBuilder } from "effect/http-api"
import { ServerState } from "../identity"
import { ScanStore } from "../persistence/ScanStore"

const errorBase = (server: ServerState["Service"], requestId: string) => ({
  request_id: requestId,
  instance_id: server.instanceId,
  epoch: server.epoch
})

export const TaskHandlers = HttpApiBuilder.group(TaskApi, "tasks", (handlers) =>
  Effect.gen(function*() {
    const server = yield* ServerState
    const scans = yield* ScanStore
    return handlers
      .handle("list", () =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const tasks = yield* scans.listTasks().pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...errorBase(server, context.request_id)
            }))
          )
          return { ...errorBase(server, context.request_id), server_time: Date.now(), data: tasks }
        })
      )
      .handle("get", ({ params }) =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const task = yield* scans.readTask(params.id).pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...errorBase(server, context.request_id)
            }))
          )
          if (task === null) {
            return yield* new TaskNotFound({
              code: "not_found",
              message: "scan task not found",
              retryable: false,
              ...errorBase(server, context.request_id)
            })
          }
          return { ...errorBase(server, context.request_id), server_time: Date.now(), data: task }
        })
      )
  })
)

export const ReviewHandlers = HttpApiBuilder.group(ReviewApi, "review", (handlers) =>
  Effect.gen(function*() {
    const server = yield* ServerState
    const scans = yield* ScanStore
    return handlers
      .handle("candidates", () =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const candidates = yield* scans.listStaged().pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...errorBase(server, context.request_id)
            }))
          )
          return { ...errorBase(server, context.request_id), server_time: Date.now(), data: candidates }
        })
      )
      .handle("command", ({ params, payload }) =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const base = errorBase(server, context.request_id)
          if (payload.instance_id !== server.instanceId) {
            return yield* new InstanceMismatch({
              code: "instance_mismatch",
              message: "instance mismatch",
              retryable: false,
              ...base
            })
          }
          if (payload.epoch !== server.epoch) {
            return yield* new EpochChanged({
              code: "epoch_changed",
              message: "authority epoch changed; refresh Review before releasing this discovery",
              retryable: true,
              ...base
            })
          }
          if (payload.command.type !== "release-hold") {
            return yield* new InvalidRequest({
              code: "invalid_request",
              message: "unsupported review command",
              retryable: false,
              ...base
            })
          }

          const released = yield* scans.releaseHeld({
            candidateId: params.id,
            rootId: payload.root_id,
            operationId: payload.operation_id,
            epoch: payload.epoch,
            expectedCandidateVersion: payload.expected_candidate_version,
            expectedMappingRevision: payload.expected_mapping_revision,
            expectedPolicyRevision: payload.expected_policy_revision
          }).pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...base
            }))
          )

          switch (released.kind) {
            case "committed":
            case "replayed":
              return {
                ...base,
                server_time: Date.now(),
                data: { operation_id: payload.operation_id, candidate: released.candidate }
              }
            case "operation_conflict":
              return yield* new OperationConflict({
                code: "operation_conflict",
                message: "operation id reused with a different review command",
                retryable: false,
                ...base
              })
            case "operation_expired":
              return yield* new OperationExpired({
                code: "operation_expired",
                message: "review command result expired; refresh Review before retrying",
                retryable: false,
                ...base
              })
            case "storage_full":
              return yield* new StorageFull({
                code: "storage_full503",
                message: "review command operation storage is full",
                retryable: true,
                ...base
              })
            case "root_not_found":
              return yield* new CandidateNotFound({
                code: "not_found",
                message: "saved root for this discovery not found; refresh Review",
                retryable: false,
                ...base
              })
            case "candidate_not_found":
              return yield* new CandidateNotFound({
                code: "not_found",
                message: "staged discovery not found; refresh Review",
                retryable: false,
                ...base
              })
            case "candidate_version_conflict":
              return yield* new RevisionConflict({
                code: "revision_conflict",
                message: "discovery changed; refresh Review before releasing it",
                retryable: false,
                details: { current_revision: String(released.currentCandidateVersion) },
                ...base
              })
            case "candidate_not_held":
              return yield* new RevisionConflict({
                code: "revision_conflict",
                message: "discovery hold changed; refresh Review before releasing it",
                retryable: false,
                details: { current_revision: String(released.currentCandidateVersion) },
                ...base
              })
            case "mapping_revision_conflict":
              return yield* new RevisionConflict({
                code: "revision_conflict",
                message: "saved root mapping changed; refresh the root and Review",
                retryable: false,
                details: { current_revision: released.currentMappingRevision },
                ...base
              })
            case "policy_revision_conflict":
              return yield* new RevisionConflict({
                code: "revision_conflict",
                message: "saved root policy changed; refresh the root and Review",
                retryable: false,
                details: { current_revision: released.currentPolicyRevision },
                ...base
              })
          }
        })
      )
  })
)
