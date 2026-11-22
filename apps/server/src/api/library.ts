import { Effect } from "effect"
import { EntryNotFound, InternalError, InvalidRequest, LibraryApi, RequestContext, RootNotFound } from "@henshin/contracts"
import { HttpApiBuilder } from "effect/http-api"
import { ServerState } from "../identity"
import { InvalidLibraryEntryResolutionCursor, LibraryStore } from "../persistence/LibraryStore"
import { RootStore } from "../persistence/RootStore"

const errorBase = (server: ServerState["Service"], requestId: string) => ({
  request_id: requestId,
  instance_id: server.instanceId,
  epoch: server.epoch
})

const rootView = (root: {
  libraryId: string
  rootId: string
  label: string
  selectedPath: string
  canonicalPath: string
  mappingRevision: string
  policyRevision: string
  exclusions: ReadonlyArray<{ readonly path: string; readonly scope: "exact" | "subtree" }>
  state: "active"
}) => ({
  library_id: root.libraryId,
  root_id: root.rootId,
  label: root.label,
  selected_server_path: root.selectedPath,
  canonical_server_path: root.canonicalPath,
  mapping_revision: root.mappingRevision,
  policy_revision: root.policyRevision,
  exclusions: root.exclusions,
  state: root.state
})

export const LibraryHandlers = HttpApiBuilder.group(LibraryApi, "library", (handlers) =>
  Effect.gen(function*() {
    const server = yield* ServerState
    const library = yield* LibraryStore
    const roots = yield* RootStore
    return handlers
      .handle("get", () =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const [summary, listedRoots] = yield* Effect.all([
            library.summary(),
            roots.list()
          ]).pipe(
            Effect.mapError(() => {
              return new InternalError({
                code: "internal_error",
                message: "internal error",
                retryable: false,
                ...errorBase(server, context.request_id)
              })
            })
          )
          return {
            ...errorBase(server, context.request_id),
            server_time: Date.now(),
            data: {
              library_id: summary.library_id,
              change_revision: summary.change_revision,
              roots: listedRoots.map(rootView)
            }
          }
        })
      )
      .handle("search", ({ payload }) =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const page = yield* library.page({
            pageSize: payload.page_size ?? 50,
            cursor: payload.cursor ?? null
          }).pipe(
            Effect.mapError(() => {
              return new InternalError({
                code: "internal_error",
                message: "internal error",
                retryable: false,
                ...errorBase(server, context.request_id)
              })
            })
          )
          return {
            ...errorBase(server, context.request_id),
            server_time: Date.now(),
            data: page
          }
        })
      )
      .handle("indexedSamples", ({ params }) =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const root = (yield* roots.list().pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...errorBase(server, context.request_id)
            }))
          )).find((candidate) => candidate.rootId === params.id)
          if (root === undefined) {
            return yield* new RootNotFound({
              code: "not_found",
              message: "root not found",
              retryable: false,
              ...errorBase(server, context.request_id)
            })
          }
          const page = yield* library.indexedRootSamples(params.id).pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...errorBase(server, context.request_id)
            }))
          )
          return {
            ...errorBase(server, context.request_id),
            server_time: Date.now(),
            data: page
          }
        })
      )
      .handle("resolution", ({ params, query }) =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const hasCursor = query.sibling_cursor !== undefined
          const hasRevision = query.sibling_claims_revision !== undefined
          if (hasCursor !== hasRevision) {
            return yield* new InvalidRequest({
              code: "invalid_request",
              message: "sibling cursor and sibling claims revision must be supplied together",
              retryable: false,
              details: { field: "sibling_cursor" },
              ...errorBase(server, context.request_id)
            })
          }
          const resolution = yield* library.resolution({
            entryId: params.id,
            siblingCursor: query.sibling_cursor,
            siblingClaimsRevision: query.sibling_claims_revision
          }).pipe(
            Effect.mapError((error) => error instanceof InvalidLibraryEntryResolutionCursor
              ? new InvalidRequest({
                code: "invalid_request",
                message: "sibling cursor is invalid or stale; restart sibling claims",
                retryable: false,
                details: { field: "sibling_cursor" },
                ...errorBase(server, context.request_id)
              })
              : new InternalError({
                code: "internal_error",
                message: "internal error",
                retryable: false,
                ...errorBase(server, context.request_id)
              }))
          )
          if (resolution === null) {
            return yield* new EntryNotFound({
              code: "not_found",
              message: "library entry not found",
              retryable: false,
              ...errorBase(server, context.request_id)
            })
          }
          return {
            ...errorBase(server, context.request_id),
            server_time: Date.now(),
            data: resolution
          }
        })
      )
  })
)
