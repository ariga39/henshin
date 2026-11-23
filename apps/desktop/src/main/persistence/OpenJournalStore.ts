import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import type { OpenEvent } from "@henshin/contracts/event"
import { LocalDatabaseWorker, LocalDatabaseWorkerError } from "./LocalDatabaseWorker"
import {
  OpenJournalAdmission,
  OpenJournalMutation,
  OpenJournalReadResult,
  OpenJournalRemoval,
  OpenJournalRows,
  type DraftWorkerRequest,
  type OpenJournalRow
} from "./draft-worker-protocol"

export interface OpenJournalInput {
  readonly instanceId: string
  readonly actionId: string
  readonly entryId: string
  readonly profileId?: string | null
  readonly deviceId: string
  readonly observedLocationRevision: string
  readonly observedContentVersion: string
}

export interface OpenJournalFailure {
  readonly failureCode: string
  readonly failureMessage: string
}

export class OpenJournalConflictError extends Data.TaggedError("OpenJournalConflictError")<{}> {}
export class OpenJournalNotFoundError extends Data.TaggedError("OpenJournalNotFoundError")<{}> {}
export class OpenJournalStoreFullError extends Data.TaggedError("OpenJournalStoreFullError")<{}> {}

const decodeAdmission = Schema.decodeUnknownOption(OpenJournalAdmission)
const decodeMutation = Schema.decodeUnknownOption(OpenJournalMutation)
const decodeRemoval = Schema.decodeUnknownOption(OpenJournalRemoval)
const decodeRows = Schema.decodeUnknownOption(OpenJournalRows)
const decodeRow = Schema.decodeUnknownOption(OpenJournalReadResult)

export class OpenJournalStore extends Context.Service<
  OpenJournalStore,
  {
    readonly prepare: (
      input: OpenJournalInput
    ) => Effect.Effect<
      { readonly admitted: boolean; readonly entry: OpenJournalRow },
      LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalStoreFullError
    >
    readonly recordAccepted: (
      key: Pick<OpenJournalInput, "instanceId" | "actionId">,
      event: OpenEvent
    ) => Effect.Effect<
      OpenJournalRow,
      LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalNotFoundError
    >
    readonly acknowledge: (
      key: Pick<OpenJournalInput, "instanceId" | "actionId">
    ) => Effect.Effect<
      OpenJournalRow,
      LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalNotFoundError
    >
    readonly hold: (
      key: Pick<OpenJournalInput, "instanceId" | "actionId"> & {
        readonly deliveryErrorCode: string
        readonly deliveryErrorMessage: string
      }
    ) => Effect.Effect<
      OpenJournalRow,
      LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalNotFoundError
    >
    readonly recordFailed: (
      key: Pick<OpenJournalInput, "instanceId" | "actionId"> & OpenJournalFailure
    ) => Effect.Effect<
      OpenJournalRow,
      LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalNotFoundError
    >
    readonly recordUnknown: (
      key: Pick<OpenJournalInput, "instanceId" | "actionId">
    ) => Effect.Effect<
      OpenJournalRow,
      LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalNotFoundError
    >
    readonly dismissUnknown: (
      key: Pick<OpenJournalInput, "instanceId" | "actionId">
    ) => Effect.Effect<void, LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalNotFoundError>
    readonly discardHeld: (
      key: Pick<OpenJournalInput, "instanceId" | "actionId">
    ) => Effect.Effect<void, LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalNotFoundError>
    readonly list: (instanceId: string) => Effect.Effect<ReadonlyArray<OpenJournalRow>, LocalDatabaseWorkerError>
    readonly get: (
      key: Pick<OpenJournalInput, "instanceId" | "actionId">
    ) => Effect.Effect<OpenJournalRow | undefined, LocalDatabaseWorkerError>
    readonly findLatestByEntry: (
      key: Pick<OpenJournalInput, "instanceId" | "entryId">
    ) => Effect.Effect<OpenJournalRow | undefined, LocalDatabaseWorkerError>
    readonly findUnresolvedByEntry: (
      key: Pick<OpenJournalInput, "instanceId" | "entryId">
    ) => Effect.Effect<OpenJournalRow | undefined, LocalDatabaseWorkerError>
  }
