import { Context, Effect, Layer } from "effect"
import type {
  CommandAttempt,
  CommandReconciliation,
  ConnectionStatusView,
  DiscardedDraft,
  HandshakeView,
  NoteView,
  PublicError,
  SavedDraft,
  SavedDraftAbsent
} from "@henshin/contracts"

export type Result<A> =
  | { readonly ok: true; readonly data: A }
  | { readonly ok: false; readonly error: PublicError }

export interface EditNoteInput {
  readonly note_id: string
  readonly text: string
  readonly expected_revision: string
  readonly base_epoch: string
  readonly operation_id: string
}

export interface PrototypeBridge {
  handshake(): Promise<Result<HandshakeView>>
  connect(): Promise<Result<ConnectionStatusView>>
  disconnect(): Promise<Result<ConnectionStatusView>>
  connectionStatus(): Promise<Result<ConnectionStatusView>>
  getNote(noteId: string): Promise<Result<NoteView>>
  editNote(input: EditNoteInput): Promise<Result<NoteView>>
  saveDraft(input: SaveDraftInput): Promise<Result<SavedDraft>>
  loadDraft(input: LoadDraftInput): Promise<Result<SavedDraft | SavedDraftAbsent | null>>
  discardDraft(input: DiscardDraftInput): Promise<Result<DiscardedDraft>>
  listCommandAttempts(): Promise<Result<ReadonlyArray<CommandAttempt>>>
  reconcileCommand(operationId: string): Promise<Result<CommandReconciliation>>
  dismissCommand(operationId: string): Promise<Result<CommandAttempt>>
}

export interface SaveDraftInput {
  readonly note_id: string
  readonly form_id: string
  readonly text: string
  readonly expected_local_revision: string
  readonly base_server_revision: string
  readonly base_epoch: string
}

export interface LoadDraftInput {
  readonly note_id: string
  readonly form_id: string
}

export interface DiscardDraftInput {
  readonly note_id: string
  readonly form_id: string
  readonly expected_local_revision: string
}

declare global {
  interface Window {
    readonly henshinPrototype: PrototypeBridge
  }
}

/**
 * Wraps an IPC invocation so a rejected call becomes a typed public failure
 * rather than a defect that would surface as an unhandled rejection.
 */
const callIpc = <A>(thunk: () => Promise<Result<A>>): Effect.Effect<Result<A>> =>
  Effect.tryPromise({
    try: thunk,
    catch: (error) => error
  }).pipe(
    Effect.match({
      onFailure: () => ({
        ok: false as const,
        error: { code: "ipc_failed", message: "IPC request failed", retryable: false }
      }),
      onSuccess: (result) => result
    })
  )

/**
 * Renderer-side client for the narrow preload surface. The renderer never sees
 * a URL, credential, or generic fetch capability.
 */
export class PrototypeClient extends Context.Service<
  PrototypeClient,
  {
    readonly handshake: () => Effect.Effect<Result<HandshakeView>>
    readonly connect: () => Effect.Effect<Result<ConnectionStatusView>>
    readonly disconnect: () => Effect.Effect<Result<ConnectionStatusView>>
    readonly connectionStatus: () => Effect.Effect<Result<ConnectionStatusView>>
    readonly getNote: (noteId: string) => Effect.Effect<Result<NoteView>>
    readonly editNote: (input: EditNoteInput) => Effect.Effect<Result<NoteView>>
    readonly saveDraft: (input: SaveDraftInput) => Effect.Effect<Result<SavedDraft>>
    readonly loadDraft: (input: LoadDraftInput) => Effect.Effect<Result<SavedDraft | SavedDraftAbsent | null>>
    readonly discardDraft: (input: DiscardDraftInput) => Effect.Effect<Result<DiscardedDraft>>
    readonly listCommandAttempts: () => Effect.Effect<Result<ReadonlyArray<CommandAttempt>>>
    readonly reconcileCommand: (operationId: string) => Effect.Effect<Result<CommandReconciliation>>
    readonly dismissCommand: (operationId: string) => Effect.Effect<Result<CommandAttempt>>
  }
>()("henshin/desktop/renderer/PrototypeClient") {
  static readonly layer = Layer.succeed(
    PrototypeClient,
    PrototypeClient.of({
      handshake: () => callIpc(() => window.henshinPrototype.handshake()),
      connect: () => callIpc(() => window.henshinPrototype.connect()),
      disconnect: () => callIpc(() => window.henshinPrototype.disconnect()),
      connectionStatus: () => callIpc(() => window.henshinPrototype.connectionStatus()),
      getNote: (noteId) => callIpc(() => window.henshinPrototype.getNote(noteId)),
      editNote: (input) => callIpc(() => window.henshinPrototype.editNote(input)),
      saveDraft: (input) => callIpc(() => window.henshinPrototype.saveDraft(input)),
      loadDraft: (input) => callIpc(() => window.henshinPrototype.loadDraft(input)),
      discardDraft: (input) => callIpc(() => window.henshinPrototype.discardDraft(input)),
      listCommandAttempts: () => callIpc(() => window.henshinPrototype.listCommandAttempts()),
      reconcileCommand: (operationId) => callIpc(() => window.henshinPrototype.reconcileCommand(operationId)),
      dismissCommand: (operationId) => callIpc(() => window.henshinPrototype.dismissCommand(operationId))
    })
  )
}
