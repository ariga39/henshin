import { opendir } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { Effect } from "effect"
import {
  EpochChanged,
  InstanceMismatch,
  InvalidRequest,
  InternalError,
  OperationConflict,
  RequestContext,
  RootVerificationFailed,
  RootPreviewUnavailable,
  ServerApi,
  type RootPreview
} from "@henshin/contracts"
import { HttpApiBuilder } from "effect/http-api"
import {
  revalidateSourceRoot,
  selectSourceRoot,
  validateLocationSeparation,
  type SourceRootObservation
} from "../analysis/NativeSourceBoundary"
import { ServerState } from "../identity"
import { RootStore } from "../persistence/RootStore"

const rootView = (root: {
  rootId: string
  label: string
  selectedPath: string
  canonicalPath: string
  mappingRevision: string
  libraryId: string
  state: "active"
}) => ({
  library_id: root.libraryId,
  root_id: root.rootId,
  label: root.label,
  selected_server_path: root.selectedPath,
  canonical_server_path: root.canonicalPath,
  mapping_revision: root.mappingRevision,
  state: root.state
})

export const ROOT_PREVIEW_SAMPLE_LIMIT = 32

const childKind = (entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): RootPreview["children"][number]["kind"] => {
  if (entry.isFile()) return "file"
  if (entry.isDirectory()) return "directory"
  if (entry.isSymbolicLink()) return "symlink"
  return "other"
}

const enumerateChildren = (
  root: SourceRootObservation,
  instanceId: string,
  epoch: string
): Effect.Effect<RootPreview, unknown> =>
  Effect.tryPromise({
    try: async () => {
      const directory = await opendir(root.canonicalPath)
      const children: Array<RootPreview["children"][number]> = []
      try {
        while (children.length <= ROOT_PREVIEW_SAMPLE_LIMIT) {
          const entry = await directory.read()
          if (entry === null) break
          children.push({ name: entry.name, kind: childKind(entry) })
        }
      } finally {
        await directory.close()
      }

      const truncated = children.length > ROOT_PREVIEW_SAMPLE_LIMIT
      if (truncated) children.pop()
      const outcome: RootPreview["outcome"] = children.length === 0 ? "empty" : truncated ? "truncated" : "selected"

      return {
        selected_server_path: root.selectedPath,
        instance_id: instanceId,
        epoch,
        preview_identity: {
          canonical_server_path: root.canonicalPath,
          device: root.identity.device,
          inode: root.identity.inode
        },
        outcome,
        children,
        sample_limit: ROOT_PREVIEW_SAMPLE_LIMIT
      }
    },
    catch: (error) => error
  })

