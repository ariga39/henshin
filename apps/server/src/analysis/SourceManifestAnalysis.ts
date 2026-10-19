import { lstat, open, opendir } from "node:fs/promises"
import { constants } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import type { Stats } from "node:fs"
import { basename, extname, join } from "node:path"
import { Effect, Schema } from "effect"
import {
  Reader,
  ZipReader,
  type Entry,
  type ZipReaderConstructorOptions
} from "@zip.js/zip.js"

const textDecoder = new TextDecoder("utf-8", { fatal: true })
const textEncoder = new TextEncoder()

export const MANIFEST_FORMATS = ["jpeg", "png", "webp"] as const
export type ManifestFormat = (typeof MANIFEST_FORMATS)[number]

const UNSUPPORTED_FORMATS = new Set([
  "gif",
  "avif",
  "bmp",
  "tif",
  "tiff",
  "jxl",
  "heic",
  "heif"
])

const SUPPORTED_SUFFIXES = new Map<string, ManifestFormat>([
  [".jpg", "jpeg"],
  [".jpeg", "jpeg"],
  [".png", "png"],
  [".webp", "webp"]
])

export interface ManifestLimits {
  /** Maximum bytes in the source archive itself. */
  readonly maxArchiveBytes: number
  /** Maximum number of direct children or archive records inspected. */
  readonly maxEntryCount: number
  /** Maximum supported pages in the returned manifest. */
  readonly maxPageCount: number
  /** Maximum UTF-8 name plus fixed metadata accounting. */
  readonly maxNameAndMetadataBytes: number
  /** Maximum central-directory/read allocation accepted from the ZIP reader. */
  readonly maxCentralDirectoryBytes: number
  /** Maximum cumulative declared uncompressed bytes in an archive. */
  readonly maxDeclaredUncompressedBytes: number
  /** Maximum declared uncompressed bytes for one archive member. */
  readonly maxMemberUncompressedBytes: number
  /** Cooperative deadline between bounded operations; native filesystem I/O is not hard-preemptible. */
  readonly deadlineMs: number
}

export const DEFAULT_MANIFEST_LIMITS: ManifestLimits = {
  maxArchiveBytes: 4 * 1024 ** 3,
  maxEntryCount: 100_000,
  maxPageCount: 20_000,
  maxNameAndMetadataBytes: 32 * 1024 * 1024,
  maxCentralDirectoryBytes: 64 * 1024 * 1024,
  maxDeclaredUncompressedBytes: 8 * 1024 ** 3,
  maxMemberUncompressedBytes: 1 * 1024 ** 3,
  deadlineMs: 30_000
}

export type ManifestCandidateErrorCode =
  | "unsupported-source"
  | "source-link"
  | "source-changed"
  | "unsafe-name"
  | "lossy-name-decoding"
  | "duplicate-name"
  | "unsupported-pages"
  | "encrypted"
  | "structural-corruption"
  | "zero-pages"
  | "limit-exceeded"
  | "cancelled"
  | "deadline-exceeded"
  | "read-failure"

export interface ManifestDiagnostics {
  readonly supportedPages: number
  readonly unsupportedPages: number
  readonly ignoredEntries: number
  readonly directoryRecords: number
}

export class ManifestCandidateError extends Schema.TaggedError<ManifestCandidateError>()(
  "ManifestCandidateError",
  {
    code: Schema.Literals([
      "unsupported-source",
      "source-link",
      "source-changed",
      "unsafe-name",
      "lossy-name-decoding",
      "duplicate-name",
      "unsupported-pages",
      "encrypted",
      "structural-corruption",
      "zero-pages",
      "limit-exceeded",
      "cancelled",
      "deadline-exceeded",
      "read-failure"
    ]),
    message: Schema.String,
    diagnostics: Schema.Struct({
      supportedPages: Schema.Natural,
      unsupportedPages: Schema.Natural,
      ignoredEntries: Schema.Natural,
      directoryRecords: Schema.Natural
    })
  }
) {}

export interface ManifestPage {
  /** Original direct filename or archive member name; never a native output path. */
  readonly name: string
  readonly format: ManifestFormat
  readonly declaredBytes: number
}

