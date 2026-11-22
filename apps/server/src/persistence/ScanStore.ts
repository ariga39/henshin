import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  ScanTask,
  ScanTaskList,
  StagedDiscovery,
  StagedDiscoveryList,
  RootPreviewCoverage,
  ScanManifest,
  ScanAnalysisError
} from "@henshin/contracts"
import { DatabaseWorker, DatabaseWorkerError } from "./DatabaseWorker"
import {
  ScanStartOutcome,
  ScanTaskRow,
  StagedDiscoveryRow,
  type ScanTaskRow as ScanTaskRowType,
  type StagedDiscoveryRow as StagedDiscoveryRowType
} from "./worker-protocol"

export interface StartManualScanInput {
  readonly taskId: string
  readonly operationId: string
  readonly epoch: string
  readonly rootId: string
  readonly expectedMappingRevision: string
  readonly expectedPolicyRevision: string
}

export type ScanStartResult =
  | { readonly kind: "created"; readonly task: ScanTask }
  | { readonly kind: "replayed"; readonly task: ScanTask }
  | { readonly kind: "active"; readonly task: ScanTask }
  | { readonly kind: "operation_conflict" }
  | { readonly kind: "root_not_found" }
  | { readonly kind: "mapping_revision_conflict"; readonly currentMappingRevision: string }
  | { readonly kind: "policy_revision_conflict"; readonly currentPolicyRevision: string }

export interface StageDiscoveryInput {
  readonly candidateId: string
  readonly taskId: string
  readonly rootId: string
  readonly relativePath: string
  readonly kind: "archive" | "image-directory"
  readonly analysisStatus: "ready" | "error"
  readonly manifest: ScanManifest | null
  readonly analysisError: ScanAnalysisError | null
}

export interface FinishScanInput {
  readonly taskId: string
  readonly status: "succeeded" | "completed_with_errors" | "failed" | "interrupted"
  readonly directoriesVisited: number
  readonly candidatesDiscovered: number
  readonly candidatesAnalyzed: number
  readonly analysisErrorCount: number
  readonly reviewNeededCount: number
  readonly coverage: typeof RootPreviewCoverage.Type | null
  readonly error: { readonly code: string; readonly message: string } | null
  readonly readinessError: { readonly code: string; readonly message: string } | null
}

const decodeStart = Schema.decodeUnknownOption(ScanStartOutcome)
const decodeTaskRow = Schema.decodeUnknownOption(ScanTaskRow)
const decodeTask = Schema.decodeUnknownOption(ScanTask)
const decodeTasks = Schema.decodeUnknownOption(Schema.Array(ScanTaskRow))
const decodeStagedRows = Schema.decodeUnknownOption(Schema.Array(StagedDiscoveryRow))
const decodeStaged = Schema.decodeUnknownOption(StagedDiscovery)
const decodeCoverage = Schema.decodeUnknownOption(RootPreviewCoverage)
const decodeManifest = Schema.decodeUnknownOption(ScanManifest)
const decodeAnalysisError = Schema.decodeUnknownOption(ScanAnalysisError)

