import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from "electron"
import { Cause, Duration, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  DiscardDraftIpcRequest,
  ConnectIpcRequest,
  RemoteConnectIpcRequest,
  ConfirmRemoteIpcRequest,
  CancelRemoteIpcRequest,
  ManagedConnectIpcRequest,
  ConnectionStatusIpcRequest,
  DisconnectIpcRequest,
  DismissCommandIpcRequest,
  EditNoteIpcRequest,
  GetNoteIpcRequest,
  HandshakeIpcRequest,
  IpcChannels,
  LibraryHttpClient,
  OpenEventHttpClient,
  ListOpenJournalIpcRequest,
  LocalMappingActivateIpcRequest,
  LocalMappingActivateIpcResult,
  LocalMappingListIpcRequest,
  LocalMappingPreviewIpcRequest,
  LibrarySearchIpcRequest,
  OpenBookIpcRequest,
  OpenBookStatusIpcRequest,
  LibraryEntryCommandIpcRequest,
  ThumbnailGetIpcRequest,
  ThumbnailHttpClient,
  LoadDraftIpcRequest,
  ListCommandAttemptsIpcRequest,
  PrototypeHttpClient,
  PublicApiError,
  RootPreviewIpcRequest,
  RootListIpcRequest,
  RootCommandIpcRequest,
  RootSaveIpcRequest,
  ReleaseHeldDiscoveryIpcRequest,
  LibraryEntryIpcRequest,
  LibraryNoteIpcRequest,
  ReviewCandidateIpcRequest,
  ReviewCandidatesIpcRequest,
  ServerHttpClient,
  ReviewHttpClient,
  TaskHttpClient,
  TaskListIpcRequest,
  SaveDraftIpcRequest,
  ReconcileCommandIpcRequest,
  RecoverOpenJournalIpcRequest,
  ConnectionStatusView,
  ConnectionTargetView,
  RemoteConnectionCandidateView,
  localMappingSampleCanActivate,
  type PublicError,
  type LocalMappingPreview,
  type RootPreviewResult,
  ReaderExecutableSelectIpcRequest,
  ReaderProfileListIpcRequest,
  ReaderProfileSaveIpcRequest,
  ReaderProfileTestIpcRequest,
  ReaderProfileTestTargetSelectIpcRequest,
  type ReaderProfileTestResult
} from "@henshin/contracts"
import { inspectLocalMapping, LocalMappingUnavailableError } from "./LocalMappingPreview"
import { startServerChild, type ServerChild } from "./server-child"
import { DraftConflictError, DraftStore, DraftStoreFullError } from "./persistence/DraftStore"
import {
  CommandAttemptConflictError,
  CommandAttemptStore,
  CommandAttemptStoreFullError
} from "./persistence/CommandAttemptStore"
import {
  CommandAttemptUnresolvedError,
  StoredCommandRejectionError,
  executeNoteEdit,
  reconcileNoteCommand
} from "./CommandCoordinator"
import { LocalDatabaseWorker } from "./persistence/LocalDatabaseWorker"
import { OpenResolutionCache } from "./persistence/OpenResolutionCache"
import {
  OpenJournalConflictError,
  OpenJournalNotFoundError,
  OpenJournalStore,
  OpenJournalStoreFullError
} from "./persistence/OpenJournalStore"
import { LocalMappingStore, type LocalMappingActivationOutcome } from "./persistence/LocalMappingStore"
import {
  ReaderProfileConflictError,
  ReaderProfileNotFoundError,
  ReaderProfileStore,
  ReaderProfileStoreFullError,
  toReaderProfileView
} from "./persistence/ReaderProfileStore"
import {
  ReaderExecutableSelectionError,
  ReaderExecutableSelectionRequiredError,
  ReaderProfileValidationError,
  ReaderTestLaunchError,
  ReaderTestTargetError,
  ReaderTestTargetSelectionError,
  validateExecutablePath,
  validateReaderProfile,
  resolveReaderTestTarget
} from "./reader-profile-validation"
import { drainOpenEvents } from "./OpenEventDelivery"
import { OpenEventDeliveryScheduler } from "./OpenEventDeliveryScheduler"
import {
  ConnectionInstanceMismatchError,
  ConnectionCompatibilityError,
  ConnectionFailureError,
  ConnectionEndpointError,
  ConnectionConfirmationError,
  ConnectionLifecycle,
  ConnectionPausedError
} from "./ConnectionLifecycle"
import { OpenCoordinator, type OpenCoordinatorPorts } from "./OpenCoordinator"
import { loadDeviceId } from "./device-identity"

const SHUTDOWN_TIMEOUT_MS = 5_000
const LOCAL_MAPPING_REQUEST_TIMEOUT = Duration.seconds(12)
// The server gives one thumbnail request a 30-second aggregate producer
// budget; keep a small allowance for HTTP and IPC teardown.
const THUMBNAIL_NETWORK_DEADLINE = Duration.seconds(32)

interface Session {
  readonly instanceId: string
  readonly epoch: string
}

interface IpcOk<A> {
  readonly ok: true
  readonly data: A
}
interface IpcErr {
  readonly ok: false
  readonly error: PublicError
}

let mainWindow: BrowserWindow | null = null
const appWindows = new Set<BrowserWindow>()
const trustedWindowUrls = new Map<BrowserWindow, string>()
let serverChild: ServerChild | null = null
type MainServices = DraftStore | CommandAttemptStore | OpenJournalStore | LocalMappingStore | ReaderProfileStore | OpenResolutionCache
let runtime: ManagedRuntime.ManagedRuntime<MainServices, never> | null = null
let connection: ConnectionLifecycle | null = null
let openCoordinator: OpenCoordinator | null = null
let managedDatabasePath: string | null = null
let managedChildStart: Promise<ServerChild> | null = null
let connectionTarget: ConnectionTargetView = {
  mode: "managed",
  base_url: null,
  instance_id: null
}
interface PendingRemoteConnection {
  readonly candidateId: string
  readonly candidate: ConnectionLifecycle
  readonly instanceId: string
  readonly baseUrl: string
}
let pendingRemoteConnection: PendingRemoteConnection | null = null
let connectionOperation: Promise<void> = Promise.resolve()
let rendererUrl = ""
let shutdownPromise: Promise<void> | null = null
let readyToQuit = false
const prototypeMode = process.env.HENSHIN_PROTOTYPE_MODE === "1"
let protectedWritablePaths: ReadonlyArray<string> = []
let deviceId = ""
const localMappingPreviews = new Map<string, {
  readonly connection: ConnectionLifecycle
  readonly epoch: string
  readonly previewToken: string
  readonly preview: LocalMappingPreview
}>()
const localMappingChecks = new Map<string, number>()

class LocalMappingStaleError extends Error {
  readonly code = "local_mapping_stale"

  constructor(message = "the local mapping preview is stale; inspect the directory again") {
    super(message)
  }
}
const executableSelections = new Map<string, { readonly path: string; readonly createdAt: number }>()
const EXECUTABLE_SELECTION_TTL_MS = 10 * 60 * 1000
const MAX_EXECUTABLE_SELECTIONS = 32
const testTargetSelections = new Map<string, {
  readonly profileId: string
  readonly profileRevision: string
  readonly selectedPath: string
  readonly resolvedTarget: string
  readonly createdAt: number
}>()
const TEST_TARGET_SELECTION_TTL_MS = 10 * 60 * 1000
const MAX_TEST_TARGET_SELECTIONS = 32
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const dispatchExplicitReaderTest = (executablePath: string, argumentsList: ReadonlyArray<string>): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false
    const settle = (result: "accepted" | "failed"): void => {
      if (settled) return
      settled = true
      if (result === "accepted") resolve()
      else reject(new ReaderTestLaunchError("the operating system could not start the reader process"))
    }
    try {
      const child = spawn(executablePath, [...argumentsList], {
        cwd: app.getPath("userData"),
        shell: false,
        stdio: "ignore",
        windowsHide: true
      })
      child.once("spawn", () => {
        child.unref()
        settle("accepted")
      })
      child.once("error", () => settle("failed"))
    } catch {
      settle("failed")
    }
  })

