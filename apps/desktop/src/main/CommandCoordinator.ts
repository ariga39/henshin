import { Data, Duration, Effect, Option, Result, Schema } from "effect"
import type {
  CommandAttempt,
  CommandReconciliation,
  Note,
  NoteView,
  OperationResult
} from "@henshin/contracts"
import { PrototypeHttpClient, PublicApiError } from "@henshin/contracts"
import {
  CommandAttemptStore,
  type CommandAttemptInput
} from "./persistence/CommandAttemptStore"

const COMMAND_DEADLINE = Duration.seconds(5)

export interface VerifiedSession {
  readonly instanceId: string
  readonly epoch: string
}

export interface NoteEditInput {
  readonly noteId: string
  readonly text: string
  readonly expectedRevision: string
  readonly operationId: string
}

export type BeforeNetworkDispatch = () => void

export type NoteCommandClient = Pick<
  PrototypeHttpClient["Service"],
  "editNote" | "getOperation" | "getNote"
>

export class CommandAttemptUnresolvedError extends Data.TaggedError("CommandAttemptUnresolvedError")<{
  readonly operationId: string
}> {}

export class StoredCommandRejectionError extends Data.TaggedError("StoredCommandRejectionError")<{
  readonly code: string
  readonly message: string
  readonly currentRevision: string | null
}> {}

const timeoutRead = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A | undefined> =>
  effect.pipe(
    Effect.result,
    Effect.timeoutOption(COMMAND_DEADLINE),
    Effect.map((value) =>
      Option.match(value, {
        onNone: () => undefined,
        onSome: (result) => (Result.isSuccess(result) ? result.success : undefined)
      })
    )
  )

const decodePublicError = Schema.decodeUnknownOption(PublicApiError)

const publicError = (error: unknown): typeof PublicApiError.Type | undefined => {
  const decoded = decodePublicError(error)
  return Option.isNone(decoded) ? undefined : decoded.value
}

/**
 * These server schemas establish a definitive no-write rejection. Epoch and
 * operation-expiry answers are deliberately excluded: they require a
 * read-only reconciliation even though the individual response is a no-write
 * answer, because the prior authority/result guarantee is no longer usable.
 */
const isDefinitiveNoWrite = (error: unknown): boolean =>
  (() => {
    const decoded = publicError(error)
    return (
      decoded !== undefined &&
      decoded.retryable === false &&
      decoded._tag !== "InternalError" &&
      decoded._tag !== "EpochChanged" &&
      decoded._tag !== "InstanceMismatch" &&
      decoded._tag !== "OperationExpired"
    )
  })()

const errorCode = (error: unknown): string => {
  return publicError(error)?.code ?? "rejected"
}

const errorMessage = (error: unknown): string => {
  return publicError(error)?.message.slice(0, 256) ?? "server rejected the command"
}

const currentRevision = (error: unknown): string | null => {
  const decoded = publicError(error)
  return decoded?._tag === "RevisionConflict" ? decoded.details.current_revision : null
}

const inputFor = (session: VerifiedSession, input: NoteEditInput): CommandAttemptInput => ({
  instanceId: session.instanceId,
  operationId: input.operationId,
  noteId: input.noteId,
  intentText: input.text,
  baseRevision: input.expectedRevision,
  epoch: session.epoch
})

const storedResult = (attempt: CommandAttempt): NoteView | undefined =>
  attempt.status === "succeeded" && attempt.result_note !== null
    ? attempt.result_note
    : undefined

const storedOperationResult = (attempt: CommandAttempt): OperationResult | null =>
  attempt.result_note === null || attempt.expires_at_ms === null
    ? null
    : {
        operation_id: attempt.operation_id,
        note: attempt.result_note,
        expires_at_ms: attempt.expires_at_ms
      }

const markUnresolved = (
  store: CommandAttemptStore["Service"],
  session: VerifiedSession,
  operationId: string
): Effect.Effect<never, CommandAttemptUnresolvedError, never> =>
  store
    .markUnresolved({ instanceId: session.instanceId, operationId })
    .pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.flatMap(() => Effect.fail(new CommandAttemptUnresolvedError({ operationId })))
    )

