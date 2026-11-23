import { Effect, Result } from "effect"
import {
  CandidateNotFound,
  EntryNotFound,
  EpochChanged,
  InstanceMismatch,
  InternalError,
  InvalidRequest,
  OperationConflict,
  OperationExpired,
  RequestContext,
  RevisionConflict,
  ReviewApi,
  StorageFull,
  TaskApi,
  TaskNotFound
} from "@henshin/contracts"
import { HttpApiBuilder } from "effect/http-api"
import { ServerState } from "../identity"
import { ScanStore } from "../persistence/ScanStore"
import { LibraryStore, type EntryResolutionLookupResult, type ReplacementResolutionResult } from "../persistence/LibraryStore"
import { RootStore } from "../persistence/RootStore"
import { analyzeSourceManifest } from "../analysis/SourceManifestAnalysis"
import { resolveSourceCandidate, type SourceRootObservation } from "../analysis/NativeSourceBoundary"
import { FINGERPRINT_DEADLINE_MS, FINGERPRINT_MAX_BYTES, fingerprintSource } from "../analysis/SourceFingerprint"
import { sourceManifestView } from "../scan/ManualScanCoordinator"
import type { ServerRootRow } from "../persistence/worker-protocol"
import type { StagedDiscovery } from "@henshin/contracts"

const errorBase = (server: ServerState["Service"], requestId: string) => ({
  request_id: requestId,
  instance_id: server.instanceId,
  epoch: server.epoch
})

const freshReplacementManifest = (
  root: ServerRootRow,
  candidate: StagedDiscovery
): Effect.Effect<string | null> => {
  const observed: SourceRootObservation = {
    selectedPath: root.selectedPath,
    canonicalPath: root.canonicalPath,
    identity: { device: root.device, inode: root.inode }
  }
  return Effect.tryPromise({
    try: () => resolveSourceCandidate(observed, candidate.relative_path),
    catch: () => undefined
  }).pipe(
    Effect.catch(() => Effect.succeed(null)),
    Effect.flatMap((resolved) => {
      if (resolved === null || !resolved.ok || resolved.value.kind !== candidate.kind) return Effect.succeed(null)
      return Effect.result(analyzeSourceManifest({ sourcePath: resolved.value.nativePath })).pipe(
        Effect.flatMap((result) => {
          if (!Result.isSuccess(result)) return Effect.succeed(null)
          return Effect.result(Effect.tryPromise({
            try: (signal) => fingerprintSource(resolved.value.nativePath, result.success, {
              signal,
              maxBytes: FINGERPRINT_MAX_BYTES,
              deadlineMs: FINGERPRINT_DEADLINE_MS
            }),
            catch: () => undefined
          })).pipe(
            Effect.map((fingerprint) => Result.isSuccess(fingerprint)
              ? JSON.stringify({ ...sourceManifestView(result.success), fingerprint: fingerprint.success })
              : null)
          )
        })
      )
    })
  )
}

const renderReplacementResolution = (
  base: ReturnType<typeof errorBase>,
  operationId: string,
  expectedDecisionVersion: string,
  expectedCandidateVersion: number,
  resolved: ReplacementResolutionResult | EntryResolutionLookupResult
) => {
  switch (resolved.kind) {
    case "committed":
    case "replayed":
      return Effect.succeed({
        ...base,
        server_time: Date.now(),
        data: {
          operation_id: operationId,
          candidate: resolved.candidate,
          resolution: {
            operation_id: operationId,
            decision: resolved.decision,
            entry: resolved.entry,
            detached_entry_id: resolved.detachedEntryId
          }
        }
      })
    case "operation_conflict":
      return Effect.fail(new OperationConflict({ code: "operation_conflict", message: "operation id reused with a different replacement resolution", retryable: false, ...base }))
    case "operation_expired":
      return Effect.fail(new OperationExpired({ code: "operation_expired", message: "replacement resolution expired; refresh Review before retrying", retryable: false, ...base }))
    case "storage_full":
      return Effect.fail(new StorageFull({ code: "storage_full503", message: "replacement resolution operation storage is full", retryable: true, ...base }))
    case "candidate_not_found":
      return Effect.fail(new CandidateNotFound({ code: "not_found", message: "replacement candidate not found; refresh Review", retryable: false, ...base }))
    case "entry_not_found":
      return Effect.fail(new EntryNotFound({ code: "not_found", message: "replacement entry not found; refresh Library", retryable: false, ...base }))
    case "candidate_version_conflict":
      return Effect.fail(new RevisionConflict({ code: "revision_conflict", message: "replacement candidate changed; refresh Review before resolving it", retryable: false, details: { current_revision: String(resolved.currentCandidateVersion) }, ...base }))
    case "entry_revision_conflict":
      return Effect.fail(new RevisionConflict({ code: "revision_conflict", message: "replacement entry changed; refresh Library and Review before resolving it", retryable: false, details: { current_revision: resolved.currentDecisionVersion }, ...base }))
    case "entry_not_pending":
      return Effect.fail(new RevisionConflict({ code: "revision_conflict", message: "replacement is no longer pending; refresh Library and Review", retryable: false, details: { current_revision: expectedDecisionVersion }, ...base }))
    case "fresh_observation_conflict":
      return Effect.fail(new RevisionConflict({ code: "revision_conflict", message: "replacement source changed since Review; rescan and refresh Review before resolving it", retryable: false, details: { current_revision: String(expectedCandidateVersion) }, ...base }))
    case "candidate_not_ready":
      return Effect.fail(new InvalidRequest({ code: "invalid_request", message: "replacement candidate is not ready for resolution", retryable: false, ...base }))
    case "root_not_found":
      return Effect.fail(new CandidateNotFound({ code: "not_found", message: "saved root for this replacement was not found; refresh Review", retryable: false, ...base }))
    case "mapping_revision_conflict":
      return Effect.fail(new RevisionConflict({ code: "revision_conflict", message: "saved root mapping changed; refresh the root and Review", retryable: false, details: { current_revision: resolved.currentMappingRevision }, ...base }))
    case "policy_revision_conflict":
      return Effect.fail(new RevisionConflict({ code: "revision_conflict", message: "saved root policy changed; refresh the root and Review", retryable: false, details: { current_revision: resolved.currentPolicyRevision }, ...base }))
    case "not_found":
      return Effect.fail(new InternalError({ code: "internal_error", message: "replacement resolution lookup was unavailable", retryable: true, ...base }))
  }
}

