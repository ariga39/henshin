import type { NoteView, SavedDraft } from "@henshin/contracts"

export type Outcome =
  | { readonly kind: "committed"; readonly revision: string }
  | { readonly kind: "conflict"; readonly current_revision: string }
  | { readonly kind: "draft_saved"; readonly local_revision: string }
  | { readonly kind: "draft_loaded"; readonly copied: boolean }
  | { readonly kind: "draft_discarded"; readonly local_revision: string }
  | { readonly kind: "draft_conflict"; readonly current_local_revision: string }
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
    },
    editFormText: (text: string): void => {
      state = { ...state, form_text: text, form_edit_version: state.form_edit_version + 1 }
      for (const listener of listeners) listener()
    }
  }
}

/**
 * Small immutable external store consumed through `useSyncExternalStore`. Effect
 * workflows own the async state and publish new immutable snapshots here.
 */
export const viewStore = createViewStore()
