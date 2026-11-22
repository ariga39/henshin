import { lstat, opendir, realpath } from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path"

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * Development-host native precursor only. It has no server sibling-claim data,
 * so it rejects nonexact aliases instead of claiming full client collision
 * validation. It also does not guarantee safety against hostile concurrent
 * swaps or discover unknown mount/share aliases.
 */

export type NativeBoundaryErrorCode =
  | "invalid-root"
  | "root-unavailable"
  | "root-changed"
  | "invalid-portable-path"
  | "unsupported-name"
  | "directory-limit"
  | "missing-target"
  | "candidate-changed"
  | "source-link"
  | "not-a-directory"
  | "unsupported-candidate"
  | "location-unavailable"
  | "location-overlap"

export interface NativeBoundaryError {
  readonly ok: false
  readonly code: NativeBoundaryErrorCode
  /** Deliberately contains no native path or operating-system error text. */
  readonly message: string
}

export interface NativeBoundarySuccess<T> {
  readonly ok: true
  readonly value: T
}

export type NativeBoundaryResult<T> = NativeBoundarySuccess<T> | NativeBoundaryError

export interface NativeBoundaryLimits {
  readonly maxDirectoryEntries: number
  readonly maxDirectoryNameBytes: number
  readonly maxLogicalPathBytes: number
  readonly maxLogicalSegments: number
  readonly deadlineMs: number
}

export const DEFAULT_NATIVE_BOUNDARY_LIMITS: NativeBoundaryLimits = {
  maxDirectoryEntries: 10_000,
  maxDirectoryNameBytes: 1 * 1024 * 1024,
  maxLogicalPathBytes: 1 * 1024 * 1024,
  maxLogicalSegments: 1_024,
  deadlineMs: 5_000
}

export interface NativeIdentityToken {
  readonly device: string
  readonly inode: string
}

export interface SourceRootObservation {
  /** The operator-selected path, retained only as local configuration. */
  readonly selectedPath: string
  /** The canonical target observed at selection time. */
  readonly canonicalPath: string
  readonly identity: NativeIdentityToken
}

export interface ResolvedSourceCandidate {
  readonly kind: "archive" | "image-directory"
  readonly requestedRelativePath: string
  /** The spelling observed in each native directory entry. */
  readonly observedRelativePath: string
  readonly nativePath: string
  readonly root: SourceRootObservation
}

export type KnownSourceRoot = SourceRootObservation | string

const publicMessages: Record<NativeBoundaryErrorCode, string> = {
  "invalid-root": "the selected location is not a valid local root",
  "root-unavailable": "the selected source root is unavailable",
  "root-changed": "the selected source root changed and requires revalidation",
  "invalid-portable-path": "the logical relative path is invalid",
  "unsupported-name": "the native name cannot be resolved without equivalence assumptions",
  "directory-limit": "the native directory exceeds the validation limit",
  "missing-target": "the requested source candidate is unavailable",
  "candidate-changed": "the source candidate changed during validation",
  "source-link": "source links and redirections are not allowed",
  "not-a-directory": "an intermediate source component is not a directory",
  "unsupported-candidate": "the source candidate is not a supported regular archive or image directory",
  "location-unavailable": "a configured location is unavailable",
  "location-overlap": "configured source and writable locations overlap"
}

const failure = (code: NativeBoundaryErrorCode): NativeBoundaryError => ({
  ok: false,
  code,
  message: publicMessages[code]
})

const success = <T>(value: T): NativeBoundarySuccess<T> => ({ ok: true, value })

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

const isDirectory = (stats: Awaited<ReturnType<typeof lstat>>): boolean => stats.isDirectory()

const identityOf = (stats: Awaited<ReturnType<typeof lstat>>): NativeIdentityToken => ({
  device: String(stats.dev),
  inode: String(stats.ino)
})

const sameIdentity = (left: NativeIdentityToken, right: NativeIdentityToken): boolean =>
  left.device === right.device && left.inode === right.inode

const absoluteLocalPath = (input: string): string | undefined => {
  if (input.length === 0 || input.includes("\u0000") || !isAbsolute(input)) return undefined
  // Configured native paths deliberately reject dot components. Keeping the
  // original path for realpath would also be correct, but rejecting this
  // ambiguous syntax keeps output-parent walking small and avoids silently
  // applying lexical normalization across symlink components.
  if (input.split("/").some((component) => component === "." || component === "..")) return undefined
  return input
}

