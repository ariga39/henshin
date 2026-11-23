import { Effect } from "effect"
import {
  EntryNotFound,
  EpochChanged,
  InstanceMismatch,
  InternalError,
  InvalidRequest,
  LibraryApi,
  OperationConflict,
  OperationExpired,
  RequestContext,
  RevisionConflict,
  RootNotFound,
  StorageFull
} from "@henshin/contracts"
import { HttpApiBuilder } from "effect/http-api"
import { ServerState } from "../identity"
import { InvalidLibraryEntryResolutionCursor, InvalidLibrarySearchCursor, InvalidLibrarySearchFilter, LibraryStore } from "../persistence/LibraryStore"
import { RootStore } from "../persistence/RootStore"
import { parseCanonicalEhGalleryUrl } from "../eh-url"

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
            query: payload.query ?? "",
            tagQuery: payload.tag_query ?? "",
            cursor: payload.cursor ?? null,
            state: payload.state,
            includeTags: payload.include_tags ?? [],
            excludeTags: payload.exclude_tags ?? [],
            epoch: server.epoch
          }).pipe(
            Effect.mapError((error) => {
              if (error instanceof InvalidLibrarySearchCursor) {
                return new InvalidRequest({
                  code: "invalid_request",
                  message: "search cursor is invalid or fenced to a different query; restart search",
                  retryable: false,
                  details: { field: "cursor" },
                  ...errorBase(server, context.request_id)
                })
              }
              if (error instanceof InvalidLibrarySearchFilter) {
                return new InvalidRequest({
                  code: "invalid_request",
                  message: error.message,
                  retryable: false,
                  details: { field: error.field },
                  ...errorBase(server, context.request_id)
                })
              }
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
      .handle("entry", ({ params }) =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const entry = yield* library.entry(params.id).pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...errorBase(server, context.request_id)
            }))
          )
          if (entry === null) {
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
            data: entry
          }
        })
      )
      .handle("entryCommand", ({ params, payload }) =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          if (payload.instance_id !== server.instanceId) {
            return yield* new InstanceMismatch({
              code: "instance_mismatch",
              message: "instance mismatch",
              retryable: false,
              ...errorBase(server, context.request_id)
            })
          }
          if (payload.epoch !== server.epoch) {
            return yield* new EpochChanged({
              code: "epoch_changed",
              message: "epoch changed",
              retryable: true,
              ...errorBase(server, context.request_id)
            })
          }
          const command = payload.command
          const outcome = command.type === "bind"
            ? yield* Effect.gen(function*() {
                const parsed = parseCanonicalEhGalleryUrl(command.url)
                if (parsed === null) {
                  return yield* new InvalidRequest({
                    code: "invalid_request",
                    message: "gallery URL must use https://e-hentai.org or https://exhentai.org with /g/{gid}/{token}/",
                    retryable: false,
                    details: { field: "command.url" },
                    ...errorBase(server, context.request_id)
                  })
                }
                return yield* library.bindEntry({
                  entryId: params.id,
                  operationId: payload.operation_id,
                  epoch: server.epoch,
                  expectedDecisionVersion: payload.expected_decision_version,
                  source: parsed.source,
                  gid: parsed.gid,
                  token: parsed.token,
                  preferredDomain: parsed.preferredDomain,
                  canonicalUrl: parsed.canonicalUrl
                }).pipe(
                  Effect.mapError(() => new InternalError({
                    code: "internal_error",
                    message: "internal error",
                    retryable: false,
                    ...errorBase(server, context.request_id)
                  }))
                )
              })
            : command.type === "set-personal-title" || command.type === "remove-personal-title"
              ? yield* library.updatePersonalTitle({
                  entryId: params.id,
                  operationId: payload.operation_id,
                  epoch: server.epoch,
                  expectedDecisionVersion: payload.expected_decision_version,
                  command
                }).pipe(
                  Effect.mapError(() => new InternalError({
                    code: "internal_error",
                    message: "internal error",
                    retryable: false,
                    ...errorBase(server, context.request_id)
                  }))
                )
              : yield* library.updatePersonalTag({
              entryId: params.id,
              operationId: payload.operation_id,
              epoch: server.epoch,
              expectedDecisionVersion: payload.expected_decision_version,
              command: command as Extract<typeof command, { readonly type: "set-personal-tag" | "reset-personal-tag" }>
            }).pipe(
              Effect.mapError(() => new InternalError({
                code: "internal_error",
                message: "internal error",
                retryable: false,
                ...errorBase(server, context.request_id)
              }))
            )
          switch (outcome.kind) {
            case "committed":
            case "replayed":
              return {
                ...errorBase(server, context.request_id),
                server_time: Date.now(),
                data: outcome.result
              }
            case "operation_conflict":
              return yield* new OperationConflict({
                code: "operation_conflict",
                message: "operation id reused with a different payload",
                retryable: false,
                ...errorBase(server, context.request_id)
              })
            case "operation_expired":
              return yield* new OperationExpired({
                code: "operation_expired",
                message: "the binding operation result expired; inspect the current entry before retrying",
                retryable: false,
                ...errorBase(server, context.request_id)
              })
            case "storage_full":
              return yield* new StorageFull({
                code: "storage_full503",
                message: "binding operation recovery storage is full",
                retryable: true,
                ...errorBase(server, context.request_id)
              })
            case "entry_not_found":
              return yield* new EntryNotFound({
                code: "not_found",
                message: "library entry not found",
                retryable: false,
                ...errorBase(server, context.request_id)
              })
            case "revision_conflict":
              return yield* new RevisionConflict({
                code: "revision_conflict",
                message: "stale entry decision revision",
                retryable: false,
                details: { current_revision: outcome.currentDecisionVersion },
                ...errorBase(server, context.request_id)
              })
            case "locator_conflict":
              return yield* new InvalidRequest({
                code: "invalid_request",
                message: "this gallery identity already has a different token; verify the locator before replacing it",
                retryable: false,
                details: { field: "command.url" },
                ...errorBase(server, context.request_id)
              })
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
