import { Context, Effect, Layer, Option, Schema } from "effect"
import { DatabaseWorker, DatabaseWorkerError } from "./DatabaseWorker"
import { CommitOutcome, ReadNoteResult, type NoteRow } from "./worker-protocol"

export interface CommitNoteInput {
  readonly noteId: string
  readonly text: string
  readonly expectedRevision: string
  readonly operationId: string
  readonly epoch: string
}

const decodeReadNote = Schema.decodeUnknownOption(ReadNoteResult)
const decodeCommitOutcome = Schema.decodeUnknownOption(CommitOutcome)

/**
 * Transaction-sized store operations. Callers never compose several writes;
 * `commitNote` performs the conditional write and the operation-result insert in
 * one worker transaction. Worker payloads are re-validated at this boundary.
 */
export class NoteStore extends Context.Service<
  NoteStore,
  {
    readonly readNote: (noteId: string) => Effect.Effect<NoteRow | undefined, DatabaseWorkerError>
    readonly commitNote: (input: CommitNoteInput) => Effect.Effect<CommitOutcome, DatabaseWorkerError>
  }
>()("henshin/server/NoteStore") {
  static readonly layer: Layer.Layer<NoteStore, never, DatabaseWorker> = Layer.effect(
    NoteStore,
    Effect.gen(function*() {
      const worker = yield* DatabaseWorker

      const readNote = (noteId: string) =>
        worker.call({ op: "readNote", noteId }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeReadNote(value)
            if (Option.isNone(decoded)) {
              return Effect.fail(new DatabaseWorkerError({ message: "invalid read-note result" }))
            }
            return Effect.succeed(decoded.value === null ? undefined : decoded.value)
          })
        )

      const commitNote = (input: CommitNoteInput) =>
        worker.call({ op: "commitNote", ...input }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeCommitOutcome(value)
            if (Option.isNone(decoded)) {
              return Effect.fail(new DatabaseWorkerError({ message: "invalid commit-note result" }))
            }
            return Effect.succeed(decoded.value)
          })
        )

      return NoteStore.of({ readNote, commitNote })
    })
  )
}
