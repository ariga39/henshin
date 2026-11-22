import { Context, Effect, Layer, Option, Schema } from "effect"
import { EntryResolution, INDEXED_ROOT_SAMPLE_LIMIT, IndexedRootSamplePage, LibraryEntryPage } from "@henshin/contracts"
import { DatabaseWorker, DatabaseWorkerError } from "./DatabaseWorker"
import {
  AcceptedThumbnailEntryRow,
  IndexedRootSamplePageRow,
  LibraryEntryPageRow,
  LibraryEntryResolutionRow,
  LibrarySummaryRow
} from "./worker-protocol"

const decodeSummary = Schema.decodeUnknownOption(LibrarySummaryRow)
const decodePage = Schema.decodeUnknownOption(LibraryEntryPageRow)
const decodeAcceptedThumbnailEntry = Schema.decodeUnknownOption(Schema.NullOr(AcceptedThumbnailEntryRow))
const decodeIndexedRootSamples = Schema.decodeUnknownOption(IndexedRootSamplePageRow)
const decodeResolution = Schema.decodeUnknownOption(LibraryEntryResolutionRow)

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
    readonly indexedRootSamples: (rootId: string) => Effect.Effect<IndexedRootSamplePage, DatabaseWorkerError>
    readonly acceptedThumbnailEntry: (entryId: string) => Effect.Effect<typeof AcceptedThumbnailEntryRow.Type | null, DatabaseWorkerError>
    readonly resolution: (input: {
      readonly entryId: string
      readonly siblingCursor?: string
      readonly siblingClaimsRevision?: string
    }) => Effect.Effect<EntryResolution | null, DatabaseWorkerError>
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
      const resolution = (input: {
        readonly entryId: string
        readonly siblingCursor?: string
        readonly siblingClaimsRevision?: string
      }) => worker.call({
        op: "readEntryResolution",
        entryId: input.entryId,
        siblingCursor: input.siblingCursor,
        siblingClaimsRevision: input.siblingClaimsRevision
      }).pipe(
        Effect.flatMap((value) => decodeOrFail(decodeResolution, value, "invalid entry resolution")),
        Effect.map((row) => row === null ? null : row)
      )
      const acceptedThumbnailEntry = (entryId: string) => worker.call({
        op: "readAcceptedThumbnailEntry",
        entryId
      }).pipe(
        Effect.flatMap((value) => decodeOrFail(decodeAcceptedThumbnailEntry, value, "invalid accepted thumbnail entry"))
      )
      const indexedRootSamples = (rootId: string) => worker.call({
        op: "listIndexedRootSamples",
        rootId,
        sampleLimit: INDEXED_ROOT_SAMPLE_LIMIT + 1
      }).pipe(
        Effect.flatMap((value) => decodeOrFail(decodeIndexedRootSamples, value, "invalid indexed root samples result")),
        Effect.map((page) => ({ root_id: rootId, sample_limit: INDEXED_ROOT_SAMPLE_LIMIT, ...page }))
      )
      return LibraryStore.of({ acceptedThumbnailEntry, indexedRootSamples, resolution, summary, page })
    })
  )
}