export interface SourceObservation {
  readonly kind: "directory" | "archive"
  readonly bytes: number
  readonly mtimeMs: number
  readonly entryCount: number
}

export interface SourceManifest {
  readonly sourceKind: "directory" | "archive"
  readonly pages: ReadonlyArray<ManifestPage>
  readonly diagnostics: ManifestDiagnostics
  readonly before: SourceObservation
  readonly after: SourceObservation
}

export interface AnalyzeSourceManifestInput {
  /** A single trusted local directory, ZIP, or CBZ path. */
  readonly sourcePath: string
  readonly limits?: Partial<ManifestLimits>
  readonly signal?: AbortSignal
}

interface MutableDiagnostics {
  supportedPages: number
  unsupportedPages: number
  ignoredEntries: number
  directoryRecords: number
}

interface AnalysisContext {
  readonly limits: ManifestLimits
  readonly signal?: AbortSignal
  readonly deadlineAt: number
}

class ProbeInterruption extends Error {
  readonly code: "cancelled" | "deadline-exceeded"

  constructor(code: "cancelled" | "deadline-exceeded") {
    super(code)
    this.name = "ProbeInterruption"
    this.code = code
  }
}

class SourceChanged extends Error {
  constructor() {
    super("source changed during analysis")
    this.name = "SourceChanged"
  }
}

class SourceLink extends Error {
  constructor() {
    super("source is a symbolic link")
    this.name = "SourceLink"
  }
}

class UnsupportedSource extends Error {
  constructor() {
    super("unsupported source")
    this.name = "UnsupportedSource"
  }
}

class UnsafeName extends Error {
  constructor() {
    super("source name is unsafe")
    this.name = "UnsafeName"
  }
}

class LossyName extends Error {
  constructor() {
    super("source name cannot be decoded losslessly")
    this.name = "LossyName"
  }
}

class DuplicateName extends Error {
  constructor() {
    super("source contains an exact duplicate name")
    this.name = "DuplicateName"
  }
}

class LimitExceeded extends Error {
  constructor() {
    super("source exceeds the finite analysis limit")
    this.name = "LimitExceeded"
  }
}

class StructuralCorruption extends Error {
  constructor() {
    super("archive structure is invalid")
    this.name = "StructuralCorruption"
  }
}

class Encrypted extends Error {
  constructor() {
    super("archive content is encrypted")
    this.name = "Encrypted"
  }
}

const ManifestLimitsSchema = Schema.Struct({
  maxArchiveBytes: Schema.Natural,
  maxEntryCount: Schema.Natural,
  maxPageCount: Schema.Natural,
  maxNameAndMetadataBytes: Schema.Natural,
  maxCentralDirectoryBytes: Schema.Natural,
  maxDeclaredUncompressedBytes: Schema.Natural,
  maxMemberUncompressedBytes: Schema.Natural,
  deadlineMs: Schema.Natural
})

const combineLimits = (input: Partial<ManifestLimits> | undefined): ManifestLimits => {
  const candidate = { ...DEFAULT_MANIFEST_LIMITS, ...input }
  try {
    return Schema.decodeUnknownSync(ManifestLimitsSchema)(candidate)
  } catch {
    throw new LimitExceeded()
  }
}

const diagnosticsOf = (diagnostics: MutableDiagnostics): ManifestDiagnostics => ({ ...diagnostics })

const publicMessage = (code: ManifestCandidateErrorCode): string => ({
  "unsupported-source": "source is not a supported local candidate",
  "source-link": "source link or redirection is not allowed",
  "source-changed": "source changed during analysis",
  "unsafe-name": "candidate contains an unsafe member name",
  "lossy-name-decoding": "candidate member names cannot be decoded losslessly",
  "duplicate-name": "candidate contains an exact duplicate member name",
  "unsupported-pages": "candidate contains unsupported pages",
  encrypted: "candidate contains encrypted content",
  "structural-corruption": "candidate archive structure is invalid",
  "zero-pages": "candidate contains zero supported pages",
  "limit-exceeded": "candidate exceeds an analysis limit",
  cancelled: "candidate analysis was cancelled",
  "deadline-exceeded": "candidate analysis exceeded its deadline",
  "read-failure": "candidate could not be read"
})[code]

