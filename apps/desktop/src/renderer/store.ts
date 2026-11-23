import type {
  CommandAttempt,
  CommandReconciliation,
  ConnectionStatusView,
  DeviceRootMapping,
  LocalMappingPreview,
  LibraryEntry,
  NoteView,
  RootPreviewRequest,
  RootPreviewResult,
  ScanTask,
  StagedDiscovery,
  ServerRoot,
  SavedDraft,
  ReaderProfile,
  ReaderProfileTestResult,
  ReaderProfileTestTarget,
  OpenBookIpcResult
} from "@henshin/contracts"
import type { OpenJournalView } from "./client"

export type Outcome =
  | { readonly kind: "committed"; readonly revision: string }
  | { readonly kind: "conflict"; readonly current_revision: string }
  | { readonly kind: "draft_saved"; readonly local_revision: string }
  | { readonly kind: "draft_loaded"; readonly copied: boolean }
  | { readonly kind: "draft_discarded"; readonly local_revision: string }
  | { readonly kind: "draft_conflict"; readonly current_local_revision: string }
  | { readonly kind: "reconciled"; readonly requires_reconciliation: boolean }
  | { readonly kind: "error"; readonly message: string }

export type LibraryOpenStatus = "idle" | "loading" | "accepted" | "failed" | "unknown"

export interface LibraryOpenState {
  readonly namespace_id: string
  readonly entry_id: string
  readonly profile_id: string
  readonly connection_generation: number
  readonly status: LibraryOpenStatus
  readonly result: OpenBookIpcResult | null
}

export interface ViewState {
  readonly screen: "setup" | "library"
  readonly status: "idle" | "loading" | "ready" | "error"
  readonly instance_id: string | null
  readonly epoch: string | null
  readonly note: NoteView | null
  readonly base_revision: string | null
  readonly base_epoch: string | null
  readonly form_text: string
  readonly form_edit_version: number
  readonly draft_local_revision: string
  readonly saved_draft: SavedDraft | null
  readonly outcome: Outcome | null
  readonly recovery_attempts: ReadonlyArray<CommandAttempt>
  readonly recovery_result: CommandReconciliation | null
  readonly open_journal: ReadonlyArray<OpenJournalView>
  readonly open_journal_error: string | null
  readonly root_preview_path: string
  readonly root_preview_selected_path: string | null
  readonly root_preview_status: "idle" | "loading" | "ready" | "error"
  readonly root_preview: RootPreviewResult | null
  readonly root_preview_request: RootPreviewRequest | null
  readonly root_preview_generation: number
  readonly root_preview_error: string | null
  readonly root_label: string
  readonly root_saved_roots: ReadonlyArray<ServerRoot>
  readonly root_roots_status: "idle" | "loading" | "ready" | "error"
  readonly root_roots_error: string | null
  readonly root_save_status: "idle" | "loading" | "ready" | "error"
  readonly root_save_operation_id: string | null
  readonly root_save_error: string | null
  readonly root_save_target_label: string | null
  readonly root_save_target_path: string | null
  readonly root_policy_status: "idle" | "loading" | "error"
  readonly root_policy_error: string | null
  readonly local_mapping_root_id: string | null
  readonly local_mapping_status: "idle" | "loading" | "ready" | "error"
  readonly local_mapping_preview: LocalMappingPreview | null
  readonly local_mapping_preview_token: string | null
  readonly local_mapping_error: string | null
  readonly local_mapping_list_status: "idle" | "loading" | "ready" | "error"
  readonly local_mapping_list_error: string | null
  readonly local_mapping_activation_status: "idle" | "loading" | "error"
  readonly local_mapping_activation_error: string | null
  readonly local_mappings: ReadonlyArray<DeviceRootMapping>
  readonly scan_tasks: ReadonlyArray<ScanTask>
  readonly staged_discoveries: ReadonlyArray<StagedDiscovery>
  readonly scan_status: "idle" | "loading" | "ready" | "error"
  readonly scan_error: string | null
  readonly scan_start_status: "idle" | "loading" | "error"
  readonly scan_start_error: string | null
  readonly scan_release_status: "idle" | "loading" | "error"
  readonly scan_release_candidate_id: string | null
  readonly scan_release_root_id: string | null
  readonly scan_release_operation_id: string | null
  readonly scan_release_candidate_version: number | null
  readonly scan_release_mapping_revision: string | null
  readonly scan_release_policy_revision: string | null
  readonly scan_release_error: string | null
  readonly scan_resolution_status: "idle" | "loading" | "error"
  readonly scan_resolution_candidate_id: string | null
  readonly scan_resolution_entry_id: string | null
  readonly scan_resolution_operation_id: string | null
  readonly scan_resolution_candidate_version: number | null
  readonly scan_resolution_decision_version: string | null
  readonly scan_resolution_location_revision: string | null
  readonly scan_resolution_mapping_revision: string | null
  readonly scan_resolution_policy_revision: string | null
  readonly scan_resolution_decision: "keep" | "replace" | null
  readonly scan_resolution_error: string | null
  readonly scan_hold_new_discoveries: boolean
  readonly connection: ConnectionStatusView
  readonly connection_generation: number
  readonly reader_profiles: ReadonlyArray<ReaderProfile>
  readonly reader_profiles_status: "idle" | "loading" | "ready" | "error"
  readonly reader_profiles_error: string | null
  readonly reader_profile_save_status: "idle" | "loading" | "ready" | "error"
  readonly reader_profile_save_error: string | null
  readonly reader_profile_selection_handle: string | null
  readonly reader_profile_selection_name: string | null
  readonly reader_profile_selection_error: string | null
  readonly reader_profile_test_target: ReaderProfileTestTarget | null
  readonly reader_profile_test_status: "idle" | "selecting" | "ready" | "launching" | "accepted" | "error"
  readonly reader_profile_test_result: ReaderProfileTestResult | null
  readonly reader_profile_test_error: string | null
  readonly library_entries: ReadonlyArray<LibraryEntry>
  readonly library_query: string
  readonly library_cursor: string | null
  readonly library_has_more: boolean
  readonly library_status: "idle" | "loading" | "ready" | "error"
  readonly library_error: string | null
  readonly library_request_generation: number
  readonly library_cover_generation: number
  readonly pending_replacement_entries: ReadonlyArray<LibraryEntry>
  readonly pending_replacement_cursor: string | null
  readonly pending_replacement_has_more: boolean
  readonly pending_replacement_status: "idle" | "loading" | "ready" | "error"
  readonly pending_replacement_error: string | null
  readonly library_scan_status: "idle" | "starting" | "started" | "error"
  readonly library_scan_error: string | null
  readonly library_scan_task: ScanTask | null
  readonly library_selected_entry_id: string | null
  readonly library_open_profile_id: string | null
  readonly library_open_states: ReadonlyArray<LibraryOpenState>
}

