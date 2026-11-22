import { lstat, opendir, realpath } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { extname, isAbsolute, join, relative, sep } from "node:path"
import { Option, Schema } from "effect"
import type { IndexedRootSample, LocalMappingPreview, LocalMappingSample } from "@henshin/contracts"
import { RootRelativePath } from "@henshin/contracts/root"

const MAX_DIRECTORY_ENTRIES = 4_096
const MAX_DIRECTORY_NAME_BYTES = 1_048_576
const MAX_FORMATS = 8
const LOCAL_MAPPING_BUDGET_MS = 5_000
const supportedImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"])

type LocalError = NonNullable<LocalMappingSample["local_error"]>

export class LocalMappingUnavailableError extends Error {
  readonly code = "local_mapping_unavailable"

  constructor() {
    super("the selected local directory could not be inspected")
  }
}

interface Budget {
  readonly deadlineAt: number
  exhausted: boolean
}

interface ResolvedEntry {
  readonly kind: "found"
  readonly path: string
  readonly stats: Awaited<ReturnType<typeof lstat>>
  readonly identity: string
}

type NativeLookup = (
  parentPath: string,
  requestedName: string
) => Promise<Awaited<ReturnType<typeof lstat>>>

type EntryResult =
  | ResolvedEntry
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe" }
  | { readonly kind: "error"; readonly error: LocalError }

interface InspectedSample {
  readonly sample: LocalMappingSample
  readonly physicalIdentity: string | undefined
}

const isWithin = (root: string, candidate: string): boolean => {
  const remainder = relative(root, candidate)
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
}

const formatFor = (name: string): string => extname(name).slice(1).toLowerCase()

const identityOf = (stats: Awaited<ReturnType<typeof lstat>>): string =>
  `${stats.dev.toString()}:${stats.ino.toString()}`

const systemCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined

const errorFromSystem = (error: unknown): LocalError => {
  switch (systemCode(error)) {
    case "EACCES":
    case "EPERM":
      return "permission-denied"
    case "ENAMETOOLONG":
      return "unsupported"
    case "ENOSPC":
      return "unavailable"
    default:
      return "unavailable"
  }
}

const checkBudget = (budget: Budget): boolean => {
  if (Date.now() >= budget.deadlineAt) {
    budget.exhausted = true
    return false
  }
  return true
}

const base = (sample: IndexedRootSample) => ({
  relative_path: sample.relative_path,
  indexed_kind: sample.kind,
  indexed_format_evidence: sample.format_evidence,
  indexed_size_bytes: sample.size_bytes,
  collision_kind: null,
  local_kind: null,
  local_format_evidence: [],
  local_size_bytes: null
})

const missing = (sample: IndexedRootSample): InspectedSample => ({
  sample: { ...base(sample), status: "missing", local_evidence_status: "unavailable", local_error: "missing" },
  physicalIdentity: undefined
})

const unsafe = (sample: IndexedRootSample): InspectedSample => ({
  sample: { ...base(sample), status: "unsafe", local_evidence_status: "unavailable", local_error: "unsafe" },
  physicalIdentity: undefined
})

const unsupported = (sample: IndexedRootSample): InspectedSample => ({
  sample: { ...base(sample), status: "unsupported", local_evidence_status: "unavailable", local_error: "unsupported" },
  physicalIdentity: undefined
})

const errorSample = (sample: IndexedRootSample, error: LocalError): InspectedSample => ({
  sample: { ...base(sample), status: "error", local_evidence_status: "unavailable", local_error: error },
  physicalIdentity: undefined
})

