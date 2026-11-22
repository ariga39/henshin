import type { LibraryEntry, RootPreviewResult, ScanTask, StagedDiscovery } from "@henshin/contracts"
import { useSyncExternalStore } from "react"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { releaseHeldDiscovery, resolveReplacement, retryScanResults, startManualScan } from "./workflows"

const isSavedDiscovery = (preview: RootPreviewResult | null): preview is Extract<RootPreviewResult, { kind: "saved-root-discovery" }> =>
  preview !== null && "kind" in preview

const isActive = (task: ScanTask): boolean => task.status === "queued" || task.status === "running"

const taskStatusText = (status: ScanTask["status"]): string => {
  switch (status) {
    case "completed_with_errors":
      return "completed with errors"
    default:
      return status
  }
}

const latestTaskForRoot = (tasks: ReadonlyArray<ScanTask>, rootId: string): ScanTask | null => {
  const matching = tasks.filter((task) => task.root_id === rootId)
  return matching.length === 0 ? null : matching[matching.length - 1]
}

const taskRootLabel = (state: ReturnType<typeof viewStore.getState>, rootId: string): string => {
  const root = state.root_saved_roots.find((candidate) => candidate.root_id === rootId)
  return root === undefined ? `Saved root ${rootId}` : `${root.label} (${root.selected_server_path})`
}

const scanErrorText = (task: ScanTask): string | null => {
  if (task.readiness_error !== null) return `Readiness error: ${task.readiness_error.message}`
  if (task.error !== null) return `Scan error: ${task.error.message}`
  return null
}

const replacementCandidateFor = (
  candidates: ReadonlyArray<StagedDiscovery>,
  entry: LibraryEntry
): StagedDiscovery | undefined => candidates.find((candidate) =>
  candidate.root_id === entry.root_id && candidate.relative_path === entry.relative_path)

const replacementPageCount = (candidate: StagedDiscovery): number | null =>
  candidate.manifest === null ? null : candidate.manifest.pages.length

const replacementEntryLabel = (entry: LibraryEntry): string =>
  `${entry.title} (${entry.kind}, ${entry.page_count} page${entry.page_count === 1 ? "" : "s"})`

export const HeldScanControls = ({ preview }: { readonly preview: RootPreviewResult | null }) => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)
  if (!isSavedDiscovery(preview)) return null

  const task = latestTaskForRoot(state.scan_tasks, preview.root_id)
  const disabled = state.scan_start_status === "loading" || (task !== null && isActive(task))
  return (
    <section aria-labelledby="held-scan-heading" data-testid="held-scan-controls">
      <h2 id="held-scan-heading">Manual scan</h2>
      <p data-testid="held-scan-root">{taskRootLabel(state, preview.root_id)}</p>
      <label>
        <input
          data-testid="scan-hold-new-discoveries"
          type="checkbox"
          checked={state.scan_hold_new_discoveries}
          onChange={(event) => viewStore.set({ scan_hold_new_discoveries: event.target.checked })}
        />
        Hold new discoveries for review
      </label>
      <p>{state.scan_hold_new_discoveries
        ? "Held mode: discovered books remain staged and no book is accepted into Library."
        : "Normal mode: complete, current discoveries are accepted into Library."}</p>
      <button
        data-testid="start-held-scan"
        disabled={disabled}
        onClick={() => void runtime.runPromise(startManualScan(preview.root_id))}
      >
        {state.scan_start_status === "loading" ? "Starting manual scan…" : "Start manual scan"}
      </button>
      {state.scan_start_status === "error" && (
        <p role="alert" data-testid="scan-start-error">Could not start scan: {state.scan_start_error}</p>
      )}
      {task !== null && (
        <div data-testid={`scan-task-${task.task_id}`}>
          <p data-testid="held-scan-task">Task: {task.task_id}</p>
          <p data-testid="scan-task-status">Status: {taskStatusText(task.status)}</p>
          <p data-testid="scan-task-progress">
            {task.candidates_analyzed} of {task.candidates_discovered} discoveries analyzed; {task.directories_visited} directories visited.
          </p>
          <p data-testid="scan-task-coverage">
            Coverage: {task.coverage?.status ?? "not recorded"}
          </p>
          {scanErrorText(task) !== null && <p role="alert" data-testid="scan-task-error">{scanErrorText(task)}</p>}
        </div>
      )}
    </section>
  )
}

const discoveryStatus = (candidate: StagedDiscovery): string =>
  candidate.analysis_status === "ready" ? "ready" : `analysis error: ${candidate.analysis_error?.message ?? "unknown error"}`

