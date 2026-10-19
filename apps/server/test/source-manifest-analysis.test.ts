import { vi } from "vitest"

const ioInstrumentation = vi.hoisted(() => ({
  enabled: false,
  readBlocked: false,
  readStarted: undefined as (() => void) | undefined,
  releaseRead: undefined as (() => void) | undefined,
  closeCount: 0,
  openedFlags: [] as Array<number | string>,
  writeCount: 0
}))

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  return {
    ...actual,
    open: async (...args: Array<unknown>) => {
      const handle = await (actual.open as (...input: Array<unknown>) => Promise<import("node:fs/promises").FileHandle>)(...args)
      if (!ioInstrumentation.enabled) return handle
      ioInstrumentation.openedFlags.push(args[1] as number | string)
      const read = handle.read.bind(handle)
      const close = handle.close.bind(handle)
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "read") {
            return async (...readArgs: Array<unknown>) => {
              if (!ioInstrumentation.readBlocked) {
                ioInstrumentation.readBlocked = true
                ioInstrumentation.readStarted?.()
                await new Promise<void>((resolve) => {
                  ioInstrumentation.releaseRead = resolve
                })
              }
              return read(...readArgs as Parameters<typeof handle.read>)
            }
          }
          if (property === "close") {
            return async () => {
              ioInstrumentation.closeCount += 1
              return close()
            }
          }
          return Reflect.get(target, property, receiver)
        }
      })
    },
    writeFile: async (...args: Array<unknown>) => {
      if (ioInstrumentation.enabled) ioInstrumentation.writeCount += 1
      return (actual.writeFile as (...input: Array<unknown>) => Promise<void>)(...args)
    }
  }
})

import { constants } from "node:fs"
import { mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  BlobWriter,
  Uint8ArrayReader,
  ZipWriter,
  type ZipWriterAddDataOptions,
  type ZipWriterConstructorOptions
} from "@zip.js/zip.js"
import {
  analyzeSourceManifest,
  ManifestCandidateError,
  type ManifestLimits
} from "../src/analysis/SourceManifestAnalysis"

const temporaryRoots: Array<string> = []

afterEach(async () => {
  ioInstrumentation.enabled = false
  ioInstrumentation.readBlocked = false
  ioInstrumentation.readStarted = undefined
  ioInstrumentation.releaseRead = undefined
  ioInstrumentation.closeCount = 0
  ioInstrumentation.openedFlags.length = 0
  ioInstrumentation.writeCount = 0
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

const makeTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "henshin-source-manifest-"))
  temporaryRoots.push(root)
  return root
}

const pageBytes = new Uint8Array([0, 1, 2, 3, 4])

const makeZip = async (
  path: string,
  entries: ReadonlyArray<{
    readonly name: string
    readonly bytes?: Uint8Array
    readonly options?: ZipWriterAddDataOptions
  }>,
  options?: ZipWriterConstructorOptions
): Promise<Buffer> => {
  const blobWriter = new BlobWriter("application/zip")
  const writer = new ZipWriter(blobWriter, options)
  for (const entry of entries) {
    if (entry.bytes === undefined) await writer.add(entry.name, undefined, entry.options)
    else await writer.add(entry.name, new Uint8ArrayReader(entry.bytes), entry.options)
  }
  const blob = (await writer.close()) as Blob
  const bytes = Buffer.from(await blob.arrayBuffer())
  await writeFile(path, bytes)
  return bytes
}

const crc32 = (bytes: Uint8Array): number => {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
  }
  return (value ^ 0xffffffff) >>> 0
}

const unicodePathExtraBytes = (bytes: Uint8Array): Uint8Array => {
  const extra = Buffer.alloc(5 + bytes.length)
  extra[0] = 1
  extra.writeUInt32LE(crc32(Buffer.from("x.jpg", "ascii")), 1)
  Buffer.from(bytes).copy(extra, 5)
  return extra
}

const unicodePathExtra = (name: string): Uint8Array => unicodePathExtraBytes(Buffer.from(name, "utf8"))

const rewriteZipFilename = async (
  path: string,
  replacement: Uint8Array,
  languageEncodingFlag: boolean
): Promise<void> => {
  const archive = await readFile(path)
  const localSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
  let local = archive.indexOf(localSignature)
  let central = archive.indexOf(centralSignature)
  expect(local).toBeGreaterThanOrEqual(0)
  expect(central).toBeGreaterThanOrEqual(0)
  for (const [offset, isLocal] of [
    [local, true],
    [central, false]
  ] as const) {
    const nameLengthOffset = offset + (isLocal ? 26 : 28)
    const nameOffset = offset + (isLocal ? 30 : 46)
    const nameLength = archive.readUInt16LE(nameLengthOffset)
    expect(nameLength).toBe(replacement.length)
    Buffer.from(replacement).copy(archive, nameOffset)
    if (languageEncodingFlag) {
      const flagsOffset = offset + (isLocal ? 6 : 8)
      archive.writeUInt16LE(archive.readUInt16LE(flagsOffset) | 0x0800, flagsOffset)
    }
  }
  await writeFile(path, archive)
}