const errorCode = (error: unknown): ManifestCandidateErrorCode => {
  if (error instanceof ProbeInterruption) return error.code
  if (error instanceof SourceLink) return "source-link"
  if (error instanceof UnsupportedSource) return "unsupported-source"
  if (error instanceof SourceChanged) return "source-changed"
  if (error instanceof UnsafeName) return "unsafe-name"
  if (error instanceof LossyName) return "lossy-name-decoding"
  if (error instanceof DuplicateName) return "duplicate-name"
  if (error instanceof Encrypted) return "encrypted"
  if (error instanceof LimitExceeded) return "limit-exceeded"
  if (error instanceof StructuralCorruption) return "structural-corruption"
  if (error instanceof ManifestCandidateError) return error.code
  return "read-failure"
}

const candidateErrorOf = (error: unknown): ManifestCandidateError => {
  if (error instanceof ManifestCandidateError) return error
  const code = errorCode(error)
  return new ManifestCandidateError({
    code,
    message: publicMessage(code),
    diagnostics: {
      supportedPages: 0,
      unsupportedPages: 0,
      ignoredEntries: 0,
      directoryRecords: 0
    }
  })
}

const checkBudget = (context: AnalysisContext): void => {
  // FileHandle.read itself has no portable hard-abort guarantee. The deadline
  // is therefore enforced before/after bounded native reads and enumeration.
  if (context.signal?.aborted) throw new ProbeInterruption("cancelled")
  if (Date.now() >= context.deadlineAt) throw new ProbeInterruption("deadline-exceeded")
}

const strictUtf8 = (bytes: Uint8Array): string => {
  try {
    return textDecoder.decode(bytes)
  } catch {
    throw new LossyName()
  }
}

const utf8Bytes = (value: string): Uint8Array => textEncoder.encode(value)

const classifyName = (name: string): ManifestFormat | "unsupported" | "ignored" => {
  const extension = extname(name).toLowerCase()
  const supported = SUPPORTED_SUFFIXES.get(extension)
  if (supported !== undefined) return supported
  if (UNSUPPORTED_FORMATS.has(extension.slice(1))) return "unsupported"
  return "ignored"
}

const assertSafeArchiveName = (name: string, directory: boolean): void => {
  if (name.length === 0 || name.includes("\u0000")) throw new UnsafeName()
  const trailingSlash = name.endsWith("/") || name.endsWith("\\")
  if (trailingSlash && !directory) throw new UnsafeName()

  if (
    name.startsWith("/") ||
    name.startsWith("\\") ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new UnsafeName()
  }

  const withoutOneTrailingSlash = trailingSlash ? name.slice(0, -1) : name
  const components = withoutOneTrailingSlash.split(/[\\/]/u)
  if (components.length === 0 || components.some((component) => component.length === 0)) {
    throw new UnsafeName()
  }
  if (components.some((component) => component === "." || component === "..")) {
    throw new UnsafeName()
  }
}

const compareUtf8 = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return left.length - right.length
}

const codePoints = (value: string): ReadonlyArray<number> => Array.from(value, (char) => char.codePointAt(0) as number)

