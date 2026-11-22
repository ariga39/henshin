import { Effect } from "effect"
import { InternalError, RequestContext, ReviewApi, TaskApi, TaskNotFound } from "@henshin/contracts"
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
    return handlers.handle("candidates", () =>
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
  })
)
