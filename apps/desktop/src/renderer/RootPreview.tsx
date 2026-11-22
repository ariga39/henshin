import { useSyncExternalStore } from "react"
import type { RootPreviewResult } from "@henshin/contracts"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { canSaveRoot, excludeRootPath, previewRoot, refreshRootPolicy, removeRootExclusion, saveRoot } from "./workflows"
import { HeldScanControls, HeldScanReview } from "./HeldScanReview"
import { ReaderProfiles } from "./ReaderProfiles"

const isSavedDiscovery = (preview: RootPreviewResult | null): preview is Extract<RootPreviewResult, { kind: "saved-root-discovery" }> =>
  preview !== null && "kind" in preview

const isPathPreview = (preview: RootPreviewResult | null): preview is Extract<RootPreviewResult, { children: unknown }> =>
  preview !== null && "children" in preview

const rootPreviewStatusText = (state: ReturnType<typeof viewStore.getState>): string => {
  if (state.root_save_status === "loading") return "Saving server root…"
  if (state.root_save_status === "error") {
    return `Save failed for ${state.root_save_target_label ?? "the confirmed root"} (${state.root_save_target_path ?? "unknown path"}): ${state.root_save_error}`
  }
  if (state.root_save_status === "ready") {
    return `Server root saved: ${state.root_save_target_label} (${state.root_save_target_path}).`
  }
  if (state.root_policy_status === "loading") return "Updating exclusion policy…"
  if (state.root_policy_status === "error") {
    return `Exclusion policy update failed: ${state.root_policy_error}. Refresh the preview and try again.`
  }
  if (state.root_preview_status === "loading") return "Previewing directory…"
  if (state.root_preview_status === "error") {
    if (state.root_preview_request && "kind" in state.root_preview_request) {
      return `Saved collection preview failed: ${state.root_preview_error}. Retry when the collection is available.`
    }
    return `Preview failed: ${state.root_preview_error}. Check the server path and try again.`
  }
  if (state.root_preview === null) return ""
  if (isSavedDiscovery(state.root_preview)) {
    const { coverage } = state.root_preview
    const skipped = [
      coverage.unsupported_name_count > 0 ? `${coverage.unsupported_name_count} unsupported names` : null,
      coverage.unsupported_directory_count > 0 ? `${coverage.unsupported_directory_count} unsupported directories` : null,
      state.root_preview.unsupported_loose_image_count > 0
        ? `${state.root_preview.unsupported_loose_image_count} unsupported loose images`
        : null,
      state.root_preview.unassigned_loose_image_count > 0
        ? `${state.root_preview.unassigned_loose_image_count} unassigned loose images`
        : null
    ].filter((value): value is string => value !== null)
    const coverageText = coverage.status === "partial"
      ? "Preview is partial; some source locations could not be covered."
      : "Candidate preview is complete."
    const candidateText = coverage.candidate_sample_truncated
      ? `Showing a sample of ${state.root_preview.sample_limit} candidates. More are available.`
      : null
    return [candidateText, coverageText, skipped.length > 0 ? `Skipped: ${skipped.join(", ")}.` : null]
      .filter((value): value is string => value !== null)
      .join(" ")
  }
  return state.root_preview.outcome === "empty"
    ? "The directory is empty."
    : state.root_preview.outcome === "truncated"
      ? `Showing the first ${state.root_preview.sample_limit} items. More are available.`
      : "All items are shown."
}

