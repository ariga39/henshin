import type { NoteView } from "@henshin/contracts"

export type Outcome =
  | { readonly kind: "committed"; readonly revision: string }
  | { readonly kind: "conflict"; readonly current_revision: string }
  | { readonly kind: "error"; readonly message: string }

export interface ViewState {
  readonly status: "idle" | "loading" | "ready" | "error"
  readonly instance_id: string | null
  readonly epoch: string | null
  readonly note: NoteView | null
  readonly base_revision: string | null
  readonly outcome: Outcome | null
}

const initialState: ViewState = {
  status: "idle",
  instance_id: null,
  epoch: null,
  note: null,
  base_revision: null,
  outcome: null
}

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
    }
  }
}

/**
 * Small immutable external store consumed through `useSyncExternalStore`. Effect
 * workflows own the async state and publish new immutable snapshots here.
 */
export const viewStore = createViewStore()
