import type { RootPreviewResult, ScanTask, StagedDiscovery } from "@henshin/contracts"
import { useSyncExternalStore } from "react"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { releaseHeldDiscovery, retryScanResults, startManualScan } from "./workflows"

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
      {state.scan_status !== "error" && state.scan_tasks.length === 0 && state.staged_discoveries.length === 0 && (
        <p>No held scan results yet.</p>
      )}
      {state.scan_tasks.length > 0 && (
        <ul data-testid="scan-task-list">
          {state.scan_tasks.map((task) => (
            <li key={task.task_id} data-testid="scan-task-summary">
              <strong>{taskStatusText(task.status)}</strong>
              <span> — {taskRootLabel(state, task.root_id)} — {task.candidates_analyzed}/{task.candidates_discovered} analyzed</span>
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
