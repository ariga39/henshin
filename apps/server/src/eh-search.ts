import { parseCanonicalEhGalleryUrl } from "./eh-url"
import type { EhCandidateSearchRequest, EhCandidateSearchResult, EhGalleryCandidate } from "@henshin/contracts"

const DEFAULT_SEARCH_URL = "https://e-hentai.org/"
const MAX_RESPONSE_BYTES = 512 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const MIN_START_INTERVAL_MS = 5_000
const DEFAULT_RETRY_AFTER_MS = 30_000
const MAX_RETRY_AFTER_MS = 5 * 60_000

type SearchStatus = "access_failed" | "rate_limited" | "restricted" | "unrecognized_layout"

interface UpstreamSearchResult {
  readonly data: EhCandidateSearchResult
  readonly retryAfterMs: number | null
}

interface SearchJob {
  readonly signal: AbortSignal
  readonly run: (signal: AbortSignal) => Promise<UpstreamSearchResult>
  readonly resolve: (result: EhCandidateSearchResult) => void
  readonly reject: (error: unknown) => void
  readonly deadlineAt: number
  readonly onAbort: () => void
}

const failure = (status: SearchStatus): EhCandidateSearchResult => ({
  status,
  candidates: []
})

const retryAfterMs = (value: string | null): number | null => {
  if (value === null) return null
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000))
  }
  const date = Date.parse(value)
  if (Number.isNaN(date)) return null
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()))
}

class EhSearchScheduler {
  private readonly queue: Array<SearchJob> = []
  private active = false
  private nextStartAt = 0
  private blockedUntil = 0
  private pumpTimer: ReturnType<typeof setTimeout> | undefined

  enqueue(
    run: (signal: AbortSignal) => Promise<UpstreamSearchResult>,
    signal: AbortSignal,
    deadlineAt: number
  ): Promise<EhCandidateSearchResult> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"))
    return new Promise((resolve, reject) => {
      const job: SearchJob = {
        signal,
        run,
        resolve,
        reject,
        deadlineAt,
        onAbort: () => {
          const index = this.queue.indexOf(job)
          if (index !== -1) this.queue.splice(index, 1)
          reject(signal.reason ?? new Error("aborted"))
          this.pump()
        }
      }
      this.queue.push(job)
      signal.addEventListener("abort", job.onAbort, { once: true })
      this.pump()
    })
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return
    while (this.queue[0]?.signal.aborted === true) this.queue.shift()
    const job = this.queue[0]
    if (job === undefined) return
    const now = Date.now()
    const startAt = Math.max(now, this.nextStartAt, this.blockedUntil)
    if (startAt > job.deadlineAt) {
      this.queue.shift()
      job.signal.removeEventListener("abort", job.onAbort)
      job.resolve(failure(this.blockedUntil > job.deadlineAt ? "rate_limited" : "access_failed"))
      this.pump()
      return
    }
    if (startAt > now) {
      if (this.pumpTimer === undefined) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = undefined
          this.pump()
        }, startAt - now)
        this.pumpTimer.unref?.()
      }
      return
    }
    this.queue.shift()
    job.signal.removeEventListener("abort", job.onAbort)
    this.active = true
    this.nextStartAt = now + MIN_START_INTERVAL_MS
    void job.run(job.signal).then((result) => {
      if (result.retryAfterMs !== null) this.blockedUntil = Math.max(this.blockedUntil, Date.now() + result.retryAfterMs)
      job.resolve(result.data)
    }, job.reject).finally(() => {
      this.active = false
      this.pump()
    })
  }
}

const scheduler = new EhSearchScheduler()