const naturalCompare = (left: string, right: string): number => {
  const leftPoints = codePoints(left)
  const rightPoints = codePoints(right)
  let leftIndex = 0
  let rightIndex = 0

  while (leftIndex < leftPoints.length && rightIndex < rightPoints.length) {
    const leftPoint = leftPoints[leftIndex]
    const rightPoint = rightPoints[rightIndex]
    const leftDigit = leftPoint >= 0x30 && leftPoint <= 0x39
    const rightDigit = rightPoint >= 0x30 && rightPoint <= 0x39

    if (leftDigit && rightDigit) {
      const leftStart = leftIndex
      const rightStart = rightIndex
      while (
        leftIndex < leftPoints.length &&
        leftPoints[leftIndex] >= 0x30 &&
        leftPoints[leftIndex] <= 0x39
      ) leftIndex += 1
      while (
        rightIndex < rightPoints.length &&
        rightPoints[rightIndex] >= 0x30 &&
        rightPoints[rightIndex] <= 0x39
      ) rightIndex += 1

      const leftDigits = leftPoints.slice(leftStart, leftIndex).map((point) => point - 0x30)
      const rightDigits = rightPoints.slice(rightStart, rightIndex).map((point) => point - 0x30)
      const leftNonZero = leftDigits.findIndex((digit) => digit !== 0)
      const rightNonZero = rightDigits.findIndex((digit) => digit !== 0)
      const leftSignificant = leftNonZero < 0 ? [0] : leftDigits.slice(leftNonZero)
      const rightSignificant = rightNonZero < 0 ? [0] : rightDigits.slice(rightNonZero)
      if (leftSignificant.length !== rightSignificant.length) {
        return leftSignificant.length - rightSignificant.length
      }
      for (let index = 0; index < leftSignificant.length; index += 1) {
        if (leftSignificant[index] !== rightSignificant[index]) {
          return leftSignificant[index] - rightSignificant[index]
        }
      }
      continue
    }

    if (leftPoint !== rightPoint) return leftPoint - rightPoint
    leftIndex += 1
    rightIndex += 1
  }

  if (leftIndex === leftPoints.length && rightIndex !== rightPoints.length) return -1
  if (rightIndex === rightPoints.length && leftIndex !== leftPoints.length) return 1
  return compareUtf8(utf8Bytes(left), utf8Bytes(right))
}

const sortPages = (pages: Array<ManifestPage>): void => {
  const names = new Map(pages.map((page) => [page.name, utf8Bytes(page.name)]))
  pages.sort((left, right) => {
    const comparison = naturalCompare(left.name, right.name)
    if (comparison !== 0) return comparison
    return compareUtf8(names.get(left.name) as Uint8Array, names.get(right.name) as Uint8Array)
  })
}

const sameNumber = (left: number, right: number): boolean => Object.is(left, right)

const sameStats = (left: Stats, right: Stats): boolean =>
  sameNumber(left.size, right.size) &&
  sameNumber(left.mtimeMs, right.mtimeMs) &&
  sameNumber(left.ctimeMs, right.ctimeMs) &&
  sameNumber(left.ino, right.ino) &&
  sameNumber(left.dev, right.dev)

const safeStatNumber = (value: number | bigint, limit: number): number => {
  const number = typeof value === "bigint" ? Number(value) : value
  if (!Number.isSafeInteger(number) || number < 0 || number > limit) throw new LimitExceeded()
  return number
}

const observePath = async (path: string, context: AnalysisContext): Promise<Stats> => {
  checkBudget(context)
  const stats = await lstat(path, { bigint: false })
  checkBudget(context)
  return stats
}

const closeQuietly = async (file: FileHandle): Promise<void> => {
  try {
    await file.close()
  } catch {
    // A close after a failed read is best effort; the primary candidate error remains intact.
  }
}

class SourceFileReader extends Reader<FileHandle> {
  private readonly sourceSize: number
  private readonly context: AnalysisContext
  private readonly file: FileHandle
  private readonly maxReadBytes: number

  constructor(file: FileHandle, sourceSize: number, context: AnalysisContext) {
    super(file)
    this.file = file
    this.sourceSize = sourceSize
    this.context = context
    this.maxReadBytes = context.limits.maxCentralDirectoryBytes
    this.size = sourceSize
  }

  override async init(): Promise<void> {
    return
  }

  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    checkBudget(this.context)
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(length) || index < 0 || length < 0) {
      throw new Error("invalid archive read range")
    }
    if (length > this.maxReadBytes) throw new LimitExceeded()
    const available = Math.max(0, Math.min(length, this.sourceSize - index))
    const output = new Uint8Array(available)
    let offset = 0
    while (offset < available) {
      checkBudget(this.context)
      const result = await this.file.read(output, offset, available - offset, index + offset)
      if (result.bytesRead === 0) return output.subarray(0, offset)
      offset += result.bytesRead
    }
    return output
  }
}