/** Pure validation. It performs no native filesystem access. */
export const validatePortableRelativePath = (
  input: string
): NativeBoundaryResult<ReadonlyArray<string>> => {
  if (
    input.length === 0 ||
    input.startsWith("/") ||
    input.endsWith("/") ||
    input.includes("\\") ||
    input.includes("\u0000")
  ) return failure("invalid-portable-path")

  const segments = input.split("/")
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    /^[A-Za-z]:/.test(segments[0] as string)
  ) return failure("invalid-portable-path")

  return success(segments)
}

const observeCanonicalRoot = async (
  selectedPath: string
): Promise<NativeBoundaryResult<SourceRootObservation>> => {
  const absolutePath = absoluteLocalPath(selectedPath)
  if (absolutePath === undefined) return failure("invalid-root")

  try {
    const canonicalPath = await realpath(absolutePath)
    const stats = await lstat(canonicalPath, { bigint: true })
    if (!isDirectory(stats)) return failure("invalid-root")
    return success({
      selectedPath: absolutePath,
      canonicalPath,
      identity: identityOf(stats)
    })
  } catch {
    return failure("root-unavailable")
  }
}

/** Selects a root and records the canonical target and native object identity. */
export const selectSourceRoot = async (
  selectedPath: string
): Promise<NativeBoundaryResult<SourceRootObservation>> => observeCanonicalRoot(selectedPath)

export const revalidateSourceRoot = async (
  root: SourceRootObservation,
  context?: OperationContext
): Promise<NativeBoundaryResult<SourceRootObservation>> => {
  if (context !== undefined) {
    const before = checkOperationDeadline(context)
    if (!before.ok) return before
  }
  try {
    const currentCanonicalPath = await realpath(root.selectedPath)
    if (context !== undefined) {
      const afterRealpath = checkOperationDeadline(context)
      if (!afterRealpath.ok) return afterRealpath
    }
    const currentStats = await lstat(currentCanonicalPath, { bigint: true })
    if (context !== undefined) {
      const afterStat = checkOperationDeadline(context)
      if (!afterStat.ok) return afterStat
    }
    const currentIdentity = identityOf(currentStats)
    if (
      !isDirectory(currentStats) ||
      currentCanonicalPath !== root.canonicalPath ||
      !sameIdentity(currentIdentity, root.identity)
    ) return failure("root-changed")
    return success(root)
  } catch {
    return failure("root-unavailable")
  }
}

interface ObservedEntry {
  readonly name: string
  readonly path: string
  readonly stats: Awaited<ReturnType<typeof lstat>>
}

interface OperationContext {
  readonly limits: NativeBoundaryLimits
  readonly deadlineAt: number
}

const mergedLimits = (
  limits: Partial<NativeBoundaryLimits> | undefined
): NativeBoundaryLimits | undefined => {
  const candidate = { ...DEFAULT_NATIVE_BOUNDARY_LIMITS, ...limits }
  return Number.isSafeInteger(candidate.maxDirectoryEntries) &&
    candidate.maxDirectoryEntries > 0 &&
    Number.isSafeInteger(candidate.maxDirectoryNameBytes) &&
    candidate.maxDirectoryNameBytes > 0 &&
    Number.isSafeInteger(candidate.maxLogicalPathBytes) &&
    candidate.maxLogicalPathBytes > 0 &&
    Number.isSafeInteger(candidate.maxLogicalSegments) &&
    candidate.maxLogicalSegments > 0 &&
    Number.isSafeInteger(candidate.deadlineMs) &&
    candidate.deadlineMs > 0
    ? candidate
    : undefined
}

const checkOperationDeadline = (context: OperationContext): NativeBoundaryResult<void> =>
  Date.now() >= context.deadlineAt ? failure("directory-limit") : success(undefined)

/**
 * Enumerates only the current component, using exact observed spelling. The
 * buffer encoding prevents replacement characters from becoming a false name.
 */