const dispatchReader = (profile: {
  readonly launch_mode: "explicit-executable" | "system-association"
  readonly executablePath: string | null
  readonly argument_tokens: ReadonlyArray<string>
}, resolvedTarget: string): Promise<void> => {
  if (profile.launch_mode === "explicit-executable") {
    if (profile.executablePath === null) return Promise.reject(new ReaderTestLaunchError("the saved profile has no executable"))
    return dispatchExplicitReaderTest(
      profile.executablePath,
      profile.argument_tokens.map((token) => token === "{target}" ? resolvedTarget : token)
    )
  }
  return shell.openPath(resolvedTarget).then((error) => {
    if (error !== "") throw new ReaderTestLaunchError("the operating system could not open the resolved target")
  })
}

const opaqueError: PublicError = { code: "internal_error", message: "request failed", retryable: false }
const localMappingTimeoutError: PublicError = {
  code: "local_mapping_unavailable",
  message: "the selected local directory could not be inspected",
  retryable: true
}
const invalidRequestError: PublicError = {
  code: "invalid_request",
  message: "invalid IPC request",
  retryable: false
}
const staleOpenJournalNamespaceError: PublicError = {
  code: "open_journal_namespace",
  message: "this handoff entry belongs to another server namespace; refresh the diagnostics before recovering it",
  retryable: true
}

const decodePublicError = Schema.decodeUnknownOption(PublicApiError)

/**
 * Maps a failure to the public error shape only when it decodes as a recognized
 * public error. Anything else becomes an opaque failure, so an arbitrary
 * message, stack, or internal cause never crosses the IPC boundary.
 */
const toPublicError = (error: unknown): PublicError => {
  if (error instanceof LocalMappingUnavailableError) {
    return {
      code: "local_mapping_unavailable",
      message: error.message,
      retryable: true
    }
  }
  if (error instanceof LocalMappingStaleError) {
    return { code: error.code, message: error.message, retryable: true }
  }
  if (error instanceof CommandAttemptConflictError) {
    return {
      code: "operation_conflict",
      message: "operation id reused with a different local intent",
      retryable: false
    }
  }
  if (error instanceof ConnectionPausedError) {
    return {
      code: "connection_paused",
      message: "server network work is paused; reconnect deliberately",
      retryable: true
    }
  }
  if (error instanceof ConnectionInstanceMismatchError) {
    return {
      code: "instance_mismatch",
      message: "managed endpoint identity changed; reconnect requires endpoint recovery",
      retryable: false
    }
  }
  if (error instanceof ConnectionCompatibilityError) {
    return {
      code: "connection_incompatible",
      message: error.message,
      retryable: false
    }
  }
  if (error instanceof ConnectionFailureError) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  if (error instanceof ConnectionEndpointError) {
    return { code: "invalid_connection_endpoint", message: error.message, retryable: false }
  }
  if (error instanceof ConnectionConfirmationError) {
    return { code: "connection_confirmation_required", message: error.message, retryable: false }
  }
  if (error instanceof CommandAttemptStoreFullError) {
    return {
      code: "command_attempt_store_full",
      message: "command recovery storage is full (64 retained attempts); terminal and dismissed attempts become cleanup-eligible after seven days, while unresolved attempts require reconciliation or dismissal",
      retryable: false
    }
  }
  if (error instanceof OpenJournalStoreFullError) {
    return {
      code: "open_journal_full",
      message: "reader handoff admission is full (64 outstanding handoffs or 8,192 terminal rows admitted); use Open recovery to dismiss an unknown intent or discard a held event, or wait for terminal retention to expire",
      retryable: false
    }
  }
  if (error instanceof OpenJournalConflictError) {
    return {
      code: "open_journal_conflict",
      message: "the handoff entry changed or is not eligible for this action",
      retryable: false
    }
  }
  if (error instanceof OpenJournalNotFoundError) {
    return {
      code: "open_journal_not_found",
      message: "the handoff entry is no longer retained",
      retryable: false
    }
  }
  if (error instanceof CommandAttemptUnresolvedError) {
    return {
      code: "reconciliation_required",
      message: "command outcome is unresolved; reconcile before creating a new save",
      retryable: false
    }
  }
  if (error instanceof StoredCommandRejectionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
      ...(error.currentRevision === null ? {} : { current_revision: error.currentRevision })
    }
  }
  if (error instanceof DraftConflictError) {
    return {
      code: "draft_conflict",
      message: "saved draft changed in another window",
      retryable: false,
      current_local_revision: error.currentLocalRevision
    }
  }
  if (error instanceof DraftStoreFullError) {
    return { code: "draft_store_full", message: "saved draft storage is full", retryable: false }
  }
  if (error instanceof ReaderProfileConflictError) {
    return {
      code: "reader_profile_conflict",
      message: "reader profile changed in another window",
      retryable: false,
      current_revision: error.currentRevision
    }
  }
  if (error instanceof ReaderProfileNotFoundError) {
    return { code: "reader_profile_not_found", message: "reader profile no longer exists", retryable: false }
  }
  if (error instanceof ReaderProfileStoreFullError) {
    return { code: "reader_profile_store_full", message: "reader profile storage is full", retryable: false }
  }
  if (error instanceof ReaderProfileValidationError || error instanceof ReaderExecutableSelectionRequiredError || error instanceof ReaderExecutableSelectionError || error instanceof ReaderTestTargetError || error instanceof ReaderTestTargetSelectionError || error instanceof ReaderTestLaunchError) {
    return { code: error.code, message: error.message, retryable: false }
  }
  const decoded = decodePublicError(error)
  if (Option.isNone(decoded)) return opaqueError
  const value = decoded.value
  if (value._tag === "RevisionConflict") {
    return {
      code: value.code,
      message: value.message,
      retryable: value.retryable,
      current_revision: value.details.current_revision
    }
  }
  if (value._tag === "DraftConflict") {
    return {
      code: value.code,
      message: value.message,
      retryable: value.retryable,
      current_local_revision: value.details.current_local_revision
    }
  }
  return { code: value.code, message: value.message, retryable: value.retryable }
}

export const localMappingError = (error: unknown): PublicError =>
  Cause.isTimeoutError(error) ? localMappingTimeoutError : toPublicError(error)

const toResult = <A, R>(effect: Effect.Effect<{ readonly data: A }, unknown, R>): Effect.Effect<IpcOk<A> | IpcErr, never, R> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error: toPublicError(error) }),
      onSuccess: (envelope) => ({ ok: true as const, data: envelope.data })
    })
  )

const toRawResult = <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<IpcOk<A> | IpcErr, never, R> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error: toPublicError(error) }),
      onSuccess: (data) => ({ ok: true as const, data })
    })
  )

const assertTrustedSender = (event: IpcMainInvokeEvent): BrowserWindow => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender)
  if (
    senderWindow === null ||
    senderWindow.isDestroyed() ||
    !appWindows.has(senderWindow) ||
    senderWindow.getParentWindow() !== null ||
    event.sender !== senderWindow.webContents
  ) {
    throw new Error("rejected IPC from an untrusted web contents")
  }
  const frame = event.senderFrame
  if (frame === null || frame !== senderWindow.webContents.mainFrame) {
    throw new Error("rejected IPC from an untrusted frame")
  }
  if (trustedWindowUrls.get(senderWindow) !== frame.url) {
    throw new Error("rejected IPC from an untrusted origin")
  }
  return senderWindow
}

const requireRuntime = (): ManagedRuntime.ManagedRuntime<MainServices, never> => {
  if (runtime === null) throw new Error("runtime is not ready")
  return runtime
}

const requireSession = (): Session => {
  if (connection === null) throw new Error("connection lifecycle is not ready")
  const session = connection.getSession()
  if (session === null) throw new ConnectionPausedError({ state: connection.getStatus().state })
  return { instanceId: session.instanceId, epoch: session.epoch }
}

