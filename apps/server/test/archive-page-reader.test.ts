import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BlobWriter, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js"
import { afterEach, describe, expect, it } from "vitest"
import { readArchivePages } from "../src/analysis/SourceManifestAnalysis"

const roots: Array<string> = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe("bounded archive page reads", () => {
  it("skips a corrupt selected member and returns a later member", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-archive-pages-"))
    roots.push(root)
    const archive = path.join(root, "book.cbz")
    const writer = new ZipWriter(new BlobWriter("application/zip"))
    await writer.add("001.png", new Uint8ArrayReader(new Uint8Array([1, 2, 3])), { compressionMethod: 0 })
    await writer.add("002.png", new Uint8ArrayReader(new Uint8Array([4, 5, 6])), { compressionMethod: 0 })
    const blob = await writer.close()
    const bytes = Buffer.from(await blob.arrayBuffer())
    const localHeader = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const centralHeader = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    const dataStart = localHeader + 30 + bytes.readUInt16LE(localHeader + 26) + bytes.readUInt16LE(localHeader + 28)
    const compressedSize = bytes.readUInt32LE(centralHeader + 20)
    expect(compressedSize).toBeGreaterThan(0)
    bytes[dataStart] = (bytes[dataStart] ?? 0) ^ 0xff
    await writeFile(archive, bytes)

    const result = await readArchivePages(archive, ["001.png", "002.png"], {
      maxPageBytes: 16 * 1024 * 1024
    })
    expect(result.pages.has("001.png")).toBe(false)
    expect(result.pages.get("002.png")).toEqual(new Uint8Array([4, 5, 6]))
  })

  it("stops before opening an archive when its signal is already cancelled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-archive-pages-cancel-"))
    roots.push(root)
    const controller = new AbortController()
    controller.abort()
    await expect(
      readArchivePages(path.join(root, "missing.cbz"), ["001.png"], { signal: controller.signal })
    ).rejects.toThrow()
  })

  it("consumes members in order and stops after the first successful consumer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-archive-pages-lazy-"))
    roots.push(root)
    const archive = path.join(root, "book.cbz")
    const writer = new ZipWriter(new BlobWriter("application/zip"))
    await writer.add("10.png", new Uint8ArrayReader(new Uint8Array([10])), { compressionMethod: 0 })
    await writer.add("2.png", new Uint8ArrayReader(new Uint8Array([2])), { compressionMethod: 0 })
    await writer.add("3.png", new Uint8ArrayReader(new Uint8Array([3])), { compressionMethod: 0 })
    const blob = await writer.close()
    await writeFile(archive, Buffer.from(await blob.arrayBuffer()))

    const seen: Array<string> = []
    const result = await readArchivePages(archive, ["2.png", "10.png", "3.png"], {
      expectedEntryCount: 3,
      onPage: async (name) => {
        seen.push(name)
        return name === "10.png"
      }
    })
    expect(seen).toEqual(["2.png", "10.png"])
    expect(result.pages.size).toBe(0)
  })
})