const findExactEntry = async (
  parentPath: string,
  requestedName: string,
  context: OperationContext
): Promise<NativeBoundaryResult<ObservedEntry>> => {
  let entryCount = 0
  let nameBytes = 0
  try {
    const directory = await opendir(parentPath, {
      bufferSize: 32,
      encoding: "buffer"
    } as unknown as Parameters<typeof opendir>[1])
    try {
      for await (const dirent of directory) {
        const withinDeadline = checkOperationDeadline(context)
        if (!withinDeadline.ok) return withinDeadline
        entryCount += 1
        if (entryCount > context.limits.maxDirectoryEntries) return failure("directory-limit")

        let name: string
        try {
          const bytes = dirent.name as unknown as Uint8Array
          name = textDecoder.decode(bytes)
        } catch {
          return failure("unsupported-name")
        }
        nameBytes += (dirent.name as unknown as Uint8Array).byteLength
        if (nameBytes > context.limits.maxDirectoryNameBytes) return failure("directory-limit")
        if (name !== requestedName) continue

        const childPath = join(parentPath, name)
        const stats = await lstat(childPath, { bigint: true })
        const afterStat = checkOperationDeadline(context)
        if (!afterStat.ok) return afterStat
        return success({ name, path: childPath, stats })
      }
    } finally {
      try {
        await directory.close()
      } catch {
        // The lookup result is already determined; close failure is not exposed.
      }
    }
  } catch (error) {
    if (isMissing(error)) return failure("missing-target")
    return failure("location-unavailable")
  }

  // A native lookup may succeed for a case/Unicode-equivalent spelling. It is
  // evidence that the name is not simply absent, but it is never used to pick
  // an entry: this precursor supports exact enumeration only.
  const beforeAliasLookup = checkOperationDeadline(context)
  if (!beforeAliasLookup.ok) return beforeAliasLookup
  try {
    await lstat(join(parentPath, requestedName), { bigint: true })
    return failure("unsupported-name")
  } catch (error) {
    return isMissing(error) ? failure("missing-target") : failure("location-unavailable")
  }
}

const archiveExtension = (name: string): boolean => {
  const extension = extname(name).toLowerCase()
  return extension === ".zip" || extension === ".cbz"
}

const containsByComponents = (ancestor: string, descendant: string): boolean => {
  const childPath = relative(ancestor, descendant)
  return childPath === "" || (childPath !== ".." && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath))
}

const verifyFinalCandidate = async (
  root: SourceRootObservation,
  entry: ObservedEntry,
  context: OperationContext
): Promise<NativeBoundaryResult<void>> => {
  const before = checkOperationDeadline(context)
  if (!before.ok) return before
  try {
    const currentEntry = await lstat(entry.path, { bigint: true })
    const afterEntry = checkOperationDeadline(context)
    if (!afterEntry.ok) return afterEntry
    if (currentEntry.isSymbolicLink()) return failure("source-link")
    if (!sameIdentity(identityOf(currentEntry), identityOf(entry.stats))) {
      return failure("candidate-changed")
    }

    const canonicalCandidate = await realpath(entry.path)
    const afterRealpath = checkOperationDeadline(context)
    if (!afterRealpath.ok) return afterRealpath
    if (!containsByComponents(root.canonicalPath, canonicalCandidate)) {
      return failure("source-link")
    }
    const canonicalStats = await lstat(canonicalCandidate, { bigint: true })
    const afterCanonicalStat = checkOperationDeadline(context)
    if (!afterCanonicalStat.ok) return afterCanonicalStat
    if (!sameIdentity(identityOf(currentEntry), identityOf(canonicalStats))) {
      return failure("candidate-changed")
    }
  } catch (error) {
    return isMissing(error) ? failure("candidate-changed") : failure("location-unavailable")
  }
  return success(undefined)
}

export interface ResolveSourceCandidateOptions {
  readonly limits?: Partial<NativeBoundaryLimits>
}

/**
 * Resolves a portable child without following any child symbolic link. This
 * is a validation result only; it creates no directories and writes nothing.
 */
