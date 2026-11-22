import { useSyncExternalStore } from "react"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { previewRoot, saveRoot } from "./workflows"

const rootPreviewStatusText = (state: ReturnType<typeof viewStore.getState>): string => {
  if (state.root_save_status === "loading") return "Saving server root…"
  if (state.root_save_status === "error") {
    return `Save failed for ${state.root_save_target_label ?? "the confirmed root"} (${state.root_save_target_path ?? "unknown path"}): ${state.root_save_error}`
  }
  if (state.root_save_status === "ready") {
    return `Server root saved: ${state.root_save_target_label} (${state.root_save_target_path}).`
  }
  if (state.root_preview_status === "loading") return "Previewing directory…"
  if (state.root_preview_status === "error") {
    return `Preview failed: ${state.root_preview_error}. Check the server path and try again.`
  }
  if (state.root_preview === null) return ""
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
  const canSave = state.root_preview !== null &&
    state.root_preview_status === "ready" &&
    state.root_preview_path === state.root_preview.selected_server_path &&
    state.root_label.length > 0
  return (
    <main className="collection">
      <h1>Collection setup</h1>
      <p>Enter the full path to your collection as it appears on the server.</p>
      <form onSubmit={(event) => {
        event.preventDefault()
        if (!loading && !saving && state.root_preview_path) void runtime.runPromise(previewRoot(state.root_preview_path))
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
        <button data-testid="root-preview-submit" disabled={loading || saving || !state.root_preview_path}>
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
      <button data-testid="root-save" disabled={!canSave || saving} onClick={() => void runtime.runPromise(saveRoot)}>
        {saving ? "Saving…" : "Save server root"}
      </button>
      {state.root_preview_status === "error" && state.root_preview_selected_path === state.root_preview_path && (
        <button data-testid="root-preview-retry" disabled={saving} onClick={() => void runtime.runPromise(previewRoot(state.root_preview_path))}>
          Retry preview
        </button>
      )}
      {state.root_preview && state.root_preview.children.length > 0 && (
        <ul data-testid="root-preview-children">
          {state.root_preview.children.map((child, index) => (
            <li key={index}><span>{child.name}</span><small>{child.kind}</small></li>
          ))}
        </ul>
      )}
      <section aria-labelledby="saved-roots-heading">
        <h2 id="saved-roots-heading">Saved server roots</h2>
        {state.root_roots_status === "loading" && <p>Loading saved roots…</p>}
        {state.root_roots_status === "error" && <p>Could not load saved roots: {state.root_roots_error}</p>}
        <ul data-testid="root-saved-roots">
          {state.root_saved_roots.map((root) => (
            <li key={root.root_id} data-testid="root-saved">
              <strong>{root.label}</strong><span> {root.selected_server_path}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
