import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import type { DiscardedDraft, SavedDraft, SavedDraftAbsent } from "@henshin/contracts"
import { LocalDatabaseWorker, LocalDatabaseWorkerError } from "./LocalDatabaseWorker"
import {
  DraftReadResult,
  DraftWriteOutcome,
  type DraftRow,
  type DraftWorkerRequest
} from "./draft-worker-protocol"

export class DraftConflictError extends Data.TaggedError("DraftConflictError")<{
  readonly currentLocalRevision: string
}> {}

export class DraftStoreFullError extends Data.TaggedError("DraftStoreFullError")<{}> {}

export interface DraftKey {
  readonly instanceId: string
  readonly noteId: string
  readonly formId: string
}

export interface SaveDraftInput extends DraftKey {
  readonly text: string
  readonly expectedLocalRevision: string
  readonly baseServerRevision: string
  readonly baseEpoch: string
}

const decodeRead = Schema.decodeUnknownOption(DraftReadResult)
const decodeWrite = Schema.decodeUnknownOption(DraftWriteOutcome)

const toSavedDraft = (row: DraftRow): SavedDraft => ({
  instance_id: row.instanceId,
  note_id: row.noteId,
  form_id: row.formId,
  text: row.text,
  local_revision: row.localRevision,
  base_server_revision: row.baseServerRevision,
  base_epoch: row.baseEpoch
})

export class DraftStore extends Context.Service<
  DraftStore,
  {
    readonly load: (key: DraftKey) => Effect.Effect<SavedDraft | SavedDraftAbsent | undefined, LocalDatabaseWorkerError>
    readonly save: (input: SaveDraftInput) => Effect.Effect<SavedDraft, LocalDatabaseWorkerError | DraftConflictError | DraftStoreFullError>
    readonly discard: (key: DraftKey & { readonly expectedLocalRevision: string }) => Effect.Effect<DiscardedDraft, LocalDatabaseWorkerError | DraftConflictError>
  }
>()("henshin/desktop/DraftStore") {
  static readonly layer = (dbPath: string, workerUrl: URL): Layer.Layer<DraftStore> =>
    Layer.effect(
      DraftStore,
      Effect.gen(function*() {
        const worker = yield* LocalDatabaseWorker

        const call = (request: DraftWorkerRequest): Effect.Effect<unknown, LocalDatabaseWorkerError> =>
          worker.call(request)

        const load = (key: DraftKey): Effect.Effect<SavedDraft | SavedDraftAbsent | undefined, LocalDatabaseWorkerError> =>
          call({ op: "load", ...key }).pipe(
            Effect.flatMap((value) => {
              const decoded = decodeRead(value)
              if (Option.isNone(decoded)) {
                return Effect.fail(new LocalDatabaseWorkerError({ message: "invalid draft read result" }))
              }
              if (decoded.value === null) return Effect.succeed(undefined)
              if ("kind" in decoded.value) {
                return Effect.succeed({
                  instance_id: decoded.value.instanceId,
                  note_id: decoded.value.noteId,
                  form_id: decoded.value.formId,
                  local_revision: decoded.value.localRevision
                } satisfies SavedDraftAbsent)
              }
              return Effect.succeed(toSavedDraft(decoded.value))
            })
          )

        const save = (input: SaveDraftInput): Effect.Effect<
          SavedDraft,
          LocalDatabaseWorkerError | DraftConflictError | DraftStoreFullError
        > =>
          call({ op: "save", ...input }).pipe(
            Effect.flatMap((value): Effect.Effect<
              SavedDraft,
              LocalDatabaseWorkerError | DraftConflictError | DraftStoreFullError
            > => {
              const decoded = decodeWrite(value)
              if (Option.isNone(decoded)) {
                return Effect.fail(new LocalDatabaseWorkerError({ message: "invalid draft save result" }))
              }
              switch (decoded.value.kind) {
                case "saved":
                  return Effect.succeed(toSavedDraft(decoded.value.draft))
                case "conflict":
                  return Effect.fail(new DraftConflictError({ currentLocalRevision: decoded.value.currentLocalRevision }))
                case "full":
                  return Effect.fail(new DraftStoreFullError())
                case "discarded":
                  return Effect.fail(new LocalDatabaseWorkerError({ message: "unexpected discard result" }))
              }
            })
          )

        const discard = (input: DraftKey & { readonly expectedLocalRevision: string }): Effect.Effect<
          DiscardedDraft,
          LocalDatabaseWorkerError | DraftConflictError
        > =>
          call({ op: "discard", ...input }).pipe(
            Effect.flatMap((value): Effect.Effect<
              DiscardedDraft,
              LocalDatabaseWorkerError | DraftConflictError
            > => {
              const decoded = decodeWrite(value)
              if (Option.isNone(decoded)) {
                return Effect.fail(new LocalDatabaseWorkerError({ message: "invalid draft discard result" }))
              }
              switch (decoded.value.kind) {
                case "discarded":
                  return Effect.succeed({
                    instance_id: decoded.value.instanceId,
                    note_id: decoded.value.noteId,
                    form_id: decoded.value.formId,
                    local_revision: decoded.value.localRevision
                  } satisfies DiscardedDraft)
                case "conflict":
                  return Effect.fail(new DraftConflictError({ currentLocalRevision: decoded.value.currentLocalRevision }))
                case "saved":
                case "full":
                  return Effect.fail(new LocalDatabaseWorkerError({ message: "unexpected draft result" }))
              }
            })
          )

        return DraftStore.of({ load, save, discard })
      })
    ).pipe(Layer.provide(LocalDatabaseWorker.layer(dbPath, { workerUrl })))
}