export const resolveSourceCandidate = async (
  root: SourceRootObservation,
  requestedRelativePath: string,
  options?: ResolveSourceCandidateOptions
): Promise<NativeBoundaryResult<ResolvedSourceCandidate>> => {
  const limits = mergedLimits(options?.limits)
  if (limits === undefined) return failure("directory-limit")
  const context: OperationContext = { limits, deadlineAt: Date.now() + limits.deadlineMs }
  const portable = validatePortableRelativePath(requestedRelativePath)
  if (!portable.ok) return portable
  if (
    new TextEncoder().encode(requestedRelativePath).byteLength > limits.maxLogicalPathBytes ||
    portable.value.length > limits.maxLogicalSegments
  ) return failure("directory-limit")

  const currentRoot = await revalidateSourceRoot(root, context)
  if (!currentRoot.ok) return currentRoot

  let parentPath = root.canonicalPath
  const observedSegments: Array<string> = []
  const segments = portable.value

  for (const [index, requestedName] of segments.entries()) {
    const entry = await findExactEntry(parentPath, requestedName, context)
    if (!entry.ok) return entry
    observedSegments.push(entry.value.name)
    if (entry.value.stats.isSymbolicLink()) return failure("source-link")

    const isFinal = index === segments.length - 1
    if (!isFinal) {
      if (!entry.value.stats.isDirectory()) return failure("not-a-directory")
      parentPath = entry.value.path
      continue
    }

    if (entry.value.stats.isDirectory()) {
      const verified = await verifyFinalCandidate(root, entry.value, context)
      if (!verified.ok) return verified
      const rootAfterCandidate = await revalidateSourceRoot(root, context)
      if (!rootAfterCandidate.ok) return rootAfterCandidate
      const completed = checkOperationDeadline(context)
      if (!completed.ok) return completed
      return success({
        kind: "image-directory",
        requestedRelativePath,
        observedRelativePath: observedSegments.join("/"),
        nativePath: entry.value.path,
        root: currentRoot.value
      })
    }
    if (entry.value.stats.isFile() && archiveExtension(entry.value.name)) {
      const verified = await verifyFinalCandidate(root, entry.value, context)
      if (!verified.ok) return verified
      const rootAfterCandidate = await revalidateSourceRoot(root, context)
      if (!rootAfterCandidate.ok) return rootAfterCandidate
      const completed = checkOperationDeadline(context)
      if (!completed.ok) return completed
      return success({
        kind: "archive",
        requestedRelativePath,
        observedRelativePath: observedSegments.join("/"),
        nativePath: entry.value.path,
        root: currentRoot.value
      })
    }
    return failure("unsupported-candidate")
  }

  return failure("unsupported-candidate")
}

export interface SourceDiscoveryLimits extends NativeBoundaryLimits {
  /** Maximum number of directories visited, including the observed root. */
  readonly maxDirectories: number
  /** Maximum number of candidates returned before coverage becomes partial. */
  readonly maxCandidates: number
}

export const DEFAULT_SOURCE_DISCOVERY_LIMITS: SourceDiscoveryLimits = {
  ...DEFAULT_NATIVE_BOUNDARY_LIMITS,
  maxDirectories: 1_024,
  maxCandidates: 64
}

export type SourceDiscoveryIssueCode =
  | "directory-limit"
  | "location-unavailable"
  | "missing-target"
  | "candidate-changed"
  | "unsupported-name"
  | "source-link"

export interface SourceDiscoveryIssue {
  readonly code: SourceDiscoveryIssueCode
  /** Portable location when one could be represented safely. */
  readonly relativePath?: string
}

export interface SourceDiscoveryCandidate {
  readonly kind: "archive" | "image-directory"
  readonly relativePath: string
  readonly directImageCount: number
  readonly unsupportedDirectImageCount: number
}

export interface SourceDiscoveryCoverage {
  readonly status: "complete" | "partial"
  readonly directoriesVisited: number
  readonly entriesObserved: number
  readonly candidateCount: number
  readonly candidateSampleTruncated: boolean
  /** Known links are excluded, not treated as missing content. */
  readonly excludedLinks: ReadonlyArray<string>
  readonly excludedLinkCount: number
  /** Native names that cannot be represented by the portable logical path model. */
  readonly unsupportedNames: ReadonlyArray<string>
  readonly unsupportedNameCount: number
  readonly unsupportedDirectories: ReadonlyArray<string>
  readonly unsupportedDirectoryCount: number
  readonly issues: ReadonlyArray<SourceDiscoveryIssue>
  readonly issueCount: number
}

export interface SourceRootDiscovery {
  readonly root: SourceRootObservation
  readonly candidates: ReadonlyArray<SourceDiscoveryCandidate>
  /** Supported images directly under the configured root have no child entry path. */
  readonly unassignedLooseImages: ReadonlyArray<string>
  readonly unassignedLooseImageCount: number
  readonly unsupportedLooseImages: ReadonlyArray<string>
  readonly unsupportedLooseImageCount: number
  readonly coverage: SourceDiscoveryCoverage
}

