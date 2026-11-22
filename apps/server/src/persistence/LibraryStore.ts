import { Context, Effect, Layer, Option, Schema } from "effect"
import { LibraryEntryPage } from "@henshin/contracts"
import { DatabaseWorker, DatabaseWorkerError } from "./DatabaseWorker"
import { LibraryEntryPageRow, LibrarySummaryRow } from "./worker-protocol"

const decodeSummary = Schema.decodeUnknownOption(LibrarySummaryRow)
const decodePage = Schema.decodeUnknownOption(LibraryEntryPageRow)

const decodeOrFail = <A>(decoder: (value: unknown) => Option.Option<A>, value: unknown, message: string): Effect.Effect<A, DatabaseWorkerError> => {
  const decoded = decoder(value)
  return Option.isNone(decoded)
    ? Effect.fail(new DatabaseWorkerError({ message }))
    : Effect.succeed(decoded.value)
}

export class LibraryStore extends Context.Service<
  LibraryStore,
  {
    readonly summary: () => Effect.Effect<typeof LibrarySummaryRow.Type, DatabaseWorkerError>
    readonly page: (input: { readonly pageSize: number; readonly cursor: string | null }) => Effect.Effect<LibraryEntryPage, DatabaseWorkerError>
  }
>()("henshin/server/LibraryStore") {
  static readonly layer: Layer.Layer<LibraryStore, never, DatabaseWorker> = Layer.effect(
    LibraryStore,
    Effect.gen(function*() {
      const worker = yield* DatabaseWorker
      const summary = () => worker.call({ op: "readLibrary" }).pipe(
        Effect.flatMap((value) => decodeOrFail(decodeSummary, value, "invalid library summary"))
      )
      const page = (input: { readonly pageSize: number; readonly cursor: string | null }) => worker.call({
        op: "listLibraryEntries",
        pageSize: input.pageSize,
        cursor: input.cursor
      }).pipe(
        Effect.flatMap((value) => decodeOrFail(decodePage, value, "invalid library entry page"))
      )
      return LibraryStore.of({ summary, page })
    })
  )
}
