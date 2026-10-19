import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import type { CommandAttempt, Note, Revision } from "@henshin/contracts"
import { LocalDatabaseWorker, LocalDatabaseWorkerError } from "./LocalDatabaseWorker"
import {
  CommandAttemptAdmission,
  CommandAttemptRow,
  CommandAttemptMutation,
  CommandAttemptRows,
  type DraftWorkerRequest
} from "./draft-worker-protocol"

export interface CommandAttemptInput {
  readonly instanceId: string
  readonly operationId: string
  readonly noteId: string
  readonly intentText: string
  readonly baseRevision: string
  readonly epoch: string
}

export class CommandAttemptConflictError extends Data.TaggedError("CommandAttemptConflictError")<{}> {}
export class CommandAttemptStoreFullError extends Data.TaggedError("CommandAttemptStoreFullError")<{}> {}
export class CommandAttemptNotFoundError extends Data.TaggedError("CommandAttemptNotFoundError")<{}> {}

const decodeAdmission = Schema.decodeUnknownOption(CommandAttemptAdmission)
const decodeMutation = Schema.decodeUnknownOption(CommandAttemptMutation)
const decodeRows = Schema.decodeUnknownOption(CommandAttemptRows)
const decodeRow = Schema.decodeUnknownOption(Schema.NullOr(CommandAttemptRow))

const toAttempt = (row: CommandAttemptRow): CommandAttempt => ({
  instance_id: row.instanceId,
  operation_id: row.operationId,
  note_id: row.noteId,
  intent_text: row.intentText,
  base_revision: row.baseRevision,
  epoch: row.epoch,
  status: row.status,
  created_at_ms: row.createdAtMs,
  updated_at_ms: row.updatedAtMs,
  result_note: row.resultNote,
  expires_at_ms: row.expiresAtMs,
  error_code: row.errorCode,
  error_message: row.errorMessage,
  current_revision: row.currentRevision,
  dismissed: row.dismissed
})

export interface CommandAttemptSuccess {
  readonly resultNote: Note
  readonly expiresAtMs: number
}

export interface CommandAttemptRejection {
  readonly errorCode: string
  readonly errorMessage: string
  readonly currentRevision: Revision | null
}

export class CommandAttemptStore extends Context.Service<
  CommandAttemptStore,
  {
    readonly admit: (
      input: CommandAttemptInput
    ) => Effect.Effect<
      { readonly admitted: boolean; readonly attempt: CommandAttempt },
      LocalDatabaseWorkerError | CommandAttemptConflictError | CommandAttemptStoreFullError
    >
    readonly markSubmitted: (
      key: Pick<CommandAttemptInput, "instanceId" | "operationId">
    ) => Effect.Effect<CommandAttempt, LocalDatabaseWorkerError | CommandAttemptNotFoundError>
    readonly markUnresolved: (
      key: Pick<CommandAttemptInput, "instanceId" | "operationId">
    ) => Effect.Effect<CommandAttempt, LocalDatabaseWorkerError | CommandAttemptNotFoundError>
    readonly markSucceeded: (
      key: Pick<CommandAttemptInput, "instanceId" | "operationId"> & CommandAttemptSuccess
    ) => Effect.Effect<CommandAttempt, LocalDatabaseWorkerError | CommandAttemptNotFoundError>
    readonly markRejected: (
      key: Pick<CommandAttemptInput, "instanceId" | "operationId"> & CommandAttemptRejection
    ) => Effect.Effect<CommandAttempt, LocalDatabaseWorkerError | CommandAttemptNotFoundError>
    readonly list: (instanceId: string) => Effect.Effect<ReadonlyArray<CommandAttempt>, LocalDatabaseWorkerError>
    readonly get: (
      key: Pick<CommandAttemptInput, "instanceId" | "operationId">
    ) => Effect.Effect<CommandAttempt | undefined, LocalDatabaseWorkerError>
    readonly dismiss: (
      key: Pick<CommandAttemptInput, "instanceId" | "operationId">
    ) => Effect.Effect<CommandAttempt, LocalDatabaseWorkerError | CommandAttemptNotFoundError>
  }
