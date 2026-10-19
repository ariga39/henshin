import { Effect } from "effect"
import {
  analyzeSourceManifest,
  ManifestCandidateError,
  type AnalyzeSourceManifestInput
} from "./SourceManifestAnalysis"

const sourcePath = process.argv[2]
if (sourcePath === undefined) {
  console.error("usage: manifest-probe <local-directory|zip|cbz>")
  process.exitCode = 2
} else {
  const startedAt = Date.now()
  const input: AnalyzeSourceManifestInput = { sourcePath }
  try {
    const manifest = await Effect.runPromise(analyzeSourceManifest(input))
    const totalBytes = manifest.pages.reduce((total, page) => total + page.declaredBytes, 0)
    console.log(
      JSON.stringify({
        result: "manifest-complete",
        sourceKind: manifest.sourceKind,
        pageCount: manifest.pages.length,
        supportedPages: manifest.diagnostics.supportedPages,
        unsupportedPages: manifest.diagnostics.unsupportedPages,
        ignoredEntries: manifest.diagnostics.ignoredEntries,
        directoryRecords: manifest.diagnostics.directoryRecords,
        declaredPageBytes: totalBytes,
        elapsedMs: Date.now() - startedAt
      })
    )
  } catch (error) {
    const candidate = error instanceof ManifestCandidateError ? error : undefined
    console.error(
      JSON.stringify({
        result: "candidate-error",
        code: candidate?.code ?? "read-failure",
        supportedPages: candidate?.diagnostics.supportedPages ?? 0,
        unsupportedPages: candidate?.diagnostics.unsupportedPages ?? 0,
        ignoredEntries: candidate?.diagnostics.ignoredEntries ?? 0,
        directoryRecords: candidate?.diagnostics.directoryRecords ?? 0,
        elapsedMs: Date.now() - startedAt
      })
    )
    process.exitCode = 1
  }
}