const requireOpenSession = (): { readonly session: Session; readonly offline: boolean } => {
  if (connection === null) throw new Error("connection lifecycle is not ready")
  const session = connection.getSession()
  if (session !== null) return { session, offline: false }
  const status = connection.getStatus()
  if (status.state !== "disconnected") throw new ConnectionPausedError({ state: status.state })
  const cached = connection.getCachedSession()
  if (cached === null) throw new ConnectionPausedError({ state: status.state })
  return { session: cached, offline: true }
}

const requireNamespace = (): string => {
  if (connection === null) throw new Error("connection lifecycle is not ready")
  const instanceId = connection.getNamespace()
  if (instanceId === null) throw new ConnectionPausedError({ state: connection.getStatus().state })
  return instanceId
}

const requireConnection = (): ConnectionLifecycle => {
  if (connection === null) throw new Error("connection lifecycle is not ready")
  return connection
}

const ensureManagedChild = async (): Promise<ServerChild> => {
  if (serverChild !== null) return serverChild
  if (managedDatabasePath === null) throw new Error("managed service configuration is not ready")
  if (managedChildStart !== null) return managedChildStart
  managedChildStart = startServerChild(managedDatabasePath)
  try {
    serverChild = await managedChildStart
    return serverChild
  } finally {
    managedChildStart = null
  }
}

const serializeConnectionOperation = <A>(operation: () => Promise<A>): Promise<A> => {
  const result = connectionOperation.then(operation, operation)
  connectionOperation = result.then(() => undefined, () => undefined)
  return result
}

const discardPendingRemoteConnection = async (): Promise<void> => {
  const pending = pendingRemoteConnection
  pendingRemoteConnection = null
  if (pending !== null) {
    notifyRemoteCandidateInvalidated(pending.candidateId)
    await pending.candidate.close()
  }
}

const setPendingRemoteConnection = async (pending: PendingRemoteConnection): Promise<void> => {
  const previous = pendingRemoteConnection
  pendingRemoteConnection = pending
  if (previous !== null) {
    notifyRemoteCandidateInvalidated(previous.candidateId)
    await previous.candidate.close()
  }
}

const notifyOpenJournalChanged = (): void => {
  for (const window of appWindows) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannels.openJournalChanged)
  }
}

const notifyOpenStateChanged = (): void => {
  for (const window of appWindows) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannels.openStateChanged)
  }
}

const deliverPendingOpenEvents = async (): Promise<void> => {
  const activeConnection = connection
  if (activeConnection === null) return
  const session = activeConnection.getSession()
  if (session === null) return
  const generation = activeConnection.currentGeneration()
  if (generation === null) return
  try {
    const store = await requireRuntime().runPromise(Effect.gen(function*() {
      return yield* OpenJournalStore
    }))
    const client: OpenEventHttpClient["Service"] = {
      batch: (request) => Effect.tryPromise({
        try: () => activeConnection.run(
          Effect.gen(function*() {
            const authenticatedClient = yield* OpenEventHttpClient
            return yield* authenticatedClient.batch(request)
          })
        ),
        // ConnectionLifecycle.run rejects with its own authority errors as
        // well as the HTTP client's declared failures; drainOpenEvents treats
        // both as runtime delivery outcomes.
        catch: (error) => error as never
      })
    }
    const result = await Effect.runPromise(drainOpenEvents(store, client, session, {
      isActive: () => activeConnection.currentGeneration() === generation
    }))
    if (result.missingResults) {
      console.warn("open event delivery stopped after an incomplete server response")
    }
  } catch (error) {
    // A lost response, paused connection, or local write failure leaves the
    // immutable event pending. The active generation retries transient errors;
    // a changed generation exposes the residual journal through the refresh
    // notification and the next deliberate reconnect retries it.
    console.warn("open event delivery stopped with pending journal entries", error)
  } finally {
    notifyOpenJournalChanged()
  }
}

const openEventDeliveryScheduler = new OpenEventDeliveryScheduler(deliverPendingOpenEvents)

const runNetworkResult = <A>(
  effect: Effect.Effect<
    IpcOk<A> | IpcErr,
    never,
    PrototypeHttpClient | ServerHttpClient | LibraryHttpClient | TaskHttpClient | ReviewHttpClient | OpenEventHttpClient | ThumbnailHttpClient
  >,
  timeout?: Duration.Duration,
  errorMapper: (error: unknown) => PublicError = toPublicError
): Promise<IpcOk<A> | IpcErr> =>
  requireConnection()
    .run(effect, timeout)
    .catch((error) => ({ ok: false as const, error: errorMapper(error) }))

const runLocalResult = <A>(
  effect: Effect.Effect<IpcOk<A> | IpcErr, never, MainServices>
): Promise<IpcOk<A> | IpcErr> =>
  requireRuntime().runPromise(effect).catch((error) => ({ ok: false as const, error: toPublicError(error) }))

const localMappingKey = (instanceId: string, rootId: string): string => `${instanceId}:${rootId}`

const beginLocalMappingCheck = (key: string): void => {
  localMappingChecks.set(key, (localMappingChecks.get(key) ?? 0) + 1)
}

const endLocalMappingCheck = (key: string): void => {
  const remaining = (localMappingChecks.get(key) ?? 1) - 1
  if (remaining <= 0) localMappingChecks.delete(key)
  else localMappingChecks.set(key, remaining)
}

const hasBlockingLocalEvidence = (preview: LocalMappingPreview): boolean =>
  preview.samples.some((sample) => !localMappingSampleCanActivate(sample))

const createOpenCoordinator = (): OpenCoordinator => {
  const ports: OpenCoordinatorPorts = {
    deviceId,
    journal: {
      get: (instanceId, actionId) => requireRuntime().runPromise(
        Effect.gen(function*() {
          const store = yield* OpenJournalStore
          return yield* store.get({ instanceId, actionId })
        })
      ),
      findLatestByEntry: (instanceId, entryId) => requireRuntime().runPromise(
        Effect.gen(function*() {
          const store = yield* OpenJournalStore
          return yield* store.findLatestByEntry({ instanceId, entryId })
        })
      ),
      findUnresolvedByEntry: (instanceId, entryId) => requireRuntime().runPromise(
        Effect.gen(function*() {
          const store = yield* OpenJournalStore
          return yield* store.findUnresolvedByEntry({ instanceId, entryId })
        })
      ),
      prepare: (input) => requireRuntime().runPromise(
        Effect.gen(function*() {
          const store = yield* OpenJournalStore
          return yield* store.prepare(input)
        })
      ),
      recordAccepted: (key, event) => requireRuntime().runPromise(
        Effect.gen(function*() {
          const store = yield* OpenJournalStore
          return yield* store.recordAccepted(key, event)
        })
      ),
      recordUnknown: (key) => requireRuntime().runPromise(
        Effect.gen(function*() {
          const store = yield* OpenJournalStore
          return yield* store.recordUnknown(key)
        })
      ),
      recordFailed: (key, failure) => requireRuntime().runPromise(
        Effect.gen(function*() {
          const store = yield* OpenJournalStore
          return yield* store.recordFailed({ ...key, ...failure })
        })
      )
    },
    loadMapping: (instanceId, rootId) => requireRuntime().runPromise(
      Effect.gen(function*() {
        const store = yield* LocalMappingStore
        return yield* store.load({ instanceId, rootId })
      })
    ),
    loadProfile: (profileId) => requireRuntime().runPromise(
      Effect.gen(function*() {
        const store = yield* ReaderProfileStore
        return yield* store.get(profileId)
      })
    ),
    resolve: (entryId, query) => requireConnection().run(
      Effect.gen(function*() {
        const client = yield* LibraryHttpClient
        return (yield* client.resolution({
          params: { id: entryId },
          query: query === undefined
            ? {}
            : {
                ...(query.siblingCursor === undefined ? {} : { sibling_cursor: query.siblingCursor }),
                ...(query.siblingClaimsRevision === undefined ? {} : { sibling_claims_revision: query.siblingClaimsRevision })
              }
        })).data
      })
    ),
    loadCachedResolution: (instanceId, entryId) => requireRuntime().runPromise(
      Effect.gen(function*() {
        const cache = yield* OpenResolutionCache
        return yield* cache.get({ instanceId, entryId })
      })
    ),
    saveCachedResolution: (input) => requireRuntime().runPromise(
      Effect.gen(function*() {
        const cache = yield* OpenResolutionCache
        yield* cache.save(input)
      })
    ),
    dispatch: (profile, target) => dispatchReader(profile, target),
    assertCurrent: (instanceId, epoch) => {
      const current = requireSession()
      if (current.instanceId !== instanceId || current.epoch !== epoch) {
        throw new ConnectionPausedError({ state: requireConnection().getStatus().state })
      }
    },
    onAcceptedEventDurable: () => openEventDeliveryScheduler.schedule(),
    onActiveChanged: notifyOpenStateChanged
  }
  return new OpenCoordinator(ports)
}