>()("henshin/desktop/OpenJournalStore") {
  static readonly layerFromWorker: Layer.Layer<OpenJournalStore, never, LocalDatabaseWorker> = Layer.effect(
    OpenJournalStore,
    Effect.gen(function*() {
      const worker = yield* LocalDatabaseWorker
      const call = (request: DraftWorkerRequest): Effect.Effect<unknown, LocalDatabaseWorkerError> =>
        worker.call(request)

      const prepare = (
        input: OpenJournalInput
      ): Effect.Effect<
        { readonly admitted: boolean; readonly entry: OpenJournalRow },
        LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalStoreFullError
      > =>
        call({ op: "prepareOpen", ...input, profileId: input.profileId ?? null }).pipe(
          Effect.flatMap((value): Effect.Effect<
            { readonly admitted: boolean; readonly entry: OpenJournalRow },
            LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalStoreFullError
          > => {
            const decoded = decodeAdmission(value)
            if (Option.isNone(decoded)) {
              return Effect.fail(new LocalDatabaseWorkerError({ message: "invalid open journal admission result" }))
            }
            switch (decoded.value.kind) {
              case "admitted":
                return Effect.succeed({ admitted: true, entry: decoded.value.entry })
              case "existing":
                return Effect.succeed({ admitted: false, entry: decoded.value.entry })
              case "conflict":
                return Effect.fail(new OpenJournalConflictError())
              case "full":
                return Effect.fail(new OpenJournalStoreFullError())
            }
          })
        )

      const mutation = (
        request: DraftWorkerRequest,
        operation: string
      ): Effect.Effect<
        OpenJournalRow,
        LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalNotFoundError
      > =>
        call(request).pipe(
          Effect.flatMap((value): Effect.Effect<
            OpenJournalRow,
            LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalNotFoundError
          > => {
            const decoded = decodeMutation(value)
            if (Option.isNone(decoded)) {
              return Effect.fail(new LocalDatabaseWorkerError({ message: `invalid ${operation} result` }))
            }
            switch (decoded.value.kind) {
              case "updated":
              case "existing":
                return Effect.succeed(decoded.value.entry)
              case "not_found":
                return Effect.fail(new OpenJournalNotFoundError())
              case "conflict":
                return Effect.fail(new OpenJournalConflictError())
            }
          })
        )

      const recordAccepted = (
        key: Pick<OpenJournalInput, "instanceId" | "actionId">,
        event: OpenEvent
      ) => mutation({ op: "recordOpenAccepted", ...key, event }, "record accepted open")

      const acknowledge = (
        key: Pick<OpenJournalInput, "instanceId" | "actionId">
      ) => mutation({ op: "acknowledgeOpenEvent", ...key }, "acknowledge open event")

      const hold = (
        key: Pick<OpenJournalInput, "instanceId" | "actionId"> & {
          readonly deliveryErrorCode: string
          readonly deliveryErrorMessage: string
        }
      ) => mutation({ op: "holdOpenEvent", ...key }, "hold open event")

      const recordFailed = (
        key: Pick<OpenJournalInput, "instanceId" | "actionId"> & OpenJournalFailure
      ) => mutation({ op: "recordOpenFailed", ...key }, "record failed open")

      const recordUnknown = (
        key: Pick<OpenJournalInput, "instanceId" | "actionId">
      ) => mutation({ op: "recordOpenUnknown", ...key }, "record unknown open")

      const removal = (
        request: DraftWorkerRequest,
        operation: string
      ): Effect.Effect<void, LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalNotFoundError> =>
        call(request).pipe(
          Effect.flatMap((value): Effect.Effect<
            void,
            LocalDatabaseWorkerError | OpenJournalConflictError | OpenJournalNotFoundError
          > => {
            const decoded = decodeRemoval(value)
            if (Option.isNone(decoded)) {
              return Effect.fail(new LocalDatabaseWorkerError({ message: `invalid ${operation} result` }))
            }
            switch (decoded.value.kind) {
              case "deleted":
                return Effect.succeed(undefined)
              case "not_found":
                return Effect.fail(new OpenJournalNotFoundError())
              case "conflict":
                return Effect.fail(new OpenJournalConflictError())
            }
          })
        )

      const dismissUnknown = (
        key: Pick<OpenJournalInput, "instanceId" | "actionId">
      ) => removal({ op: "dismissUnknownOpen", ...key }, "dismiss unknown open")

      const discardHeld = (
        key: Pick<OpenJournalInput, "instanceId" | "actionId">
      ) => removal({ op: "discardHeldOpenEvent", ...key }, "discard held open event")

      const list = (instanceId: string): Effect.Effect<ReadonlyArray<OpenJournalRow>, LocalDatabaseWorkerError> =>
        call({ op: "listOpenJournal", instanceId }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeRows(value)
            return Option.isNone(decoded)
              ? Effect.fail(new LocalDatabaseWorkerError({ message: "invalid open journal list" }))
              : Effect.succeed(decoded.value)
          })
        )

      const get = (
        key: Pick<OpenJournalInput, "instanceId" | "actionId">
      ): Effect.Effect<OpenJournalRow | undefined, LocalDatabaseWorkerError> =>
        call({ op: "getOpenJournal", ...key }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeRow(value)
            return Option.isNone(decoded)
              ? Effect.fail(new LocalDatabaseWorkerError({ message: "invalid open journal read" }))
              : Effect.succeed(decoded.value ?? undefined)
          })
        )

      const findLatestByEntry = (
        key: Pick<OpenJournalInput, "instanceId" | "entryId">
      ): Effect.Effect<OpenJournalRow | undefined, LocalDatabaseWorkerError> =>
        call({ op: "getLatestOpenJournalByEntry", ...key }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeRow(value)
            return Option.isNone(decoded)
              ? Effect.fail(new LocalDatabaseWorkerError({ message: "invalid latest open journal read" }))
              : Effect.succeed(decoded.value ?? undefined)
          })
        )

      const findUnresolvedByEntry = (
        key: Pick<OpenJournalInput, "instanceId" | "entryId">
      ): Effect.Effect<OpenJournalRow | undefined, LocalDatabaseWorkerError> =>
        call({ op: "getUnresolvedOpenJournalByEntry", ...key }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeRow(value)
            return Option.isNone(decoded)
              ? Effect.fail(new LocalDatabaseWorkerError({ message: "invalid unresolved open journal read" }))
              : Effect.succeed(decoded.value ?? undefined)
          })
        )

      return OpenJournalStore.of({
        prepare,
        recordAccepted,
        acknowledge,
        hold,
        recordFailed,
        recordUnknown,
        dismissUnknown,
        discardHeld,
        list,
        get,
        findLatestByEntry,
        findUnresolvedByEntry
      })
    })
  )
}