export interface DiscoverSourceRootOptions {
  readonly limits?: Partial<SourceDiscoveryLimits>
}

const supportedImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"])
const unsupportedImageExtensions = new Set([
  ".gif",
  ".avif",
  ".bmp",
  ".tif",
  ".tiff",
  ".jxl",
  ".heic",
  ".heif"
])

const sourceDiscoveryLimits = (
  limits: Partial<SourceDiscoveryLimits> | undefined
): SourceDiscoveryLimits | undefined => {
  const candidate = { ...DEFAULT_SOURCE_DISCOVERY_LIMITS, ...limits }
  return Number.isSafeInteger(candidate.maxDirectories) &&
    candidate.maxDirectories > 0 &&
    Number.isSafeInteger(candidate.maxCandidates) &&
    candidate.maxCandidates > 0 &&
    Number.isSafeInteger(candidate.maxDirectoryEntries) &&
    candidate.maxDirectoryEntries > 0 &&
    Number.isSafeInteger(candidate.maxDirectoryNameBytes) &&
    candidate.maxDirectoryNameBytes > 0 &&
    Number.isSafeInteger(candidate.maxLogicalPathBytes) &&
    candidate.maxLogicalPathBytes > 0 &&
    Number.isSafeInteger(candidate.maxLogicalSegments) &&
    candidate.maxLogicalSegments > 0 &&
    Number.isSafeInteger(candidate.deadlineMs) &&
    candidate.deadlineMs > 0
    ? candidate
    : undefined
}

const discoveryNativeLimits = (
  limits: SourceDiscoveryLimits,
  deadlineMs = limits.deadlineMs
): NativeBoundaryLimits => ({
  maxDirectoryEntries: limits.maxDirectoryEntries,
  maxDirectoryNameBytes: limits.maxDirectoryNameBytes,
  maxLogicalPathBytes: limits.maxLogicalPathBytes,
  maxLogicalSegments: limits.maxLogicalSegments,
  deadlineMs
})

const utf8Compare = (left: string, right: string): number => {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index]
  }
  return leftBytes.length - rightBytes.length
}

const sorted = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...values].sort(utf8Compare)

const classifyImageName = (name: string): "supported" | "unsupported" | "other" => {
  const extension = extname(name).toLowerCase()
  if (supportedImageExtensions.has(extension)) return "supported"
  if (unsupportedImageExtensions.has(extension)) return "unsupported"
  return "other"
}

const isArchiveName = (name: string): boolean => {
  const extension = extname(name).toLowerCase()
  return extension === ".zip" || extension === ".cbz"
}

const discoveryIssue = (
  code: SourceDiscoveryIssueCode,
  relativePath?: string
): SourceDiscoveryIssue => (relativePath === undefined ? { code } : { code, relativePath })

const discoveryIssueCode = (code: NativeBoundaryErrorCode): SourceDiscoveryIssueCode => {
  switch (code) {
    case "directory-limit":
    case "missing-target":
    case "candidate-changed":
    case "unsupported-name":
    case "source-link":
    case "location-unavailable":
      return code
    default:
      return "location-unavailable"
  }
}

const DISCOVERY_DIAGNOSTIC_SAMPLE_LIMIT = 32

const appendSample = <T>(sample: Array<T>, value: T): void => {
  if (sample.length < DISCOVERY_DIAGNOSTIC_SAMPLE_LIMIT) sample.push(value)
}

/**
 * Enumerates a trusted source root without reading page or archive payloads.
 * Each image directory reports only its direct images; nested directories are
 * visited as independent candidates. Known links are excluded and never
 * descended, while read/limit failures make coverage explicitly partial.
 */
