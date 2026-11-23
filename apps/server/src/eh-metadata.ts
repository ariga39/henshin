import { Schema } from "effect"

const DEFAULT_GDATA_URL = "https://api.e-hentai.org/api.php"
const MAX_RESPONSE_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 5_000

const GdataItem = Schema.Struct({
  gid: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  token: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  title_jpn: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  error: Schema.optional(Schema.String)
})
const GdataResponse = Schema.Struct({ gmetadata: Schema.Array(GdataItem) })

export interface EhMetadataLocator {
  readonly gid: string
  readonly token: string
}

export type EhMetadataFetchResult =
  | { readonly kind: "success"; readonly title: string; readonly titleJpn: string; readonly tags: ReadonlyArray<string> }
  | {
      readonly kind: "failure"
      readonly error: string
      readonly retryable?: boolean
      readonly retryAfterMs?: number
    }

const failure = (error: string, options?: { readonly retryable?: boolean; readonly retryAfterMs?: number }): EhMetadataFetchResult => ({
  kind: "failure",
  error: error.slice(0, 200),
  ...options
})

const MAX_RETRIES = 2
const MAX_RETRY_DELAY_MS = 30_000
/** Interactive refreshes do not hold the serialized request tail longer than this. */
const MAX_INTERACTIVE_WAIT_MS = 60_000
const MIN_REQUEST_INTERVAL_MS = 5_000

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

const retryAfterMilliseconds = (value: string | null, now: number): number | undefined => {
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = seconds * 1_000
    return Number.isFinite(milliseconds) ? milliseconds : undefined
  }
  const date = Date.parse(value)
  const milliseconds = date - now
  return Number.isFinite(date) && Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined
}

const canonicalDecimalGid = (gid: string): string | null => {
  if (!/^[0-9]{1,20}$/u.test(gid)) return null
  return gid.replace(/^0+(?=\d)/u, "")
}

const requestBody = (locator: EhMetadataLocator): string | null => {
  const gid = canonicalDecimalGid(locator.gid)
  return gid === null
    ? null
    : `{"method":"gdata","namespace":1,"gidlist":[[${gid},${JSON.stringify(locator.token)}]]}`
}

const endpoint = (): URL | null => {
  try {
    const value = new URL(process.env.HENSHIN_EH_GDATA_URL ?? DEFAULT_GDATA_URL)
    const localHttp = value.protocol === "http:" && (value.hostname === "127.0.0.1" || value.hostname === "localhost")
    if (value.protocol !== "https:" && !localHttp) return null
    return value
  } catch {
    return null
  }
}

const readBoundedText = async (response: Response): Promise<string> => {
  if (response.body === null) throw new Error("upstream response has no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = next.value
      total += chunk.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new Error("upstream response exceeded the bounded size")
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

const decodedResponse = (value: unknown): typeof GdataResponse.Type | null => {
  const decoded = Schema.decodeUnknownOption(GdataResponse)(value)
  return decoded._tag === "Some" ? decoded.value : null
}

const preserveNumericGidSource = (
  key: string,
  value: unknown,
  context: { readonly source: string }
): unknown => key === "gid" && typeof value === "number" ? context.source : value

export const fetchEhMetadata = async (locator: EhMetadataLocator): Promise<EhMetadataFetchResult> => {
  const url = endpoint()
  if (url === null) return failure("metadata adapter endpoint is not supported")
  const body = requestBody(locator)
  if (body === null) return failure("metadata gallery ID is not a bounded decimal number")

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body
    })
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      return failure(`metadata upstream returned HTTP ${response.status}`, {
        retryable,
        retryAfterMs: response.status === 429 ? retryAfterMilliseconds(response.headers.get("retry-after"), Date.now()) : undefined
      })
    }
    const text = await readBoundedText(response)
    let parsed: unknown
    try {
      parsed = JSON.parse(text, preserveNumericGidSource as Parameters<typeof JSON.parse>[1]) as unknown
    } catch {
      return failure("metadata upstream returned invalid JSON")
    }
    const decoded = decodedResponse(parsed)
    if (decoded === null || decoded.gmetadata.length !== 1) return failure("metadata upstream returned an invalid item set")
    const item = decoded.gmetadata[0]
    if (item.error !== undefined) return failure(`metadata upstream rejected the gallery: ${item.error}`)
    const responseGid = item.gid === undefined
      ? undefined
      : typeof item.gid === "number"
        ? Number.isSafeInteger(item.gid) ? String(item.gid) : undefined
        : item.gid
    if (
      responseGid === undefined ||
      canonicalDecimalGid(responseGid) !== canonicalDecimalGid(locator.gid) ||
      item.token !== locator.token
    ) return failure("metadata upstream identity did not match the gallery")
    if (item.title === undefined || item.title_jpn === undefined || item.tags === undefined) {
      return failure("metadata upstream omitted required gallery fields")
    }
    return { kind: "success", title: item.title, titleJpn: item.title_jpn, tags: item.tags }
  } catch (error) {
    return failure(
      error instanceof Error && error.name === "AbortError" ? "metadata upstream timed out" : "metadata upstream request failed",
      { retryable: true }
    )
  } finally {
    clearTimeout(timeout)
  }
}

export interface EhMetadataSchedulerOptions {
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly minimumIntervalMs?: number
  readonly maxRetries?: number
}

export interface EhMetadataScheduler {
  readonly fetch: (locator: EhMetadataLocator) => Promise<EhMetadataFetchResult>
}

/** Serializes all metadata requests and applies bounded response-driven retry timing. */
export const makeEhMetadataScheduler = (
  fetcher: (locator: EhMetadataLocator) => Promise<EhMetadataFetchResult> = fetchEhMetadata,
  options: EhMetadataSchedulerOptions = {}
): EhMetadataScheduler => {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? delay
  const minimumIntervalMs = options.minimumIntervalMs ?? MIN_REQUEST_INTERVAL_MS
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  let tail = Promise.resolve()
  let lastStartedAt: number | undefined
  let retryNotBefore = 0

  const run = async (locator: EhMetadataLocator): Promise<EhMetadataFetchResult> => {
    for (let attempt = 0; ; attempt += 1) {
      const earliest = Math.max(
        retryNotBefore,
        lastStartedAt === undefined ? now() : lastStartedAt + minimumIntervalMs
      )
      const wait = earliest - now()
      if (wait > 0) {
        if (wait > MAX_INTERACTIVE_WAIT_MS) {
          return failure("metadata refresh deferred until the upstream retry window expires", {
            retryable: true,
            retryAfterMs: wait
          })
        }
        await sleep(wait)
      }
      lastStartedAt = now()
      const result = await fetcher(locator)
      if (result.kind === "success" || !result.retryable) return result

      const retryDelay = result.retryAfterMs
      if (retryDelay !== undefined) {
        const retryUntil = now() + retryDelay
        if (Number.isFinite(retryUntil)) retryNotBefore = Math.max(retryNotBefore, retryUntil)
        // A long server-directed delay is a bounded non-retry outcome for this
        // request, but it still gates later independent requests globally.
        if (retryDelay > MAX_RETRY_DELAY_MS || attempt >= maxRetries) return result
        await sleep(Math.max(0, retryUntil - now()))
      } else {
        if (attempt >= maxRetries) return result
        await sleep(Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** attempt))
      }
    }
  }

  return {
    fetch: (locator) => {
      const current = tail.then(() => run(locator))
      tail = current.then(() => undefined, () => undefined)
      return current
    }
  }
}
