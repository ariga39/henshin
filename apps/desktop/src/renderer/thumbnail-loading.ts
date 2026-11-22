import type { Result } from "./client"

export const MAX_ACTIVE_THUMBNAIL_LOADS = 4

/**
 * The server may keep a render in flight for up to ten seconds. These bounded
 * delays give a request that observed the server's 503 enough opportunity to
 * retry after one of those renders completes without leaving a timer behind.
 */
export const THUMBNAIL_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 4_000] as const

type Load = () => Promise<Result<Uint8Array>>
type QueueTask = () => void

const queued: Array<QueueTask> = []
let active = 0

const pump = (): void => {
  while (active < MAX_ACTIVE_THUMBNAIL_LOADS && queued.length > 0) {
    queued.shift()?.()
  }
}

const enqueue = (task: QueueTask): void => {
  queued.push(task)
  pump()
}

const removeQueued = (task: QueueTask): void => {
  const index = queued.indexOf(task)
  if (index >= 0) queued.splice(index, 1)
}

export interface ThumbnailLoadRequest {
  readonly promise: Promise<Result<Uint8Array>>
  readonly cancel: () => void
}

/**
 * Schedules one cover request within the server's render concurrency budget.
 * Cancellation removes queued work and clears retry timers; an already active
 * IPC call is allowed to settle, but its result cannot reach the caller.
 */
export const createThumbnailLoadRequest = (load: Load): ThumbnailLoadRequest => {
  let cancelled = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let queuedTask: QueueTask | undefined
  let resolvePromise: (result: Result<Uint8Array>) => void = () => undefined
  let rejectPromise: (error: unknown) => void = () => undefined

  const promise = new Promise<Result<Uint8Array>>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  const finish = (result: Result<Uint8Array>): void => {
    if (!cancelled) resolvePromise(result)
  }

  const start = (attempt: number): void => {
    if (cancelled) return
    const task: QueueTask = () => {
      queuedTask = undefined
      if (cancelled) {
        pump()
        return
      }
      active += 1
      void load().then((result) => {
        if (cancelled) return
        if (!result.ok && result.error.code === "thumbnail_updating" && attempt < THUMBNAIL_RETRY_DELAYS_MS.length) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            start(attempt + 1)
          }, THUMBNAIL_RETRY_DELAYS_MS[attempt])
          return
        }
        finish(result)
      }).catch((error: unknown) => {
        if (!cancelled) rejectPromise(error)
      }).finally(() => {
        active -= 1
        pump()
      })
    }
    queuedTask = task
    enqueue(task)
  }

  start(0)

  return {
    promise,
    cancel: () => {
      cancelled = true
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
      if (queuedTask !== undefined) {
        removeQueued(queuedTask)
        queuedTask = undefined
      }
    }
  }
}