export const discoverSourceRoot = async (
  root: SourceRootObservation,
  options?: DiscoverSourceRootOptions
): Promise<NativeBoundaryResult<SourceRootDiscovery>> => {
  const limits = sourceDiscoveryLimits(options?.limits)
  if (limits === undefined) return failure("directory-limit")

  const context: OperationContext = {
    limits: discoveryNativeLimits(limits),
    deadlineAt: Date.now() + limits.deadlineMs
  }
  const initialRoot = await revalidateSourceRoot(root, context)
  if (!initialRoot.ok) return initialRoot
  const candidates: Array<SourceDiscoveryCandidate> = []
  const unassignedLooseImages: Array<string> = []
  const unsupportedLooseImages: Array<string> = []
  const unsupportedDirectories: Array<string> = []
  const excludedLinks: Array<string> = []
  const unsupportedNames: Array<string> = []
  const issues: Array<SourceDiscoveryIssue> = []
  let candidateCount = 0
  let unassignedLooseImageCount = 0
  let unsupportedLooseImageCount = 0
  let unsupportedDirectoryCount = 0
  let excludedLinkCount = 0
  let unsupportedNameCount = 0
  let issueCount = 0
  const directories: Array<{
    readonly relativePath: string
    readonly nativePath: string
    readonly identity: NativeIdentityToken
  }> = [
    { relativePath: "", nativePath: initialRoot.value.canonicalPath, identity: initialRoot.value.identity }
  ]
  let directoriesVisited = 0
  let entriesObserved = 0
  let partial = false
  let stopped = false

  const markPartial = (code: SourceDiscoveryIssueCode, relativePath?: string): void => {
    partial = true
    issueCount += 1
    appendSample(issues, discoveryIssue(code, relativePath))
  }

  const remainingNativeLimits = (): NativeBoundaryLimits =>
    discoveryNativeLimits(limits, Math.max(1, context.deadlineAt - Date.now()))

  while (directories.length > 0 && !stopped) {
    const next = directories.shift() as {
      readonly relativePath: string
      readonly nativePath: string
      readonly identity: NativeIdentityToken
    }
    const beforeDirectory = checkOperationDeadline(context)
    if (!beforeDirectory.ok) {
      markPartial("directory-limit", next.relativePath || undefined)
      break
    }
    if (directoriesVisited >= limits.maxDirectories) {
      markPartial("directory-limit", next.relativePath || undefined)
      break
    }
    directoriesVisited += 1

    if (next.relativePath !== "") {
      let queuedStats: Awaited<ReturnType<typeof lstat>>
      try {
        queuedStats = await lstat(next.nativePath, { bigint: true })
      } catch {
        markPartial("candidate-changed", next.relativePath)
        continue
      }
      if (!queuedStats.isDirectory()) {
        markPartial(queuedStats.isSymbolicLink() ? "source-link" : "candidate-changed", next.relativePath)
        if (queuedStats.isSymbolicLink()) {
          excludedLinkCount += 1
          appendSample(excludedLinks, next.relativePath)
        }
        continue
      }
      if (!sameIdentity(identityOf(queuedStats), next.identity)) {
        markPartial("candidate-changed", next.relativePath)
        continue
      }
      const verified = await verifyFinalCandidate(initialRoot.value, {
        name: basename(next.nativePath),
        path: next.nativePath,
        stats: queuedStats
      }, context)
      if (!verified.ok) {
        if (verified.code === "source-link") {
          excludedLinkCount += 1
          appendSample(excludedLinks, next.relativePath)
        }
        markPartial(discoveryIssueCode(verified.code), next.relativePath)
        continue
      }
    }

    let directImageCount = 0
    let unsupportedDirectImageCount = 0
    let directoryComplete = true
    let entryCount = 0
    let nameBytes = 0
    let directory: Awaited<ReturnType<typeof opendir>>
    try {
      directory = await opendir(next.nativePath, {
        bufferSize: 32,
        encoding: "buffer"
      } as unknown as Parameters<typeof opendir>[1])
    } catch {
      markPartial("location-unavailable", next.relativePath || undefined)
      continue
    }

    try {
      for await (const entry of directory) {
        const withinDeadline = checkOperationDeadline(context)
        if (!withinDeadline.ok) {
          markPartial("directory-limit", next.relativePath || undefined)
          directoryComplete = false
          stopped = true
          break
        }
        entryCount += 1
        entriesObserved += 1
        if (entryCount > limits.maxDirectoryEntries) {
          markPartial("directory-limit", next.relativePath || undefined)
          directoryComplete = false
          stopped = true
          break
        }

        let name: string
        try {
          name = textDecoder.decode(entry.name as unknown as Uint8Array)
        } catch {
          markPartial("unsupported-name", next.relativePath || undefined)
          directoryComplete = false
          continue
        }
        nameBytes += (entry.name as unknown as Uint8Array).byteLength
        if (nameBytes > limits.maxDirectoryNameBytes) {
          markPartial("directory-limit", next.relativePath || undefined)
          directoryComplete = false
          stopped = true
          break
        }

        const relativePath = next.relativePath === "" ? name : `${next.relativePath}/${name}`
        const portable = validatePortableRelativePath(relativePath)
        if (!portable.ok || portable.value.length > limits.maxLogicalSegments) {
          unsupportedNameCount += 1
          appendSample(unsupportedNames, relativePath)
          continue
        }
        if (
          new TextEncoder().encode(relativePath).byteLength > limits.maxLogicalPathBytes
        ) {
          markPartial("directory-limit", next.relativePath || undefined)
          directoryComplete = false
          continue
        }

        let stats: Awaited<ReturnType<typeof lstat>>
        try {
          stats = await lstat(join(next.nativePath, name), { bigint: true })
        } catch {
          markPartial("candidate-changed", relativePath)
          directoryComplete = false
          continue
        }
        if (stats.isSymbolicLink()) {
          excludedLinkCount += 1
          appendSample(excludedLinks, relativePath)
          continue
        }

        if (stats.isDirectory()) {
          const resolved = await resolveSourceCandidate(
            initialRoot.value,
            relativePath,
            { limits: remainingNativeLimits() }
          )
          if (!resolved.ok) {
            if (resolved.code === "source-link") {
              excludedLinkCount += 1
              appendSample(excludedLinks, relativePath)
            }
            else markPartial(discoveryIssueCode(resolved.code), relativePath)
            continue
          }
          directories.push({ relativePath, nativePath: resolved.value.nativePath, identity: identityOf(stats) })
          continue
        }

        if (stats.isFile() && isArchiveName(name)) {
          const resolved = await resolveSourceCandidate(
            initialRoot.value,
            relativePath,
            { limits: remainingNativeLimits() }
          )
          if (!resolved.ok) {
            if (resolved.code === "source-link") {
              excludedLinkCount += 1
              appendSample(excludedLinks, relativePath)
            }
            else markPartial(discoveryIssueCode(resolved.code), relativePath)
            continue
          }
          candidateCount += 1
          if (candidates.length >= limits.maxCandidates) {
            markPartial("directory-limit", relativePath)
            stopped = true
            break
          }
          candidates.push({
            kind: "archive",
            relativePath,
            directImageCount: 0,
            unsupportedDirectImageCount: 0
          })
          continue
        }

        if (!stats.isFile()) continue
        const imageKind = classifyImageName(name)
        if (imageKind === "supported") {
          if (next.relativePath === "") {
            unassignedLooseImageCount += 1
            appendSample(unassignedLooseImages, relativePath)
          } else directImageCount += 1
        } else if (imageKind === "unsupported") {
          if (next.relativePath === "") {
            unsupportedLooseImageCount += 1
            appendSample(unsupportedLooseImages, relativePath)
          } else unsupportedDirectImageCount += 1
        }
      }
    } catch {
      markPartial("location-unavailable", next.relativePath || undefined)
      directoryComplete = false
      stopped = true
    } finally {
      try {
        await directory.close()
      } catch {
        // Async iteration closes completed directories; a second close is harmless.
      }
    }

    if (directoryComplete && next.relativePath !== "" && directImageCount > 0) {
      candidateCount += 1
      if (candidates.length >= limits.maxCandidates) {
        markPartial("directory-limit", next.relativePath)
        break
      }
      candidates.push({
        kind: "image-directory",
        relativePath: next.relativePath,
        directImageCount,
        unsupportedDirectImageCount
      })
    } else if (directoryComplete && next.relativePath !== "" && unsupportedDirectImageCount > 0) {
      unsupportedDirectoryCount += 1
      appendSample(unsupportedDirectories, next.relativePath)
    }
  }

  const finalRoot = await revalidateSourceRoot(root, context)
  if (!finalRoot.ok) {
    if (finalRoot.code !== "directory-limit") return finalRoot
    markPartial("directory-limit")
  }

  candidates.sort((left, right) => utf8Compare(left.relativePath, right.relativePath))
  const discovery: SourceRootDiscovery = {
    root: initialRoot.value,
    candidates,
    unassignedLooseImages: sorted(unassignedLooseImages),
    unassignedLooseImageCount,
    unsupportedLooseImages: sorted(unsupportedLooseImages),
    unsupportedLooseImageCount,
    coverage: {
      status: partial || directories.length > 0 ? "partial" : "complete",
      directoriesVisited,
      entriesObserved,
      candidateCount,
      candidateSampleTruncated: candidateCount > candidates.length,
      excludedLinks: sorted(excludedLinks),
      excludedLinkCount,
      unsupportedNames: sorted(unsupportedNames),
      unsupportedNameCount,
      unsupportedDirectories: sorted(unsupportedDirectories),
      unsupportedDirectoryCount,
      issues,
      issueCount
    }
  }
  return success(discovery)
}