const initialState: ViewState = {
  screen: "setup",
  status: "idle",
  instance_id: null,
  epoch: null,
  note: null,
  base_revision: null,
  base_epoch: null,
  form_text: "",
  form_edit_version: 0,
  draft_local_revision: "0",
  saved_draft: null,
  outcome: null,
  recovery_attempts: [],
  recovery_result: null,
  open_journal: [],
  open_journal_error: null,
  root_preview_path: "",
  root_preview_selected_path: null,
  root_preview_status: "idle",
  root_preview: null,
  root_preview_request: null,
  root_preview_generation: 0,
  root_preview_error: null,
  root_label: "",
  root_saved_roots: [],
  root_roots_status: "idle",
  root_roots_error: null,
  root_save_status: "idle",
  root_save_operation_id: null,
  root_save_error: null,
  root_save_target_label: null,
  root_save_target_path: null,
  root_policy_status: "idle",
  root_policy_error: null,
  local_mapping_root_id: null,
  local_mapping_status: "idle",
  local_mapping_preview: null,
  local_mapping_preview_token: null,
  local_mapping_error: null,
  local_mapping_list_status: "idle",
  local_mapping_list_error: null,
  local_mapping_activation_status: "idle",
  local_mapping_activation_error: null,
  local_mappings: [],
  scan_tasks: [],
  staged_discoveries: [],
  scan_status: "idle",
  scan_error: null,
  scan_start_status: "idle",
  scan_start_error: null,
  scan_release_status: "idle",
  scan_release_candidate_id: null,
  scan_release_root_id: null,
  scan_release_operation_id: null,
  scan_release_candidate_version: null,
  scan_release_mapping_revision: null,
  scan_release_policy_revision: null,
  scan_release_error: null,
  scan_resolution_status: "idle",
  scan_resolution_candidate_id: null,
  scan_resolution_entry_id: null,
  scan_resolution_operation_id: null,
  scan_resolution_candidate_version: null,
  scan_resolution_decision_version: null,
  scan_resolution_location_revision: null,
  scan_resolution_mapping_revision: null,
  scan_resolution_policy_revision: null,
  scan_resolution_decision: null,
  scan_resolution_error: null,
  scan_hold_new_discoveries: false,
  connection: { state: "disconnected", instance_id: null, epoch: null, reason: null },
  connection_generation: 0,
  reader_profiles: [],
  reader_profiles_status: "idle",
  reader_profiles_error: null,
  reader_profile_save_status: "idle",
  reader_profile_save_error: null,
  reader_profile_selection_handle: null,
  reader_profile_selection_name: null,
  reader_profile_selection_error: null,
  reader_profile_test_target: null,
  reader_profile_test_status: "idle",
  reader_profile_test_result: null,
  reader_profile_test_error: null,
  library_entries: [],
  library_query: "",
  library_cursor: null,
  library_has_more: false,
  library_status: "idle",
  library_error: null,
  library_request_generation: 0,
  library_cover_generation: 0,
  pending_replacement_entries: [],
  pending_replacement_cursor: null,
  pending_replacement_has_more: false,
  pending_replacement_status: "idle",
  pending_replacement_error: null,
  library_scan_status: "idle",
  library_scan_error: null,
  library_scan_task: null,
  library_selected_entry_id: null,
  library_open_profile_id: null,
  library_open_states: []
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
