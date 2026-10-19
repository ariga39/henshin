import { Context, Effect, Layer } from "effect"
import type { HandshakeView, NoteView, PublicError } from "@henshin/contracts"

export type Result<A> =
  | { readonly ok: true; readonly data: A }
  | { readonly ok: false; readonly error: PublicError }

export interface EditNoteInput {
  readonly note_id: string
  readonly text: string
  readonly expected_revision: string
  readonly operation_id: string
}

export interface PrototypeBridge {
  handshake(): Promise<Result<HandshakeView>>
  getNote(noteId: string): Promise<Result<NoteView>>
  editNote(input: EditNoteInput): Promise<Result<NoteView>>
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
    readonly getNote: (noteId: string) => Effect.Effect<Result<NoteView>>
    readonly editNote: (input: EditNoteInput) => Effect.Effect<Result<NoteView>>
  }
>()("henshin/desktop/renderer/PrototypeClient") {
  static readonly layer = Layer.succeed(
    PrototypeClient,
    PrototypeClient.of({
      handshake: () => callIpc(() => window.henshinPrototype.handshake()),
      getNote: (noteId) => callIpc(() => window.henshinPrototype.getNote(noteId)),
      editNote: (input) => callIpc(() => window.henshinPrototype.editNote(input))
    })
  )
}