const analyze = async (sourcePath: string, options: Partial<ManifestLimits> = {}) =>
  Effect.runPromise(analyzeSourceManifest({ sourcePath, limits: options }))

const candidateError = async (sourcePath: string, options: Partial<ManifestLimits> = {}) => {
  try {
    await analyze(sourcePath, options)
    throw new Error("expected candidate error")
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestCandidateError)
    return error as ManifestCandidateError
  }
}

const inventory = async (root: string): Promise<ReadonlyArray<string>> => {
  const names = await readdir(root)
  const records: Array<string> = []
  for (const name of names.sort()) {
    const path = join(root, name)
    const info = await stat(path)
    records.push(`${name}\u0000${info.size}\u0000${info.mtimeMs}`)
  }
  return records
}

describe("bounded source manifest analysis", () => {
  it("returns a complete direct-image manifest with boundaries and exact names", async () => {
    const root = await makeTempRoot()
    const source = join(root, "direct")
    await (await import("node:fs/promises")).mkdir(source)
    for (const name of [
      "2.jpg",
      "10.jpg",
      "01.jpg",
      "1.jpg",
      "A.jpg",
      "café.jpg",
      "页2.webp",
      "页10.png",
      "ignored.txt"
    ]) await writeFile(join(source, name), pageBytes)
    await (await import("node:fs/promises")).mkdir(join(source, "child"))
    await writeFile(join(source, "child", "not-a-page.jpg"), pageBytes)
    await writeFile(join(source, "nested.zip"), pageBytes)

    const before = await inventory(source)
    const manifest = await analyze(source)
    const after = await inventory(source)

    expect(manifest.sourceKind).toBe("directory")
    expect(manifest.pages.map((page) => page.name)).toEqual([
      "01.jpg",
      "1.jpg",
      "2.jpg",
      "10.jpg",
      "A.jpg",
      "café.jpg",
      "页2.webp",
      "页10.png"
    ])
    expect(manifest.diagnostics).toMatchObject({ supportedPages: 8, unsupportedPages: 0 })
    expect(before).toEqual(after)
  })

  it("streams a ZIP/CBZ listing, preserves backslashes, and ignores nested archives", async () => {
    const root = await makeTempRoot()
    const archive = join(root, "fixture.cbz")
    await makeZip(archive, [
      { name: "book/" },
      { name: "book/10.jpg", bytes: pageBytes },
      { name: "book/2.jpg", bytes: pageBytes },
      { name: "book/01.jpg", bytes: pageBytes },
      { name: "book/页2.webp", bytes: pageBytes },
      { name: "book/页10.png", bytes: pageBytes },
      { name: "book\\part\\case.jpg", bytes: pageBytes },
      { name: "book/A.jpg", bytes: pageBytes },
      { name: "book/a.jpg", bytes: pageBytes },
      { name: "book/a0002.jpg", bytes: pageBytes },
      { name: "book/a2.jpg", bytes: pageBytes },
      { name: "book/a2b.jpg", bytes: pageBytes },
      { name: "book/café.jpg", bytes: pageBytes },
      { name: "book/cafe\u0301.jpg", bytes: pageBytes },
      { name: "book/notes.txt", bytes: pageBytes },
      { name: "book/other.zip", bytes: pageBytes }
    ])

    const manifest = await analyze(archive)
    expect(manifest.pages.map((page) => page.name)).toEqual([
      "book/01.jpg",
      "book/2.jpg",
      "book/10.jpg",
      "book/A.jpg",
      "book/a.jpg",
      "book/a0002.jpg",
      "book/a2.jpg",
      "book/a2b.jpg",
      "book/cafe\u0301.jpg",
      "book/café.jpg",
      "book/页2.webp",
      "book/页10.png",
      "book\\part\\case.jpg"
    ])
    expect(manifest.diagnostics).toMatchObject({
      supportedPages: 13,
      unsupportedPages: 0,
      ignoredEntries: 2,
      directoryRecords: 1
    })
  })

  it("uses zip.js CP437 decoding for legacy names and strict UTF-8 for EFS names", async () => {
    const root = await makeTempRoot()
    const cp437 = join(root, "cp437.zip")
    await makeZip(cp437, [{ name: "x.jpg", bytes: pageBytes }])
    await rewriteZipFilename(cp437, new Uint8Array([0x82, 0x2e, 0x6a, 0x70, 0x67]), false)
    expect((await analyze(cp437)).pages.map((page) => page.name)).toEqual(["é.jpg"])

    const malformed = join(root, "malformed-utf8.zip")
    await makeZip(malformed, [{ name: "x.jpg", bytes: pageBytes }])
    await rewriteZipFilename(malformed, new Uint8Array([0xc3, 0x2e, 0x6a, 0x70, 0x67]), true)
    expect((await candidateError(malformed)).code).toBe("lossy-name-decoding")
  })

  it("accepts a valid maintained Unicode-path extra field without rewriting the name", async () => {
    const root = await makeTempRoot()
    const archive = join(root, "unicode-extra.zip")
    await makeZip(
      archive,
      [{
        name: "x.jpg",
        bytes: pageBytes,
        options: { extraField: new Map([[0x7075, unicodePathExtra("é.jpg")]]) }
      }],
      { useUnicodeFileNames: false }
    )
    expect((await analyze(archive)).pages.map((page) => page.name)).toEqual(["é.jpg"])

    const malformed = join(root, "malformed-unicode-extra.zip")
    await makeZip(
      malformed,
      [{
        name: "x.jpg",
        bytes: pageBytes,
        options: { extraField: new Map([[0x7075, unicodePathExtraBytes(new Uint8Array([0xc3]))]]) }
      }],
      { useUnicodeFileNames: false }
    )
    expect((await candidateError(malformed)).code).toBe("lossy-name-decoding")
  })

  it("rejects mixed supported and recognized unsupported pages without partial success", async () => {
    const root = await makeTempRoot()
    const archive = join(root, "mixed.zip")
    await makeZip(archive, [
      { name: "1.jpg", bytes: pageBytes },
      { name: "2.avif", bytes: pageBytes },
      { name: "3.bmp", bytes: pageBytes },
      { name: "readme.md", bytes: pageBytes }
    ])

    const error = await candidateError(archive)
    expect(error.code).toBe("unsupported-pages")
    expect(error.diagnostics).toMatchObject({ supportedPages: 1, unsupportedPages: 2 })
  })

  it("rejects unsafe names, exact duplicates, encryption, and structural corruption", async () => {
    const root = await makeTempRoot()
    const unsafe = join(root, "unsafe.zip")
    await makeZip(unsafe, [{ name: "../outside.jpg", bytes: pageBytes }])
    expect((await candidateError(unsafe)).code).toBe("unsafe-name")

    const duplicate = join(root, "duplicate.zip")
    const duplicateBytes = await makeZip(duplicate, [
      { name: "a.jpg", bytes: pageBytes },
      { name: "b.jpg", bytes: pageBytes }
    ])
    const firstB = Buffer.from("b.jpg", "utf8")
    const firstA = Buffer.from("a.jpg", "utf8")
    for (let index = 0; index <= duplicateBytes.length - firstB.length; index += 1) {
      if (duplicateBytes.subarray(index, index + firstB.length).equals(firstB)) {
        firstA.copy(duplicateBytes, index)
      }
    }
    await writeFile(duplicate, duplicateBytes)
    expect((await candidateError(duplicate)).code).toBe("duplicate-name")

    const encrypted = join(root, "encrypted.zip")
    await makeZip(encrypted, [{ name: "secret.jpg", bytes: pageBytes }], {
      password: "fixture-password",
      encryptionStrength: 1
    })
    expect((await candidateError(encrypted)).code).toBe("encrypted")

    const corrupt = join(root, "corrupt.zip")
    const corruptBytes = await makeZip(corrupt, [{ name: "1.jpg", bytes: pageBytes }])
    const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06])
    const eocdIndex = corruptBytes.lastIndexOf(eocd)
    expect(eocdIndex).toBeGreaterThanOrEqual(0)
    corruptBytes[eocdIndex] = 0
    await writeFile(corrupt, corruptBytes)
    expect((await candidateError(corrupt)).code).toBe("structural-corruption")
  })

  it("rejects empty, unsupported-only, cancelled, and over-limit candidates", async () => {
    const root = await makeTempRoot()
    const empty = join(root, "empty")
    await (await import("node:fs/promises")).mkdir(empty)
    expect((await candidateError(empty)).code).toBe("zero-pages")

    const unsupported = join(root, "unsupported")
    await (await import("node:fs/promises")).mkdir(unsupported)
    await writeFile(join(unsupported, "only.tiff"), pageBytes)
    expect((await candidateError(unsupported)).code).toBe("unsupported-pages")

    const limited = join(root, "limited")
    await (await import("node:fs/promises")).mkdir(limited)
    await writeFile(join(limited, "1.jpg"), pageBytes)
    await writeFile(join(limited, "2.jpg"), pageBytes)
    expect((await candidateError(limited, { maxPageCount: 1 })).code).toBe("limit-exceeded")
    expect((await candidateError(limited, { maxPageCount: Number.NaN })).code).toBe("limit-exceeded")
    expect((await candidateError(limited, { maxPageCount: Number.POSITIVE_INFINITY })).code).toBe("limit-exceeded")
    expect((await candidateError(limited, { maxPageCount: 1.5 })).code).toBe("limit-exceeded")

    const archive = join(root, "cancelled.zip")
    await makeZip(archive, [{ name: "1.jpg", bytes: pageBytes }])
    expect((await candidateError(archive, { maxCentralDirectoryBytes: 16 })).code).toBe("limit-exceeded")
    const controller = new AbortController()
    controller.abort()
    const cancelled = await (async () => {
      try {
        await Effect.runPromise(analyzeSourceManifest({ sourcePath: archive, signal: controller.signal }))
        throw new Error("expected cancellation")
      } catch (error) {
        return error as ManifestCandidateError
      }
    })()
    expect(cancelled.code).toBe("cancelled")
  })

  it("awaits interrupted archive cleanup before the fiber completes and never opens for writing", async () => {
    const root = await makeTempRoot()
    const archive = join(root, "interrupted.zip")
    await makeZip(archive, [{ name: "1.jpg", bytes: pageBytes }])
    let readStartedResolve!: () => void
    const readStarted = new Promise<void>((resolve) => {
      readStartedResolve = resolve
    })
    ioInstrumentation.enabled = true
    ioInstrumentation.readStarted = readStartedResolve

    const fiber = Effect.runFork(analyzeSourceManifest({ sourcePath: archive }))
    await readStarted

    let interruptionFinished = false
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interruptionFinished = true
    })
    await Promise.resolve()
    expect(interruptionFinished).toBe(false)
    expect(ioInstrumentation.closeCount).toBe(0)

    ioInstrumentation.releaseRead?.()
    await interruption
    expect(interruptionFinished).toBe(true)
    expect(ioInstrumentation.closeCount).toBe(1)
    expect(ioInstrumentation.writeCount).toBe(0)
    expect(ioInstrumentation.openedFlags).toHaveLength(1)
    const flags = ioInstrumentation.openedFlags[0]
    expect(typeof flags).toBe("number")
    expect((flags as number) & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC)).toBe(0)
  })

  it("rejects a source link and detects a direct-source change without claiming stability", async () => {
    const root = await makeTempRoot()
    const source = join(root, "changing")
    await (await import("node:fs/promises")).mkdir(source)
    for (let index = 0; index < 1_500; index += 1) {
      await writeFile(join(source, `${index}.jpg`), pageBytes)
    }
    const change = setTimeout(() => {
      void utimes(source, new Date(), new Date(Date.now() + 2_000))
    }, 0)
    const changed = await candidateError(source)
    clearTimeout(change)
    expect(changed.code).toBe("source-changed")

    const link = join(root, "link")
    await symlink(source, link)
    expect((await candidateError(link)).code).toBe("source-link")
  })

  it("preserves a literal replacement-character directory name and rejects page links as incomplete", async () => {
    const root = await makeTempRoot()
    const source = join(root, "direct-boundaries")
    await (await import("node:fs/promises")).mkdir(source)
    await writeFile(join(source, "\uFFFD.jpg"), pageBytes)
    await writeFile(join(source, "1.jpg"), pageBytes)
    await symlink(join(source, "1.jpg"), join(source, "2.jpg"))
    await symlink(join(source, "1.jpg"), join(source, "sidecar.txt"))
    expect((await candidateError(source)).code).toBe("source-link")
    await (await import("node:fs/promises")).unlink(join(source, "2.jpg"))
    expect((await analyze(source)).pages.map((page) => page.name)).toEqual(["1.jpg", "\uFFFD.jpg"])
  })

  it("does not write source fixtures on success or error", async () => {
    const root = await makeTempRoot()
    const source = join(root, "audited")
    await (await import("node:fs/promises")).mkdir(source)
    await writeFile(join(source, "1.jpg"), pageBytes)
    await writeFile(join(source, "unsupported.heic"), pageBytes)
    const before = await inventory(source)
    await candidateError(source)
    const after = await inventory(source)
    expect(after).toEqual(before)
    expect(await readFile(join(source, "1.jpg"))).toEqual(Buffer.from(pageBytes))
  })
})