/**
 * Main-owned command admission and dispatch. The supplied client is already
 * constructed from main-owned endpoint/authentication state; the renderer only
 * supplies the bounded note intent and operation ID.
 */
export const executeNoteEdit = (
  client: NoteCommandClient,
  store: CommandAttemptStore["Service"],
  session: VerifiedSession,
  input: NoteEditInput,
  beforeDispatch?: BeforeNetworkDispatch
): Effect.Effect<NoteView, unknown> =>
  Effect.gen(function*() {
    let phase: "admitting" | "submitted" | "dispatching" = "admitting"
    const admitted = yield* store.admit(inputFor(session, input))
    if (!admitted.admitted) {
      const existingResult = storedResult(admitted.attempt)
      if (existingResult !== undefined) return existingResult
      if (admitted.attempt.status === "rejected") {
        return yield* new StoredCommandRejectionError({
          code: admitted.attempt.error_code ?? "rejected",
          message: admitted.attempt.error_message ?? "server rejected the command",
          currentRevision: admitted.attempt.current_revision
        })
      }
      return yield* new CommandAttemptUnresolvedError({ operationId: input.operationId })
    }

    // This short local transition is part of admission. If it cannot be
    // persisted, no HTTP dispatch is attempted and the prepared row remains.
    // The phase write is inside the uninterruptible bookkeeping region so an
    // interruption cannot lose the proof that the local row became submitted.
    const localKey = { instanceId: session.instanceId, operationId: input.operationId }
    const localAdmission = Effect.uninterruptible(
      store.markSubmitted(localKey).pipe(
        Effect.tap(() => Effect.sync(() => {
          phase = "submitted"
        }))
      )
    )
    const response = yield* Effect.gen(function*() {
      yield* localAdmission
      if (beforeDispatch !== undefined) {
        yield* Effect.try({ try: beforeDispatch, catch: (error) => error })
      }
      yield* Effect.uninterruptible(Effect.sync(() => {
        phase = "dispatching"
      }))
      return yield* client
        .editNote({
          params: { id: input.noteId },
          payload: {
            operation_id: input.operationId,
            expected_revision: input.expectedRevision,
            text: input.text,
            instance_id: session.instanceId,
            epoch: session.epoch
          }
        })
        .pipe(Effect.result, Effect.timeoutOption(COMMAND_DEADLINE))
    }).pipe(
      Effect.ensuring(
        Effect.uninterruptible(
          Effect.suspend(() =>
            phase === "submitted"
              ? store.markRejected({
                  ...localKey,
                  errorCode: "not_dispatched",
                  errorMessage: "command was not dispatched",
                  currentRevision: null
                }).pipe(
                  Effect.asVoid,
                  Effect.catch(() => Effect.void)
                )
              : Effect.void
          )
        )
      )
    )

    if (Option.isNone(response)) {
      return yield* markUnresolved(store, session, input.operationId)
    }
    if (Result.isFailure(response.value)) {
      const failure = response.value.failure
      if (!isDefinitiveNoWrite(failure)) {
        return yield* markUnresolved(store, session, input.operationId)
      }
      const persisted = yield* store
        .markRejected({
          instanceId: session.instanceId,
          operationId: input.operationId,
          errorCode: errorCode(failure),
          errorMessage: errorMessage(failure),
          currentRevision: currentRevision(failure)
        })
        .pipe(Effect.result)
      if (Result.isFailure(persisted)) {
        return yield* markUnresolved(store, session, input.operationId)
      }
      return yield* Effect.fail(failure)
    }

    const result = response.value.success.data
    const persisted = yield* store
      .markSucceeded({
        instanceId: session.instanceId,
        operationId: input.operationId,
        resultNote: result.note,
        expiresAtMs: result.expires_at_ms
      })
      .pipe(Effect.result)
    if (Result.isFailure(persisted) || persisted.success.status !== "succeeded") {
      return yield* markUnresolved(store, session, input.operationId)
    }
    return result.note
  })
