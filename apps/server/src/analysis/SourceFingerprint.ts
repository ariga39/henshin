import { constants, type Stats } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import type { ScanFingerprint } from "@henshin/contracts/root"
import { recheckSourceObservation, type SourceManifest } from "./SourceManifestAnalysis"

const MAX_READ_BYTES = 1024 * 1024
export const FINGERPRINT_MAX_BYTES = 4 * 1024 ** 3
export const FINGERPRINT_DEADLINE_MS = 30_000
const FINGERPRINT_MAX_FILES = 20_000

export interface FingerprintOptions {
  readonly signal?: AbortSignal
  readonly maxBytes?: number
  readonly deadlineMs?: number
}

interface FingerprintBudget {
  readonly signal?: AbortSignal
  readonly maxBytes: number
  readonly deadlineAt: number
  bytesRead: number
  filesRead: number
}

class FingerprintSourceChanged extends Error {
  constructor() {
    super("source changed while fingerprinting")
  }
}

class FingerprintLimitExceeded extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FingerprintLimitExceeded"
  }
}

const checkBudget = (budget: FingerprintBudget): void => {
  budget.signal?.throwIfAborted()
  if (Date.now() > budget.deadlineAt) throw new FingerprintLimitExceeded("fingerprint deadline exceeded")
}

const statKey = (stats: Stats): string => JSON.stringify({
  dev: stats.dev,
  ino: stats.ino,
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs
})

const hashFile = async (sourcePath: string, budget: FingerprintBudget): Promise<{ readonly digest: Buffer; readonly size: number }> => {
  checkBudget(budget)
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const file = await open(sourcePath, constants.O_RDONLY | noFollow)
  try {
    checkBudget(budget)
    const before = await file.stat({ bigint: false })
    if (!before.isFile()) throw new FingerprintSourceChanged()
    if (before.size > budget.maxBytes - budget.bytesRead) {
      throw new FingerprintLimitExceeded("fingerprint byte limit exceeded")
    }
    const digest = createHash("sha256")
    const buffer = Buffer.allocUnsafe(MAX_READ_BYTES)
    let offset = 0
    while (offset < before.size) {
      checkBudget(budget)
      const result = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
      if (result.bytesRead === 0) throw new FingerprintSourceChanged()
      digest.update(buffer.subarray(0, result.bytesRead))
      offset += result.bytesRead
      budget.bytesRead += result.bytesRead
    }
    budget.filesRead += 1
    const after = await file.stat({ bigint: false })
    if (!after.isFile() || statKey(before) !== statKey(after) || offset !== after.size) {
      throw new FingerprintSourceChanged()
    }
    return { digest: digest.digest(), size: after.size }
  } finally {
    await file.close().catch(() => undefined)
  }
}

const archiveFingerprint = async (sourcePath: string, manifest: SourceManifest, budget: FingerprintBudget): Promise<ScanFingerprint> => {
  await assertManifestObservation(sourcePath, manifest, budget)
  const before = await lstat(sourcePath, { bigint: false })
  if (!before.isFile()) throw new FingerprintSourceChanged()
  const hashed = await hashFile(sourcePath, budget)
  await assertManifestObservation(sourcePath, manifest, budget)
  const after = await lstat(sourcePath, { bigint: false })
  if (!after.isFile() || statKey(before) !== statKey(after)) throw new FingerprintSourceChanged()
  return { profile: "archive-sha256-v1", digest: hashed.digest.toString("hex") }
}

const writeLength = (hash: ReturnType<typeof createHash>, length: number): void => {
  const encoded = Buffer.allocUnsafe(4)
  encoded.writeUInt32BE(length, 0)
  hash.update(encoded)
}

const writeSize = (hash: ReturnType<typeof createHash>, size: number): void => {
  const encoded = Buffer.allocUnsafe(8)
  encoded.writeBigUInt64BE(BigInt(size), 0)
  hash.update(encoded)
}

const assertManifestObservation = async (
  sourcePath: string,
  manifest: SourceManifest,
  budget: FingerprintBudget
): Promise<void> => {
  checkBudget(budget)
  const remainingMs = Math.max(1, budget.deadlineAt - Date.now())
  const observation = await recheckSourceObservation(sourcePath, manifest.sourceKind, manifest.after.entryCount, {
    signal: budget.signal,
    limits: { deadlineMs: remainingMs }
  })
  if (observation.observationToken !== manifest.after.observationToken) throw new FingerprintSourceChanged()
}

const directoryFingerprint = async (sourcePath: string, manifest: SourceManifest, budget: FingerprintBudget): Promise<ScanFingerprint> => {
  await assertManifestObservation(sourcePath, manifest, budget)
  const before = await lstat(sourcePath, { bigint: false })
  if (!before.isDirectory()) throw new FingerprintSourceChanged()
  const digest = createHash("sha256")
  digest.update("directory-pages-sha256-v1\0", "utf8")
  const pages = [...manifest.pages].sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))
  for (const page of pages) {
    checkBudget(budget)
    if (budget.filesRead >= FINGERPRINT_MAX_FILES) throw new FingerprintLimitExceeded("fingerprint file limit exceeded")
    const name = Buffer.from(page.name, "utf8")
    const pagePath = join(sourcePath, page.name)
    const hashed = await hashFile(pagePath, budget)
    writeLength(digest, name.length)
    digest.update(name)
    writeSize(digest, hashed.size)
    digest.update(hashed.digest)
  }
  await assertManifestObservation(sourcePath, manifest, budget)
  const after = await lstat(sourcePath, { bigint: false })
  if (!after.isDirectory() || statKey(before) !== statKey(after)) throw new FingerprintSourceChanged()
  return { profile: "directory-pages-sha256-v1", digest: digest.digest("hex") }
}

export const fingerprintSource = async (
  sourcePath: string,
  manifest: SourceManifest,
  options: FingerprintOptions = {}
): Promise<ScanFingerprint> => {
  const deadlineMs = options.deadlineMs ?? FINGERPRINT_DEADLINE_MS
  const budget: FingerprintBudget = {
    signal: options.signal,
    maxBytes: options.maxBytes ?? FINGERPRINT_MAX_BYTES,
    deadlineAt: Date.now() + deadlineMs,
    bytesRead: 0,
    filesRead: 0
  }
  return manifest.sourceKind === "archive"
    ? archiveFingerprint(sourcePath, manifest, budget)
    : directoryFingerprint(sourcePath, manifest, budget)
}