const findExactEntry = async (
  parentPath: string,
  requestedName: string,
  budget: Budget,
  nativeLookup: NativeLookup
): Promise<EntryResult> => {
  if (!checkBudget(budget)) return { kind: "error", error: "budget-exceeded" }
  let observed = 0
  let observedNameBytes = 0
  let exactEntry: Dirent | undefined
  const observedEntries: Array<Dirent> = []
  let directoryLimit = false
  try {
    const directory = await opendir(parentPath)
    for await (const entry of directory) {
      if (!checkBudget(budget)) return { kind: "error", error: "budget-exceeded" }
      if (entry.name === requestedName) {
        exactEntry = entry
        break
      }
      observed += 1
      observedNameBytes += Buffer.byteLength(entry.name)
      if (observed > MAX_DIRECTORY_ENTRIES || observedNameBytes > MAX_DIRECTORY_NAME_BYTES) {
        directoryLimit = true
        break
      }
      observedEntries.push(entry)
    }
  } catch (error) {
    if (systemCode(error) === "ENOENT") return { kind: "missing" }
    return { kind: "error", error: errorFromSystem(error) }
  }
  if (exactEntry !== undefined) {
    const entryPath = join(parentPath, exactEntry.name)
    try {
      const stats = await lstat(entryPath)
      if (stats.isSymbolicLink()) return { kind: "unsafe" }
      return {
        kind: "found",
        path: entryPath,
        stats,
        identity: identityOf(stats)
      }
    } catch (error) {
      return { kind: "error", error: errorFromSystem(error) }
    }
  }
  try {
    const nativePath = join(parentPath, requestedName)
    const stats = await nativeLookup(parentPath, requestedName)
    if (stats.isSymbolicLink()) return { kind: "unsafe" }
    const identity = identityOf(stats)
    let matchingObservedEntry: Dirent | undefined
    for (const entry of observedEntries) {
      if (!checkBudget(budget)) return { kind: "error", error: "budget-exceeded" }
      try {
        const observedStats = await lstat(join(parentPath, entry.name))
        if (identityOf(observedStats) === identity) {
          matchingObservedEntry = entry
          break
        }
      } catch {
        // The native lookup remains the authority if an observed sibling has vanished.
      }
    }
    return {
      kind: "found",
      path: matchingObservedEntry === undefined ? nativePath : join(parentPath, matchingObservedEntry.name),
      stats,
      identity
    }
  } catch (error) {
    if (systemCode(error) === "ENOENT") return directoryLimit ? { kind: "error", error: "directory-limit" } : { kind: "missing" }
    return { kind: "error", error: errorFromSystem(error) }
  }
}

const inspectDirectory = async (
  directoryPath: string,
  budget: Budget
): Promise<{
  readonly formats: ReadonlyArray<string>
  readonly sizeBytes: number | null
  readonly status: "complete" | "partial" | "unavailable"
  readonly error: LocalError | null
}> => {
  const formats = new Set<string>()
  let sizeBytes = 0
  let directory
  try {
    directory = await opendir(directoryPath)
  } catch (error) {
    return { formats: [], sizeBytes: null, status: "unavailable", error: errorFromSystem(error) }
  }
  try {
    for await (const entry of directory) {
      if (!checkBudget(budget)) {
        return { formats: [...formats].slice(0, MAX_FORMATS), sizeBytes: null, status: "partial", error: "budget-exceeded" }
      }
      if (entry.isSymbolicLink() || !entry.isFile()) continue
      const format = formatFor(entry.name)
      if (!supportedImageExtensions.has(`.${format}`)) continue
      try {
        const stats = await lstat(join(directoryPath, entry.name))
        if (stats.isSymbolicLink()) continue
        if (!checkBudget(budget)) {
          return { formats: [...formats].slice(0, MAX_FORMATS), sizeBytes: null, status: "partial", error: "budget-exceeded" }
        }
        formats.add(format)
        sizeBytes += stats.size
      } catch (error) {
        return { formats: [...formats].slice(0, MAX_FORMATS), sizeBytes: null, status: "partial", error: errorFromSystem(error) }
      }
    }
  } catch (error) {
    return { formats: [...formats].slice(0, MAX_FORMATS), sizeBytes: null, status: "partial", error: errorFromSystem(error) }
  }
  if (!checkBudget(budget)) {
    return { formats: [...formats].slice(0, MAX_FORMATS), sizeBytes: null, status: "partial", error: "budget-exceeded" }
  }
  return { formats: [...formats].slice(0, MAX_FORMATS), sizeBytes, status: "complete", error: null }
}