interface CanonicalLocation {
  readonly canonicalPath: string
  readonly kind: "source" | "writable"
  readonly identity?: NativeIdentityToken
}

const canonicalizeOutputLocation = async (
  outputPath: string
): Promise<NativeBoundaryResult<CanonicalLocation>> => {
  // This checks the configured output location only; future descendants of a
  // managed output tree require their own publication-time validation.
  const absolutePath = absoluteLocalPath(outputPath)
  if (absolutePath === undefined) return failure("invalid-root")

  let currentPath = absolutePath
  const missingSegments: Array<string> = []
  while (true) {
    let currentStats: Awaited<ReturnType<typeof lstat>>
    try {
      currentStats = await lstat(currentPath, { bigint: true })
    } catch (error) {
      if (!isMissing(error)) return failure("location-unavailable")
      const parentPath = resolve(currentPath, "..")
      if (parentPath === currentPath) return failure("location-unavailable")
      missingSegments.unshift(basename(currentPath))
      currentPath = parentPath
      continue
    }

    // Existing symlinks are canonicalized as known aliases so overlap can be
    // detected; dangling symlinks fail when realpath is attempted below.
    if (missingSegments.length > 0 && !currentStats.isDirectory() && !currentStats.isSymbolicLink()) {
      return failure("location-unavailable")
    }
    let canonicalParent: string
    try {
      canonicalParent = await realpath(currentPath)
    } catch {
      return failure("location-unavailable")
    }
    let canonicalStats: Awaited<ReturnType<typeof lstat>>
    try {
      canonicalStats = await lstat(canonicalParent, { bigint: true })
    } catch {
      return failure("location-unavailable")
    }
    if (!canonicalStats.isDirectory()) return failure("location-unavailable")
    return success({
      canonicalPath: join(canonicalParent, ...missingSegments),
      kind: "writable",
      ...(missingSegments.length === 0 ? { identity: identityOf(canonicalStats) } : {})
    })
  }
}

