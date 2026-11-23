import { Effect } from "effect"
import {
  InternalError,
  InvalidRequest,
  MaintenanceApi,
  OperationConflict,
  RequestContext,
  TaskNotFound
} from "@henshin/contracts"
import { HttpApiBuilder } from "effect/http-api"
import { ServerState } from "../identity"
import { BackupTaskStore } from "../persistence/BackupTaskStore"

const errorBase = (server: ServerState["Service"], requestId: string) => ({
  request_id: requestId,
  instance_id: server.instanceId,
  epoch: server.epoch
})

export const MaintenanceHandlers = HttpApiBuilder.group(MaintenanceApi, "maintenance", (handlers) =>
  Effect.gen(function*() {
    const server = yield* ServerState
    const backups = yield* BackupTaskStore
    return handlers
      .handle("createBackup", ({ payload }) =>
      Effect.gen(function*() {
        const context = yield* RequestContext
        const base = errorBase(server, context.request_id)
        if (payload.retention_class !== "archive") {
          return yield* new InvalidRequest({
            code: "invalid_request",
            message: "unsupported backup retention class",
            retryable: false,
            details: { field: "retention_class" },
            ...base
          })
        }

        const started = yield* backups.start({
          operationId: payload.operation_id,
          epoch: server.epoch,
          destinationId: payload.destination_id,
          label: payload.label ?? null
        }).pipe(
          Effect.mapError(() => new InternalError({
            code: "internal_error",
            message: "internal error",
            retryable: true,
            ...base
          }))
        )

        switch (started.kind) {
          case "destination_not_found":
            return yield* new TaskNotFound({
              code: "not_found",
              message: "registered backup destination not found",
              retryable: false,
              ...base
            })
          case "operation_conflict":
            return yield* new OperationConflict({
              code: "operation_conflict",
              message: "operation id reused with a different backup request",
              retryable: false,
              ...base
            })
          case "created":
          case "replayed":
            yield* backups.run(started.task.task_id).pipe(Effect.forkDetach)
            return {
              ...base,
              server_time: Date.now(),
              data: { task: started.task }
            }
        }
      })
      )
  })
)
