import { useSyncExternalStore } from "react"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { discardSavedDraft, loadNote, loadSavedDraft, saveLocalDraft, saveNote } from "./workflows"

const outcomeText = (state: ReturnType<typeof viewStore.getState>): string => {
  const outcome = state.outcome
  if (outcome === null) return "idle"
  switch (outcome.kind) {
    case "committed":
      return `committed revision=${outcome.revision}`
    case "conflict":
      return `conflict current_revision=${outcome.current_revision}`
    case "draft_saved":
      return `local draft saved revision=${outcome.local_revision}`
    case "draft_loaded":
      return "local draft loaded into form; refresh before server reapply"
    case "draft_discarded":
      return `local draft discarded revision=${outcome.local_revision}`
    case "draft_conflict":
      return `local draft conflict current_revision=${outcome.current_local_revision}`
    case "error":
      return `error ${outcome.message}`
  }
}

export const App = () => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)

  return (
    <main>
      <h1>Henshin runtime persistence prototype</h1>
      <p>
        Narrow G1 case2 precursor: the synthetic note has explicit desktop-local draft recovery.
        Local drafts never send a server mutation.
      </p>
      <dl>
        <dt>instance</dt>
        <dd data-testid="instance">{state.instance_id ?? "none"}</dd>
        <dt>epoch</dt>
        <dd data-testid="epoch">{state.epoch ?? "none"}</dd>
        <dt>note text</dt>
        <dd data-testid="note-text">{state.note?.text ?? "none"}</dd>
        <dt>committed revision</dt>
        <dd data-testid="committed-revision">{state.note?.revision ?? "none"}</dd>
        <dt>editing from revision</dt>
        <dd data-testid="base-revision">{state.base_revision ?? "none"}</dd>
      </dl>
      <label htmlFor="text-input">New text</label>
      <input
        id="text-input"
        data-testid="text-input"
        value={state.form_text}
        onChange={(event) => viewStore.set({ form_text: event.target.value })}
      />
      <button data-testid="load" onClick={() => void runtime.runPromise(loadNote)}>
        Load current note
      </button>
      <section aria-labelledby="draft-actions">
        <h2 id="draft-actions">Desktop-local draft</h2>
        <p>Load saved draft copies text into this form only. Refresh the note before deliberate server reapply.</p>
        <button data-testid="save-local-draft" onClick={() => void runtime.runPromise(saveLocalDraft)}>
          Save local draft
        </button>
        <button data-testid="load-local-draft" onClick={() => void runtime.runPromise(loadSavedDraft)}>
          Load saved draft
        </button>
        <button data-testid="discard-local-draft" onClick={() => void runtime.runPromise(discardSavedDraft)}>
          Discard saved draft
        </button>
        <p data-testid="draft-status">
          {state.saved_draft === null
            ? "no saved draft loaded"
            : `saved local revision=${state.saved_draft.local_revision} base epoch=${state.saved_draft.base_epoch}`}
        </p>
      </section>
      <section aria-labelledby="server-actions">
        <h2 id="server-actions">Server mutation</h2>
        <p>Only this deliberate Save sends the synthetic note edit to the server.</p>
        <button data-testid="save" onClick={() => void runtime.runPromise(saveNote(state.form_text))}>
          Save to server
        </button>
      </section>
      <p data-testid="outcome">{outcomeText(state)}</p>
    </main>
  )
}
