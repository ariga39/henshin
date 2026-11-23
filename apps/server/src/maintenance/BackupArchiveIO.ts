import { createHash } from "node:crypto"
import { open, stat } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import {
  Reader,
  ZipReader,
  type Entry
} from "@zip.js/zip.js"

export const MAX_STATE_BYTES = 512 * 1024 * 1024
export const MAX_CONFIGURATION_BYTES = 4 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 256 * 1024
export const MAX_ARCHIVE_BYTES = MAX_STATE_BYTES + MAX_CONFIGURATION_BYTES + MAX_MANIFEST_BYTES + 16 * 1024 * 1024
export const IO_CHUNK_BYTES = 1024 * 1024

export class BackupArchiveSizeError extends Error {
  constructor() {
    super("backup archive exceeds the size limit")
    this.name = "BackupArchiveSizeError"
  }
}

export class BackupArchiveMemberSizeError extends Error {
  constructor() {
    super("backup archive member exceeds the size limit")
    this.name = "BackupArchiveMemberSizeError"
  }
}

export class BackupFileHandleReader extends Reader<FileHandle> {
  readonly size: number

  constructor(
    private readonly file: FileHandle,
    size: number
  ) {
    super(file)
    this.size = size
  }

  override async init(): Promise<void> {
    return
  }

  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(length) || index < 0 || length < 0) {
      throw new Error("invalid backup archive read range")
    }
    const available = Math.max(0, Math.min(length, this.size - index))
    const output = new Uint8Array(available)
    let offset = 0
    while (offset < available) {
      const result = await this.file.read(output, offset, available - offset, index + offset)
      if (result.bytesRead === 0) throw new Error("backup archive ended before its declared range")
      offset += result.bytesRead
    }
    return output
  }
}

export const inspectBackupArchive = async <A>(
  archivePath: string,
  inspect: (entries: ReadonlyArray<Entry>) => Promise<A>
): Promise<A> => {
  const archiveSize = (await stat(archivePath)).size
  if (archiveSize > MAX_ARCHIVE_BYTES) throw new BackupArchiveSizeError()
  const file = await open(archivePath, "r")
  const reader = new ZipReader(new BackupFileHandleReader(file, archiveSize))
  try {
    return await inspect(await reader.getEntries())
  } finally {
    await reader.close()
    await file.close()
  }
}

export const streamBackupArchiveEntry = async (
  entry: Entry,
  maxBytes: number,
  writeChunk: (chunk: Uint8Array) => Promise<void> | void
): Promise<number> => {
  if (entry.directory) throw new BackupArchiveMemberSizeError()
  let size = 0
  await entry.getData(new WritableStream<Uint8Array>({
    write(chunk) {
      const nextSize = size + chunk.byteLength
      if (nextSize > maxBytes) throw new BackupArchiveMemberSizeError()
      size = nextSize
      return writeChunk(chunk)
    }
  }))
  return size
}

export const readBackupArchiveMember = async (entry: Entry, maxBytes: number): Promise<Uint8Array> => {
  const chunks: Array<Uint8Array> = []
  const size = await streamBackupArchiveEntry(entry, maxBytes, (chunk) => {
    chunks.push(chunk.slice())
  })
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export const digestFile = async (filePath: string, expectedSize: number): Promise<string> => {
  const file = await open(filePath, "r")
  try {
    const hash = createHash("sha256")
    const buffer = new Uint8Array(IO_CHUNK_BYTES)
    let offset = 0
    while (offset < expectedSize) {
      const result = await file.read(buffer, 0, Math.min(buffer.length, expectedSize - offset), offset)
      if (result.bytesRead === 0) throw new Error("backup payload ended before its declared size")
      hash.update(buffer.subarray(0, result.bytesRead))
      offset += result.bytesRead
    }
    if ((await file.stat()).size !== expectedSize) throw new Error("backup payload changed during verification")
    return hash.digest("hex")
  } finally {
    await file.close()
  }
}
