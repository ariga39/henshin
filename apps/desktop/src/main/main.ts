import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron"
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  DiscardDraftIpcRequest,
  EditNoteIpcRequest,
  GetNoteIpcRequest,
  HandshakeIpcRequest,
  IpcChannels,
  LoadDraftIpcRequest,
  PrototypeHttpClient,
  PublicApiError,
  SaveDraftIpcRequest,
  type PublicError
} from "@henshin/contracts"
import { startServerChild, type ServerChild } from "./server-child"
import { DraftConflictError, DraftStore, DraftStoreFullError } from "./persistence/DraftStore"

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
type MainServices = PrototypeHttpClient | DraftStore
let runtime: ManagedRuntime.ManagedRuntime<MainServices, never> | null = null
let session: Session | null = null
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
  if (session === null) throw new Error("no authenticated server session")
  return session
}

const registerIpc = (): void => {
  ipcMain.handle(IpcChannels.handshake, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(HandshakeIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }

    return requireRuntime().runPromise(
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const envelope = yield* client.handshake()
        // Return the explicit handshake view the renderer expects, not the raw
        // endpoint payload.
        return {
          ok: true as const,
          data: { instance_id: envelope.instance_id, epoch: envelope.epoch }
        }
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error: toPublicError(error) }),
          onSuccess: (result) => result
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.getNote, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(GetNoteIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const request = decoded.value

    return requireRuntime().runPromise(
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

    // Namespace and epoch come from main's authenticated session, never from
    // the renderer.
    const activeSession = requireSession()
    return requireRuntime().runPromise(
      toResult(
        Effect.gen(function*() {
          const client = yield* PrototypeHttpClient
          const result = yield* client.editNote({
            params: { id: request.note_id },
            payload: {
              operation_id: request.operation_id,
              expected_revision: request.expected_revision,
              text: request.text,
              instance_id: activeSession.instanceId,
              epoch: activeSession.epoch
            }
          })
          return { ...result, data: result.data.note }
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.saveDraft, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(SaveDraftIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const request = decoded.value
    const activeSession = requireSession()
    return requireRuntime().runPromise(
      toResult(
        Effect.gen(function*() {
          const store = yield* DraftStore
          const draft = yield* store.save({
            instanceId: activeSession.instanceId,
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
  })

  ipcMain.handle(IpcChannels.loadDraft, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(LoadDraftIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const request = decoded.value
    const activeSession = requireSession()
    return requireRuntime().runPromise(
      toResult(
        Effect.gen(function*() {
          const store = yield* DraftStore
          const draft = yield* store.load({
            instanceId: activeSession.instanceId,
            noteId: request.note_id,
            formId: request.form_id
          })
          return { data: draft ?? null }
        })
      )
    )
  })

  ipcMain.handle(IpcChannels.discardDraft, (event, raw: unknown) => {
    assertTrustedSender(event)
    const decoded = Schema.decodeUnknownOption(DiscardDraftIpcRequest)(raw)
    if (Option.isNone(decoded)) return { ok: false as const, error: invalidRequestError }
    const request = decoded.value
    const activeSession = requireSession()
    return requireRuntime().runPromise(
      toResult(
        Effect.gen(function*() {
          const store = yield* DraftStore
          const discarded = yield* store.discard({
            instanceId: activeSession.instanceId,
            noteId: request.note_id,
            formId: request.form_id,
            expectedLocalRevision: request.expected_local_revision
          })
          return { data: discarded }
        })
      )
    )
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
  runtime = ManagedRuntime.make(
    Layer.merge(
      PrototypeHttpClient.layer({
        baseUrl: serverChild.baseUrl,
        bearerToken: serverChild.bearerToken
      }),
      DraftStore.layer(clientDbPath, draftWorkerUrl)
    )
  )

  // Establish the authenticated session through the typed client, so the
  // namespace/epoch used for mutations is server-verified rather than assumed.
  const handshake = await runtime.runPromise(
    Effect.gen(function*() {
      const client = yield* PrototypeHttpClient
      return yield* client.handshake()
    })
  )
  session = { instanceId: handshake.instance_id, epoch: handshake.epoch }

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