export const RootPreviewScreen = () => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)
  const loading = state.root_preview_status === "loading"
  const saving = state.root_save_status === "loading"
  const changingPolicy = state.root_policy_status === "loading"
  const retryRequest = state.root_preview_request
  return (
    <main className="collection">
      <h1>Collection setup</h1>
      <p>Enter the full path to your collection as it appears on the server.</p>
      <form onSubmit={(event) => {
        event.preventDefault()
        if (!loading && !saving && !changingPolicy && state.root_preview_path) void runtime.runPromise(previewRoot({ path: state.root_preview_path }))
      }}>
        <label htmlFor="server-path">Server directory</label>
        <input id="server-path" data-testid="root-preview-path" value={state.root_preview_path}
          disabled={loading} required spellCheck={false}
          onChange={(event) => viewStore.set({
            root_preview_path: event.target.value,
            ...(state.root_save_status === "loading"
              ? {}
              : { root_save_status: "idle" as const, root_save_error: null })
          })} />
        <button data-testid="root-preview-submit" disabled={loading || saving || changingPolicy || !state.root_preview_path}>
          {loading ? "Previewing…" : "Preview directory"}
        </button>
      </form>
      <label htmlFor="root-label">Root label</label>
      <input id="root-label" data-testid="root-label" value={state.root_label}
        disabled={saving} required spellCheck={false}
        onChange={(event) => viewStore.set({ root_label: event.target.value, root_save_status: "idle", root_save_error: null })} />
      {state.root_preview_selected_path && (
        <h2 data-testid="root-preview-selected-path">{state.root_preview_selected_path}</h2>
      )}
      <p role="status" data-testid="root-preview-outcome">{rootPreviewStatusText(state)}</p>
      {!isSavedDiscovery(state.root_preview) && (
        <button data-testid="root-save" disabled={!canSaveRoot(state) || changingPolicy} onClick={() => void runtime.runPromise(saveRoot)}>
          {saving ? "Saving…" : "Save server root"}
        </button>
      )}
      {state.root_preview_status === "error" && retryRequest !== null && (
        <button data-testid="root-preview-retry" disabled={saving || loading} onClick={() => void runtime.runPromise(previewRoot(retryRequest))}>
          Retry preview
        </button>
      )}
      {isPathPreview(state.root_preview) && state.root_preview.children.length > 0 && (
        <ul data-testid="root-preview-children">
          {state.root_preview.children.map((child, index) => (
            <li key={index}><span>{child.name}</span><small>{child.kind}</small></li>
          ))}
        </ul>
      )}
      {isSavedDiscovery(state.root_preview) && state.root_preview.candidates.length > 0 && (
        <ul data-testid="root-preview-candidates">
          {state.root_preview.candidates.map((candidate) => (
            <li key={candidate.relative_path}>
              <span>{candidate.relative_path}</span>
              <small>{candidate.kind}</small>
              {candidate.kind === "image-directory" && (
                <small> {candidate.direct_image_count} direct images</small>
              )}
              <button
                data-testid="root-exclude"
                disabled={changingPolicy}
                onClick={() => void runtime.runPromise(excludeRootPath({
                  rootId: state.root_preview && "kind" in state.root_preview ? state.root_preview.root_id : "",
                  path: candidate.relative_path,
                  scope: candidate.kind === "archive" ? "exact" : "subtree",
                  expectedPolicyRevision: isSavedDiscovery(state.root_preview) ? state.root_preview.policy_revision : ""
                }))}
              >
                Exclude {candidate.kind === "archive" ? "file" : "subtree"}
              </button>
              {candidate.unsupported_direct_image_count > 0 && (
                <small> {candidate.unsupported_direct_image_count} unsupported direct images</small>
              )}
            </li>
          ))}
        </ul>
      )}
      {isSavedDiscovery(state.root_preview) && (
        <p data-testid="root-preview-coverage">
          {state.root_preview.unassigned_loose_image_count} unassigned loose images; {state.root_preview.unsupported_loose_image_count} unsupported loose images; {state.root_preview.coverage.unsupported_name_count} unsupported names; {state.root_preview.coverage.unsupported_directory_count} unsupported directories; {state.root_preview.coverage.excluded_link_count} linked locations excluded; {state.root_preview.coverage.entries_observed} entries observed.
        </p>
      )}
      {state.root_policy_status === "error" && (
        <button
          data-testid="root-policy-refresh"
          disabled={changingPolicy}
          onClick={() => {
            void runtime.runPromise(refreshRootPolicy)
          }}
        >
          Refresh preview
        </button>
      )}
      <HeldScanControls preview={state.root_preview} />
      <HeldScanReview />
      <section aria-labelledby="saved-roots-heading">
        <h2 id="saved-roots-heading">Saved server roots</h2>
        {state.root_roots_status === "loading" && <p>Loading saved roots…</p>}
        {state.root_roots_status === "error" && <p>Could not load saved roots: {state.root_roots_error}</p>}
        <ul data-testid="root-saved-roots">
          {state.root_saved_roots.map((root) => (
            <li key={root.root_id} data-testid="root-saved">
              <strong>{root.label}</strong><span> {root.selected_server_path}</span>
              <small data-testid="root-saved-policy">
                {root.exclusions.length === 0 ? " No exclusions" : " Excluded: "}
                {root.exclusions.map((exclusion) => (
                  <span key={`${exclusion.path}:${exclusion.scope}`}>
                    {exclusion.path} ({exclusion.scope})
                    <button
                      data-testid="root-remove-exclusion"
                      disabled={changingPolicy}
                      onClick={() => void runtime.runPromise(removeRootExclusion({
                        rootId: root.root_id,
                        path: exclusion.path,
                        scope: exclusion.scope,
                        expectedPolicyRevision: root.policy_revision
                      }))}
                    >
                      Remove exclusion
                    </button>
                  </span>
                ))}
              </small>
              <button data-testid="root-saved-preview" disabled={loading || saving || changingPolicy} onClick={() => void runtime.runPromise(previewRoot({ kind: "saved-root", root_id: root.root_id }))}>
                Preview books
              </button>
            </li>
          ))}
        </ul>
      </section>
      <ReaderProfiles />
    </main>
  )
}