const archiveOptions: ZipReaderConstructorOptions = {
  strictness: "strict",
  filenameValidation: "tolerant",
  checkLocalDirectory: true,
  checkLocalFilename: true,
  checkOverlappingEntryOnly: true,
  // zip.js selects UTF-8 for EFS names and otherwise uses its maintained
  // UTF-8/CP437 profile. Do not force every raw filename through UTF-8.
  decodeText: (value, encoding, type) =>
    type === "filename" && encoding.trim().toLowerCase() === "utf-8" ? strictUtf8(value) : undefined
}

const pageFromArchiveEntry = (
  entry: Entry,
  pages: Array<ManifestPage>,
  diagnostics: MutableDiagnostics,
  context: AnalysisContext
): void => {
  const name = entry.filename
  const unicodePath = entry.extraFieldUnicodePath
  if (unicodePath?.valid === true) {
    // zip.js uses a non-fatal decoder for the maintained Unicode Path extra
    // field. Re-check its payload so malformed UTF-8 cannot become U+FFFD.
    const decodedUnicodePath = strictUtf8(unicodePath.data.subarray(5))
    if (decodedUnicodePath !== name || unicodePath.filename !== name) throw new LossyName()
  }
  assertSafeArchiveName(name, entry.directory)

  if (entry.directory) {
    diagnostics.directoryRecords += 1
    return
  }
  const format = classifyName(name)
  if (format === "unsupported") {
    diagnostics.unsupportedPages += 1
    return
  }
  if (format === "ignored") {
    diagnostics.ignoredEntries += 1
    return
  }

  if (entry.encrypted) throw new ManifestCandidateError({
    code: "encrypted",
    message: publicMessage("encrypted"),
    diagnostics: diagnosticsOf(diagnostics)
  })
  if (pages.length >= context.limits.maxPageCount) throw new LimitExceeded()
  pages.push({ name, format, declaredBytes: safeStatNumber(entry.uncompressedSize, context.limits.maxMemberUncompressedBytes) })
  diagnostics.supportedPages += 1
}