const stableSample = (sample: LocalMappingPreview["samples"][number]) => ({
  ...sample,
  indexed_format_evidence: [...sample.indexed_format_evidence].sort(),
  local_format_evidence: [...sample.local_format_evidence].sort()
})

const sameLocalMappingEvidence = (left: LocalMappingPreview, right: LocalMappingPreview): boolean =>
  left.root_id === right.root_id &&
  left.selected_local_path === right.selected_local_path &&
  left.canonical_local_path === right.canonical_local_path &&
  left.sample_truncated === right.sample_truncated &&
  left.local_budget_exhausted === right.local_budget_exhausted &&
  JSON.stringify(left.samples.map(stableSample)) === JSON.stringify(right.samples.map(stableSample))

const toDeviceMapping = (mapping: {
  readonly rootId: string
  readonly selectedPath: string
  readonly canonicalPath: string
  readonly mappingRevision: string
}): LocalMappingActivateIpcResult => ({
  root_id: mapping.rootId,
  selected_local_path: mapping.selectedPath,
  canonical_local_path: mapping.canonicalPath,
  mapping_revision: mapping.mappingRevision,
  state: "active"
})

const connectionStatusResult = (status: ConnectionStatusView): IpcOk<ConnectionStatusView> => ({
  ok: true,
  data: status
})

const connectionTargetResult = (): IpcOk<ConnectionTargetView> => ({
  ok: true,
  data: connectionTarget
})

const notifyConnectionTargetChanged = (): void => {
  for (const window of appWindows) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannels.connectionChanged, connectionTarget)
  }
}

const notifyConnectionStatusChanged = (status: ConnectionStatusView): void => {
  for (const window of appWindows) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannels.connectionStatusChanged, status)
  }
}

const notifyRemoteCandidateInvalidated = (candidateId: string): void => {
  for (const window of appWindows) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannels.remoteCandidateInvalidated, candidateId)
  }
}

const setConnectionTarget = (target: ConnectionTargetView): void => {
  if (
    connectionTarget.mode === target.mode &&
    connectionTarget.base_url === target.base_url &&
    connectionTarget.instance_id === target.instance_id
  ) return
  connectionTarget = target
  notifyConnectionTargetChanged()
}

const updateTargetFromStatus = (status: ConnectionStatusView): void => {
  setConnectionTarget({
    ...connectionTarget,
    instance_id: status.instance_id
  })
}

