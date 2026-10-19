import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron"
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
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
  LoadDraftIpcRequest,
  ListCommandAttemptsIpcRequest,
  PrototypeHttpClient,
  PublicApiError,
  SaveDraftIpcRequest,
  ReconcileCommandIpcRequest,
  ConnectionStatusView,
  type PublicError
} from "@henshin/contracts"
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
import {
  ConnectionInstanceMismatchError,
  ConnectionLifecycle,
  ConnectionPausedError
} from "./ConnectionLifecycle"

const SHUTDOWN_TIMEOUT_MS = 5_000

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
type MainServices = DraftStore | CommandAttemptStore
let runtime: ManagedRuntime.ManagedRuntime<MainServices, never> | null = null
let connection: ConnectionLifecycle | null = null
let rendererUrl = ""
let shutdownPromise: Promise<void> | null = null
let readyToQuit = false

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const opaqueError: PublicError = { code: "internal_error", message: "request failed", retryable: false }
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

const runNetworkResult = <A>(
  effect: Effect.Effect<IpcOk<A> | IpcErr, never, PrototypeHttpClient>
): Promise<IpcOk<A> | IpcErr> =>
  requireConnection()
    .run(effect)
    .catch((error) => ({ ok: false as const, error: toPublicError(error) }))

const connectionStatusResult = (status: ConnectionStatusView): IpcOk<ConnectionStatusView> => ({
  ok: true,
  data: status
})

const registerIpc = (): void => {
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
      .then(connectionStatusResult)
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
  void window.loadFile(path.join(app.getAppPath(), "dist", "index.html"))
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
      CommandAttemptStore.layerFromWorker
    ).pipe(Layer.provide(localWorker))
  )

  // The owned child remains supervised independently; disconnect only pauses
  // the authenticated HTTP scope for this managed endpoint.
  connection = new ConnectionLifecycle({
    baseUrl: serverChild.baseUrl,
    bearerToken: serverChild.bearerToken
  })
  await connection.connect()

  registerIpc()
  createWindow()
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  rendererUrl = pathToFileURL(path.join(app.getAppPath(), "dist", "index.html")).toString()
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
