import { randomUUID } from "node:crypto"
import { Effect, Result } from "effect"
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
  type SourceDiscoveryCoverage
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

const coverageView = (coverage: SourceDiscoveryCoverage) => ({
  status: coverage.status,
  directories_visited: coverage.directoriesVisited,
  entries_observed: coverage.entriesObserved,
  candidate_count: coverage.candidateCount,
  candidate_sample_truncated: coverage.candidateSampleTruncated,
  excluded_links: coverage.excludedLinks,
  excluded_link_count: coverage.excludedLinkCount,
  unsupported_names: coverage.unsupportedNames,
  unsupported_name_count: coverage.unsupportedNameCount,
  unsupported_directories: coverage.unsupportedDirectories,
  unsupported_directory_count: coverage.unsupportedDirectoryCount,
  issues: coverage.issues,
  issue_count: coverage.issueCount
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

/** Runs one explicit held manual scan; it never performs reconciliation or allocation. */
export const runManualHeldScan = Effect.fn("runManualHeldScan")(function*(task: ScanTask, root: ServerRootRow) {
  const store = yield* ScanStore
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
      directoriesVisited: 0,
      candidatesDiscovered: 0,
      candidatesAnalyzed: 0,
      analysisErrorCount: 0,
      reviewNeededCount: 0,
      coverage: null,
      error: null,
      readinessError: { code: "readiness_error", message: "saved root is unavailable or changed" }
    })
    return
  }

  const discovered = yield* Effect.tryPromise({
    try: () => discoverSourceRoot(current.value),
    catch: () => undefined
  })
  if (!discovered.ok) {
    yield* finish(store, {
      taskId: task.task_id,
      status: "failed",
      directoriesVisited: 0,
      candidatesDiscovered: 0,
      candidatesAnalyzed: 0,
      analysisErrorCount: 0,
      reviewNeededCount: 0,
      coverage: null,
      error: null,
      readinessError: { code: discovered.code, message: "saved root could not be discovered" }
    })
    return
  }

  let analyzedCount = 0
  let analysisErrorCount = 0
  for (const candidate of discovered.value.candidates) {
    const resolved = yield* Effect.tryPromise({
      try: () => resolveSourceCandidate(current.value, candidate.relativePath),
      catch: () => undefined
    })

    if (!resolved.ok) {
      analysisErrorCount += 1
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
      continue
    }

    const result = yield* Effect.result(analyzeSourceManifest({ sourcePath: resolved.value.nativePath }))
    if (Result.isSuccess(result)) {
      const manifest = result.success
      analyzedCount += 1
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
    } else {
      analysisErrorCount += 1
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
    }
  }

  const coverage = coverageView(discovered.value.coverage)
  const hasErrors = analysisErrorCount > 0 || coverage.status === "partial"
  yield* finish(store, {
    taskId: task.task_id,
    status: hasErrors ? "completed_with_errors" : "succeeded",
    directoriesVisited: coverage.directories_visited,
    candidatesDiscovered: discovered.value.candidates.length,
    candidatesAnalyzed: analyzedCount,
    analysisErrorCount,
    reviewNeededCount: discovered.value.candidates.length,
    coverage,
    error: hasErrors
      ? { code: analysisErrorCount > 0 ? "analysis_error" : "partial_coverage", message: analysisErrorCount > 0 ? "one or more discoveries could not be analyzed" : "scan coverage is partial" }
      : null,
    readinessError: null
  })
})