export const TaskHandlers = HttpApiBuilder.group(TaskApi, "tasks", (handlers) =>
  Effect.gen(function*() {
    const server = yield* ServerState
    const scans = yield* ScanStore
    return handlers
      .handle("list", () =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const tasks = yield* scans.listTasks().pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...errorBase(server, context.request_id)
            }))
          )
          return { ...errorBase(server, context.request_id), server_time: Date.now(), data: tasks }
        })
      )
      .handle("get", ({ params }) =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const task = yield* scans.readTask(params.id).pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...errorBase(server, context.request_id)
            }))
          )
          if (task === null) {
            return yield* new TaskNotFound({
              code: "not_found",
              message: "scan task not found",
              retryable: false,
              ...errorBase(server, context.request_id)
            })
          }
          return { ...errorBase(server, context.request_id), server_time: Date.now(), data: task }
        })
      )
  })
)

export const ReviewHandlers = HttpApiBuilder.group(ReviewApi, "review", (handlers) =>
  Effect.gen(function*() {
    const server = yield* ServerState
    const scans = yield* ScanStore
    const library = yield* LibraryStore
    const roots = yield* RootStore
    return handlers
      .handle("candidates", () =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const candidates = yield* scans.listStaged().pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...errorBase(server, context.request_id)
            }))
          )
          return { ...errorBase(server, context.request_id), server_time: Date.now(), data: candidates }
        })
      )
      .handle("command", ({ params, payload }) =>
        Effect.gen(function*() {
          const context = yield* RequestContext
          const base = errorBase(server, context.request_id)
          if (payload.instance_id !== server.instanceId) {
            return yield* new InstanceMismatch({
              code: "instance_mismatch",
              message: "instance mismatch",
              retryable: false,
              ...base
            })
          }
          if (payload.epoch !== server.epoch) {
            return yield* new EpochChanged({
              code: "epoch_changed",
              message: "authority epoch changed; refresh Review before releasing this discovery",
              retryable: true,
              ...base
            })
          }
          if (payload.command.type === "resolve-replacement") {
            const expectedDecisionVersion = payload.expected_decision_version
            const expectedLocationRevision = payload.expected_location_revision
            if (expectedDecisionVersion === undefined || expectedLocationRevision === undefined) {
              return yield* new InvalidRequest({
                code: "invalid_request",
                message: "replacement resolution requires entry decision and location revisions",
                retryable: false,
                details: { field: "expected_decision_version" },
                ...base
              })
            }
            const resolutionInput = {
              candidateId: params.id,
              rootId: payload.root_id,
              entryId: payload.command.entry_id,
              operationId: payload.operation_id,
              epoch: payload.epoch,
              decision: payload.command.decision,
              expectedCandidateVersion: payload.expected_candidate_version,
              expectedDecisionVersion,
              expectedLocationRevision,
              expectedMappingRevision: payload.expected_mapping_revision,
              expectedPolicyRevision: payload.expected_policy_revision
            }
            const lookup = yield* library.lookupReplacementOperation(resolutionInput).pipe(
              Effect.mapError(() => new InternalError({ code: "internal_error", message: "internal error", retryable: true, ...base }))
            )
            if (lookup.kind !== "not_found") {
              return yield* renderReplacementResolution(
                base,
                payload.operation_id,
                expectedDecisionVersion,
                payload.expected_candidate_version,
                lookup
              )
            }

            const [rootList, candidates] = yield* Effect.all([roots.list(), scans.listStaged()]).pipe(
              Effect.mapError(() => new InternalError({ code: "internal_error", message: "internal error", retryable: true, ...base }))
            )
            const currentRoot = rootList.find((candidate) => candidate.rootId === payload.root_id)
            const currentCandidate = candidates.find((candidate) => candidate.candidate_id === params.id && candidate.root_id === payload.root_id)
            let freshManifestJson: string | null = null
            if (
              currentRoot !== undefined &&
              currentCandidate !== undefined &&
              currentCandidate.analysis_status === "ready" &&
              currentCandidate.manifest !== null
            ) {
              freshManifestJson = yield* freshReplacementManifest(currentRoot, currentCandidate)
              if (freshManifestJson === null) {
                return yield* new RevisionConflict({
                  code: "revision_conflict",
                  message: "replacement source changed or could not be freshly verified; rescan and refresh Review before resolving it",
                  retryable: false,
                  details: { current_revision: String(currentCandidate.candidate_version) },
                  ...base
                })
              }
            }
            const resolved = yield* library.resolveReplacement({ ...resolutionInput, freshManifestJson }).pipe(
              Effect.mapError(() => new InternalError({ code: "internal_error", message: "internal error", retryable: true, ...base }))
            )
            return yield* renderReplacementResolution(
              base,
              payload.operation_id,
              expectedDecisionVersion,
              payload.expected_candidate_version,
              resolved
            )
          }
          if (payload.command.type !== "release-hold") {
            return yield* new InvalidRequest({
              code: "invalid_request",
              message: "unsupported review command",
              retryable: false,
              ...base
            })
          }

          const released = yield* scans.releaseHeld({
            candidateId: params.id,
            rootId: payload.root_id,
            operationId: payload.operation_id,
            epoch: payload.epoch,
            expectedCandidateVersion: payload.expected_candidate_version,
            expectedMappingRevision: payload.expected_mapping_revision,
            expectedPolicyRevision: payload.expected_policy_revision
          }).pipe(
            Effect.mapError(() => new InternalError({
              code: "internal_error",
              message: "internal error",
              retryable: false,
              ...base
            }))
          )

          switch (released.kind) {
            case "committed":
            case "replayed":
              return {
                ...base,
                server_time: Date.now(),
                data: { operation_id: payload.operation_id, candidate: released.candidate }
              }
            case "operation_conflict":
              return yield* new OperationConflict({
                code: "operation_conflict",
                message: "operation id reused with a different review command",
                retryable: false,
                ...base
              })
            case "operation_expired":
              return yield* new OperationExpired({
                code: "operation_expired",
                message: "review command result expired; refresh Review before retrying",
                retryable: false,
                ...base
              })
            case "storage_full":
              return yield* new StorageFull({
                code: "storage_full503",
                message: "review command operation storage is full",
                retryable: true,
                ...base
              })
            case "root_not_found":
              return yield* new CandidateNotFound({
                code: "not_found",
                message: "saved root for this discovery not found; refresh Review",
                retryable: false,
                ...base
              })
            case "candidate_not_found":
              return yield* new CandidateNotFound({
                code: "not_found",
                message: "staged discovery not found; refresh Review",
                retryable: false,
                ...base
              })
            case "candidate_version_conflict":
              return yield* new RevisionConflict({
                code: "revision_conflict",
                message: "discovery changed; refresh Review before releasing it",
                retryable: false,
                details: { current_revision: String(released.currentCandidateVersion) },
                ...base
              })
            case "candidate_not_held":
              return yield* new RevisionConflict({
                code: "revision_conflict",
                message: "discovery hold changed; refresh Review before releasing it",
                retryable: false,
                details: { current_revision: String(released.currentCandidateVersion) },
                ...base
              })
            case "mapping_revision_conflict":
              return yield* new RevisionConflict({
                code: "revision_conflict",
                message: "saved root mapping changed; refresh the root and Review",
                retryable: false,
                details: { current_revision: released.currentMappingRevision },
                ...base
              })
            case "policy_revision_conflict":
              return yield* new RevisionConflict({
                code: "revision_conflict",
                message: "saved root policy changed; refresh the root and Review",
                retryable: false,
                details: { current_revision: released.currentPolicyRevision },
                ...base
              })
          }
        })
      )
  })
)
