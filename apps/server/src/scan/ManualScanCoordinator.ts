import { discoveryCoverageView } from "../analysis/discovery-coverage"
import { randomUUID } from "node:crypto"
import { Cause, Duration, Effect, Result } from "effect"
import {
  analyzeSourceManifest,
  ManifestCandidateError,
  type SourceManifest
} from "../analysis/SourceManifestAnalysis"
import {
  discoverSourceRoot,
  discoveryIssueCode,
  MANUAL_SCAN_SOURCE_DISCOVERY_LIMITS,
  revalidateSourceRoot,
  resolveSourceCandidate,
  type SourceRootObservation,
} from "../analysis/NativeSourceBoundary"
import { FINGERPRINT_DEADLINE_MS, FINGERPRINT_MAX_BYTES, fingerprintSource } from "../analysis/SourceFingerprint"
import { ScanStore, type FinishScanInput } from "../persistence/ScanStore"
import { ScanManifest, type ScanTask } from "@henshin/contracts"
import type { ServerRootRow } from "../persistence/worker-protocol"

const emptyDiagnostics = () => ({
  supported_pages: 0,
  unsupported_pages: 0,
  ignored_entries: 0,
  directory_records: 0
})

export const sourceManifestView = (manifest: SourceManifest) => ({
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
    entry_count: manifest.before.entryCount,
    observation_token: manifest.before.observationToken
  },
  after: {
    kind: manifest.after.kind,
    bytes: manifest.after.bytes,
    mtime_ms: manifest.after.mtimeMs,
    entry_count: manifest.after.entryCount,
    observation_token: manifest.after.observationToken
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

/** Positive default; HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS may override it per deployment. */
export const NORMAL_SCAN_QUIET_INTERVAL_MS = 50

const normalScanQuietIntervalMs = (): number => {
  const configured = Number(process.env.HENSHIN_NORMAL_SCAN_QUIET_INTERVAL_MS)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : NORMAL_SCAN_QUIET_INTERVAL_MS
}

const deferredPathsMessage = (label: string, paths: ReadonlyArray<string>, total: number): string =>
  `${label}: ${paths.join(", ")}${total > paths.length ? ` (+${total - paths.length} more)` : ""}`

const rootObservation = (root: ServerRootRow): SourceRootObservation => ({
  selectedPath: root.selectedPath,
  canonicalPath: root.canonicalPath,
  identity: { device: root.device, inode: root.inode }
})

type ScanStoreService = ScanStore["Service"]

const finish = (store: ScanStoreService, input: FinishScanInput) => store.finish(input)

const stagedCountForRoot = (store: ScanStoreService, rootId: string) =>
  store.listStaged().pipe(
    Effect.map((candidates) => candidates.filter((candidate) => candidate.root_id === rootId).length)
  )

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
  const rootFenceChanged = Cause.pretty(cause).includes(
    "scan task no longer matches the current root mapping or policy"
  )
  const error = interrupted
    ? {
        code: "scan_interrupted",
        message: "scan interrupted; staged discoveries and progress were preserved. Retry the scan after confirming the source is available."
      }
    : rootFenceChanged
    ? {
        code: "root_policy_changed",
        message: "scan stopped because the saved root mapping or policy changed while it was running. Retry the scan to continue with the current root settings."
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
      try: () => discoverSourceRoot(current.value, {
        limits: MANUAL_SCAN_SOURCE_DISCOVERY_LIMITS,
        exclusions: root.exclusions
      }),
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
      candidatesDiscovered: coverage.candidate_count,
      reviewNeededCount: 0,
      coverage
    }
    yield* store.recordDiscovery(task.task_id, coverage, coverage.candidate_count)

    const firstObservations = new Map<string, string>()
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
          holdState: task.hold_new_discoveries ? "held" : "eligible",
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
        firstObservations.set(candidate.relativePath, JSON.stringify(sourceManifestView(manifest)))
        yield* store.stage({
          candidateId: randomUUID(),
          taskId: task.task_id,
          rootId: task.root_id,
          relativePath: candidate.relativePath,
          kind: candidate.kind,
          holdState: task.hold_new_discoveries ? "held" : "eligible",
          analysisStatus: "ready",
          manifest: sourceManifestView(manifest),
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
          holdState: task.hold_new_discoveries ? "held" : "eligible",
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

    let readinessError: { readonly code: string; readonly message: string } | null = null
    let unstableCandidateCount = 0
    let fingerprintFailureCount = 0
    let allocationDeferred = false
    let deferredReviewNeededCount: number | undefined
    if (!task.hold_new_discoveries && coverage.status === "complete") {
      const fingerprintPaths = new Set(yield* store.readNormalScanFingerprintPlan({
        taskId: task.task_id,
        rootId: task.root_id
      }))
      let verifiedAnalyzed = 0
      let verifiedErrors = 0
      const verifiedCandidatePaths: Array<string> = []
      yield* Effect.sleep(Duration.millis(normalScanQuietIntervalMs()))
      for (const candidate of discovered.value.candidates) {
        const resolved = yield* Effect.tryPromise({
          try: () => resolveSourceCandidate(current.value, candidate.relativePath),
          catch: () => undefined
        })
        if (!resolved.ok) {
          verifiedErrors += 1
          yield* store.stage({
            candidateId: randomUUID(),
            taskId: task.task_id,
            rootId: task.root_id,
            relativePath: candidate.relativePath,
            kind: candidate.kind,
            holdState: "eligible",
            analysisStatus: "error",
            manifest: null,
            analysisError: sourceError(resolved.code)
          })
          continue
        }
        const result = yield* Effect.result(analyzeSourceManifest({ sourcePath: resolved.value.nativePath }))
        if (Result.isSuccess(result)) {
          verifiedAnalyzed += 1
          const manifestView = sourceManifestView(result.success)
          const observedManifest = JSON.stringify(manifestView)
          const stable = firstObservations.get(candidate.relativePath) === observedManifest
          let stagedManifest: typeof ScanManifest.Type = manifestView
          let fingerprintCompleted = true
          if (stable && fingerprintPaths.has(candidate.relativePath)) {
            const fingerprintResult = yield* Effect.result(Effect.tryPromise({
              try: (signal) => fingerprintSource(resolved.value.nativePath, result.success, {
                signal,
                maxBytes: FINGERPRINT_MAX_BYTES,
                deadlineMs: FINGERPRINT_DEADLINE_MS
              }),
              catch: (error) => error
            }))
            if (Result.isSuccess(fingerprintResult)) {
              stagedManifest = { ...manifestView, fingerprint: fingerprintResult.success }
            } else {
              fingerprintFailureCount += 1
              fingerprintCompleted = false
            }
          }
          if (stable && fingerprintCompleted) {
            verifiedCandidatePaths.push(candidate.relativePath)
          } else {
            unstableCandidateCount += 1
          }
          yield* store.stage({
            candidateId: randomUUID(),
            taskId: task.task_id,
            rootId: task.root_id,
            relativePath: candidate.relativePath,
            kind: candidate.kind,
            holdState: "eligible",
            analysisStatus: "ready",
            manifest: stagedManifest,
            analysisError: null
          })
        } else {
          verifiedErrors += 1
          yield* store.stage({
            candidateId: randomUUID(),
            taskId: task.task_id,
            rootId: task.root_id,
            relativePath: candidate.relativePath,
            kind: candidate.kind,
            holdState: "eligible",
            analysisStatus: "error",
            manifest: null,
            analysisError: analysisError(result.failure)
          })
        }
      }
      progress = {
        ...progress,
        candidatesAnalyzed: verifiedAnalyzed,
        analysisErrorCount: verifiedErrors,
        reviewNeededCount: 0
      }
      const rootStillCurrent = yield* Effect.tryPromise({
        try: () => revalidateSourceRoot(observed),
        catch: () => undefined
      })
      if (!rootStillCurrent.ok) {
        if (progress.coverage !== null) {
          progress = {
            ...progress,
            coverage: {
              ...progress.coverage,
              status: "partial",
              issues: [...progress.coverage.issues, { code: discoveryIssueCode(rootStillCurrent.code) }],
              issue_count: progress.coverage.issue_count + 1
            }
          }
        }
        readinessError = { code: "root_changed", message: "saved root changed or became unavailable during scan" }
      } else {
        const published = yield* store.publishNormal({
          taskId: task.task_id,
          rootId: task.root_id,
          mappingRevision: task.mapping_revision,
          expectedPolicyRevision: root.policyRevision,
          observedPaths: discovered.value.candidates.map((candidate) => candidate.relativePath),
          observedCandidatePaths: verifiedCandidatePaths
        })
        switch (published.kind) {
          case "published":
            break
          case "allocation_deferred":
            allocationDeferred = true
            deferredReviewNeededCount = published.reviewNeededCount
            readinessError = {
              code: "allocation_deferred",
              message: [
                "automatic allocation was deferred",
                deferredPathsMessage("missing occupied paths", published.missingPaths, published.missingPathCount),
                deferredPathsMessage("unidentified occupied paths", published.unidentifiedPaths, published.unidentifiedPathCount),
                deferredPathsMessage("changed occupied paths", published.changedPaths, published.changedPathCount),
                `${published.excludedPathCount} occupied path(s) excluded by policy`
              ].join("; ")
            }
            break
          case "root_not_found":
          case "mapping_revision_conflict":
            readinessError = { code: "root_changed", message: "saved root changed during scan" }
            break
          case "policy_revision_conflict":
            readinessError = { code: "policy_changed", message: "saved root policy changed during scan" }
            break
        }
      }
    }

    const reviewNeededCount = deferredReviewNeededCount ?? (yield* stagedCountForRoot(store, task.root_id))
    progress = {
      ...progress,
      reviewNeededCount
    }
    const hasErrors = progress.analysisErrorCount > 0 || progress.coverage?.status === "partial" || unstableCandidateCount > 0 || fingerprintFailureCount > 0 || allocationDeferred
    const failed = readinessError !== null && readinessError.code !== "allocation_deferred"
    yield* finish(store, {
      taskId: task.task_id,
      status: failed ? "failed" : hasErrors ? "completed_with_errors" : "succeeded",
      directoriesVisited: progress.directoriesVisited,
      candidatesDiscovered: progress.candidatesDiscovered,
      candidatesAnalyzed: progress.candidatesAnalyzed,
      analysisErrorCount: progress.analysisErrorCount,
      reviewNeededCount: progress.reviewNeededCount,
      coverage: progress.coverage,
      error: !failed && hasErrors
        ? {
            code: allocationDeferred ? "allocation_deferred" : fingerprintFailureCount > 0 ? "fingerprint_unavailable" : unstableCandidateCount > 0 ? "unstable_observation" : progress.analysisErrorCount > 0 ? "analysis_error" : "partial_coverage",
            message: allocationDeferred
              ? "automatic allocation was deferred; unresolved occupied paths require review"
              : fingerprintFailureCount > 0
                ? "one or more targeted fingerprints could not be completed within the scan limits"
              : unstableCandidateCount > 0
                ? "one or more discoveries changed during the quiet interval"
                : progress.analysisErrorCount > 0
                  ? "one or more discoveries could not be analyzed"
                  : "scan coverage is partial"
          }
        : null,
      readinessError
    })
  }).pipe(Effect.catchCause((cause) => finishUnexpected(store, task, progress, cause)))
})
