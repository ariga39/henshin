import { Context, Effect, Layer } from "effect"
import type {
  CommandAttempt,
  CommandReconciliation,
  ConnectionStatusView,
  DeviceRootMapping,
  DiscardedDraft,
  HandshakeView,
  LibraryEntryPage,
  LocalMappingActivateIpcRequest,
  LocalMappingPreviewIpcResult,
  NoteView,
  PublicError,
  SavedDraft,
  RootPreviewResult,
  RootPreviewRequest,
  RootCommandIpcRequest,
  RootRegistrationRequest,
  ReleaseHeldDiscoveryIpcRequest,
  ResolveReplacementIpcRequest,
  ReviewCandidateIpcRequest,
  ReviewCommandResult,
  ScanTask,
  ScanTaskSubmission,
  StagedDiscovery,
  ServerRoot,
  ServerRootList,
  SavedDraftAbsent,
  ThumbnailKey,
  ReaderExecutableSelectionIpcResult,
  ReaderProfile,
  ReaderProfileSaveIpcRequest,
  ReaderProfileTestIpcRequest,
  ReaderProfileTestResult,
  ReaderProfileTestTarget,
  ReaderProfileTestTargetSelectIpcRequest,
  ReaderProfileTestTargetSelectIpcResult,
  RecoverOpenJournalIpcRequest
} from "@henshin/contracts"
import type { OpenEvent } from "@henshin/contracts/event"

export interface OpenJournalView {
  readonly instanceId: string
  readonly actionId: string
  readonly entryId: string
  readonly deviceId: string
  readonly observedLocationRevision: string
  readonly observedContentVersion: string
  readonly status: "prepared" | "accepted" | "failed" | "unknown"
  readonly event: OpenEvent | null
  readonly deliveryStatus: "pending" | "acknowledged" | "held" | null
  readonly deliveryErrorCode: string | null
  readonly deliveryErrorMessage: string | null
  readonly failureCode: string | null
  readonly failureMessage: string | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

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

export interface OpenJournalBridge {
  onChanged(listener: () => void): () => void
  list(): Promise<Result<ReadonlyArray<OpenJournalView>>>
  recover(input: RecoverOpenJournalIpcRequest): Promise<Result<null>>
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
    readonly henshinOpenJournal: OpenJournalBridge
    readonly henshinRootPreview: RootPreviewBridge
    readonly henshinLocalMapping: LocalMappingBridge
    readonly henshinScanReview: ScanReviewBridge
    readonly henshinReaderProfiles: ReaderProfileBridge
    readonly henshinLibrary: LibraryBridge
  }
}

export interface ReaderProfileBridge {
  list(): Promise<Result<ReadonlyArray<ReaderProfile>>>
  selectExecutable(): Promise<Result<ReaderExecutableSelectionIpcResult>>
  save(input: ReaderProfileSaveIpcRequest): Promise<Result<ReaderProfile>>
  selectTestTarget(input: ReaderProfileTestTargetSelectIpcRequest): Promise<Result<ReaderProfileTestTargetSelectIpcResult>>
  test(input: ReaderProfileTestIpcRequest): Promise<Result<ReaderProfileTestResult>>
}

export interface RootPreviewBridge {
  preview(input: RootPreviewRequest): Promise<Result<RootPreviewResult>>
  list(): Promise<Result<ServerRootList>>
  save(input: RootRegistrationRequest): Promise<Result<ServerRoot>>
  command(input: RootCommandIpcRequest): Promise<Result<ServerRoot | ScanTaskSubmission>>
}

export interface LocalMappingBridge {
  preview(input: { readonly root_id: string }): Promise<Result<LocalMappingPreviewIpcResult>>
  list(input: {}): Promise<Result<ReadonlyArray<DeviceRootMapping>>>
  activate(input: LocalMappingActivateIpcRequest): Promise<Result<DeviceRootMapping>>
}

export interface ScanReviewBridge {
  listTasks(): Promise<Result<ReadonlyArray<ScanTask>>>
  candidates(): Promise<Result<ReadonlyArray<StagedDiscovery>>>
  command(input: ReviewCandidateIpcRequest): Promise<Result<ReviewCommandResult>>
}

