import { discoveryCoverageView } from "../analysis/discovery-coverage"
import { randomUUID } from "node:crypto"
import { Cause, Effect, Result } from "effect"
import {
  analyzeSourceManifest,
  ManifestCandidateError,
  type SourceManifest
} from "../analysis/SourceManifestAnalysis"
import {
  discoverSourceRoot,
  revalidateSourceRoot,
  resolveSourceCandidate,
  type SourceRootObservation,
} from "../analysis/NativeSourceBoundary"
import { ScanStore, type FinishScanInput } from "../persistence/ScanStore"
import type { ScanTask } from "@henshin/contracts"
import type { ServerRootRow } from "../persistence/worker-protocol"

const emptyDiagnostics = () => ({
  supported_pages: 0,
  unsupported_pages: 0,
  ignored_entries: 0,
  directory_records: 0
})

const manifestView = (manifest: SourceManifest) => ({
  source_kind: manifest.sourceKind,
  pages: manifest.pages.map((page) => ({
    name: page.name,
    format: page.format,
    declared_bytes: page.declaredBytes
  })),
  diagnostics: {
    supported_pages: manifest.diagnostics.supportedPages,
    unsupported_pages: manifest.diagnostics.unsupportedPages,
    ignored_entries: manifest.diagnostics.ignoredEntries,
    directory_records: manifest.diagnostics.directoryRecords
  },
  before: {
    kind: manifest.before.kind,
    bytes: manifest.before.bytes,
    mtime_ms: manifest.before.mtimeMs,
    entry_count: manifest.before.entryCount
  },
  after: {
    kind: manifest.after.kind,
    bytes: manifest.after.bytes,
    mtime_ms: manifest.after.mtimeMs,
    entry_count: manifest.after.entryCount
  }
})

const analysisError = (error: unknown) => {
  if (error instanceof ManifestCandidateError) {
    return {
      code: error.code,
      message: error.message,
      diagnostics: {
        supported_pages: error.diagnostics.supportedPages,
        unsupported_pages: error.diagnostics.unsupportedPages,
        ignored_entries: error.diagnostics.ignoredEntries,
        directory_records: error.diagnostics.directoryRecords
      }
    }
  }
  const message = error instanceof Error ? error.message : "candidate analysis failed"
  return { code: "read-failure", message, diagnostics: emptyDiagnostics() }
}

const sourceError = (code: string) => ({
  code,
  message: "candidate could not be revalidated for analysis",
  diagnostics: emptyDiagnostics()
})

const rootObservation = (root: ServerRootRow): SourceRootObservation => ({
  selectedPath: root.selectedPath,
  canonicalPath: root.canonicalPath,
  identity: { device: root.device, inode: root.inode }
})

type ScanStoreService = ScanStore["Service"]

const finish = (store: ScanStoreService, input: FinishScanInput) => store.finish(input)

interface ScanProgress {
  readonly directoriesVisited: number
  readonly candidatesDiscovered: number
  readonly candidatesAnalyzed: number
  readonly analysisErrorCount: number
  readonly reviewNeededCount: number
  readonly coverage: FinishScanInput["coverage"]
}

const progressOf = (task: ScanTask): ScanProgress => ({
  directoriesVisited: task.directories_visited,
  candidatesDiscovered: task.candidates_discovered,
  candidatesAnalyzed: task.candidates_analyzed,
  analysisErrorCount: task.analysis_error_count,
  reviewNeededCount: task.review_needed_count,
  coverage: task.coverage
})

const finishUnexpected = (
  store: ScanStoreService,
  task: ScanTask,
  progress: ScanProgress,
  cause: Cause.Cause<unknown>
) => {
  const interrupted = Cause.hasInterruptsOnly(cause)
  const error = interrupted
    ? {
        code: "scan_interrupted",
        message: "scan interrupted; staged discoveries and progress were preserved. Retry the scan after confirming the source is available."
      }
    : {
        code: "scan_failed",
        message: "scan failed unexpectedly; staged discoveries and progress were preserved. Check server diagnostics, resolve the underlying issue, and retry the scan."
      }

  return Effect.uninterruptible(
    Effect.gen(function*() {
      yield* Effect.logError(
        `held scan ${task.task_id} ${interrupted ? "interrupted" : "failed"}: ${Cause.pretty(cause)}`
      )
      yield* finish(store, {
        taskId: task.task_id,
        status: interrupted ? "interrupted" : "failed",
        directoriesVisited: progress.directoriesVisited,
        candidatesDiscovered: progress.candidatesDiscovered,
        candidatesAnalyzed: progress.candidatesAnalyzed,
        analysisErrorCount: progress.analysisErrorCount,
        reviewNeededCount: progress.reviewNeededCount,
        coverage: progress.coverage,
        error,
        readinessError: null
      }).pipe(
        Effect.catchCause((finishCause) =>
          Effect.logError(`could not persist terminal scan status: ${Cause.pretty(finishCause)}`)
        )
      )
    })
  )
}