export const HeldScanReview = () => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)
  const pendingEntries = state.library_entries.filter((entry) => entry.state === "replacement-pending")
  return (
    <section aria-labelledby="held-review-heading" data-testid="held-scan-review">
      <h2 id="held-review-heading">Review staged discoveries</h2>
      {state.scan_status === "loading" && <p>Refreshing scan results…</p>}
      {state.scan_status === "error" && (
        <>
          <p role="alert">Could not load scan results: {state.scan_error}</p>
          <button data-testid="scan-results-retry" onClick={() => void runtime.runPromise(retryScanResults)}>
            Retry
          </button>
        </>
      )}
      {state.scan_release_status === "error" && state.scan_release_error !== null && (
        <p role="alert" data-testid="scan-release-error">
          Could not release hold: {state.scan_release_error}
        </p>
      )}
      {pendingEntries.length > 0 && (
        <section aria-labelledby="replacement-review-heading" data-testid="replacement-review">
          <h2 id="replacement-review-heading">Changed books need a decision</h2>
          <p>
            The server found a different representation at an occupied path. Keep this entry only when it is the same edition; that preserves its identity and history. A different entry detaches the old identity and starts the new entry without inherited history or overrides. Leaving it pending keeps the book blocked from opening.
          </p>
          {pendingEntries.map((entry) => {
            const candidate = replacementCandidateFor(state.staged_discoveries, entry)
            const resolving = candidate !== undefined &&
              state.scan_resolution_candidate_id === candidate.candidate_id &&
              state.scan_resolution_status === "loading"
            const resolutionError = state.scan_resolution_status === "error" &&
              state.scan_resolution_entry_id === entry.entry_id
                ? state.scan_resolution_error
                : null
            const pageCount = candidate === undefined ? null : replacementPageCount(candidate)
            return (
              <article key={entry.entry_id} data-testid={`replacement-${entry.entry_id}`}>
                <h3>Previous entry</h3>
                <dl>
                  <dt>Previously indexed</dt>
                  <dd data-testid="replacement-previous-details">{replacementEntryLabel(entry)}</dd>
                  <dt>Source path</dt>
                  <dd>{entry.source_path}</dd>
                  <dt>Entry history</dt>
                  <dd>{entry.entry_id}</dd>
                </dl>
                <h3>Candidate at the same path</h3>
                {candidate === undefined ? (
                  <p data-testid="replacement-candidate-unavailable">
                    Candidate details are unavailable. Keep this replacement pending and refresh Review before deciding.
                  </p>
                ) : (
                  <>
                    <dl>
                      <dt>Candidate location</dt>
                      <dd data-testid="replacement-candidate-path">{candidate.relative_path}</dd>
                      <dt>Format</dt>
                      <dd>{candidate.kind}</dd>
                      <dt>Pages</dt>
                      <dd data-testid="replacement-candidate-pages">{pageCount === null ? "not available" : pageCount}</dd>
                      <dt>Decision version</dt>
                      <dd data-testid="replacement-decision-version">{entry.replacement?.decision_version ?? "not available"}</dd>
                      <dt>Analysis</dt>
                      <dd>{candidate.analysis_status === "ready" ? "complete" : candidate.analysis_error?.message ?? "not ready"}</dd>
                    </dl>
                    {candidate.analysis_status === "ready" && candidate.manifest !== null && pageCount !== null && pageCount > 0 ? (
                      <div>
                        <button
                          data-testid={`replacement-keep-${entry.entry_id}`}
                          disabled={resolving}
                          onClick={() => void runtime.runPromise(resolveReplacement(candidate.candidate_id, entry.entry_id, "keep"))}
                        >
                          {resolving && state.scan_resolution_decision === "keep" ? "Keeping entry…" : "Keep this entry (same edition)"}
                        </button>
                        <button
                          data-testid={`replacement-replace-${entry.entry_id}`}
                          disabled={resolving}
                          onClick={() => void runtime.runPromise(resolveReplacement(candidate.candidate_id, entry.entry_id, "replace"))}
                        >
                          {resolving && state.scan_resolution_decision === "replace" ? "Creating new entry…" : "Treat as a different entry"}
                        </button>
                      </div>
                    ) : (
                      <p>Resolution is unavailable until the candidate has complete analysis.</p>
                    )}
                  </>
                )}
                {resolutionError !== null && (
                  <p role="alert" data-testid="replacement-resolution-error">Could not resolve replacement: {resolutionError}</p>
                )}
                <p data-testid="replacement-pending-note">
                  Decide later: keep the current entry and its history pending until you are ready.
                </p>
              </article>
            )
          })}
        </section>
      )}
      {state.scan_status !== "error" && state.scan_tasks.length === 0 && state.staged_discoveries.length === 0 && (
        <p>No held scan results yet.</p>
      )}
      {state.scan_tasks.length > 0 && (
        <ul data-testid="scan-task-list">
          {state.scan_tasks.map((task) => (
            <li key={task.task_id} data-testid="scan-task-summary">
              <strong>{taskStatusText(task.status)}</strong>
              <span> — {taskRootLabel(state, task.root_id)} — {task.candidates_analyzed}/{task.candidates_discovered} analyzed</span>
              <small data-testid="scan-task-coverage"> — coverage: {task.coverage?.status ?? "not recorded"}</small>
              {scanErrorText(task) !== null && <small> {scanErrorText(task)}</small>}
            </li>
          ))}
        </ul>
      )}
      {state.staged_discoveries.length > 0 && (
        <ul data-testid="staged-discoveries">
          {state.staged_discoveries.map((candidate) => (
            <li key={candidate.candidate_id} data-testid="staged-discovery">
              <span data-testid="staged-discovery-root">{taskRootLabel(state, candidate.root_id)}</span>
              <span data-testid="staged-discovery-path">{candidate.relative_path}</span>
              <small>{discoveryStatus(candidate)}; hold: {candidate.hold_state}</small>
              {candidate.hold_state === "held" && (
                <button
                  data-testid={`release-hold-${candidate.candidate_id}`}
                  disabled={state.scan_release_status === "loading"}
                  onClick={() => void runtime.runPromise(releaseHeldDiscovery(candidate.candidate_id))}
                >
                  {state.scan_release_candidate_id === candidate.candidate_id && state.scan_release_status === "loading"
                    ? "Releasing hold…"
                    : "Release hold"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
