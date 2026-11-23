import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { EntryResolution, INDEXED_ROOT_SAMPLE_LIMIT, IndexedRootSamplePage, LibraryEntryPage, StagedDiscovery } from "@henshin/contracts"
import { DatabaseWorker, DatabaseWorkerError } from "./DatabaseWorker"
import {
  AcceptedThumbnailEntryRow,
  IndexedRootSamplePageRow,
  LibraryEntryPageResult,
  LibraryEntryResolutionResult,
  LibraryEntryDetailsRow,
  BindEntryOutcome,
  PersonalTitleOutcome,
  LibrarySummaryRow,
  EntryResolutionLookupOutcome,
  ResolveReplacementOutcome
} from "./worker-protocol"

export interface ReplacementResolutionInput {
  readonly candidateId: string
  readonly rootId: string
  readonly entryId: string
  readonly operationId: string
  readonly epoch: string
  readonly decision: "keep" | "replace"
  readonly expectedCandidateVersion: number
  readonly expectedDecisionVersion: string
  readonly expectedLocationRevision: string
  readonly expectedMappingRevision: string
  readonly expectedPolicyRevision: string
}

export type ReplacementResolutionResult =
  | Extract<typeof ResolveReplacementOutcome.Type, { readonly kind: "committed" | "replayed" }> & {
      readonly candidate: StagedDiscovery
    }
  | Exclude<typeof ResolveReplacementOutcome.Type, { readonly kind: "committed" | "replayed" }>

export type EntryResolutionLookupResult =
  | Extract<ReplacementResolutionResult, { readonly kind: "replayed" }>
  | { readonly kind: "operation_conflict" | "operation_expired" | "not_found" }

const decodeSummary = Schema.decodeUnknownOption(LibrarySummaryRow)
const decodePage = Schema.decodeUnknownOption(LibraryEntryPageResult)
const decodeResolution = Schema.decodeUnknownOption(LibraryEntryResolutionResult)
const decodeAcceptedThumbnailEntry = Schema.decodeUnknownOption(Schema.NullOr(AcceptedThumbnailEntryRow))
const decodeIndexedRootSamples = Schema.decodeUnknownOption(IndexedRootSamplePageRow)
const decodeReplacement = Schema.decodeUnknownOption(ResolveReplacementOutcome)
const decodeEntryResolutionLookup = Schema.decodeUnknownOption(EntryResolutionLookupOutcome)
const decodeEntryDetailsResult = Schema.decodeUnknownOption(Schema.NullOr(LibraryEntryDetailsRow))
const decodeBindEntry = Schema.decodeUnknownOption(BindEntryOutcome)
const decodePersonalTitle = Schema.decodeUnknownOption(PersonalTitleOutcome)
const decodeStaged = Schema.decodeUnknownOption(StagedDiscovery)

const jsonValue = (value: string | null): unknown => {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

export class InvalidLibraryEntryResolutionCursor extends Data.TaggedError("InvalidLibraryEntryResolutionCursor")<{}> {}
export class InvalidLibrarySearchCursor extends Data.TaggedError("InvalidLibrarySearchCursor")<{}> {}

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
    readonly page: (input: {
      readonly pageSize: number
      readonly query: string
      readonly cursor: string | null
      readonly state?: "replacement-pending"
      readonly epoch: string
    }) => Effect.Effect<LibraryEntryPage, DatabaseWorkerError | InvalidLibrarySearchCursor>
    readonly entry: (entryId: string) => Effect.Effect<import("@henshin/contracts").LibraryEntryDetails | null, DatabaseWorkerError>
    readonly bindEntry: (input: {
      readonly entryId: string
      readonly operationId: string
      readonly epoch: string
      readonly expectedDecisionVersion: string
      readonly source: "EH"
      readonly gid: string
      readonly token: string
      readonly preferredDomain: "e-hentai.org" | "exhentai.org"
      readonly canonicalUrl: string
    }) => Effect.Effect<typeof BindEntryOutcome.Type, DatabaseWorkerError>
    readonly updatePersonalTitle: (input: {
      readonly entryId: string
      readonly operationId: string
      readonly epoch: string
      readonly expectedDecisionVersion: string
      readonly command:
        | { readonly type: "set-personal-title"; readonly title: string }
        | { readonly type: "remove-personal-title" }
    }) => Effect.Effect<typeof PersonalTitleOutcome.Type, DatabaseWorkerError>
    readonly indexedRootSamples: (rootId: string) => Effect.Effect<IndexedRootSamplePage, DatabaseWorkerError>
    readonly resolution: (input: {
      readonly entryId: string
      readonly siblingCursor?: string
      readonly siblingClaimsRevision?: string
    }) => Effect.Effect<EntryResolution | null, DatabaseWorkerError | InvalidLibraryEntryResolutionCursor>
    readonly acceptedThumbnailEntry: (entryId: string) => Effect.Effect<typeof AcceptedThumbnailEntryRow.Type | null, DatabaseWorkerError>
    readonly lookupReplacementOperation: (input: ReplacementResolutionInput) => Effect.Effect<
      EntryResolutionLookupResult,
      DatabaseWorkerError
    >
    readonly resolveReplacement: (input: ReplacementResolutionInput & {
      readonly freshManifestJson: string | null
    }) => Effect.Effect<ReplacementResolutionResult, DatabaseWorkerError>
  }
