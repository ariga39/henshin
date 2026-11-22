import { useSyncExternalStore } from "react"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { previewRoot } from "./workflows"

const rootPreviewStatusText = (state: ReturnType<typeof viewStore.getState>): string => {
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
  return (
    <main className="collection">
      <h1>Collection setup</h1>
      <p>Enter the full path to your collection as it appears on the server.</p>
      <form onSubmit={(event) => {
        event.preventDefault()
        if (!loading && state.root_preview_path) void runtime.runPromise(previewRoot(state.root_preview_path))
      }}>
        <label htmlFor="server-path">Server directory</label>
        <input id="server-path" data-testid="root-preview-path" value={state.root_preview_path}
          disabled={loading} required spellCheck={false}
          onChange={(event) => viewStore.set({ root_preview_path: event.target.value })} />
        <button data-testid="root-preview-submit" disabled={loading || !state.root_preview_path}>
          {loading ? "Previewing…" : "Preview directory"}
        </button>
      </form>
      {state.root_preview_selected_path && (
        <h2 data-testid="root-preview-selected-path">{state.root_preview_selected_path}</h2>
      )}
      <p role="status" data-testid="root-preview-outcome">{rootPreviewStatusText(state)}</p>
      {state.root_preview_status === "error" && state.root_preview_selected_path === state.root_preview_path && (
        <button data-testid="root-preview-retry" onClick={() => void runtime.runPromise(previewRoot(state.root_preview_path))}>
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
    </main>
  )
}
