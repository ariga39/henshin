import { Worker } from "node:worker_threads"
import { Context, Data, Duration, Effect, Layer, Option, Schema } from "effect"
import { WorkerResponse, type WorkerRequest } from "./worker-protocol"

export class DatabaseWorkerError extends Data.TaggedError("DatabaseWorkerError")<{
  readonly message: string
}> {}

const MAX_PENDING_CALLS = 64
const CALL_DEADLINE = Duration.seconds(5)
const SHUTDOWN_DEADLINE_MS = 2_000

type Settlement = "completed" | "failed" | "timed-out"

const settleWithin = (promise: Promise<unknown>, timeoutMs: number): Promise<Settlement> =>
  new Promise((resolve) => {
    let settled = false
    const finish = (result: Settlement) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => finish("timed-out"), timeoutMs)
    promise.then(
      () => finish("completed"),
      () => finish("failed")
    )
  })

export interface DatabaseWorkerOptions {
  /** Test-only worker replacement and data used by worker fault fixtures. */
  readonly workerUrl?: URL
  readonly workerData?: Readonly<Record<string, unknown>>
  readonly callDeadline?: Duration.Duration
  readonly shutdownDeadlineMs?: number
}

/**
 * Owns the dedicated SQLite worker thread.
 *
 * Guarantees:
 * - every in-flight call settles when the worker errors or exits;
 * - new calls fail fast after death and beyond a finite admission bound;
 * - each call has a finite deadline, and interruption or `postMessage` failure
 *   removes its pending entry rather than leaking it;
 * - shutdown is a bounded, awaited graceful close followed by termination.
 */
export class DatabaseWorker extends Context.Service<
  DatabaseWorker,
  { readonly call: (request: WorkerRequest) => Effect.Effect<unknown, DatabaseWorkerError> }
>()("henshin/server/DatabaseWorker") {
  static readonly layer = (
    dbPath: string,
    options: DatabaseWorkerOptions = {}
  ): Layer.Layer<DatabaseWorker> =>
    Layer.effect(
      DatabaseWorker,
      Effect.gen(function*() {
        const pending = new Map<
          number,
          { resolve: (value: unknown) => void; reject: (error: Error) => void }
        >()
        let nextId = 1
        let alive = true
        let stopped = false
        let resolveStopped: () => void = () => undefined
        const stoppedPromise = new Promise<void>((resolve) => {
          resolveStopped = resolve
        })

        const failPending = (message: string) => {
          const entries = Array.from(pending.values())
          pending.clear()
          for (const entry of entries) entry.reject(new Error(message))
        }

        const worker = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const instance = new Worker(options.workerUrl ?? new URL("./worker.mjs", import.meta.url), {
              workerData: { ...options.workerData, dbPath }
            })

            instance.on("message", (raw: unknown) => {
              const decoded = Schema.decodeUnknownOption(WorkerResponse)(raw)
              if (Option.isNone(decoded)) {
                failPending("database worker sent an invalid response")
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
              stopped = true
              resolveStopped()
              alive = false
              failPending(error.message)
            })

            instance.on("exit", () => {
              stopped = true
              resolveStopped()
              alive = false
              failPending("database worker exited")
            })

            return instance
          }),
          (instance) =>
            Effect.promise(async () => {
              alive = false
              if (stopped || instance.threadId === -1) return
              const shutdownDeadlineMs = options.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS
              let closeId: number | undefined
              const ack = new Promise<void>((resolve) => {
                closeId = nextId++
                pending.set(closeId, { resolve: () => resolve(), reject: () => resolve() })
                try {
                  instance.postMessage({ id: closeId, request: { op: "close" } })
                } catch {
                  pending.delete(closeId)
                  resolve()
                }
              })
              const closeResult = await Promise.race([
                settleWithin(ack, shutdownDeadlineMs),
                stoppedPromise.then((): Settlement => "completed")
              ])
              if (closeId !== undefined) pending.delete(closeId)
              if (closeResult === "timed-out") {
                console.error("database worker shutdown timed out waiting for close acknowledgement")
              }
              if (stopped || closeResult === "completed" && instance.threadId === -1) return
              if (instance.threadId !== -1) {
                const terminateResult = await settleWithin(instance.terminate(), shutdownDeadlineMs)
                if (terminateResult === "timed-out") {
                  console.error("database worker shutdown timed out waiting for termination")
                }
              }
            })
        )

        const call = (request: WorkerRequest): Effect.Effect<unknown, DatabaseWorkerError> =>
          Effect.suspend(() => {
            if (!alive) {
              return Effect.fail(
                new DatabaseWorkerError({ message: "database worker is not running" })
              )
            }
            if (pending.size >= MAX_PENDING_CALLS) {
              return Effect.fail(
                new DatabaseWorkerError({ message: "database worker admission limit reached" })
              )
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
                new DatabaseWorkerError({
                  message: error instanceof Error ? error.message : String(error)
                })
            })

            return execute.pipe(
              Effect.onInterrupt(() => Effect.sync(() => void pending.delete(id))),
              Effect.timeoutOption(options.callDeadline ?? CALL_DEADLINE),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(new DatabaseWorkerError({ message: "database worker call timed out" })),
                  onSome: Effect.succeed
                })
              )
            )
          })

        return DatabaseWorker.of({ call })
      })
    )
}
