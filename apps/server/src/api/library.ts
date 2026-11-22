import { Effect } from "effect"
import { InternalError, LibraryApi, RequestContext } from "@henshin/contracts"
import { HttpApiBuilder } from "effect/http-api"
import { ServerState } from "../identity"
import { LibraryStore } from "../persistence/LibraryStore"
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
  })
)