const analyzeArchive = async (
  sourcePath: string,
  sourceStats: Stats,
  context: AnalysisContext
): Promise<SourceManifest> => {
  const sourceBytes = safeStatNumber(sourceStats.size, context.limits.maxArchiveBytes)
  const diagnostics: MutableDiagnostics = {
    supportedPages: 0,
    unsupportedPages: 0,
    ignoredEntries: 0,
    directoryRecords: 0
  }
  const pages: Array<ManifestPage> = []
  const names = new Set<string>()
  let file: FileHandle | undefined
  let reader: ZipReader<FileHandle> | undefined
  let completed = false
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
    try {
      file = await open(sourcePath, constants.O_RDONLY | noFollow)
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        String((error as { readonly code: unknown }).code) === "ELOOP"
      ) throw new SourceLink()
      throw error
    }
    const openedStats = await file.stat({ bigint: false })
    if (!openedStats.isFile() || !sameStats(sourceStats, openedStats)) throw new SourceChanged()
    const fileReader = new SourceFileReader(file, sourceBytes, context)
    reader = new ZipReader(fileReader, archiveOptions)
    let entryCount = 0
    let metadataBytes = 0
    let declaredBytes = 0
    for await (const entry of reader.getEntriesGenerator()) {
      checkBudget(context)
      entryCount += 1
      if (entryCount > context.limits.maxEntryCount) throw new LimitExceeded()
      if (
        reader.directoryLength !== undefined &&
        reader.directoryLength > context.limits.maxCentralDirectoryBytes
      ) throw new LimitExceeded()
      const entryMetadataBytes =
        entry.rawFilename.length +
        entry.rawExtraField.length +
        entry.rawComment.length +
        64
      metadataBytes += entryMetadataBytes
      if (metadataBytes > context.limits.maxNameAndMetadataBytes) throw new LimitExceeded()
      const memberBytes = safeStatNumber(entry.uncompressedSize, context.limits.maxMemberUncompressedBytes)
      declaredBytes += memberBytes
      if (declaredBytes > context.limits.maxDeclaredUncompressedBytes) throw new LimitExceeded()
      if (names.has(entry.filename)) throw new DuplicateName()
      names.add(entry.filename)
      if (entry.encrypted) throw new ManifestCandidateError({
        code: "encrypted",
        message: publicMessage("encrypted"),
        diagnostics: diagnosticsOf(diagnostics)
      })
      pageFromArchiveEntry(entry, pages, diagnostics, context)
    }
    if (diagnostics.unsupportedPages > 0 || pages.length === 0) {
      const code = diagnostics.unsupportedPages > 0 ? "unsupported-pages" : "zero-pages"
      throw new ManifestCandidateError({
        code,
        message: publicMessage(code),
        diagnostics: diagnosticsOf(diagnostics)
      })
    }
    sortPages(pages)
    checkBudget(context)
    const afterStats = await observePath(sourcePath, context)
    if (!afterStats.isFile() || !sameStats(sourceStats, afterStats)) throw new SourceChanged()
    completed = true
    return {
      sourceKind: "archive",
      pages,
      diagnostics: diagnosticsOf(diagnostics),
      before: { kind: "archive", bytes: sourceBytes, mtimeMs: sourceStats.mtimeMs, entryCount },
      after: { kind: "archive", bytes: sourceBytes, mtimeMs: afterStats.mtimeMs, entryCount }
    }
  } catch (error) {
    if (
      error instanceof ManifestCandidateError ||
      error instanceof ProbeInterruption ||
      error instanceof SourceChanged ||
      error instanceof UnsafeName ||
      error instanceof LossyName ||
      error instanceof DuplicateName ||
      error instanceof Encrypted ||
      error instanceof LimitExceeded
    ) throw error
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { readonly code: unknown }).code)
        : ""
    const message = error instanceof Error ? error.message.toLowerCase() : ""
    if (code.includes("ENCRYPTED") || message.includes("encrypted")) throw new Encrypted()
    if (
      code.startsWith("ERR_") ||
      message.includes("central directory") ||
      message.includes("end of central") ||
      message.includes("local file header") ||
      message.includes("zip64") ||
      message.includes("archive")
    ) throw new StructuralCorruption()
    throw error
  } finally {
    if (reader !== undefined) {
      try {
        await reader.close()
      } catch {
        // Preserve the candidate error while still attempting to release the reader.
      }
    }
    if (file !== undefined) await closeQuietly(file)
    if (completed) checkBudget(context)
  }
}

interface DirectObservedEntry {
  readonly kind: "file" | "directory" | "link" | "other"
  readonly stats: Stats
}

interface DirectObservation {
  readonly root: Stats
  readonly entries: ReadonlyMap<string, DirectObservedEntry>
  readonly pages: ReadonlyArray<ManifestPage>
  readonly diagnostics: ManifestDiagnostics
}

const readDirectObservation = async (
  sourcePath: string,
  context: AnalysisContext
): Promise<DirectObservation> => {
  const root = await observePath(sourcePath, context)
  if (!root.isDirectory()) throw new Error("source is not a directory")
  const diagnostics: MutableDiagnostics = {
    supportedPages: 0,
    unsupportedPages: 0,
    ignoredEntries: 0,
    directoryRecords: 0
  }
  const pages: Array<ManifestPage> = []
  const entries = new Map<string, DirectObservedEntry>()
  let metadataBytes = 0
  // Node 24 supports buffer-encoded Dirent names, but the current node types
  // do not expose the overload. Keep the cast local to this runtime-proven API.
  const directory = await opendir(sourcePath, {
    bufferSize: 32,
    encoding: "buffer"
  } as unknown as Parameters<typeof opendir>[1])
  try {
    for await (const dirent of directory) {
      checkBudget(context)
      if (entries.size >= context.limits.maxEntryCount) throw new LimitExceeded()
      const name = strictUtf8(dirent.name as unknown as Uint8Array)
      metadataBytes += utf8Bytes(name).byteLength + 64
      if (metadataBytes > context.limits.maxNameAndMetadataBytes) throw new LimitExceeded()
      const childPath = join(sourcePath, name)
      const childStats = await lstat(childPath, { bigint: false })
      checkBudget(context)
      const kind = childStats.isSymbolicLink()
        ? "link"
        : childStats.isFile()
          ? "file"
          : childStats.isDirectory()
            ? "directory"
            : "other"
      entries.set(name, { kind, stats: childStats })
      if (kind === "link" && classifyName(name) !== "ignored") throw new SourceLink()
      if (kind !== "file") continue
      const format = classifyName(name)
      if (format === "unsupported") {
        diagnostics.unsupportedPages += 1
        continue
      }
      if (format === "ignored") {
        diagnostics.ignoredEntries += 1
        continue
      }
      if (pages.length >= context.limits.maxPageCount) throw new LimitExceeded()
      const bytes = safeStatNumber(childStats.size, context.limits.maxMemberUncompressedBytes)
      pages.push({ name, format, declaredBytes: bytes })
      diagnostics.supportedPages += 1
    }
  } finally {
    try {
      await directory.close()
    } catch {
      // Async iteration closes a completed directory; do not replace the candidate result.
    }
  }
  checkBudget(context)
  return { root, entries, pages, diagnostics: diagnosticsOf(diagnostics) }
}

