import { Worker } from "node:worker_threads"
import { Context, Data, Duration, Effect, Layer, Option, Schema } from "effect"
import { DraftWorkerResponse, type DraftWorkerRequest } from "./draft-worker-protocol"

export class LocalDatabaseWorkerError extends Data.TaggedError("LocalDatabaseWorkerError")<{
  readonly message: string
}> {}

const MAX_PENDING_CALLS = 64
const CALL_DEADLINE = Duration.seconds(5)
const SHUTDOWN_DEADLINE_MS = 2_000

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface LocalDatabaseWorkerOptions {
  readonly workerUrl: URL
  readonly callDeadline?: Duration.Duration
  readonly shutdownDeadlineMs?: number
}

export class LocalDatabaseWorker extends Context.Service<
  LocalDatabaseWorker,
  { readonly call: (request: DraftWorkerRequest) => Effect.Effect<unknown, LocalDatabaseWorkerError> }
>()("henshin/desktop/LocalDatabaseWorker") {
  static readonly layer = (
    dbPath: string,
    options: LocalDatabaseWorkerOptions
  ): Layer.Layer<LocalDatabaseWorker> =>
    Layer.effect(
      LocalDatabaseWorker,
      Effect.gen(function*() {
        const pending = new Map<
          number,
          { resolve: (value: unknown) => void; reject: (error: Error) => void }
        >()
        let nextId = 1
        let alive = true

        const failPending = (message: string) => {
          const entries = Array.from(pending.values())
          pending.clear()
          for (const entry of entries) entry.reject(new Error(message))
        }

        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const instance = new Worker(options.workerUrl, { workerData: { dbPath } })
            instance.on("message", (raw: unknown) => {
              const decoded = Schema.decodeUnknownOption(DraftWorkerResponse)(raw)
              if (Option.isNone(decoded)) {
                failPending("local database worker sent an invalid response")
                return
              }
              const response = decoded.value
              const entry = pending.get(response.id)
              if (entry === undefined) return
              pending.delete(response.id)
              if (response.ok) entry.resolve(response.value)
              else entry.reject(new Error(response.error))
            })
            instance.on("error", (error: Error) => {
              alive = false
              failPending(error.message)
            })
            instance.on("exit", () => {
              alive = false
              failPending("local database worker exited")
            })
            return instance
          }),
          (instance) =>
            Effect.promise(async () => {
              alive = false
              if (instance.threadId === -1) return
              const ack = new Promise<void>((resolve) => {
                const id = nextId++
                pending.set(id, { resolve: () => resolve(), reject: () => resolve() })
                try {
                  instance.postMessage({ id, request: { op: "close" } })
                } catch {
                  pending.delete(id)
                  resolve()
                }
              })
              await Promise.race([ack, delay(options.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS)])
              if (instance.threadId !== -1) {
                await Promise.race([
                  instance.terminate(),
                  delay(options.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS)
                ])
              }
            })
        )

        const call = (request: DraftWorkerRequest): Effect.Effect<unknown, LocalDatabaseWorkerError> =>
          Effect.suspend(() => {
            if (!alive) return Effect.fail(new LocalDatabaseWorkerError({ message: "local database worker is not running" }))
            if (pending.size >= MAX_PENDING_CALLS) {
              return Effect.fail(new LocalDatabaseWorkerError({ message: "local database worker admission limit reached" }))
            }
            const id = nextId++
            const execute = Effect.tryPromise({
              try: () =>
                new Promise<unknown>((resolve, reject) => {
                  pending.set(id, { resolve, reject })
                  try {
                    worker.postMessage({ id, request })
                  } catch (error) {
                    pending.delete(id)
                    reject(error instanceof Error ? error : new Error(String(error)))
                  }
                }),
              catch: (error) =>
                new LocalDatabaseWorkerError({
                  message: error instanceof Error ? error.message : String(error)
                })
            })
            return execute.pipe(
              Effect.onInterrupt(() => Effect.sync(() => void pending.delete(id))),
              Effect.timeoutOption(options.callDeadline ?? CALL_DEADLINE),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new LocalDatabaseWorkerError({ message: "local database worker call timed out" })),
                  onSome: Effect.succeed
                })
              )
            )
          })

        return LocalDatabaseWorker.of({ call })
      })
    )
}
