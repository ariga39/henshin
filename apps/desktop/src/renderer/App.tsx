import { useSyncExternalStore } from "react"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import {
  dismissRecovery,
  discardSavedDraft,
  loadNote,
  disconnect,
  reconnect,
  loadRecovery,
  loadSavedDraft,
  reconcileRecovery,
  saveLocalDraft,
  saveNote
} from "./workflows"

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
      return outcome.copied
        ? "local draft loaded into form; refresh before server reapply"
        : "local draft retained; form changed while loading"
    case "draft_discarded":
      return `local draft discarded revision=${outcome.local_revision}`
    case "draft_conflict":
      return `local draft conflict current_revision=${outcome.current_local_revision}`
    case "reconciled":
      return outcome.requires_reconciliation ? "reconciliation still required" : "reconciliation complete"
    case "error":
      return `error ${outcome.message}`
  }
}

const reconciliationReasonText = (reason: NonNullable<ReturnType<typeof viewStore.getState>["recovery_result"]>["reconciliation_reason"]): string => {
  switch (reason) {
    case "operation_expired":
      return "operation result unavailable or expired"
    case "query_unavailable":
      return "operation status unavailable; current state may still be authoritative"
    case "persistence_failed":
      return "recovery result found but local persistence is incomplete"
    case "changed_epoch":
      return "authority epoch changed"
    case "complete":
      return "complete"
  }
}

export const App = () => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)
  const currentNoteLoading = state.status === "loading"
  const connected = state.connection.state === "connected"

  return (
    <main>
      <h1>Henshin runtime persistence prototype</h1>
      <p>
        Narrow G1 case2 precursor: the synthetic note has explicit desktop-local draft recovery.
        Local drafts never send a server mutation.
      </p>
      <dl>
        <dt>connection</dt>
        <dd data-testid="connection-status">{state.connection.state}</dd>
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
      <section aria-labelledby="connection-actions">
        <h2 id="connection-actions">Server connection</h2>
        <p>
          {state.connection.state === "disconnected"
            ? "Server network work is paused; local drafts and command recovery remain available."
            : state.connection.state === "blocked"
              ? `Connection blocked: ${state.connection.reason ?? "recovery required"}.`
              : state.connection.state}
        </p>
        <button
          data-testid="reconnect"
          disabled={state.connection.state === "connecting"}
          onClick={() => void runtime.runPromise(reconnect)}
        >
          Reconnect
        </button>
        <button
          data-testid="disconnect"
          disabled={!connected}
          onClick={() => void runtime.runPromise(disconnect)}
        >
          Disconnect
        </button>
      </section>
      <label htmlFor="text-input">New text</label>
      <input
        id="text-input"
        data-testid="text-input"
        value={state.form_text}
        disabled={currentNoteLoading}
        onChange={(event) => viewStore.editFormText(event.target.value)}
      />
      <button
        data-testid="load"
        disabled={currentNoteLoading || !connected}
        onClick={() => void runtime.runPromise(loadNote)}
      >
        Load current note
      </button>
      <section aria-labelledby="draft-actions">
        <h2 id="draft-actions">Desktop-local draft</h2>
        <p>Load saved draft copies text into this form only. Refresh the note before deliberate server reapply.</p>
        <button
          data-testid="save-local-draft"
          disabled={currentNoteLoading}
          onClick={() => void runtime.runPromise(saveLocalDraft)}
        >
          Save local draft
        </button>
        <button
          data-testid="load-local-draft"
          disabled={currentNoteLoading}
          onClick={() => void runtime.runPromise(loadSavedDraft)}
        >
          Load saved draft
        </button>
        <button
          data-testid="discard-local-draft"
          disabled={currentNoteLoading}
          onClick={() => void runtime.runPromise(discardSavedDraft)}
        >
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
        <button
          data-testid="save"
          disabled={currentNoteLoading || !connected}
          onClick={() => void runtime.runPromise(saveNote(state.form_text))}
        >
          Save to server
        </button>
      </section>
      <p data-testid="outcome">{outcomeText(state)}</p>
      <section aria-labelledby="recovery-actions">
        <h2 id="recovery-actions">Command recovery</h2>
        <p>Recovery is read-only. It never resends a saved mutation.</p>
        <button data-testid="load-recovery" onClick={() => void runtime.runPromise(loadRecovery)}>
          List command diagnostics
        </button>
        {state.recovery_attempts.map((attempt) => (
          <article key={attempt.operation_id} data-testid={`recovery-${attempt.operation_id}`}>
            <p>
              operation {attempt.operation_id}: {attempt.status}; intent “{attempt.intent_text}” from revision{" "}
              {attempt.base_revision}
            </p>
            <p>submitted epoch {attempt.epoch}</p>
            <button onClick={() => void runtime.runPromise(reconcileRecovery(attempt.operation_id))}>
              Reconcile
            </button>
            <button onClick={() => void runtime.runPromise(dismissRecovery(attempt.operation_id))}>
              Dismiss
            </button>
          </article>
        ))}
        {state.recovery_result !== null && (
          <div data-testid="recovery-comparison">
            <p>
              original intent: “{state.recovery_result.attempt.intent_text}” from revision {state.recovery_result.attempt.base_revision}
            </p>
            <p>submitted epoch: {state.recovery_result.attempt.epoch}</p>
            <p>
              recovered result: {state.recovery_result.server_result === null
                ? "unavailable or expired"
                : `“${state.recovery_result.server_result.note.text}” at revision ${state.recovery_result.server_result.note.revision} (lookup expiry ${state.recovery_result.server_result.expires_at_ms})`}
            </p>
            <p>
              current note: {state.recovery_result.current_note === null
                ? "unavailable"
                : `“${state.recovery_result.current_note.text}” at revision ${state.recovery_result.current_note.revision}`}
            </p>
            <p data-testid="recovery-result">
              {state.recovery_result.requires_reconciliation
                ? state.recovery_result.reconciliation_reason === "changed_epoch"
                  ? "authority epoch changed; compare the current note before deliberate reapply"
                  : `${reconciliationReasonText(state.recovery_result.reconciliation_reason)}; compare the current note before deliberate reapply`
                : `reconciled ${state.recovery_result.attempt.status}; compare before deliberate reapply`}
            </p>
          </div>
        )}
      </section>
    </main>
  )
}
