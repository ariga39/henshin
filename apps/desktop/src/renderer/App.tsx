import { useState, useSyncExternalStore } from "react"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import { loadNote, saveNote } from "./workflows"

const outcomeText = (state: ReturnType<typeof viewStore.getState>): string => {
  const outcome = state.outcome
  if (outcome === null) return "idle"
  switch (outcome.kind) {
    case "committed":
      return `committed revision=${outcome.revision}`
    case "conflict":
      return `conflict current_revision=${outcome.current_revision}`
    case "error":
      return `error ${outcome.message}`
  }
}

export const App = () => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)
  const [text, setText] = useState("")

  return (
    <main>
      <h1>Henshin runtime persistence prototype</h1>
      <p>Synthetic conditional edit over renderer -&gt; preload -&gt; main -&gt; server -&gt; SQLite worker.</p>
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
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button data-testid="load" onClick={() => void runtime.runPromise(loadNote)}>
        Load
      </button>
      <button data-testid="save" onClick={() => void runtime.runPromise(saveNote(text))}>
        Save
      </button>
      <p data-testid="outcome">{outcomeText(state)}</p>
    </main>
  )
}
