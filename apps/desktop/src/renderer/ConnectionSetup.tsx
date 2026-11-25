import { useState, useSyncExternalStore } from "react"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import {
  connectRemote,
  cancelRemote,
  confirmRemote,
  disconnectNormal,
  reconnectNormal,
  useManagedConnection
} from "./workflows"

export const ConnectionSetup = () => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)
  const [baseUrl, setBaseUrl] = useState("")
  const [bearerToken, setBearerToken] = useState("")
  const transitioning = state.connection.state === "connecting" || state.remote_probe_status === "loading"
  const pending = state.pending_remote_connection

  return (
    <section aria-labelledby="connection-setup-heading">
      <h2 id="connection-setup-heading">Server connection</h2>
      <p data-testid="connection-target">
        {state.connection_target.mode === "managed"
          ? "Using this desktop's managed local service."
          : `Remote server: ${state.connection_target.base_url ?? "not configured"} (session only; re-enter the credential after restart)`}
      </p>
      <p data-testid="connection-status">Connection: {state.connection.state}</p>
      {state.connection.state === "blocked" && state.connection.reason !== null && state.outcome?.kind !== "error" && (
        <p role="alert">Connection issue: {state.connection.reason}</p>
      )}
      {state.outcome?.kind === "error" && <p role="alert" data-testid="connection-outcome">Connection issue: {state.outcome.message}</p>}
      <div className="connection-actions">
        <button data-testid="connection-reconnect" disabled={transitioning} onClick={() => void runtime.runPromise(reconnectNormal)}>
          Reconnect
        </button>
        <button data-testid="connection-disconnect" disabled={state.connection.state !== "connected"} onClick={() => void runtime.runPromise(disconnectNormal)}>
          Disconnect
        </button>
        {state.connection_target.mode === "remote" && (
          <button data-testid="connection-use-managed" disabled={transitioning} onClick={() => void runtime.runPromise(useManagedConnection)}>
            Use managed local service
          </button>
        )}
      </div>
      {pending !== null && (
        <div role="alert" data-testid="remote-confirmation">
          <p>
            The server reported instance <code>{pending.instance_id}</code>.
            Confirm this identity before using its library.
          </p>
          <p data-testid="remote-session-only-warning">
            This connection is for this session only. Re-enter the credential after restart.
          </p>
          <button
            data-testid="remote-confirm"
            disabled={transitioning}
            onClick={() => void runtime.runPromise(confirmRemote)}
          >
            Use for this session only
          </button>
          <button
            data-testid="remote-cancel"
            disabled={transitioning}
            onClick={() => void runtime.runPromise(cancelRemote)}
          >
            Cancel
          </button>
        </div>
      )}
      <form
        data-testid="remote-connection-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!transitioning && pending === null && baseUrl !== "" && bearerToken !== "") {
            void runtime.runPromise(connectRemote(baseUrl, bearerToken)).finally(() => setBearerToken(""))
          }
        }}
      >
        <label htmlFor="remote-base-url">Trusted HTTPS endpoint</label>
        <input
          id="remote-base-url"
          data-testid="remote-base-url"
          type="url"
          value={baseUrl}
          disabled={transitioning || pending !== null}
          required
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://library.example.test"
        />
        <label htmlFor="remote-bearer-token">Owner credential</label>
        <input
          id="remote-bearer-token"
          data-testid="remote-bearer-token"
          type="password"
          value={bearerToken}
          disabled={transitioning || pending !== null}
          required
          autoComplete="off"
          onChange={(event) => setBearerToken(event.target.value)}
        />
        <button data-testid="remote-connect" disabled={transitioning || pending !== null || baseUrl === "" || bearerToken === ""}>
          {transitioning ? "Connecting…" : "Connect to remote server"}
        </button>
      </form>
      <p>Only a successfully authenticated server with the expected identity becomes the active library.</p>
    </section>
  )
}
