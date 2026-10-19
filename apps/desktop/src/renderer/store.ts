import type {
  CommandAttempt,
  CommandReconciliation,
  ConnectionStatusView,
  NoteView,
  SavedDraft
} from "@henshin/contracts"

export type Outcome =
  | { readonly kind: "committed"; readonly revision: string }
  | { readonly kind: "conflict"; readonly current_revision: string }
  | { readonly kind: "draft_saved"; readonly local_revision: string }
  | { readonly kind: "draft_loaded"; readonly copied: boolean }
  | { readonly kind: "draft_discarded"; readonly local_revision: string }
  | { readonly kind: "draft_conflict"; readonly current_local_revision: string }
  | { readonly kind: "reconciled"; readonly requires_reconciliation: boolean }
  | { readonly kind: "error"; readonly message: string }

export interface ViewState {
  readonly status: "idle" | "loading" | "ready" | "error"
  readonly instance_id: string | null
  readonly epoch: string | null
  readonly note: NoteView | null
  readonly base_revision: string | null
  readonly form_text: string
  readonly form_edit_version: number
  readonly draft_local_revision: string
  readonly saved_draft: SavedDraft | null
  readonly outcome: Outcome | null
  readonly recovery_attempts: ReadonlyArray<CommandAttempt>
  readonly recovery_result: CommandReconciliation | null
  readonly connection: ConnectionStatusView
  readonly connection_generation: number
}

const initialState: ViewState = {
  status: "idle",
  instance_id: null,
  epoch: null,
  note: null,
  base_revision: null,
  form_text: "",
  form_edit_version: 0,
  draft_local_revision: "0",
  saved_draft: null,
  outcome: null,
  recovery_attempts: [],
  recovery_result: null,
  connection: { state: "disconnected", instance_id: null, epoch: null, reason: null },
  connection_generation: 0
}

const sameConnection = (left: ConnectionStatusView, right: ConnectionStatusView): boolean =>
  left.state === right.state &&
  left.instance_id === right.instance_id &&
  left.epoch === right.epoch &&
  left.reason === right.reason

const createViewStore = () => {
  let state: ViewState = initialState
  const listeners = new Set<() => void>()

  return {
    getState: (): ViewState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (patch: Partial<ViewState>): void => {
      state = { ...state, ...patch }
      for (const listener of listeners) listener()
    },
    editFormText: (text: string): void => {
      state = { ...state, form_text: text, form_edit_version: state.form_edit_version + 1 }
      for (const listener of listeners) listener()
    },
    setConnection: (connection: ConnectionStatusView): void => {
      if (sameConnection(state.connection, connection)) return
      state = {
        ...state,
        connection,
        connection_generation: state.connection_generation + 1
      }
      for (const listener of listeners) listener()
    },
    beginConnectionTransition: (stateName: ConnectionStatusView["state"]): number => {
      const connection = { ...state.connection, state: stateName }
      state = {
        ...state,
        connection,
        status:
          state.status === "loading"
            ? state.note === null
              ? "idle"
              : "ready"
            : state.status,
        connection_generation: state.connection_generation + 1
      }
      for (const listener of listeners) listener()
      return state.connection_generation
    },
    publishConnection: (connection: ConnectionStatusView, generation: number): boolean => {
      if (state.connection_generation !== generation) return false
      if (sameConnection(state.connection, connection)) return true
      state = { ...state, connection }
      for (const listener of listeners) listener()
      return true
    }
  }
}

/**
 * Small immutable external store consumed through `useSyncExternalStore`. Effect
 * workflows own the async state and publish new immutable snapshots here.
 */
export const viewStore = createViewStore()
