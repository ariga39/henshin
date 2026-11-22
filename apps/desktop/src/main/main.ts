import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron"
import { Cause, Duration, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  DiscardDraftIpcRequest,
  ConnectIpcRequest,
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
  LocalMappingPreviewIpcRequest,
  LibrarySearchIpcRequest,
  LoadDraftIpcRequest,
  ListCommandAttemptsIpcRequest,
  PrototypeHttpClient,
  PublicApiError,
  RootPreviewIpcRequest,
  RootListIpcRequest,
  RootCommandIpcRequest,
  RootSaveIpcRequest,
  ReleaseHeldDiscoveryIpcRequest,
  ReviewCandidatesIpcRequest,
  ServerHttpClient,
  ReviewHttpClient,
  TaskHttpClient,
  TaskListIpcRequest,
  SaveDraftIpcRequest,
  ReconcileCommandIpcRequest,
  ConnectionStatusView,
  type PublicError,
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
import { OpenJournalStore } from "./persistence/OpenJournalStore"
import { drainOpenEvents } from "./OpenEventDelivery"
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
import {
  ConnectionInstanceMismatchError,
  ConnectionLifecycle,
  ConnectionPausedError
} from "./ConnectionLifecycle"

const SHUTDOWN_TIMEOUT_MS = 5_000
const LOCAL_MAPPING_REQUEST_TIMEOUT = Duration.seconds(12)

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
let serverChild: ServerChild | null = null
type MainServices = DraftStore | CommandAttemptStore | OpenJournalStore | ReaderProfileStore
let runtime: ManagedRuntime.ManagedRuntime<MainServices, never> | null = null
let connection: ConnectionLifecycle | null = null
let rendererUrl = ""
let shutdownPromise: Promise<void> | null = null
let readyToQuit = false
const prototypeMode = process.env.HENSHIN_PROTOTYPE_MODE === "1"
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
  if (error instanceof CommandAttemptStoreFullError) {
    return {
      code: "command_attempt_store_full",
      message: "command recovery storage is full (64 retained attempts); terminal and dismissed attempts become cleanup-eligible after seven days, while unresolved attempts require reconciliation or dismissal",
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

const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) {
    throw new Error("rejected IPC from an untrusted web contents")
  }
  const frame = event.senderFrame
  if (frame === null || frame !== mainWindow.webContents.mainFrame) {
    throw new Error("rejected IPC from an untrusted frame")
  }
  if (frame.url !== rendererUrl) {
    throw new Error("rejected IPC from an untrusted origin")
  }
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

const notifyOpenJournalChanged = (): void => {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.openJournalChanged)
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

const runNetworkResult = <A>(
  effect: Effect.Effect<
    IpcOk<A> | IpcErr,
    never,
    PrototypeHttpClient | ServerHttpClient | LibraryHttpClient | TaskHttpClient | ReviewHttpClient | OpenEventHttpClient
  >,
  timeout?: Duration.Duration,
  errorMapper: (error: unknown) => PublicError = toPublicError
): Promise<IpcOk<A> | IpcErr> =>
  requireConnection()
    .run(effect, timeout)
    .catch((error) => ({ ok: false as const, error: errorMapper(error) }))

const connectionStatusResult = (status: ConnectionStatusView): IpcOk<ConnectionStatusView> => ({
  ok: true,
  data: status
})

const registerIpc = (): void => {
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
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(LocalMappingPreviewIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const selected = await dialog.showOpenDialog(mainWindow!, {
      title: "Select the local collection directory",
      properties: ["openDirectory"]
    })
    if (selected.canceled || selected.filePaths.length === 0) return { ok: true as const, data: null }
    const selectedPath = selected.filePaths[0]
    return runNetworkResult(
      toRawResult(
        Effect.gen(function*() {
          const client = yield* LibraryHttpClient
          const indexed = yield* client.indexedSamples({ params: { id: decoded.value.root_id } })
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
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ReaderExecutableSelectIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    if (mainWindow === null) return { ok: false as const, error: opaqueError }
    const picker = await dialog.showOpenDialog(mainWindow, {
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
    assertTrustedSender(event)
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
      if (mainWindow === null) return { ok: false as const, error: opaqueError }

      const picker = await dialog.showOpenDialog(mainWindow, {
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
    const decoded = Schema.decodeUnknownOption(ReleaseHeldDiscoveryIpcRequest)(raw)
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
              command: input.command
            }
          })
        })
      )
    )
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

  ipcMain.handle(IpcChannels.connect, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ConnectIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return requireConnection()
      .connect()
      .then((status) => {
        void deliverPendingOpenEvents()
        return connectionStatusResult(status)
      })
      .catch((error) => ({ ok: false as const, error: toPublicError(error) }))
  })

  ipcMain.handle(IpcChannels.disconnect, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(DisconnectIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return requireConnection().disconnect().then(connectionStatusResult)
  })

  ipcMain.handle(IpcChannels.connectionStatus, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(ConnectionStatusIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    return connectionStatusResult(requireConnection().getStatus())
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

const createWindow = (): void => {
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
    mainWindow = null
  })
  mainWindow = window
  void window.loadFile(path.join(app.getAppPath(), "dist", "index.html"), {
    query: prototypeMode ? { mode: "prototype" } : undefined
  })
}

/**
 * Single bounded shutdown owner. Stops the runtime and the owned child exactly
 * once, awaiting both with a finite deadline. Startup failure and normal exit
 * both route through it.
 */
const shutdown = (): Promise<void> => {
  if (shutdownPromise !== null) return shutdownPromise
  shutdownPromise = (async () => {
    const activeRuntime = runtime
    runtime = null
    const activeConnection = connection
    connection = null
    if (activeConnection !== null) await activeConnection.close()
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
  serverChild = await startServerChild(dbPath)

  const draftWorkerUrl = pathToFileURL(path.join(app.getAppPath(), "dist", "draft-worker.mjs"))
  const localWorker = LocalDatabaseWorker.layer(clientDbPath, { workerUrl: draftWorkerUrl })
  runtime = ManagedRuntime.make(
    Layer.mergeAll(
      DraftStore.layerFromWorker,
      CommandAttemptStore.layerFromWorker,
      OpenJournalStore.layerFromWorker,
      ReaderProfileStore.layerFromWorker
    ).pipe(Layer.provide(localWorker))
  )

  // The owned child remains supervised independently; disconnect only pauses
  // the authenticated HTTP scope for this managed endpoint.
  connection = new ConnectionLifecycle({
    baseUrl: serverChild.baseUrl,
    bearerToken: serverChild.bearerToken
  })
  await connection.connect()
  void deliverPendingOpenEvents()

  registerIpc()
  createWindow()
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  rendererUrl = `${pathToFileURL(path.join(app.getAppPath(), "dist", "index.html")).toString()}${
    prototypeMode ? "?mode=prototype" : ""
  }`
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
