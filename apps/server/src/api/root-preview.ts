import { opendir } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { Effect } from "effect"
import {
  EpochChanged,
  InstanceMismatch,
  InvalidRequest,
  InternalError,
  OperationConflict,
  OperationExpired,
  StorageFull,
  MAX_ROOT_EXCLUSIONS,
  RevisionConflict,
  RequestContext,
  RootVerificationFailed,
  RootPreviewUnavailable,
  RootNotFound,
  ServerApi,
  type RootPreview,
  type SavedRootPreview
} from "@henshin/contracts"
import { HttpApiBuilder } from "effect/http-api"
import {
  revalidateSourceRoot,
  discoverSourceRoot,
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
  policyRevision: string
  exclusions: ReadonlyArray<{ readonly path: string; readonly scope: "exact" | "subtree" }>
  libraryId: string
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

const enumerateSavedRootCandidates = (
  root: SourceRootObservation,
  rootId: string,
  instanceId: string,
  epoch: string,
  policyRevision: string,
  exclusions: ReadonlyArray<{ readonly path: string; readonly scope: "exact" | "subtree" }>
): Effect.Effect<SavedRootPreview, unknown> =>
  Effect.tryPromise({
    try: async () => {
      const discovered = await discoverSourceRoot(root, {
        limits: { maxCandidates: ROOT_PREVIEW_SAMPLE_LIMIT },
        exclusions
      })
      if (!discovered.ok) throw new Error(discovered.code)
      const value = discovered.value
      return {
        kind: "saved-root-discovery" as const,
        root_id: rootId,
        selected_server_path: root.selectedPath,
        instance_id: instanceId,
        epoch,
        policy_revision: policyRevision,
        candidates: value.candidates.map((candidate) => ({
          relative_path: candidate.relativePath,
          kind: candidate.kind,
          direct_image_count: candidate.directImageCount,
          unsupported_direct_image_count: candidate.unsupportedDirectImageCount
        })),
        sample_limit: ROOT_PREVIEW_SAMPLE_LIMIT,
        unassigned_loose_images: value.unassignedLooseImages,
        unassigned_loose_image_count: value.unassignedLooseImageCount,
        unsupported_loose_images: value.unsupportedLooseImages,
        unsupported_loose_image_count: value.unsupportedLooseImageCount,
        coverage: {
          status: value.coverage.status,
          directories_visited: value.coverage.directoriesVisited,
          entries_observed: value.coverage.entriesObserved,
          candidate_count: value.coverage.candidateCount,
          candidate_sample_truncated: value.coverage.candidateSampleTruncated,
          excluded_links: value.coverage.excludedLinks,
          excluded_link_count: value.coverage.excludedLinkCount,
          unsupported_names: value.coverage.unsupportedNames,
          unsupported_name_count: value.coverage.unsupportedNameCount,
          unsupported_directories: value.coverage.unsupportedDirectories,
          unsupported_directory_count: value.coverage.unsupportedDirectoryCount,
          issues: value.coverage.issues.map(({ code, relativePath }) =>
            relativePath === undefined ? { code } : { code, relative_path: relativePath }),
          issue_count: value.coverage.issueCount
        }
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

          const unavailable = (message: string) =>
            new RootPreviewUnavailable({
              code: "root_preview_inaccessible",
              message,
              retryable: true,
              ...errorBase
            })

          if ("kind" in payload && payload.kind === "saved-root") {
            const listed = yield* roots.list().pipe(
              Effect.mapError(() => new InternalError({
                code: "internal_error",
                message: "internal error",
                retryable: false,
                ...errorBase
              }))
            )
            const saved = listed.find((root) => root.rootId === payload.root_id)
            if (saved === undefined) return yield* unavailable("saved server root is unavailable")

            const observed: SourceRootObservation = {
              selectedPath: saved.selectedPath,
              canonicalPath: saved.canonicalPath,
              identity: { device: saved.device, inode: saved.inode }
            }
            const current = yield* Effect.tryPromise({
              try: () => revalidateSourceRoot(observed),
              catch: () => undefined
            }).pipe(Effect.mapError(() => unavailable("saved server root changed or is unavailable")))
            if (!current.ok) return yield* unavailable(current.code === "root-changed"
              ? "saved server path now identifies a different directory"
              : "saved server path is unavailable")

            const preview = yield* enumerateSavedRootCandidates(
              current.value,
              saved.rootId,
              server.instanceId,
              server.epoch,
              saved.policyRevision,
              saved.exclusions
            ).pipe(Effect.mapError(() => unavailable("saved server root is unavailable or inaccessible")))

            return {
              instance_id: server.instanceId,
              epoch: server.epoch,
              request_id: context.request_id,
              server_time: Date.now(),
              data: preview
            }
          }

          if (!("path" in payload)) return yield* unavailable("invalid preview request")

          // Keep the setup preview bounded to immediate children. It is also
          // the identity-bearing DTO used by root registration.
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
            Effect.mapError(() => unavailable("selected directory is unavailable or inaccessible")),
            Effect.flatMap((result) =>
              result.ok ? Effect.succeed(result.value) : Effect.fail(unavailable("selected directory is unavailable or inaccessible"))
            )
          )

          const preview = yield* enumerateChildren(selected, server.instanceId, server.epoch).pipe(
            Effect.mapError(() => unavailable("selected directory is unavailable or inaccessible"))
          )

          const current = yield* Effect.tryPromise({
            try: () => revalidateSourceRoot(selected),
            catch: () => undefined
          }).pipe(Effect.mapError(() => unavailable("selected directory changed during preview")))
          if (!current.ok) return yield* unavailable("selected directory changed during preview")

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
      .handle("command", ({ params, payload }) =>
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
              message: "authority epoch changed; refresh the root policy",
              retryable: true,
              ...errorBase
            })
          }

          const result = yield* roots.commitPolicy({
            rootId: params.id,
            operationId: payload.operation_id,
            epoch: payload.epoch,
            expectedPolicyRevision: payload.expected_policy_revision,
            command: payload.command
          }).pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...errorBase
            }))
          )

          switch (result.kind) {
            case "exclusion_limit":
              return yield* new InvalidRequest({
                code: "invalid_request", message: `A collection can have up to ${MAX_ROOT_EXCLUSIONS} exclusions.`,
                retryable: false, ...errorBase
              })
            case "operation_expired":
              return yield* new OperationExpired({
                code: "operation_expired", message: "Root policy result expired. Refresh the collection.",
                retryable: false, ...errorBase
              })
            case "storage_full":
              return yield* new StorageFull({
                code: "storage_full503", message: "Root policy operation storage is full.",
                retryable: true, ...errorBase
              })
            case "operation_conflict":
              return yield* new OperationConflict({
                code: "operation_conflict",
                message: "operation id reused with a different root-policy command",
                retryable: false,
                ...errorBase
              })
            case "root_not_found":
              return yield* new RootNotFound({
                code: "not_found",
                message: "root not found",
                retryable: false,
                ...errorBase
              })
            case "policy_revision_conflict":
              return yield* new RevisionConflict({
                code: "revision_conflict",
                message: "stale root policy revision",
                retryable: false,
                details: { current_revision: result.currentPolicyRevision },
                ...errorBase
              })
            case "committed":
            case "replayed":
              return {
                instance_id: server.instanceId,
                epoch: server.epoch,
                request_id: context.request_id,
                server_time: Date.now(),
                data: rootView(result.root)
              }
          }
        })
      )
  })
)

export const RootPreviewHandlers = RootHandlers
