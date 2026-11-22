import { afterEach, describe, expect, it, vi } from "vitest"
import type { Result } from "../../desktop/src/renderer/client"
import {
  createThumbnailLoadRequest,
  THUMBNAIL_RETRY_DELAYS_MS
} from "../../desktop/src/renderer/thumbnail-loading"

const updating: Result<Uint8Array> = {
  ok: false,
  error: {
    code: "thumbnail_updating",
    message: "thumbnail generation is updating",
    retryable: true
  }
}

const ready = (value: number): Result<Uint8Array> => ({
  ok: true,
  data: new Uint8Array([value])
})

afterEach(() => {
  vi.useRealTimers()
})

describe("desktop library thumbnail loading", () => {
  it("recovers after a delayed server update", async () => {
    vi.useFakeTimers()
    const load = vi.fn<() => Promise<Result<Uint8Array>>>()
      .mockResolvedValueOnce(updating)
      .mockResolvedValueOnce(ready(7))

    const request = createThumbnailLoadRequest(load)
    await Promise.resolve()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(THUMBNAIL_RETRY_DELAYS_MS[0])
    await expect(request.promise).resolves.toEqual(ready(7))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("clears a retry timer when an obsolete cover is cancelled", async () => {
    vi.useFakeTimers()
    const load = vi.fn<() => Promise<Result<Uint8Array>>>().mockResolvedValue(updating)
    const request = createThumbnailLoadRequest(load)
    await Promise.resolve()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)

    request.cancel()
    await vi.advanceTimersByTimeAsync(THUMBNAIL_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("does not exceed the server render concurrency limit", async () => {
    const pending: Array<(result: Result<Uint8Array>) => void> = []
    const load = vi.fn(() => new Promise<Result<Uint8Array>>((resolve) => pending.push(resolve)))
    const requests = Array.from({ length: 5 }, () => createThumbnailLoadRequest(load))

    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(4)

    pending.slice(0, 4).forEach((resolve) => resolve(ready(1)))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(5)

    pending[4]?.(ready(5))
    await expect(Promise.all(requests.map((request) => request.promise))).resolves.toHaveLength(5)
  })
})