>()("henshin/server/LibraryStore") {
  static readonly layer: Layer.Layer<LibraryStore, never, DatabaseWorker> = Layer.effect(
    LibraryStore,
    Effect.gen(function*() {
      const worker = yield* DatabaseWorker
      const summary = () => worker.call({ op: "readLibrary" }).pipe(
        Effect.flatMap((value) => decodeOrFail(decodeSummary, value, "invalid library summary"))
      )
      const page = (input: {
        readonly pageSize: number
        readonly query: string
        readonly cursor: string | null
        readonly state?: "replacement-pending"
        readonly epoch: string
      }) => worker.call({
        op: "listLibraryEntries",
        pageSize: input.pageSize,
        query: input.query,
        epoch: input.epoch,
        cursor: input.cursor,
        state: input.state ?? null
      }).pipe(
        Effect.flatMap((value) => decodeOrFail(decodePage, value, "invalid library entry page")),
        Effect.flatMap((result): Effect.Effect<LibraryEntryPage, DatabaseWorkerError | InvalidLibrarySearchCursor> =>
          result.kind === "invalid_cursor"
            ? Effect.fail(new InvalidLibrarySearchCursor())
            : Effect.succeed(result.page)
        )
      )
      const entry = (entryId: string) => worker.call({ op: "readEntry", entryId }).pipe(
        Effect.flatMap((value) => decodeOrFail(decodeEntryDetailsResult, value, "invalid library entry details"))
      )
      const bindEntry = (input: Parameters<LibraryStore["Service"]["bindEntry"]>[0]) => worker.call({
        op: "bindEntry",
        ...input
      }).pipe(
        Effect.flatMap((value) => decodeOrFail(decodeBindEntry, value, "invalid bind entry result"))
      )
      const updatePersonalTitle = (input: Parameters<LibraryStore["Service"]["updatePersonalTitle"]>[0]) => worker.call({
        op: "updatePersonalTitle",
        ...input
      }).pipe(
        Effect.flatMap((value) => decodeOrFail(decodePersonalTitle, value, "invalid personal title result"))
      )
      const resolution = (input: {
        readonly entryId: string
        readonly siblingCursor?: string
        readonly siblingClaimsRevision?: string
      }): Effect.Effect<EntryResolution | null, DatabaseWorkerError | InvalidLibraryEntryResolutionCursor> => worker.call({
          op: "readEntryResolution",
          entryId: input.entryId,
          siblingCursor: input.siblingCursor,
          siblingClaimsRevision: input.siblingClaimsRevision
        }).pipe(
        Effect.mapError((error): DatabaseWorkerError | InvalidLibraryEntryResolutionCursor => error),
        Effect.flatMap((value): Effect.Effect<EntryResolution | null, DatabaseWorkerError | InvalidLibraryEntryResolutionCursor> => {
          const decoded = decodeResolution(value)
          if (Option.isNone(decoded)) return Effect.fail(new DatabaseWorkerError({ message: "invalid entry resolution" }))
          const result = decoded.value
          return result !== null && typeof result === "object" && "kind" in result && result.kind === "invalid_cursor"
            ? Effect.fail(new InvalidLibraryEntryResolutionCursor())
            : Effect.succeed(result as EntryResolution | null)
        })
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
      const normalizeReplacementResult = (
        result: typeof ResolveReplacementOutcome.Type
      ): Effect.Effect<ReplacementResolutionResult, DatabaseWorkerError> => {
        if (result.kind !== "committed" && result.kind !== "replayed") {
          return Effect.succeed(result as Exclude<ReplacementResolutionResult, { readonly kind: "committed" | "replayed" }>)
        }
        const candidate = decodeStaged({
          candidate_id: result.candidate.candidate_id,
          task_id: result.candidate.task_id,
          root_id: result.candidate.root_id,
          relative_path: result.candidate.relative_path,
          kind: result.candidate.kind,
          candidate_version: result.candidate.candidate_version,
          hold_state: result.candidate.hold_state,
          analysis_status: result.candidate.analysis_status,
          manifest: jsonValue(result.candidate.manifest_json),
          analysis_error: jsonValue(result.candidate.analysis_error_json),
          updated_at_ms: result.candidate.updated_at_ms
        })
        return Option.isNone(candidate)
          ? Effect.fail(new DatabaseWorkerError({ message: "invalid persisted replacement candidate" }))
          : Effect.succeed({ ...result, candidate: candidate.value } as ReplacementResolutionResult)
      }
      const lookupReplacementOperation = (input: ReplacementResolutionInput): Effect.Effect<EntryResolutionLookupResult, DatabaseWorkerError> =>
        worker.call({ op: "lookupEntryResolution", ...input }).pipe(
          Effect.flatMap((value) => decodeOrFail(
            decodeEntryResolutionLookup,
            value,
            "invalid replacement resolution lookup result"
          )),
          Effect.flatMap((result): Effect.Effect<EntryResolutionLookupResult, DatabaseWorkerError> => {
            if (result.kind !== "replayed") {
              return Effect.succeed(result as Exclude<EntryResolutionLookupResult, { readonly kind: "replayed" }>)
            }
            return normalizeReplacementResult(result as typeof ResolveReplacementOutcome.Type) as Effect.Effect<
              Extract<ReplacementResolutionResult, { readonly kind: "replayed" }>,
              DatabaseWorkerError
            >
          })
        )
      const resolveReplacement = (input: Parameters<LibraryStore["Service"]["resolveReplacement"]>[0]) =>
        worker.call({ op: "resolveReplacement", ...input }).pipe(
          Effect.flatMap((value) => decodeOrFail(decodeReplacement, value, "invalid replacement resolution result")),
          Effect.flatMap(normalizeReplacementResult)
        )
      return LibraryStore.of({
        acceptedThumbnailEntry,
        indexedRootSamples,
        lookupReplacementOperation,
        resolution,
        resolveReplacement,
        bindEntry,
        updatePersonalTitle,
        entry,
        summary,
        page
      })
    })
  )
}