>()("henshin/desktop/CommandAttemptStore") {
  static readonly layerFromWorker: Layer.Layer<CommandAttemptStore, never, LocalDatabaseWorker> = Layer.effect(
    CommandAttemptStore,
    Effect.gen(function*() {
      const worker = yield* LocalDatabaseWorker
      const call = (request: DraftWorkerRequest): Effect.Effect<unknown, LocalDatabaseWorkerError> =>
        worker.call(request)

      const admit = (input: CommandAttemptInput): Effect.Effect<
        { readonly admitted: boolean; readonly attempt: CommandAttempt },
        LocalDatabaseWorkerError | CommandAttemptConflictError | CommandAttemptStoreFullError
      > =>
        call({ op: "admitCommand", ...input }).pipe(
          Effect.flatMap((value): Effect.Effect<
            { readonly admitted: boolean; readonly attempt: CommandAttempt },
            LocalDatabaseWorkerError | CommandAttemptConflictError | CommandAttemptStoreFullError
          > => {
            const decoded = decodeAdmission(value)
            if (Option.isNone(decoded)) {
              return Effect.fail(new LocalDatabaseWorkerError({ message: "invalid command admission result" }))
            }
            switch (decoded.value.kind) {
              case "admitted":
                return Effect.succeed({ admitted: true, attempt: toAttempt(decoded.value.attempt) })
              case "existing":
                return Effect.succeed({ admitted: false, attempt: toAttempt(decoded.value.attempt) })
              case "conflict":
                return Effect.fail(new CommandAttemptConflictError())
              case "full":
                return Effect.fail(new CommandAttemptStoreFullError())
            }
          })
        )

      const mutation = (
        request: DraftWorkerRequest,
        operation: string
      ): Effect.Effect<CommandAttempt, LocalDatabaseWorkerError | CommandAttemptNotFoundError> =>
        call(request).pipe(
          Effect.flatMap((value): Effect.Effect<
            CommandAttempt,
            LocalDatabaseWorkerError | CommandAttemptNotFoundError
          > => {
            const decoded = decodeMutation(value)
            if (Option.isNone(decoded)) {
              return Effect.fail(new LocalDatabaseWorkerError({ message: `invalid ${operation} result` }))
            }
            if (decoded.value.kind === "not_found") return Effect.fail(new CommandAttemptNotFoundError())
            return Effect.succeed(toAttempt(decoded.value.attempt))
          })
        )

      const markSubmitted = (key: Pick<CommandAttemptInput, "instanceId" | "operationId">) =>
        mutation({ op: "markCommandSubmitted", ...key }, "mark submitted")

      const markUnresolved = (key: Pick<CommandAttemptInput, "instanceId" | "operationId">) =>
        mutation({ op: "markCommandUnresolved", ...key }, "mark unresolved")

      const markSucceeded = (
        key: Pick<CommandAttemptInput, "instanceId" | "operationId"> & CommandAttemptSuccess
      ) =>
        mutation(
          { op: "markCommandSucceeded", ...key, resultNote: key.resultNote, expiresAtMs: key.expiresAtMs },
          "mark succeeded"
        )

      const markRejected = (
        key: Pick<CommandAttemptInput, "instanceId" | "operationId"> & CommandAttemptRejection
      ) =>
        mutation(
          { op: "markCommandRejected", ...key, currentRevision: key.currentRevision },
          "mark rejected"
        )

      const list = (instanceId: string): Effect.Effect<ReadonlyArray<CommandAttempt>, LocalDatabaseWorkerError> =>
        call({ op: "listCommandAttempts", instanceId }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeRows(value)
            return Option.isNone(decoded)
              ? Effect.fail(new LocalDatabaseWorkerError({ message: "invalid command attempt list" }))
              : Effect.succeed(decoded.value.map(toAttempt))
          })
        )

      const get = (
        key: Pick<CommandAttemptInput, "instanceId" | "operationId">
      ): Effect.Effect<CommandAttempt | undefined, LocalDatabaseWorkerError> =>
        call({ op: "getCommandAttempt", ...key }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeRow(value)
            return Option.isNone(decoded)
              ? Effect.fail(new LocalDatabaseWorkerError({ message: "invalid command attempt read" }))
              : Effect.succeed(decoded.value === null ? undefined : toAttempt(decoded.value))
          })
        )

      const dismiss = (key: Pick<CommandAttemptInput, "instanceId" | "operationId">) =>
        mutation({ op: "dismissCommand", ...key }, "dismiss command")

      return CommandAttemptStore.of({
        admit,
        markSubmitted,
        markUnresolved,
        markSucceeded,
        markRejected,
        list,
        get,
        dismiss
      })
    })
  )
}