const locationPath = async (
  location: KnownSourceRoot
): Promise<NativeBoundaryResult<CanonicalLocation>> => {
  if (typeof location === "string") {
    const root = await selectSourceRoot(location)
    return root.ok
      ? success({ canonicalPath: root.value.canonicalPath, kind: "source", identity: root.value.identity })
      : root
  }
  const root = await revalidateSourceRoot(location)
  return root.ok
    ? success({ canonicalPath: root.value.canonicalPath, kind: "source", identity: root.value.identity })
    : root
}

const overlaps = (left: CanonicalLocation, right: CanonicalLocation): boolean =>
  (left.identity !== undefined &&
    right.identity !== undefined &&
    sameIdentity(left.identity, right.identity)) ||
  containsByComponents(left.canonicalPath, right.canonicalPath) ||
  containsByComponents(right.canonicalPath, left.canonicalPath)

export interface LocationSeparationInput {
  readonly sourceRoots: ReadonlyArray<KnownSourceRoot>
  readonly writableLocations: ReadonlyArray<string>
}

/**
 * Canonicalizes all supplied locations, including missing output leaves, and
 * rejects equality/ancestor/descendant overlap in either configuration order.
 */
export const validateLocationSeparation = async (
  input: LocationSeparationInput
): Promise<NativeBoundaryResult<void>> => {
  const locations: Array<CanonicalLocation> = []
  for (const sourceRoot of input.sourceRoots) {
    const location = await locationPath(sourceRoot)
    if (!location.ok) return location
    locations.push(location.value)
  }
  for (const writableLocation of input.writableLocations) {
    const location = await canonicalizeOutputLocation(writableLocation)
    if (!location.ok) return location
    locations.push(location.value)
  }

  for (let leftIndex = 0; leftIndex < locations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < locations.length; rightIndex += 1) {
      if (locations[leftIndex].kind === "writable" && locations[rightIndex].kind === "writable") {
        continue
      }
      if (overlaps(locations[leftIndex], locations[rightIndex])) {
        return failure("location-overlap")
      }
    }
  }
  return success(undefined)
}