/** Runs one explicit held manual scan; it never performs reconciliation or allocation. */
export const runManualHeldScan = Effect.fn("runManualHeldScan")(function*(task: ScanTask, root: ServerRootRow) {
  const store = yield* ScanStore
  let progress = progressOf(task)

  yield* Effect.gen(function*() {
    yield* store.markRunning(task.task_id)

    const observed = rootObservation(root)
    const current = yield* Effect.tryPromise({
      try: () => revalidateSourceRoot(observed),
      catch: () => undefined
    })
    if (!current.ok) {
      yield* finish(store, {
        taskId: task.task_id,
        status: "failed",
        directoriesVisited: progress.directoriesVisited,
        candidatesDiscovered: progress.candidatesDiscovered,
        candidatesAnalyzed: progress.candidatesAnalyzed,
        analysisErrorCount: progress.analysisErrorCount,
        reviewNeededCount: progress.reviewNeededCount,
        coverage: progress.coverage,
        error: null,
        readinessError: { code: "readiness_error", message: "saved root is unavailable or changed" }
      })
      return
    }

    const discovered = yield* Effect.tryPromise({
      try: () => discoverSourceRoot(current.value, { exclusions: root.exclusions }),
      catch: () => undefined
    })
    if (!discovered.ok) {
      yield* finish(store, {
        taskId: task.task_id,
        status: "failed",
        directoriesVisited: progress.directoriesVisited,
        candidatesDiscovered: progress.candidatesDiscovered,
        candidatesAnalyzed: progress.candidatesAnalyzed,
        analysisErrorCount: progress.analysisErrorCount,
        reviewNeededCount: progress.reviewNeededCount,
        coverage: progress.coverage,
        error: null,
        readinessError: { code: discovered.code, message: "saved root could not be discovered" }
      })
      return
    }

    const coverage = discoveryCoverageView(discovered.value.coverage)
    progress = {
      ...progress,
      directoriesVisited: coverage.directories_visited,
      candidatesDiscovered: discovered.value.candidates.length,
      reviewNeededCount: 0,
      coverage
    }
    yield* store.recordDiscovery(task.task_id, coverage, discovered.value.candidates.length)

    for (const candidate of discovered.value.candidates) {
      const resolved = yield* Effect.tryPromise({
        try: () => resolveSourceCandidate(current.value, candidate.relativePath),
        catch: () => undefined
      })

      if (!resolved.ok) {
        yield* store.stage({
          candidateId: randomUUID(),
          taskId: task.task_id,
          rootId: task.root_id,
          relativePath: candidate.relativePath,
          kind: candidate.kind,
          analysisStatus: "error",
          manifest: null,
          analysisError: sourceError(resolved.code)
        })
        progress = {
          ...progress,
          analysisErrorCount: progress.analysisErrorCount + 1,
          reviewNeededCount: progress.reviewNeededCount + 1
        }
        continue
      }

      const result = yield* Effect.result(analyzeSourceManifest({ sourcePath: resolved.value.nativePath }))
      if (Result.isSuccess(result)) {
        const manifest = result.success
        yield* store.stage({
          candidateId: randomUUID(),
          taskId: task.task_id,
          rootId: task.root_id,
          relativePath: candidate.relativePath,
          kind: candidate.kind,
          analysisStatus: "ready",
          manifest: manifestView(manifest),
          analysisError: null
        })
        progress = {
          ...progress,
          candidatesAnalyzed: progress.candidatesAnalyzed + 1,
          reviewNeededCount: progress.reviewNeededCount + 1
        }
      } else {
        yield* store.stage({
          candidateId: randomUUID(),
          taskId: task.task_id,
          rootId: task.root_id,
          relativePath: candidate.relativePath,
          kind: candidate.kind,
          analysisStatus: "error",
          manifest: null,
          analysisError: analysisError(result.failure)
        })
        progress = {
          ...progress,
          analysisErrorCount: progress.analysisErrorCount + 1,
          reviewNeededCount: progress.reviewNeededCount + 1
        }
      }
    }

    const hasErrors = progress.analysisErrorCount > 0 || coverage.status === "partial"
    yield* finish(store, {
      taskId: task.task_id,
      status: hasErrors ? "completed_with_errors" : "succeeded",
      directoriesVisited: progress.directoriesVisited,
      candidatesDiscovered: progress.candidatesDiscovered,
      candidatesAnalyzed: progress.candidatesAnalyzed,
      analysisErrorCount: progress.analysisErrorCount,
      reviewNeededCount: progress.reviewNeededCount,
      coverage: progress.coverage,
      error: hasErrors
        ? { code: progress.analysisErrorCount > 0 ? "analysis_error" : "partial_coverage", message: progress.analysisErrorCount > 0 ? "one or more discoveries could not be analyzed" : "scan coverage is partial" }
        : null,
      readinessError: null
    })
  }).pipe(Effect.catchCause((cause) => finishUnexpected(store, task, progress, cause)))
})