const endpoint = (): URL | null => {
  try {
    const value = new URL(process.env.HENSHIN_EH_SEARCH_URL ?? DEFAULT_SEARCH_URL)
    const localHttp = value.protocol === "http:" && (value.hostname === "127.0.0.1" || value.hostname === "localhost")
    return value.protocol === "https:" || localHttp ? value : null
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
      total += next.value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new Error("upstream response exceeded the bounded size")
      chunks.push(next.value)
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

const htmlText = (value: string): string => value
  .replace(/<[^>]+>/gu, " ")
  .replace(/&amp;/gu, "&")
  .replace(/&quot;/gu, '"')
  .replace(/&#39;|&#x27;/giu, "'")
  .replace(/&lt;/gu, "<")
  .replace(/&gt;/gu, ">")
  .replace(/&nbsp;/gu, " ")
  .replace(/\s+/gu, " ")
  .trim()

const attribute = (openingTag: string, name: string): string | null => {
  const match = new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "iu").exec(openingTag)
  return match?.[2] ?? null
}

const classAttribute = (openingTag: string): string => attribute(openingTag, "class") ?? ""

const hasClass = (openingTag: string, className: string): boolean =>
  new RegExp(`(?:^|\\s)${className}(?:\\s|$)`, "u").test(classAttribute(openingTag))

const innerText = (row: string, className: string): string | null => {
  const match = new RegExp(
    `<[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/`,
    "iu"
  ).exec(row)
  return match === null ? null : htmlText(match[1] ?? "")
}

const cellText = (row: string, className: string): string | null => {
  const match = new RegExp(
    `<(td|div)\\b[^>]*\\bclass\\s*=\\s*['\"][^'\"]*\\b${className}\\b[^'\"]*['\"][^>]*>([\\s\\S]*?)</\\1>`,
    "iu"
  ).exec(row)
  return match === null ? null : htmlText(match[2] ?? "")
}

const parseCandidate = (row: string, baseUrl: URL): EhGalleryCandidate | null => {
  const href = [...row.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/giu)]
    .map((match) => match[2])
    .find((candidate) => candidate !== undefined && /\/g\//iu.test(candidate))
  if (href === undefined) return null
  let resolvedHref: string
  try {
    resolvedHref = new URL(href, baseUrl).toString()
  } catch {
    return null
  }
  const parsed = parseCanonicalEhGalleryUrl(resolvedHref)
  const title = innerText(row, "glink")
  if (parsed === null || title === null || title.length === 0) return null
  const language = innerText(row, "glsub")
  const pagesText = innerText(row, "glpage") ?? cellText(row, "gl4c") ?? ""
  const ratingText = innerText(row, "glrating")
  const pageCountMatch = pagesText.match(/(?:^|\s)([0-9][0-9,]*)\s+pages?\b/iu)
  const pageCount = pageCountMatch?.[1] === undefined ? null : Number(pageCountMatch[1].replace(/,/gu, ""))
  const rating = ratingText !== null && /^[0-9]+(?:\.[0-9]+)?$/u.test(ratingText) ? Number(ratingText) : null
  return {
    source: "EH",
    gid: parsed.gid,
    canonical_url: parsed.canonicalUrl,
    title,
    language_evidence: language === null || language.length === 0 ? [] : language.split(/\s*,\s*/u),
    page_count: pageCount,
    rating
  }
}

const parseCandidates = (
  html: string,
  preferredDomain: "e-hentai.org" | "exhentai.org"
): EhCandidateSearchResult => {
  const baseUrl = new URL(`https://${preferredDomain}/`)
  const blocks: string[] = []
  const tablePattern = /(<table\b[^>]*>)([\s\S]*?)<\/table>/giu
  for (const match of html.matchAll(tablePattern)) {
    const openingTag = match[1] ?? ""
    if (!hasClass(openingTag, "itg")) continue
    for (const row of (match[2] ?? "").matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/giu)) blocks.push(row[0] ?? "")
  }
  const tilePattern = /(<div\b[^>]*class\s*=\s*["'][^"']*\bgl1t\b[^"']*["'][^>]*>)([\s\S]*?)(?=<div\b[^>]*class\s*=\s*["'][^"']*\bgl1t\b|$)/giu
  for (const match of html.matchAll(tilePattern)) {
    blocks.push(match[0] ?? "")
  }

  const rows: EhGalleryCandidate[] = []
  const seen = new Set<string>()
  let invalidGalleryRow = false
  for (const row of blocks) {
    const hasGalleryAnchor = /<a\b[^>]*\bhref\s*=\s*["'][^"']*\/g\//iu.test(row)
    if (!hasGalleryAnchor) continue
    const candidate = parseCandidate(row, baseUrl)
    if (candidate === null) {
      invalidGalleryRow = true
      continue
    }
    if (seen.has(candidate.canonical_url)) continue
    seen.add(candidate.canonical_url)
    rows.push(candidate)
  }
  if (rows.length > 0) return { status: "results", candidates: rows.slice(0, 25) }

  const explicitlyEmpty = /(?:no\s+(?:galleries|hits|results)(?:\s+found)?|nothing\s+found)/iu.test(htmlText(html))
  return invalidGalleryRow || !explicitlyEmpty
    ? failure("unrecognized_layout")
    : { status: "empty", candidates: [] }
}

export const searchEhCandidates = async (
  query: EhCandidateSearchRequest,
  signal?: AbortSignal
): Promise<EhCandidateSearchResult> => {
  const url = endpoint()
  if (url === null) return failure("access_failed")
  const search = [query.title.trim(), query.author?.trim(), query.language?.trim()]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" ")
  url.searchParams.set("f_search", search)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const requestSignal = AbortSignal.any([controller.signal, ...(signal === undefined ? [] : [signal])])
    return await scheduler.enqueue(async (scheduledSignal) => {
      const response = await fetch(url, { redirect: "error", signal: scheduledSignal, headers: { accept: "text/html" } })
      const retryAfter = retryAfterMs(response.headers.get("retry-after"))
      if (response.status === 403) return { data: failure("restricted"), retryAfterMs: null }
      if (response.status === 429) return { data: failure("rate_limited"), retryAfterMs: retryAfter ?? DEFAULT_RETRY_AFTER_MS }
      if (!response.ok) return { data: failure("access_failed"), retryAfterMs: retryAfter }
      const preferredDomain = url.hostname.toLowerCase() === "exhentai.org" ? "exhentai.org" : "e-hentai.org"
      return { data: parseCandidates(await readBoundedText(response), preferredDomain), retryAfterMs: null }
    }, requestSignal, Date.now() + REQUEST_TIMEOUT_MS)
  } catch {
    return failure("access_failed")
  } finally {
    signal?.removeEventListener("abort", abort)
    clearTimeout(timeout)
  }
}