const analyzeDirectory = async (
  sourcePath: string,
  context: AnalysisContext
): Promise<SourceManifest> => {
  const first = await readDirectObservation(sourcePath, context)
  const second = await readDirectObservation(sourcePath, context)
  if (
    !sameStats(first.root, second.root) ||
    first.entries.size !== second.entries.size ||
    Array.from(first.entries).some(([name, entry]) => {
      const other = second.entries.get(name)
      return other === undefined || entry.kind !== other.kind || !sameStats(entry.stats, other.stats)
    })
  ) throw new SourceChanged()
  if (first.diagnostics.unsupportedPages > 0 || first.pages.length === 0) {
    const code = first.diagnostics.unsupportedPages > 0 ? "unsupported-pages" : "zero-pages"
    throw new ManifestCandidateError({
      code,
      message: publicMessage(code),
      diagnostics: first.diagnostics
    })
  }
  const pages = [...first.pages]
  sortPages(pages)
  checkBudget(context)
  return {
    sourceKind: "directory",
    pages,
    diagnostics: first.diagnostics,
    before: { kind: "directory", bytes: 0, mtimeMs: first.root.mtimeMs, entryCount: first.entries.size },
    after: { kind: "directory", bytes: 0, mtimeMs: second.root.mtimeMs, entryCount: second.entries.size }
  }
}

const analyze = async (input: AnalyzeSourceManifestInput): Promise<SourceManifest> => {
  const limits = combineLimits(input.limits)
  const context: AnalysisContext = {
    limits,
    signal: input.signal,
    deadlineAt: Date.now() + limits.deadlineMs
  }
  checkBudget(context)
  const stats = await observePath(input.sourcePath, context)
  if (stats.isSymbolicLink()) throw new SourceLink()
  if (stats.isDirectory()) return analyzeDirectory(input.sourcePath, context)
  if (!stats.isFile()) throw new UnsupportedSource()
  const extension = extname(basename(input.sourcePath)).toLowerCase()
  if (extension !== ".zip" && extension !== ".cbz") throw new UnsupportedSource()
  return analyzeArchive(input.sourcePath, stats, context)
}

export const analyzeSourceManifest = (
  input: AnalyzeSourceManifestInput
): Effect.Effect<SourceManifest, ManifestCandidateError> =>
  Effect.callback((resume, effectSignal) => {
    const signal = input.signal === undefined
      ? effectSignal
      : AbortSignal.any([input.signal, effectSignal])
    const analysis = analyze({ ...input, signal })
    const settled = analysis.then(
      (manifest) => resume(Effect.succeed(manifest)),
      (error) => resume(Effect.fail(candidateErrorOf(error)))
    )
    // Effect interruption aborts the cooperative signal and waits here for
    // analyze() to settle. This closes the ZIP reader and file handle before
    // the interrupted effect is observed, provided native local I/O returns.
    return Effect.promise(() => settled.then(() => undefined, () => undefined))
  })