const inspectSample = async (
  canonicalRoot: string,
  sample: IndexedRootSample,
  budget: Budget,
  nativeLookup: NativeLookup
): Promise<InspectedSample> => {
  if (!checkBudget(budget)) return errorSample(sample, "budget-exceeded")
  let currentPath = canonicalRoot
  const segments = sample.relative_path.split("/")
  for (const [index, segment] of segments.entries()) {
    const entry = await findExactEntry(currentPath, segment, budget, nativeLookup)
    switch (entry.kind) {
      case "missing":
        return missing(sample)
      case "unsafe":
        return unsafe(sample)
      case "error":
        return entry.error === "unsupported" ? unsupported(sample) : errorSample(sample, entry.error)
      case "found":
        currentPath = entry.path
        if (index < segments.length - 1 && !entry.stats.isDirectory()) return errorSample(sample, "unavailable")
        break
    }
  }

  if (!checkBudget(budget)) return errorSample(sample, "budget-exceeded")
  let canonicalTarget: string
  try {
    canonicalTarget = await realpath(currentPath)
  } catch (error) {
    return systemCode(error) === "ENOENT" ? missing(sample) : errorSample(sample, errorFromSystem(error))
  }
  if (!isWithin(canonicalRoot, canonicalTarget)) return unsafe(sample)

  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(currentPath)
  } catch (error) {
    return systemCode(error) === "ENOENT" ? missing(sample) : errorSample(sample, errorFromSystem(error))
  }
  if (stats.isSymbolicLink()) return unsafe(sample)
  const physicalIdentity = identityOf(stats)
  if (sample.kind === "archive" && stats.isFile() && [".zip", ".cbz"].includes(extname(currentPath).toLowerCase())) {
    return {
      sample: {
        ...base(sample),
        status: "found",
        local_kind: "archive",
        local_format_evidence: [formatFor(currentPath)],
        local_size_bytes: stats.size,
        local_evidence_status: "complete",
        local_error: null
      },
      physicalIdentity
    }
  }
  if (sample.kind === "image-directory" && stats.isDirectory()) {
    const evidence = await inspectDirectory(currentPath, budget)
    return {
      sample: {
        ...base(sample),
        status: "found",
        local_kind: "image-directory",
        local_format_evidence: evidence.formats,
        local_size_bytes: evidence.sizeBytes,
        local_evidence_status: evidence.status,
        local_error: evidence.error
      },
      physicalIdentity
    }
  }
  return unsupported(sample)
}

export const inspectLocalMapping = async (
  rootId: string,
  selectedPath: string,
  samples: ReadonlyArray<IndexedRootSample>,
  sampleTruncated: boolean,
  nativeLookup: NativeLookup = async (parentPath, requestedName) => lstat(join(parentPath, requestedName))
): Promise<LocalMappingPreview> => {
  for (const sample of samples) {
    if (Option.isNone(Schema.decodeUnknownOption(RootRelativePath)(sample.relative_path))) {
      throw new LocalMappingUnavailableError()
    }
  }
  if (selectedPath.length === 0 || !isAbsolute(selectedPath)) throw new LocalMappingUnavailableError()
  const canonicalRoot = await realpath(selectedPath).catch(() => null)
  if (canonicalRoot === null) throw new LocalMappingUnavailableError()
  const rootStats = await lstat(canonicalRoot).catch(() => null)
  if (rootStats === null || !rootStats.isDirectory()) throw new LocalMappingUnavailableError()

  const budget: Budget = { deadlineAt: Date.now() + LOCAL_MAPPING_BUDGET_MS, exhausted: false }
  const inspected: Array<InspectedSample> = []
  for (const sample of samples) {
    let result: InspectedSample
    try {
      result = await inspectSample(canonicalRoot, sample, budget, nativeLookup)
    } catch (error) {
      result = errorSample(sample, errorFromSystem(error))
    }
    inspected.push(result)
    const currentRoot = await realpath(selectedPath).catch(() => null)
    if (currentRoot !== canonicalRoot) throw new LocalMappingUnavailableError()
  }

  const identities = new Map<string, Array<number>>()
  for (const [index, result] of inspected.entries()) {
    if (result.physicalIdentity === undefined || result.sample.status !== "found") continue
    const group = identities.get(result.physicalIdentity) ?? []
    group.push(index)
    identities.set(result.physicalIdentity, group)
  }
  for (const indexes of identities.values()) {
    if (indexes.length < 2) continue
    for (const index of indexes) {
      const result = inspected[index]
      if (result === undefined) continue
      inspected[index] = {
        ...result,
        sample: { ...result.sample, status: "collision", collision_kind: "physical-identity" }
      }
    }
  }

  return {
    root_id: rootId,
    selected_local_path: selectedPath,
    samples: inspected.map((result) => result.sample),
    sample_limit: 32,
    sample_truncated: sampleTruncated,
    local_budget_exhausted: budget.exhausted
  }
}
