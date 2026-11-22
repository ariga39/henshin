import { lstat, opendir, realpath } from "node:fs/promises"
import { extname, isAbsolute, join, relative, sep } from "node:path"
import { Option, Schema } from "effect"
import type { IndexedRootSample, LocalMappingPreview, LocalMappingSample } from "@henshin/contracts"
import { RootRelativePath } from "@henshin/contracts/root"

const MAX_DIRECT_CHILDREN = 64
const MAX_FORMATS = 8
const supportedImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"])

export class LocalMappingUnavailableError extends Error {
  readonly code = "local_mapping_unavailable"

  constructor() {
    super("the selected local directory could not be inspected")
  }
}

const isWithin = (root: string, candidate: string): boolean => {
  const remainder = relative(root, candidate)
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
}

const formatFor = (name: string): string => extname(name).slice(1).toLowerCase()

const missing = (sample: IndexedRootSample): LocalMappingSample => ({
  relative_path: sample.relative_path,
  indexed_kind: sample.kind,
  indexed_format_evidence: sample.format_evidence,
  indexed_size_bytes: sample.size_bytes,
  status: "missing",
  local_kind: null,
  local_format_evidence: [],
  local_size_bytes: null
})

const unsafe = (sample: IndexedRootSample): LocalMappingSample => ({
  relative_path: sample.relative_path,
  indexed_kind: sample.kind,
  indexed_format_evidence: sample.format_evidence,
  indexed_size_bytes: sample.size_bytes,
  status: "unsafe",
  local_kind: null,
  local_format_evidence: [],
  local_size_bytes: null
})

const unsupported = (sample: IndexedRootSample): LocalMappingSample => ({
  relative_path: sample.relative_path,
  indexed_kind: sample.kind,
  indexed_format_evidence: sample.format_evidence,
  indexed_size_bytes: sample.size_bytes,
  status: "unsupported",
  local_kind: null,
  local_format_evidence: [],
  local_size_bytes: null
})

const inspectDirectory = async (directoryPath: string): Promise<{
  readonly formats: ReadonlyArray<string>
  readonly sizeBytes: number | null
}> => {
  const formats = new Set<string>()
  let sizeBytes = 0
  let observed = 0
  const directory = await opendir(directoryPath)
  for await (const entry of directory) {
    observed += 1
    if (observed > MAX_DIRECT_CHILDREN) {
      return { formats: [], sizeBytes: null }
    }
    if (entry.isSymbolicLink() || !entry.isFile()) continue
    const format = formatFor(entry.name)
    if (!supportedImageExtensions.has(`.${format}`)) continue
    const stats = await lstat(join(directoryPath, entry.name))
    if (stats.isSymbolicLink()) continue
    formats.add(format)
    sizeBytes += stats.size
  }
  return { formats: [...formats].slice(0, MAX_FORMATS), sizeBytes }
}

const inspectSample = async (
  canonicalRoot: string,
  sample: IndexedRootSample
): Promise<LocalMappingSample> => {
  const decoded = Schema.decodeUnknownOption(RootRelativePath)(sample.relative_path)
  if (Option.isNone(decoded)) throw new LocalMappingUnavailableError()

  let currentPath = canonicalRoot
  for (const segment of sample.relative_path.split("/")) {
    const nextPath = join(currentPath, segment)
    try {
      const stats = await lstat(nextPath)
      if (stats.isSymbolicLink()) return unsafe(sample)
      currentPath = nextPath
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return missing(sample)
      }
      return unsupported(sample)
    }
  }

  const canonicalTarget = await realpath(currentPath).catch(() => null)
  if (canonicalTarget === null) return missing(sample)
  if (!isWithin(canonicalRoot, canonicalTarget)) return unsafe(sample)

  const stats = await lstat(currentPath)
  if (stats.isSymbolicLink()) return unsafe(sample)
  if (sample.kind === "archive" && stats.isFile() && [".zip", ".cbz"].includes(extname(currentPath).toLowerCase())) {
    return {
      relative_path: sample.relative_path,
      indexed_kind: sample.kind,
      indexed_format_evidence: sample.format_evidence,
      indexed_size_bytes: sample.size_bytes,
      status: "found",
      local_kind: "archive",
      local_format_evidence: [formatFor(currentPath)],
      local_size_bytes: stats.size
    }
  }
  if (sample.kind === "image-directory" && stats.isDirectory()) {
    const evidence = await inspectDirectory(currentPath)
    return {
      relative_path: sample.relative_path,
      indexed_kind: sample.kind,
      indexed_format_evidence: sample.format_evidence,
      indexed_size_bytes: sample.size_bytes,
      status: "found",
      local_kind: "image-directory",
      local_format_evidence: evidence.formats,
      local_size_bytes: evidence.sizeBytes
    }
  }
  return unsupported(sample)
}

export const inspectLocalMapping = async (
  rootId: string,
  selectedPath: string,
  samples: ReadonlyArray<IndexedRootSample>,
  sampleTruncated: boolean
): Promise<LocalMappingPreview> => {
  if (selectedPath.length === 0 || !isAbsolute(selectedPath)) throw new LocalMappingUnavailableError()
  const canonicalRoot = await realpath(selectedPath).catch(() => null)
  if (canonicalRoot === null) throw new LocalMappingUnavailableError()
  const rootStats = await lstat(canonicalRoot).catch(() => null)
  if (rootStats === null || !rootStats.isDirectory()) throw new LocalMappingUnavailableError()

  const results: Array<LocalMappingSample> = []
  for (const sample of samples) {
    results.push(await inspectSample(canonicalRoot, sample))
    const currentRoot = await realpath(selectedPath).catch(() => null)
    if (currentRoot !== canonicalRoot) throw new LocalMappingUnavailableError()
  }
  return {
    root_id: rootId,
    selected_local_path: selectedPath,
    samples: results,
    sample_limit: 32,
    sample_truncated: sampleTruncated
  }
}
