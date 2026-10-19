import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import {
  EpochChanged,
  InstanceMismatch,
  InternalError,
  NoteNotFound,
  OperationExpired,
  OperationConflict,
  PrototypeApi,
  RequestContext,
  RevisionConflict,
  StorageFull
} from "@henshin/contracts"
import { ServerState } from "../identity"
import { NoteStore } from "../persistence/NoteStore"

export const PrototypeHandlers = HttpApiBuilder.group(PrototypeApi, "prototype", (handlers) =>
  Effect.gen(function*() {
    const store = yield* NoteStore
    const server = yield* ServerState

    const base = (requestId: string) => ({
      request_id: requestId,
      instance_id: server.instanceId,
      epoch: server.epoch
    })

    const envelope = <A>(requestId: string, data: A) => ({
      instance_id: server.instanceId,
      epoch: server.epoch,
      request_id: requestId,
      server_time: Date.now(),
      data
    })

    const operationResult = (result: {
      readonly operationId: string
      readonly note: { readonly note_id: string; readonly text: string; readonly revision: string }
      readonly expiresAtMs: number
    }) => ({
      operation_id: result.operationId,
      note: result.note,
      expires_at_ms: result.expiresAtMs
    })

    const internalError = (requestId: string) =>
      new InternalError({
        code: "internal_error",
        message: "internal error",
        retryable: false,
        ...base(requestId)
      })

    return handlers
      .handle("handshake", () =>
        Effect.gen(function*() {
          const ctx = yield* RequestContext
          return envelope(ctx.request_id, {
            api_version: "prototype/1",
            capabilities: ["prototype-note-edit"]
          })
        })
      )
      .handle("getNote", ({ params }) =>
        Effect.gen(function*() {
          const ctx = yield* RequestContext
          const note = yield* store
            .readNote(params.id)
            .pipe(Effect.mapError(() => internalError(ctx.request_id)))
          if (note === undefined) {
            return yield* new NoteNotFound({
              code: "not_found",
              message: "note not found",
              retryable: false,
              ...base(ctx.request_id)
            })
          }
          return envelope(ctx.request_id, note)
        })
      )
      .handle("getOperation", ({ params, query }) =>
        Effect.gen(function*() {
          const ctx = yield* RequestContext
          if (query.instance_id !== server.instanceId) {
            return yield* new InstanceMismatch({
              code: "instance_mismatch",
              message: "instance mismatch",
              retryable: false,
              ...base(ctx.request_id)
            })
          }
          if (query.epoch !== server.epoch) {
            return yield* new EpochChanged({
              code: "epoch_changed",
              message: "epoch changed",
              retryable: true,
              ...base(ctx.request_id)
            })
          }

          const outcome = yield* store
            .readOperation({ operationId: params.id, epoch: server.epoch })
            .pipe(Effect.mapError(() => internalError(ctx.request_id)))

          if (outcome.kind === "expired") {
            return yield* new OperationExpired({
              code: "operation_expired",
              message: "operation result is unavailable; reconcile before retrying",
              retryable: false,
              ...base(ctx.request_id)
            })
          }
          return envelope(ctx.request_id, operationResult(outcome.result))
        })
      )
      .handle("editNote", ({ params, payload }) =>
        Effect.gen(function*() {
          const ctx = yield* RequestContext
          if (payload.instance_id !== server.instanceId) {
            return yield* new InstanceMismatch({
              code: "instance_mismatch",
              message: "instance mismatch",
              retryable: false,
              ...base(ctx.request_id)
            })
          }
          if (payload.epoch !== server.epoch) {
            return yield* new EpochChanged({
              code: "epoch_changed",
              message: "epoch changed",
              retryable: true,
              ...base(ctx.request_id)
            })
          }

          const outcome = yield* store
            .commitNote({
              noteId: params.id,
              text: payload.text,
              expectedRevision: payload.expected_revision,
              operationId: payload.operation_id,
              epoch: server.epoch
            })
            .pipe(Effect.mapError(() => internalError(ctx.request_id)))

          switch (outcome.kind) {
            case "committed":
            case "replayed":
              return envelope(ctx.request_id, operationResult(outcome.result))
            case "operation_conflict":
              return yield* new OperationConflict({
                code: "operation_conflict",
                message: "operation id reused with a different payload",
                retryable: false,
                ...base(ctx.request_id)
              })
            case "operation_expired":
              return yield* new OperationExpired({
                code: "operation_expired",
                message: "operation result is unavailable; reconcile before retrying",
                retryable: false,
                ...base(ctx.request_id)
              })
            case "storage_full":
              return yield* new StorageFull({
                code: "storage_full503",
                message: "operation result storage is full; retry with the same operation id",
                retryable: true,
                ...base(ctx.request_id)
              })
            case "revision_conflict":
              return yield* new RevisionConflict({
                code: "revision_conflict",
                message: "stale revision",
                retryable: false,
                details: { current_revision: outcome.currentRevision },
                ...base(ctx.request_id)
              })
            case "not_found":
              return yield* new NoteNotFound({
                code: "not_found",
                message: "note not found",
                retryable: false,
                ...base(ctx.request_id)
              })
          }
        })
      )
  })
)