export const RootHandlers = (dataDirectory: string) => HttpApiBuilder.group(ServerApi, "roots", (handlers) =>
  Effect.gen(function*() {
    const server = yield* ServerState
    const roots = yield* RootStore

    const base = (requestId: string) => ({
      request_id: requestId,
      instance_id: server.instanceId,
      epoch: server.epoch
    })

    const verificationFailed = (requestId: string, message: string) =>
      new RootVerificationFailed({
        code: "root_verification_failed",
        message,
        retryable: false,
        ...base(requestId)
      })

    return handlers
      .handle("list", () =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const listed = yield* roots.list().pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...base(context.request_id)
            }))
          )
          return {
            instance_id: server.instanceId,
            epoch: server.epoch,
            request_id: context.request_id,
            server_time: Date.now(),
            data: listed.map(rootView)
          }
        })
      )
      .handle("preview", ({ payload }) =>
        Effect.gen(function*() {
        const context = yield* RequestContext
        const errorBase = base(context.request_id)

        if (!isAbsolute(payload.path)) {
          return yield* new InvalidRequest({
            code: "invalid_request",
            message: "path must be an absolute directory path",
            retryable: false,
            details: { field: "path" },
            ...errorBase
          })
        }

        const selected = yield* Effect.tryPromise({
          try: () => selectSourceRoot(payload.path),
          catch: () => undefined
        }).pipe(
          Effect.mapError(() => new RootPreviewUnavailable({
            code: "root_preview_inaccessible",
            message: "selected directory is unavailable or inaccessible",
            retryable: true,
            ...errorBase
          })),
          Effect.flatMap((result) =>
            result.ok
              ? Effect.succeed(result.value)
              : Effect.fail(new RootPreviewUnavailable({
                  code: "root_preview_inaccessible",
                  message: "selected directory is unavailable or inaccessible",
                  retryable: true,
                  ...errorBase
                }))
          )
        )

        const preview = yield* enumerateChildren(selected, server.instanceId, server.epoch).pipe(
          Effect.mapError(
            () =>
              new RootPreviewUnavailable({
                code: "root_preview_inaccessible",
                message: "selected directory is unavailable or inaccessible",
                retryable: true,
              ...errorBase
              })
          )
        )

        const current = yield* Effect.tryPromise({
          try: () => revalidateSourceRoot(selected),
          catch: () => undefined
        }).pipe(
          Effect.mapError(() => new RootPreviewUnavailable({
            code: "root_preview_inaccessible",
            message: "selected directory changed during preview",
            retryable: true,
            ...errorBase
          }))
        )
        if (!current.ok) {
          return yield* new RootPreviewUnavailable({
            code: "root_preview_inaccessible",
            message: "selected directory changed during preview",
            retryable: true,
            ...errorBase
          })
        }

        return {
          instance_id: server.instanceId,
          epoch: server.epoch,
          request_id: context.request_id,
          server_time: Date.now(),
          data: preview
        }
      })
      )
      .handle("save", ({ payload }) =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const errorBase = base(context.request_id)
          if (payload.instance_id !== server.instanceId) {
            return yield* new InstanceMismatch({
              code: "instance_mismatch",
              message: "instance mismatch",
              retryable: false,
              ...errorBase
            })
          }
          if (payload.epoch !== server.epoch) {
            return yield* new EpochChanged({
              code: "epoch_changed",
              message: "authority epoch changed; preview the directory again",
              retryable: true,
              ...errorBase
            })
          }

          const proposed = {
            operationId: payload.operation_id,
            label: payload.label,
            selectedPath: payload.path,
            canonicalPath: payload.preview_identity.canonical_server_path,
            device: payload.preview_identity.device,
            inode: payload.preview_identity.inode
          }
          const replay = yield* roots.lookup(proposed).pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...errorBase
            }))
          )
          if (replay.kind === "operation_conflict") {
            return yield* new OperationConflict({
              code: "operation_conflict",
              message: "operation id reused with a different root registration",
              retryable: false,
              ...errorBase
            })
          }
          if (replay.kind === "replay") {
            return {
              instance_id: server.instanceId,
              epoch: server.epoch,
              request_id: context.request_id,
              server_time: Date.now(),
              data: rootView(replay.root)
            }
          }

          const selected = yield* Effect.tryPromise({
            try: () => selectSourceRoot(payload.path),
            catch: () => undefined
          }).pipe(
            Effect.mapError(() => verificationFailed(context.request_id, "selected directory is unavailable; preview it again")),
            Effect.flatMap((result) =>
              result.ok
                ? Effect.succeed(result.value)
                : Effect.fail(verificationFailed(context.request_id, "selected directory is unavailable; preview it again"))
            )
          )

          if (
            selected.canonicalPath !== payload.preview_identity.canonical_server_path ||
            selected.identity.device !== payload.preview_identity.device ||
            selected.identity.inode !== payload.preview_identity.inode
          ) {
            return yield* verificationFailed(context.request_id, "preview is stale; preview the directory again")
          }

          const separation = yield* Effect.tryPromise({
            try: () => validateLocationSeparation({ sourceRoots: [selected], writableLocations: [dataDirectory] }),
            catch: () => undefined
          }).pipe(
            Effect.mapError(() => verificationFailed(context.request_id, "selected directory could not be verified"))
          )
          if (!separation.ok) {
            return yield* verificationFailed(context.request_id, separation.code === "location-overlap"
              ? "selected directory overlaps a server output location"
              : "selected directory could not be verified")
          }

          const registered = yield* roots.register({
            ...proposed,
            selectedPath: selected.selectedPath,
            canonicalPath: selected.canonicalPath,
            device: selected.identity.device,
            inode: selected.identity.inode
          }).pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...errorBase
            }))
          )

          switch (registered.kind) {
            case "operation_conflict":
              return yield* new OperationConflict({
                code: "operation_conflict",
                message: "operation id reused with a different root registration",
                retryable: false,
                ...errorBase
              })
            case "root_overlap":
              return yield* verificationFailed(context.request_id, "selected directory overlaps an active server root")
            case "registered":
            case "replayed":
              return {
                instance_id: server.instanceId,
                epoch: server.epoch,
                request_id: context.request_id,
                server_time: Date.now(),
                data: rootView(registered.root)
              }
          }
        })
      )
  })
)

export const RootPreviewHandlers = RootHandlers