const registerIpc = (): void => {
  ipcMain.handle(IpcChannels.connectionStatus, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ConnectionStatusIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return connectionStatusResult(requireConnection().getStatus())
  })

  ipcMain.handle(IpcChannels.connectionTarget, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ConnectionStatusIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return connectionTargetResult()
  })

  ipcMain.handle(IpcChannels.connect, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ConnectIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return serializeConnectionOperation(async () => {
      await discardPendingRemoteConnection()
      return requireConnection()
        .connect()
        .then((status) => {
          updateTargetFromStatus(status)
          notifyConnectionStatusChanged(status)
          openEventDeliveryScheduler.schedule()
          return connectionStatusResult(status)
        })
    }).catch((error) => {
      notifyConnectionStatusChanged(requireConnection().getStatus())
      return { ok: false as const, error: toPublicError(error) }
    })
  })

  ipcMain.handle(IpcChannels.disconnect, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(DisconnectIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return serializeConnectionOperation(async () => {
      await discardPendingRemoteConnection()
      return requireConnection().disconnect().then((status) => {
        notifyConnectionStatusChanged(status)
        return connectionStatusResult(status)
      })
    }).catch((error) => {
      notifyConnectionStatusChanged(requireConnection().getStatus())
      return { ok: false as const, error: toPublicError(error) }
    })
  })

  ipcMain.handle(IpcChannels.connectRemote, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(RemoteConnectIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const request = decoded.value
    if (request.bearer_token.length === 0) {
      return {
        ok: false as const,
        error: { code: "invalid_connection_credential", message: "enter the server owner credential", retryable: false }
      }
    }
    let baseUrl: string
    try {
      baseUrl = ConnectionLifecycle.validateRemoteEndpoint(request.base_url)
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
    return serializeConnectionOperation(async () => {
      await discardPendingRemoteConnection()
      const candidate = new ConnectionLifecycle({ baseUrl, bearerToken: request.bearer_token })
      try {
        const status = await candidate.connect()
        if (status.instance_id === null) throw new ConnectionEndpointError({ message: "server identity was not provided" })
        const candidateId = randomUUID()
        await setPendingRemoteConnection({
          candidateId,
          candidate,
          instanceId: status.instance_id,
          baseUrl
        })
        return {
          ok: true as const,
          data: {
            candidate_id: candidateId,
            base_url: baseUrl,
            instance_id: status.instance_id
          } satisfies RemoteConnectionCandidateView
        }
      } catch (error) {
        await candidate.close()
        throw error
      }
    }).catch((error) => ({ ok: false as const, error: toPublicError(error) }))
  })

  ipcMain.handle(IpcChannels.confirmRemote, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ConfirmRemoteIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return serializeConnectionOperation(async () => {
      const pending = pendingRemoteConnection
      if (pending === null || pending.candidateId !== decoded.value.candidate_id) {
        throw new ConnectionConfirmationError({ message: "remote server confirmation has expired" })
      }
      pendingRemoteConnection = null
      notifyRemoteCandidateInvalidated(pending.candidateId)
      const previous = requireConnection()
      connection = pending.candidate
      connectionTarget = {
        mode: "remote",
        base_url: pending.baseUrl,
        instance_id: pending.instanceId
      }
      localMappingPreviews.clear()
      // Each lease replacement invalidates server workspace state exactly
      // once, including when the visible target is unchanged.
      notifyConnectionTargetChanged()
      // Lease replacement is committed before retiring the old runtime.
      // Cleanup failure must not revoke the freshly confirmed connection.
      await previous.close().catch(() => undefined)
      const status = pending.candidate.getStatus()
      notifyConnectionStatusChanged(status)
      openEventDeliveryScheduler.schedule()
      return connectionStatusResult(status)
    }).catch((error) => ({ ok: false as const, error: toPublicError(error) }))
  })

  ipcMain.handle(IpcChannels.cancelRemote, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(CancelRemoteIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return serializeConnectionOperation(async () => {
      await discardPendingRemoteConnection()
      return connectionStatusResult(requireConnection().getStatus())
    }).catch((error) => ({ ok: false as const, error: toPublicError(error) }))
  })

  ipcMain.handle(IpcChannels.useManaged, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ManagedConnectIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return serializeConnectionOperation(async () => {
      await discardPendingRemoteConnection()
      return ensureManagedChild()
      .then(async (child) => {
        const candidate = new ConnectionLifecycle({ baseUrl: child.baseUrl, bearerToken: child.bearerToken })
        const status = await candidate.connect()
        const previous = requireConnection()
        connection = candidate
        setConnectionTarget({ mode: "managed", base_url: null, instance_id: status.instance_id })
        await previous.close()
        updateTargetFromStatus(status)
        notifyConnectionStatusChanged(status)
        openEventDeliveryScheduler.schedule()
        return connectionStatusResult(status)
      })
    }).catch((error) => ({ ok: false as const, error: toPublicError(error) }))
  })

  ipcMain.handle(IpcChannels.rootPreview, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(RootPreviewIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    if ("path" in decoded.value) {
      const request = decoded.value as { readonly path: string }
      return runNetworkResult(
        toResult(
          Effect.gen(function*() {
            const client = yield* ServerHttpClient
            return yield* client.preview({ payload: { path: request.path } }) as unknown as Effect.Effect<
              { readonly data: RootPreviewResult },
              unknown,
              ServerHttpClient
            >
          })
        )
      )
    }
    const request = decoded.value as { readonly kind: "saved-root"; readonly root_id: string }
    return runNetworkResult(
      toResult(
        Effect.gen(function*() {
          const client = yield* ServerHttpClient
          return yield* client.preview({
            payload: { kind: "saved-root", root_id: request.root_id }
          } as Parameters<typeof client.preview>[0]) as unknown as Effect.Effect<
            { readonly data: RootPreviewResult },
            unknown,
            ServerHttpClient
          >
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.rootList, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(RootListIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return runNetworkResult(
      toResult(
        Effect.gen(function*() {
          const client = yield* ServerHttpClient
          return yield* client.list()
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.rootSave, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(RootSaveIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return runNetworkResult(
      toResult(
        Effect.gen(function*() {
          const client = yield* ServerHttpClient
          return yield* client.save({ payload: decoded.value })
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.rootCommand, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(RootCommandIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return runNetworkResult(
      toResult(
        Effect.gen(function*() {
          const client = yield* ServerHttpClient
          // The generated HttpApiClient only preserves the payload correlation
          // when this union is narrowed at the dispatch call.
          if ("expected_mapping_revision" in decoded.value) {
            const { root_id, ...payload } = decoded.value
            return yield* client.command({ params: { id: root_id }, payload })
          }
          const { root_id, ...payload } = decoded.value
          return yield* client.command({ params: { id: root_id }, payload })
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.localMappingPreview, async (event, raw: unknown) => {
    const senderWindow = assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(LocalMappingPreviewIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    let session: Session
    try {
      session = requireSession()
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
    const activeConnection = requireConnection()
    const selected = await dialog.showOpenDialog(senderWindow, {
      title: "Select the local collection directory",
      properties: ["openDirectory"]
    })
    if (selected.canceled || selected.filePaths.length === 0) return { ok: true as const, data: null }
    const selectedPath = selected.filePaths[0]
    const mappingKey = localMappingKey(session.instanceId, decoded.value.root_id)
    beginLocalMappingCheck(mappingKey)
    return runNetworkResult(
      toRawResult(
        Effect.gen(function*() {
          const client = yield* LibraryHttpClient
          const indexed = yield* client.indexedSamples({ params: { id: decoded.value.root_id } })
          if (indexed.instance_id !== session.instanceId || indexed.epoch !== session.epoch) {
            return yield* Effect.fail(new LocalMappingStaleError("the server session changed while checking the local directory"))
          }
          return yield* Effect.tryPromise({
            try: () => inspectLocalMapping(
              decoded.value.root_id,
              selectedPath,
              indexed.data.samples,
              indexed.data.sample_truncated
            ),
            catch: (error) => error
          })
        })
      ),
      LOCAL_MAPPING_REQUEST_TIMEOUT,
      localMappingError
    )
    .then((result) => {
      endLocalMappingCheck(mappingKey)
      if (connection !== activeConnection) {
        return { ok: false as const, error: toPublicError(new LocalMappingStaleError("the server session changed while checking the local directory")) }
      }
      if (!result.ok) {
        localMappingPreviews.delete(mappingKey)
        return result
      }
      if (result.data === null) return result
      const previewToken = randomUUID()
      localMappingPreviews.set(mappingKey, {
        connection: activeConnection,
        epoch: session.epoch,
        previewToken,
        preview: result.data
      })
      return {
        ok: true as const,
        data: { preview: result.data, preview_token: previewToken }
      }
    })
  })

  ipcMain.handle(IpcChannels.localMappingList, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(LocalMappingListIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    try {
      const session = requireSession()
      return runLocalResult(
        toRawResult(
          Effect.gen(function*() {
            const store = yield* LocalMappingStore
            const mappings = yield* store.list(session.instanceId)
            return mappings.map(toDeviceMapping)
          })
        )
      )
    } catch (error) {
      return Promise.resolve({ ok: false as const, error: toPublicError(error) })
    }
  })

  ipcMain.handle(IpcChannels.localMappingActivate, async (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(LocalMappingActivateIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    try {
      const session = requireSession()
      const request = decoded.value
      const mappingKey = localMappingKey(session.instanceId, request.root_id)
      if ((localMappingChecks.get(mappingKey) ?? 0) > 0) {
        return { ok: false as const, error: toPublicError(new LocalMappingStaleError("the local directory is still being checked")) }
      }
      const evidence = localMappingPreviews.get(mappingKey)
      if (evidence === undefined || evidence.connection !== requireConnection() || evidence.epoch !== session.epoch || evidence.previewToken !== request.preview_token) {
        return { ok: false as const, error: toPublicError(new LocalMappingStaleError()) }
      }

      const roots = await runNetworkResult(
        toResult(
          Effect.gen(function*() {
            const client = yield* ServerHttpClient
            return yield* client.list()
          })
        )
      )
      if (!roots.ok) return roots
      if (!roots.data.some((root) => root.root_id === request.root_id && root.state === "active")) {
        return { ok: false as const, error: toPublicError(new LocalMappingStaleError("the server root is no longer active")) }
      }

      const fresh = await runNetworkResult(
        toRawResult(
          Effect.gen(function*() {
            const client = yield* LibraryHttpClient
            const indexed = yield* client.indexedSamples({ params: { id: request.root_id } })
            if (indexed.instance_id !== session.instanceId || indexed.epoch !== session.epoch) {
              return yield* Effect.fail(new LocalMappingStaleError("the server session changed before activation"))
            }
            return yield* Effect.tryPromise({
              try: () => inspectLocalMapping(
                request.root_id,
                evidence.preview.selected_local_path,
                indexed.data.samples,
                indexed.data.sample_truncated
              ),
              catch: (error) => error
            })
          })
        ),
        LOCAL_MAPPING_REQUEST_TIMEOUT
      )
      if (!fresh.ok) return fresh
      if (!sameLocalMappingEvidence(evidence.preview, fresh.data) || hasBlockingLocalEvidence(fresh.data)) {
        return { ok: false as const, error: toPublicError(new LocalMappingStaleError("local directory evidence changed; inspect it again")) }
      }

      const currentSession = requireSession()
      if (currentSession.instanceId !== session.instanceId || currentSession.epoch !== session.epoch) {
        return { ok: false as const, error: toPublicError(new LocalMappingStaleError("the server session changed before activation")) }
      }
      const stored = await runLocalResult(
        toRawResult(
          Effect.gen(function*() {
            const store = yield* LocalMappingStore
            return yield* store.activate({
              instanceId: session.instanceId,
              rootId: request.root_id,
              selectedPath: evidence.preview.selected_local_path,
              canonicalPath: evidence.preview.canonical_local_path,
              expectedMappingRevision: request.expected_mapping_revision,
              protectedWritablePaths: protectedWritablePaths
            })
          })
        )
      )
      if (!stored.ok) return stored
      const outcome: LocalMappingActivationOutcome = stored.data
      switch (outcome.kind) {
        case "activated":
          return { ok: true as const, data: toDeviceMapping(outcome.mapping) }
        case "revision_conflict":
          return {
            ok: false as const,
            error: {
              code: "local_mapping_revision_conflict",
              message: "the device mapping changed; reload the current mapping before activating",
              retryable: true,
              current_local_revision: outcome.currentMapping?.mappingRevision ?? "0"
            }
          }
        case "root_conflict":
          return {
            ok: false as const,
            error: {
              code: "local_mapping_root_conflict",
              message: "the selected directory overlaps another active device mapping",
              retryable: false
            }
          }
        case "writable_overlap":
          return {
            ok: false as const,
            error: {
              code: "local_mapping_writable_overlap",
              message: "the selected directory overlaps a writable application path",
              retryable: false
            }
          }
      }
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.readerProfileList, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ReaderProfileListIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    try {
      return requireRuntime().runPromise(
        toResult(
          Effect.gen(function*() {
            const store = yield* ReaderProfileStore
            return { data: yield* store.list() }
          })
        )
      )
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.readerSelectExecutable, async (event, raw: unknown) => {
    const senderWindow = assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ReaderExecutableSelectIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const picker = await dialog.showOpenDialog(senderWindow, {
      title: "Choose a reader executable",
      properties: ["openFile"],
      filters: process.platform === "win32"
        ? [{ name: "Native executable", extensions: ["exe", "com"] }]
        : undefined
    })
    if (picker.canceled || picker.filePaths.length === 0) return { ok: true as const, data: null }
    const selectedPath = picker.filePaths[0]
    if (selectedPath === undefined) return { ok: true as const, data: null }
    try {
      await validateExecutablePath(selectedPath)
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
    const now = Date.now()
    for (const [handle, selection] of executableSelections) {
      if (selection.createdAt + EXECUTABLE_SELECTION_TTL_MS <= now) executableSelections.delete(handle)
    }
    while (executableSelections.size >= MAX_EXECUTABLE_SELECTIONS) {
      const oldest = executableSelections.keys().next().value
      if (oldest === undefined) break
      executableSelections.delete(oldest)
    }
    const selectionHandle = randomUUID()
    executableSelections.set(selectionHandle, { path: selectedPath, createdAt: now })
    return {
      ok: true as const,
      data: { selection_handle: selectionHandle, executable_name: path.basename(selectedPath) }
    }
  })

  ipcMain.handle(IpcChannels.readerProfileSave, async (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ReaderProfileSaveIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const request = decoded.value
    try {
      const profileIdToEdit = request.profile_id
      const existing = profileIdToEdit === null
        ? undefined
        : await requireRuntime().runPromise(
            Effect.gen(function*() {
              const store = yield* ReaderProfileStore
              return yield* store.get(profileIdToEdit)
            })
          )
      if (request.profile_id !== null && existing === undefined) {
        return { ok: false as const, error: toPublicError(new ReaderProfileNotFoundError()) }
      }

      let executablePath: string | null = null
      if (request.launch_mode === "explicit-executable") {
        if (request.selection_handle !== null) {
          const selection = executableSelections.get(request.selection_handle)
          if (selection === undefined || selection.createdAt + EXECUTABLE_SELECTION_TTL_MS <= Date.now()) {
            executableSelections.delete(request.selection_handle)
            throw new ReaderExecutableSelectionError("the executable selection expired; choose it again")
          }
          await validateExecutablePath(selection.path)
          executablePath = selection.path
        } else {
          executablePath = existing?.executablePath ?? null
        }
      } else if (request.selection_handle !== null) {
        throw new ReaderProfileValidationError("system association profiles cannot use an executable selection")
      }

      validateReaderProfile(request, executablePath)
      const profileId = request.profile_id ?? randomUUID()
      const saved = await requireRuntime().runPromise(
        toResult(
          Effect.gen(function*() {
            const store = yield* ReaderProfileStore
            const profile = yield* store.save({
              profileId,
              expectedRevision: request.expected_revision,
              name: request.name.trim(),
              launchMode: request.launch_mode,
              supportedFormats: request.supported_formats,
              targetMode: request.target_mode,
              executablePath,
              argumentTokens: request.argument_tokens
            })
            return { data: toReaderProfileView(profile) }
          })
        )
      )
      if (saved.ok && request.selection_handle !== null) executableSelections.delete(request.selection_handle)
      return saved
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.readerProfileTestTargetSelect, async (event, raw: unknown) => {
    const senderWindow = assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ReaderProfileTestTargetSelectIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    try {
      const profile = await requireRuntime().runPromise(
        Effect.gen(function*() {
          const store = yield* ReaderProfileStore
          return yield* store.get(decoded.value.profile_id)
        })
      )
      if (profile === undefined) throw new ReaderProfileNotFoundError()
      if (profile.revision !== decoded.value.expected_revision) {
        throw new ReaderProfileConflictError({ currentRevision: profile.revision })
      }
      const picker = await dialog.showOpenDialog(senderWindow, {
        title: "Choose a disposable reader test target",
        properties: profile.target_mode === "archive" ? ["openFile"] : ["openDirectory"],
        ...(profile.target_mode === "archive"
          ? { filters: [{ name: "ZIP or CBZ archive", extensions: ["zip", "cbz"] }] }
          : {})
      })
      if (picker.canceled || picker.filePaths.length === 0) return { ok: true as const, data: null }
      const selectedPath = picker.filePaths[0]
      if (selectedPath === undefined) return { ok: true as const, data: null }
      const resolvedTarget = await resolveReaderTestTarget(selectedPath, profile.target_mode)
      const now = Date.now()
      for (const [handle, selection] of testTargetSelections) {
        if (selection.createdAt + TEST_TARGET_SELECTION_TTL_MS <= now) testTargetSelections.delete(handle)
      }
      while (testTargetSelections.size >= MAX_TEST_TARGET_SELECTIONS) {
        const oldest = testTargetSelections.keys().next().value
        if (oldest === undefined) break
        testTargetSelections.delete(oldest)
      }
      const selectionHandle = randomUUID()
      testTargetSelections.set(selectionHandle, {
        profileId: profile.profile_id,
        profileRevision: profile.revision,
        selectedPath,
        resolvedTarget,
        createdAt: now
      })
      return {
        ok: true as const,
        data: {
          selection_handle: selectionHandle,
          profile_id: profile.profile_id,
          profile_revision: profile.revision,
          resolved_target: resolvedTarget
        }
      }
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.readerProfileTest, async (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ReaderProfileTestIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const request = decoded.value
    try {
      const profile = await requireRuntime().runPromise(
        Effect.gen(function*() {
          const store = yield* ReaderProfileStore
          return yield* store.get(request.profile_id)
        })
      )
      if (profile === undefined) throw new ReaderProfileNotFoundError()
      if (profile.revision !== request.expected_revision) {
        throw new ReaderProfileConflictError({ currentRevision: profile.revision })
      }
      const selection = testTargetSelections.get(request.selection_handle)
      if (selection === undefined || selection.createdAt + TEST_TARGET_SELECTION_TTL_MS <= Date.now()) {
        testTargetSelections.delete(request.selection_handle)
        throw new ReaderTestTargetSelectionError()
      }
      if (selection.profileId !== profile.profile_id || selection.profileRevision !== profile.revision) {
        throw new ReaderTestTargetSelectionError()
      }
      const currentResolvedTarget = await resolveReaderTestTarget(selection.selectedPath, profile.target_mode)
      if (currentResolvedTarget !== selection.resolvedTarget) {
        testTargetSelections.delete(request.selection_handle)
        throw new ReaderTestTargetSelectionError("the resolved test target changed; preview it again before launching the reader")
      }
      const resolvedTarget = selection.resolvedTarget

      let result: ReaderProfileTestResult
      if (profile.launch_mode === "explicit-executable") {
        if (profile.executablePath === null) throw new ReaderTestLaunchError("the saved profile has no executable")
        await validateExecutablePath(profile.executablePath)
        const argumentsList = profile.argument_tokens.map((token) => token === "{target}" ? resolvedTarget : token)
        await dispatchExplicitReaderTest(profile.executablePath, argumentsList)
        result = {
          handoff: "accepted",
          launch_mode: profile.launch_mode,
          resolved_target: resolvedTarget,
          message: "The operating system accepted the reader process handoff. This settings test created no Open event."
        }
      } else {
        const error = await shell.openPath(resolvedTarget)
        if (error !== "") throw new ReaderTestLaunchError("the operating system could not open the resolved target")
        result = {
          handoff: "accepted",
          launch_mode: profile.launch_mode,
          resolved_target: resolvedTarget,
          message: "The operating system accepted the associated-application handoff. This settings test created no Open event."
        }
      }
      testTargetSelections.delete(request.selection_handle)
      return { ok: true as const, data: result }
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.librarySearch, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(LibrarySearchIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return runNetworkResult(
      toResult(
        Effect.gen(function*() {
          const client = yield* LibraryHttpClient
          return yield* client.search({ payload: decoded.value })
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.libraryEntry, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(LibraryEntryIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return runNetworkResult(
      toResult(
        Effect.gen(function*() {
          const client = yield* LibraryHttpClient
          return yield* client.entry({ params: { id: decoded.value.entry_id } })
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.libraryNote, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(LibraryNoteIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    let session: Session
    try {
      session = requireSession()
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
    return runNetworkResult(
      toResult(
        Effect.gen(function*() {
          const client = yield* LibraryHttpClient
          return yield* client.entryCommand({
            params: { id: decoded.value.entry_id },
            payload: {
              operation_id: randomUUID(),
              instance_id: session.instanceId,
              epoch: session.epoch,
              expected_decision_version: decoded.value.expected_decision_version,
              command: decoded.value.text.length === 0
                ? { type: "clear-note" as const }
                : { type: "set-note" as const, text: decoded.value.text }
            }
          })
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.openBook, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(OpenBookIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    try {
      const { session, offline } = requireOpenSession()
      if (openCoordinator === null) return { ok: false as const, error: opaqueError }
      return openCoordinator.open({
        instanceId: session.instanceId,
        epoch: session.epoch,
        entryId: decoded.value.entry_id,
        profileId: decoded.value.profile_id,
        actionId: decoded.value.action_id,
        offline
      }).then((data) => {
        if (data.status === "accepted" && data.event_durable) openEventDeliveryScheduler.schedule()
        return { ok: true as const, data }
      }).catch((error) => ({ ok: false as const, error: toPublicError(error) }))
    } catch (error) {
      return Promise.resolve({ ok: false as const, error: toPublicError(error) })
    }
  })

  ipcMain.handle(IpcChannels.openBookStatus, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(OpenBookStatusIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    try {
      if (openCoordinator === null) return { ok: true as const, data: null }
      const instanceId = requireNamespace()
      const request = decoded.value
      return openCoordinator.status(
        instanceId,
        "entry_id" in request ? { entryId: request.entry_id } : { actionId: request.action_id }
      ).then((data) => ({ ok: true as const, data })).catch((error) => ({ ok: false as const, error: toPublicError(error) }))
    } catch (error) {
      return Promise.resolve({ ok: false as const, error: toPublicError(error) })
    }
  })

  ipcMain.handle(IpcChannels.libraryCommand, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(LibraryEntryCommandIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    let session: Session
    try {
      session = requireSession()
    } catch (error) {
      return Promise.resolve({ ok: false as const, error: toPublicError(error) })
    }
    const request = decoded.value
    return runNetworkResult(
      toResult(
        Effect.gen(function*() {
          const client = yield* LibraryHttpClient
          return yield* client.entryCommand({
            params: { id: request.entry_id },
            payload: {
              operation_id: request.operation_id,
              instance_id: session.instanceId,
              epoch: session.epoch,
              expected_decision_version: request.expected_decision_version,
              expected_location_revision: request.expected_location_revision,
              command: request.command
            }
          })
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.thumbnailGet, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ThumbnailGetIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return runNetworkResult(
      toRawResult(
        Effect.gen(function*() {
          const client = yield* ThumbnailHttpClient
          return yield* client.get({ params: { key: decoded.value.key } })
        })
      ),
      THUMBNAIL_NETWORK_DEADLINE
    )
  })

  ipcMain.handle(IpcChannels.taskList, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(TaskListIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return runNetworkResult(
      toResult(
        Effect.gen(function*() {
          const client = yield* TaskHttpClient
          return yield* client.list()
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.reviewCandidates, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ReviewCandidatesIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return runNetworkResult(
      toResult(
        Effect.gen(function*() {
          const client = yield* ReviewHttpClient
          return yield* client.candidates()
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.reviewCommand, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ReviewCandidateIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    let session: Session
    try {
      session = requireSession()
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
    return runNetworkResult(
      toResult(
        Effect.gen(function*() {
          const client = yield* ReviewHttpClient
          const input = decoded.value
          return yield* client.command({
            params: { id: input.candidate_id },
            payload: {
              root_id: input.root_id,
              operation_id: input.operation_id,
              instance_id: session.instanceId,
              epoch: session.epoch,
              expected_candidate_version: input.expected_candidate_version,
              expected_mapping_revision: input.expected_mapping_revision,
              expected_policy_revision: input.expected_policy_revision,
              ...("expected_decision_version" in input
                ? {
                    expected_decision_version: input.expected_decision_version,
                    expected_location_revision: input.expected_location_revision
                  }
                : {}),
              command: input.command
            }
          })
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.listOpenJournal, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ListOpenJournalIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    try {
      const instanceId = requireNamespace()
      return requireRuntime().runPromise(
        toResult(
          Effect.gen(function*() {
            const journal = yield* OpenJournalStore
            return { data: yield* journal.list(instanceId) }
          })
        )
      )
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.recoverOpenJournal, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(RecoverOpenJournalIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    try {
      const instanceId = requireNamespace()
      if (decoded.value.instance_id !== instanceId) return { ok: false as const, error: staleOpenJournalNamespaceError }
      return requireRuntime().runPromise(
        toResult(
          Effect.gen(function*() {
            const journal = yield* OpenJournalStore
            yield* (decoded.value.command === "dismiss_unknown"
              ? journal.dismissUnknown({ instanceId, actionId: decoded.value.action_id })
              : journal.discardHeld({ instanceId, actionId: decoded.value.action_id }))
            return { data: null }
          })
        )
      )
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  if (!prototypeMode) return

  ipcMain.handle(IpcChannels.handshake, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(HandshakeIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }

    try {
      const view = requireConnection().handshakeView()
      return connectionStatusResult({
        state: "connected",
        instance_id: view.instance_id,
        epoch: view.epoch,
        reason: null
      })
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.getNote, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(GetNoteIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const request = decoded.value

    return runNetworkResult(
      toResult(
        Effect.gen(function*() {
          const client = yield* PrototypeHttpClient
          return yield* client.getNote({ params: { id: request.note_id } })
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.editNote, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(EditNoteIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const request = decoded.value

    try {
      const activeSession = requireSession()
      const activeConnection = requireConnection()
      if (request.base_epoch !== activeSession.epoch) {
        return {
          ok: false as const,
          error: {
            code: "epoch_changed",
            message: "authority epoch changed; reload the current note before saving",
            retryable: true
          }
        }
      }
      const generation = activeConnection.currentGeneration()
      if (generation === null) throw new ConnectionPausedError({ state: activeConnection.getStatus().state })
      return requireRuntime()
        .runPromise(Effect.gen(function*() {
          return yield* CommandAttemptStore
        }))
        .then((attempts) =>
          runNetworkResult(
            toResult(
              Effect.gen(function*() {
                const client = yield* PrototypeHttpClient
                return {
                  data: yield* executeNoteEdit(
                    client,
                    attempts,
                    activeSession,
                    {
                      noteId: request.note_id,
                      text: request.text,
                      expectedRevision: request.expected_revision,
                      operationId: request.operation_id
                    },
                    () => activeConnection.assertGeneration(generation)
                  )
                }
              })
            )
          )
        )
        .catch((error) => ({ ok: false as const, error: toPublicError(error) }))
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.listCommandAttempts, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ListCommandAttemptsIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    try {
      const instanceId = requireNamespace()
      return requireRuntime().runPromise(
        toResult(
          Effect.gen(function*() {
            const attempts = yield* CommandAttemptStore
            return { data: yield* attempts.list(instanceId) }
          })
        )
      )
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.reconcileCommand, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ReconcileCommandIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    try {
      const activeSession = requireSession()
      const activeConnection = requireConnection()
      const generation = activeConnection.currentGeneration()
      if (generation === null) throw new ConnectionPausedError({ state: activeConnection.getStatus().state })
      return requireRuntime()
        .runPromise(Effect.gen(function*() {
          return yield* CommandAttemptStore
        }))
        .then((attempts) =>
          runNetworkResult(
            toResult(
              Effect.gen(function*() {
                const client = yield* PrototypeHttpClient
                activeConnection.assertGeneration(generation)
                return {
                  data: yield* reconcileNoteCommand(client, attempts, activeSession, decoded.value.operation_id)
                }
              })
            )
          )
        )
        .catch((error) => ({ ok: false as const, error: toPublicError(error) }))
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.dismissCommand, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(DismissCommandIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    try {
      const instanceId = requireNamespace()
      return requireRuntime().runPromise(
        toResult(
          Effect.gen(function*() {
            const attempts = yield* CommandAttemptStore
            return {
              data: yield* attempts.dismiss({
                instanceId,
                operationId: decoded.value.operation_id
              })
            }
          })
        )
      )
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.saveDraft, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(SaveDraftIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const request = decoded.value
    try {
      const instanceId = requireNamespace()
      return requireRuntime().runPromise(
        toResult(
          Effect.gen(function*() {
            const store = yield* DraftStore
            const draft = yield* store.save({
              instanceId,
              noteId: request.note_id,
              formId: request.form_id,
              text: request.text,
              expectedLocalRevision: request.expected_local_revision,
              baseServerRevision: request.base_server_revision,
              baseEpoch: request.base_epoch
            })
            return { data: draft }
          })
        )
      )
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.loadDraft, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(LoadDraftIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const request = decoded.value
    try {
      const instanceId = requireNamespace()
      return requireRuntime().runPromise(
        toResult(
          Effect.gen(function*() {
            const store = yield* DraftStore
            const draft = yield* store.load({
              instanceId,
              noteId: request.note_id,
              formId: request.form_id
            })
            return { data: draft ?? null }
          })
        )
      )
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })

  ipcMain.handle(IpcChannels.discardDraft, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(DiscardDraftIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const request = decoded.value
    try {
      const instanceId = requireNamespace()
      return requireRuntime().runPromise(
        toResult(
          Effect.gen(function*() {
            const store = yield* DraftStore
            const discarded = yield* store.discard({
              instanceId,
              noteId: request.note_id,
              formId: request.form_id,
              expectedLocalRevision: request.expected_local_revision
            })
            return { data: discarded }
          })
        )
      )
    } catch (error) {
      return { ok: false as const, error: toPublicError(error) }
    }
  })
}

const createWindow = (initialScreen: "setup" | "library" = "setup"): void => {
  const indexPath = path.join(app.getAppPath(), "dist", "index.html")
  const query = {
    ...(prototypeMode ? { mode: "prototype" } : {}),
    ...(initialScreen === "library" ? { screen: "library" } : {})
  }
  const queryString = new URLSearchParams(query).toString()
  const expectedUrl = `${pathToFileURL(indexPath).toString()}${queryString.length === 0 ? "" : `?${queryString}`}`
  const window = new BrowserWindow({
    width: 720,
    height: 560,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  // Deny navigation and new windows; the prototype renderer never leaves its
  // packaged document.
  window.webContents.on("will-navigate", (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))

  window.on("closed", () => {
    appWindows.delete(window)
    trustedWindowUrls.delete(window)
    if (mainWindow === window) {
      mainWindow = appWindows.values().next().value ?? null
    }
  })
  appWindows.add(window)
  trustedWindowUrls.set(window, expectedUrl)
  mainWindow = window
  void window.loadFile(indexPath, {
    query: Object.keys(query).length === 0 ? undefined : query
  })
}

const installApplicationMenu = (): void => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          id: "new-library-window",
          label: "New Window",
          accelerator: "CmdOrCtrl+N",
          click: () => createWindow("library")
        }
      ]
    },
    { role: "editMenu" as const },
    { role: "windowMenu" as const }
  ]))
}

/**
 * Single bounded shutdown owner. Stops the runtime and the owned child exactly
 * once, awaiting both with a finite deadline. Startup failure and normal exit
 * both route through it.
 */
const shutdown = (): Promise<void> => {
  if (shutdownPromise !== null) return shutdownPromise
  shutdownPromise = (async () => {
    const activeCoordinator = openCoordinator
    if (activeCoordinator !== null) {
      const coordinatorDeadline = Date.now() + SHUTDOWN_TIMEOUT_MS
      activeCoordinator.closeAdmissions()
      await Promise.race([
        (async () => {
          await activeCoordinator.waitForInFlight(Math.max(0, coordinatorDeadline - Date.now()))
          await activeCoordinator.drainPendingAccepted(Math.max(0, coordinatorDeadline - Date.now()))
        })(),
        delay(SHUTDOWN_TIMEOUT_MS)
      ])
    }
    const activeRuntime = runtime
    runtime = null
    const activeConnection = connection
    connection = null
    openCoordinator = null
    if (activeConnection !== null) await activeConnection.close()
    await discardPendingRemoteConnection()
    if (activeRuntime !== null) {
      await Promise.race([activeRuntime.dispose(), delay(SHUTDOWN_TIMEOUT_MS)])
    }
    const child = serverChild
    serverChild = null
    if (child !== null) await child.stop()
  })()
  return shutdownPromise
}

const bootstrap = async (): Promise<void> => {
  const dbPath = process.env.HENSHIN_PROTOTYPE_DB ?? path.join(app.getPath("userData"), "prototype.db")
  const clientDbPath =
    process.env.HENSHIN_PROTOTYPE_CLIENT_DB ?? path.join(app.getPath("userData"), "prototype-client.db")
  deviceId = await loadDeviceId(app.getPath("userData"))
  protectedWritablePaths = [
    app.getPath("userData"),
    app.getPath("sessionData"),
    app.getPath("logs"),
    path.dirname(dbPath),
    path.dirname(clientDbPath)
  ]
  managedDatabasePath = dbPath

  const draftWorkerUrl = pathToFileURL(path.join(app.getAppPath(), "dist", "draft-worker.mjs"))
  const localWorker = LocalDatabaseWorker.layer(clientDbPath, { workerUrl: draftWorkerUrl })
  runtime = ManagedRuntime.make(
    Layer.mergeAll(
      DraftStore.layerFromWorker,
      CommandAttemptStore.layerFromWorker,
      OpenJournalStore.layerFromWorker,
      LocalMappingStore.layerFromWorker,
      ReaderProfileStore.layerFromWorker,
      OpenResolutionCache.layerFromWorker
    ).pipe(Layer.provide(localWorker))
  )

  // The owned child remains supervised independently. A remote session only
  // changes the authenticated HTTP target; it never grants main permission to
  // stop the independently running service.
  const child = await ensureManagedChild()
  connectionTarget = { mode: "managed", base_url: null, instance_id: null }
  connection = new ConnectionLifecycle({
    baseUrl: child.baseUrl,
    bearerToken: child.bearerToken
  })
  await connection.connect()
  updateTargetFromStatus(connection.getStatus())
  openEventDeliveryScheduler.schedule()
  openCoordinator = createOpenCoordinator()
  openEventDeliveryScheduler.schedule()

  registerIpc()
  installApplicationMenu()
  createWindow()
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  try {
    await bootstrap()
  } catch (error) {
    console.error("prototype bootstrap failed:", error instanceof Error ? error.message : error)
    await shutdown()
    app.exit(1)
  }
})

app.on("window-all-closed", () => {
  app.quit()
})

app.on("before-quit", (event) => {
  if (readyToQuit) return
  event.preventDefault()
  void shutdown().finally(() => {
    readyToQuit = true
    app.quit()
  })
})