const jsonValue = (value: string | null): unknown => {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

const decodeOrThrow = <A>(decoder: (value: unknown) => Option.Option<A>, value: unknown, message: string): A => {
  const decoded = decoder(value)
  if (Option.isNone(decoded)) throw new Error(message)
  return decoded.value
}

const taskView = (row: ScanTaskRowType): ScanTask => decodeOrThrow(
  decodeTask,
  {
    task_id: row.task_id,
    root_id: row.root_id,
    kind: "manual-scan",
    mode: "manual",
    hold_new_discoveries: row.hold_new_discoveries,
    mapping_revision: row.mapping_revision,
    status: row.status,
    directories_visited: row.directories_visited,
    candidates_discovered: row.candidates_discovered,
    candidates_analyzed: row.candidates_analyzed,
    analysis_error_count: row.analysis_error_count,
    review_needed_count: row.review_needed_count,
    coverage: row.coverage_json === null
      ? null
      : decodeOrThrow(decodeCoverage, jsonValue(row.coverage_json), "invalid persisted scan coverage"),
    readiness_error: row.readiness_error_code === null || row.readiness_error_message === null
      ? null
      : { code: row.readiness_error_code, message: row.readiness_error_message },
    error: row.error_code === null || row.error_message === null
      ? null
      : { code: row.error_code, message: row.error_message },
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms
  },
  "invalid persisted scan task"
)

const stagedView = (row: StagedDiscoveryRowType): StagedDiscovery => decodeOrThrow(
  decodeStaged,
  {
    candidate_id: row.candidate_id,
    task_id: row.task_id,
    root_id: row.root_id,
    relative_path: row.relative_path,
    kind: row.kind,
    candidate_version: row.candidate_version,
    hold_state: row.hold_state,
    analysis_status: row.analysis_status,
    manifest: row.manifest_json === null
      ? null
      : decodeOrThrow(decodeManifest, jsonValue(row.manifest_json), "invalid persisted scan manifest"),
    analysis_error: row.analysis_error_json === null
      ? null
      : decodeOrThrow(decodeAnalysisError, jsonValue(row.analysis_error_json), "invalid persisted scan error"),
    updated_at_ms: row.updated_at_ms
  },
  "invalid persisted staged discovery"
)

const encoded = (value: unknown): string | null => value === null ? null : JSON.stringify(value)

export class ScanStore extends Context.Service<
  ScanStore,
  {
    readonly start: (input: StartManualScanInput) => Effect.Effect<ScanStartResult, DatabaseWorkerError>
    readonly listTasks: () => Effect.Effect<ReadonlyArray<ScanTask>, DatabaseWorkerError>
    readonly readTask: (taskId: string) => Effect.Effect<ScanTask | null, DatabaseWorkerError>
    readonly listStaged: () => Effect.Effect<ReadonlyArray<StagedDiscovery>, DatabaseWorkerError>
    readonly recordDiscovery: (taskId: string, coverage: typeof RootPreviewCoverage.Type, candidates: number) => Effect.Effect<void, DatabaseWorkerError>
    readonly markRunning: (taskId: string) => Effect.Effect<void, DatabaseWorkerError>
    readonly stage: (input: StageDiscoveryInput) => Effect.Effect<void, DatabaseWorkerError>
    readonly finish: (input: FinishScanInput) => Effect.Effect<void, DatabaseWorkerError>
    readonly recoverInterrupted: () => Effect.Effect<void, DatabaseWorkerError>
  }
>()("henshin/server/ScanStore") {
  static readonly layer: Layer.Layer<ScanStore, never, DatabaseWorker> = Layer.effect(
    ScanStore,
    Effect.gen(function*() {
      const worker = yield* DatabaseWorker

      const start = (input: StartManualScanInput) => worker.call({ op: "startManualScan", ...input }).pipe(
        Effect.flatMap((value) => {
          const decoded = decodeStart(value)
          if (Option.isNone(decoded)) return Effect.fail(new DatabaseWorkerError({ message: "invalid scan start result" }))
          const outcome = decoded.value
          if (outcome.kind === "created" || outcome.kind === "replayed" || outcome.kind === "active") {
            return Effect.try({
              try: () => ({ kind: outcome.kind, task: taskView(outcome.task) } as ScanStartResult),
              catch: () => new DatabaseWorkerError({ message: "invalid persisted scan task" })
            })
          }
          return Effect.succeed(outcome as ScanStartResult)
        })
      )

      const listTasks = () => worker.call({ op: "listScanTasks" }).pipe(
        Effect.flatMap((value) => {
          const decoded = decodeTasks(value)
          if (Option.isNone(decoded)) return Effect.fail(new DatabaseWorkerError({ message: "invalid scan task list" }))
          return Effect.all(decoded.value.map((row) => Effect.try({
            try: () => taskView(row),
            catch: () => new DatabaseWorkerError({ message: "invalid persisted scan task" })
          })))
        })
      )

      const readTask = (taskId: string) => worker.call({ op: "readScanTask", taskId }).pipe(
        Effect.flatMap((value) => {
          if (value === null) return Effect.succeed(null)
          const decoded = decodeTaskRow(value)
          if (Option.isNone(decoded)) return Effect.fail(new DatabaseWorkerError({ message: "invalid scan task" }))
          return Effect.try({
            try: () => taskView(decoded.value),
            catch: () => new DatabaseWorkerError({ message: "invalid persisted scan task" })
          })
        })
      )

      const listStaged = () => worker.call({ op: "listStagedDiscoveries" }).pipe(
        Effect.flatMap((value) => {
          const decoded = decodeStagedRows(value)
          if (Option.isNone(decoded)) return Effect.fail(new DatabaseWorkerError({ message: "invalid staged discovery list" }))
          return Effect.all(decoded.value.map((row) => Effect.try({
            try: () => stagedView(row),
            catch: () => new DatabaseWorkerError({ message: "invalid persisted staged discovery" })
          })))
        })
      )

      const recordDiscovery = (taskId: string, coverage: typeof RootPreviewCoverage.Type, candidates: number) =>
        worker.call({ op: "recordDiscovery", taskId, directories: coverage.directories_visited,
          candidates, coverageJson: JSON.stringify(coverage) }).pipe(Effect.asVoid)

      const markRunning = (taskId: string) => worker.call({ op: "markScanRunning", taskId }).pipe(Effect.asVoid)

      const stage = (input: StageDiscoveryInput) => worker.call({
        op: "stageDiscovery",
        candidateId: input.candidateId,
        taskId: input.taskId,
        rootId: input.rootId,
        relativePath: input.relativePath,
        kind: input.kind,
        analysisStatus: input.analysisStatus,
        manifestJson: encoded(input.manifest),
        analysisErrorJson: encoded(input.analysisError)
      }).pipe(Effect.asVoid)

      const finish = (input: FinishScanInput) => worker.call({
        op: "finishScan",
        taskId: input.taskId,
        status: input.status,
        directoriesVisited: input.directoriesVisited,
        candidatesDiscovered: input.candidatesDiscovered,
        candidatesAnalyzed: input.candidatesAnalyzed,
        analysisErrorCount: input.analysisErrorCount,
        reviewNeededCount: input.reviewNeededCount,
        coverageJson: encoded(input.coverage),
        errorCode: input.error?.code ?? null,
        errorMessage: input.error?.message ?? null,
        readinessErrorCode: input.readinessError?.code ?? null,
        readinessErrorMessage: input.readinessError?.message ?? null
      }).pipe(Effect.asVoid)

      const recoverInterrupted = () => worker.call({ op: "recoverScans" }).pipe(Effect.asVoid)

      return ScanStore.of({ start, listTasks, readTask, listStaged, recordDiscovery, markRunning, stage, finish, recoverInterrupted })
    })
  )
}
