import { constants, type Stats } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import type { ScanFingerprint } from "@henshin/contracts/root"
import type { SourceManifest } from "./SourceManifestAnalysis"

const MAX_READ_BYTES = 1024 * 1024

class FingerprintSourceChanged extends Error {
  constructor() {
    super("source changed while fingerprinting")
  }
}

const statKey = (stats: Stats): string => JSON.stringify({
  dev: stats.dev,
  ino: stats.ino,
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs
})

const hashFile = async (sourcePath: string): Promise<{ readonly digest: Buffer; readonly size: number }> => {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const file = await open(sourcePath, constants.O_RDONLY | noFollow)
  try {
    const before = await file.stat({ bigint: false })
    if (!before.isFile()) throw new FingerprintSourceChanged()
    const digest = createHash("sha256")
    const buffer = Buffer.allocUnsafe(MAX_READ_BYTES)
    let offset = 0
    while (offset < before.size) {
      const result = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
      if (result.bytesRead === 0) throw new FingerprintSourceChanged()
      digest.update(buffer.subarray(0, result.bytesRead))
      offset += result.bytesRead
    }
    const after = await file.stat({ bigint: false })
    if (!after.isFile() || statKey(before) !== statKey(after) || offset !== after.size) {
      throw new FingerprintSourceChanged()
    }
    return { digest: digest.digest(), size: after.size }
  } finally {
    await file.close().catch(() => undefined)
  }
}

const archiveFingerprint = async (sourcePath: string): Promise<ScanFingerprint> => {
  const before = await lstat(sourcePath, { bigint: false })
  if (!before.isFile()) throw new FingerprintSourceChanged()
  const hashed = await hashFile(sourcePath)
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

const directoryFingerprint = async (sourcePath: string, manifest: SourceManifest): Promise<ScanFingerprint> => {
  const before = await lstat(sourcePath, { bigint: false })
  if (!before.isDirectory()) throw new FingerprintSourceChanged()
  const digest = createHash("sha256")
  digest.update("directory-pages-sha256-v1\0", "utf8")
  const pages = [...manifest.pages].sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))
  for (const page of pages) {
    const name = Buffer.from(page.name, "utf8")
    const pagePath = join(sourcePath, page.name)
    const hashed = await hashFile(pagePath)
    writeLength(digest, name.length)
    digest.update(name)
    writeSize(digest, hashed.size)
    digest.update(hashed.digest)
  }
  const after = await lstat(sourcePath, { bigint: false })
  if (!after.isDirectory() || statKey(before) !== statKey(after)) throw new FingerprintSourceChanged()
  return { profile: "directory-pages-sha256-v1", digest: digest.digest("hex") }
}

export const fingerprintSource = async (sourcePath: string, manifest: SourceManifest): Promise<ScanFingerprint> =>
  manifest.sourceKind === "archive"
    ? archiveFingerprint(sourcePath)
    : directoryFingerprint(sourcePath, manifest)