const readCurrentNote = (
  client: NoteCommandClient,
  noteId: string
): Effect.Effect<Note | null> =>
  timeoutRead(client.getNote({ params: { id: noteId } })).pipe(
    Effect.map((envelope) => (envelope === undefined ? null : envelope.data))
  )

type OperationStatusObservation =
  | { readonly kind: "found"; readonly data: OperationResult }
  | { readonly kind: "expired" }
  | { readonly kind: "unavailable" }

const readOperationStatus = (
  client: NoteCommandClient,
  session: VerifiedSession,
  operationId: string
): Effect.Effect<OperationStatusObservation> =>
  client
    .getOperation({
      params: { id: operationId },
      query: { instance_id: session.instanceId, epoch: session.epoch }
    })
    .pipe(
      Effect.result,
      Effect.timeoutOption(COMMAND_DEADLINE),
      Effect.map((value): OperationStatusObservation => {
        if (Option.isNone(value)) return { kind: "unavailable" }
        if (Result.isSuccess(value.value)) return { kind: "found", data: value.value.success.data }
        return publicError(value.value.failure)?._tag === "OperationExpired"
          ? { kind: "expired" }
          : { kind: "unavailable" }
      })
    )

/** Explicit recovery: all network operations here are reads, never mutation. */
export const reconcileNoteCommand = (
  client: NoteCommandClient,
  store: CommandAttemptStore["Service"],
  session: VerifiedSession,
  operationId: string
): Effect.Effect<CommandReconciliation, unknown> =>
  Effect.gen(function*() {
    const loaded = yield* store.get({ instanceId: session.instanceId, operationId })
    if (loaded === undefined) return yield* new CommandAttemptUnresolvedError({ operationId })

    let attempt = loaded
    let serverResult: OperationResult | null = storedOperationResult(attempt)
    let reconciliationReason: CommandReconciliation["reconciliation_reason"] =
      attempt.epoch !== session.epoch
        ? "changed_epoch"
        : attempt.status === "succeeded" && serverResult !== null
          ? "complete"
          : "query_unavailable"
    if (attempt.status !== "succeeded" && attempt.status !== "rejected" && attempt.epoch === session.epoch) {
      const status = yield* readOperationStatus(client, session, operationId)
      if (status.kind === "found") {
        serverResult = status.data
        const saved = yield* store
          .markSucceeded({
            instanceId: session.instanceId,
            operationId,
            resultNote: status.data.note,
            expiresAtMs: status.data.expires_at_ms
          })
          .pipe(Effect.result)
        if (Result.isSuccess(saved) && saved.success.status === "succeeded") {
          attempt = saved.success
          reconciliationReason = "complete"
        } else {
          reconciliationReason = "persistence_failed"
        }
      } else {
        const saved = yield* store
          .markUnresolved({ instanceId: session.instanceId, operationId })
          .pipe(Effect.result)
        if (Result.isSuccess(saved)) {
          attempt = saved.success
          // A concurrent dispatcher may have durably won before this
          // unresolved transition. Recompute the outcome from the row the
          // conditional transition actually returned instead of retaining
          // the stale absence observed by reconciliation.
          const persistedResult = storedOperationResult(attempt)
          if (persistedResult !== null) {
            serverResult = persistedResult
            reconciliationReason = "complete"
          } else {
            reconciliationReason = status.kind === "expired"
              ? "operation_expired"
              : "query_unavailable"
          }
        } else {
          reconciliationReason = "persistence_failed"
        }
      }
    }

    // Observe the resource after the operation-status decision. This keeps the
    // returned snapshot useful for reconciliation without treating it as a
    // proof that a fresh mutation would be safe.
    const currentNote = yield* readCurrentNote(client, attempt.note_id)
    const terminal =
      attempt.status === "rejected" ||
      (attempt.status === "succeeded" && serverResult !== null)
    if (terminal) reconciliationReason = "complete"
    return {
      attempt,
      current_note: currentNote,
      server_result: serverResult,
      requires_reconciliation: !terminal,
      reconciliation_reason: reconciliationReason
    }
  })