export interface LibraryBridge {
  search(input: { readonly page_size?: number; readonly cursor?: string }): Promise<Result<LibraryEntryPage>>
  getThumbnail(key: ThumbnailKey): Promise<Result<Uint8Array>>
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

export class OpenJournalClient extends Context.Service<
  OpenJournalClient,
  {
    readonly list: () => Effect.Effect<Result<ReadonlyArray<OpenJournalView>>>
    readonly recover: (input: RecoverOpenJournalIpcRequest) => Effect.Effect<Result<null>>
  }
>()("henshin/desktop/renderer/OpenJournalClient") {
  static readonly layer = Layer.succeed(
    OpenJournalClient,
    OpenJournalClient.of({
      list: () => callIpc(() => window.henshinOpenJournal.list()),
      recover: (input) => callIpc(() => window.henshinOpenJournal.recover(input))
    })
  )
}

export class RootPreviewClient extends Context.Service<
  RootPreviewClient,
  {
    readonly preview: (input: RootPreviewRequest) => Effect.Effect<Result<RootPreviewResult>>
    readonly list: () => Effect.Effect<Result<ServerRootList>>
    readonly save: (input: RootRegistrationRequest) => Effect.Effect<Result<ServerRoot>>
    readonly command: (input: RootCommandIpcRequest) => Effect.Effect<Result<ServerRoot | ScanTaskSubmission>>
  }
>()("henshin/desktop/renderer/RootPreviewClient") {
  static readonly layer = Layer.succeed(
    RootPreviewClient,
    RootPreviewClient.of({
      preview: (input) => callIpc(() => window.henshinRootPreview.preview(input)),
      list: () => callIpc(() => window.henshinRootPreview.list()),
      save: (input) => callIpc(() => window.henshinRootPreview.save(input)),
      command: (input) => callIpc(() => window.henshinRootPreview.command(input))
    })
  )
}

export class LocalMappingClient extends Context.Service<
  LocalMappingClient,
  {
    readonly preview: (rootId: string) => Effect.Effect<Result<LocalMappingPreviewIpcResult>>
    readonly list: () => Effect.Effect<Result<ReadonlyArray<DeviceRootMapping>>>
    readonly activate: (input: LocalMappingActivateIpcRequest) => Effect.Effect<Result<DeviceRootMapping>>
  }
>()("henshin/desktop/renderer/LocalMappingClient") {
  static readonly layer = Layer.succeed(
    LocalMappingClient,
    LocalMappingClient.of({
      preview: (rootId) => callIpc(() => window.henshinLocalMapping.preview({ root_id: rootId })),
      list: () => callIpc(() => window.henshinLocalMapping.list({})),
      activate: (input) => callIpc(() => window.henshinLocalMapping.activate(input))
    })
  )
}

export class ScanReviewClient extends Context.Service<
  ScanReviewClient,
  {
    readonly listTasks: () => Effect.Effect<Result<ReadonlyArray<ScanTask>>>
    readonly candidates: () => Effect.Effect<Result<ReadonlyArray<StagedDiscovery>>>
    readonly release: (input: ReleaseHeldDiscoveryIpcRequest) => Effect.Effect<Result<ReviewCommandResult>>
    readonly resolve: (input: ResolveReplacementIpcRequest) => Effect.Effect<Result<ReviewCommandResult>>
  }
>()("henshin/desktop/renderer/ScanReviewClient") {
  static readonly layer = Layer.succeed(
    ScanReviewClient,
    ScanReviewClient.of({
      listTasks: () => callIpc(() => window.henshinScanReview.listTasks()),
      candidates: () => callIpc(() => window.henshinScanReview.candidates()),
      release: (input) => callIpc(() => window.henshinScanReview.command(input)),
      resolve: (input) => callIpc(() => window.henshinScanReview.command(input))
    })
  )
}

export class ReaderProfileClient extends Context.Service<
  ReaderProfileClient,
  {
    readonly list: () => Effect.Effect<Result<ReadonlyArray<ReaderProfile>>>
    readonly selectExecutable: () => Effect.Effect<Result<ReaderExecutableSelectionIpcResult>>
    readonly save: (input: ReaderProfileSaveIpcRequest) => Effect.Effect<Result<ReaderProfile>>
    readonly selectTestTarget: (input: ReaderProfileTestTargetSelectIpcRequest) => Effect.Effect<Result<ReaderProfileTestTargetSelectIpcResult>>
    readonly test: (input: ReaderProfileTestIpcRequest) => Effect.Effect<Result<ReaderProfileTestResult>>
  }
>()("henshin/desktop/renderer/ReaderProfileClient") {
  static readonly layer = Layer.succeed(
    ReaderProfileClient,
    ReaderProfileClient.of({
      list: () => callIpc(() => window.henshinReaderProfiles.list()),
      selectExecutable: () => callIpc(() => window.henshinReaderProfiles.selectExecutable()),
      save: (input) => callIpc(() => window.henshinReaderProfiles.save(input)),
      selectTestTarget: (input) => callIpc(() => window.henshinReaderProfiles.selectTestTarget(input)),
      test: (input) => callIpc(() => window.henshinReaderProfiles.test(input))
    })
  )
}

export class LibraryClient extends Context.Service<
  LibraryClient,
  {
    readonly search: (input: {
      readonly page_size?: number
      readonly cursor?: string
      readonly state?: "replacement-pending"
    }) => Effect.Effect<Result<LibraryEntryPage>>
    readonly getThumbnail: (key: ThumbnailKey) => Effect.Effect<Result<Uint8Array>>
  }
>()("henshin/desktop/renderer/LibraryClient") {
  static readonly layer = Layer.succeed(
    LibraryClient,
    LibraryClient.of({
      search: (input) => callIpc(() => window.henshinLibrary.search(input)),
      getThumbnail: (key) => callIpc(() => window.henshinLibrary.getThumbnail(key))
    })
  )
}
