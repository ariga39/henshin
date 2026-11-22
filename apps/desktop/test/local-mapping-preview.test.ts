import { link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { Dirent } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { IndexedRootSample } from "@henshin/contracts"
import {
  inspectLocalMapping,
  isWindowsInvalidSegment,
  localPhysicalIdentity,
  LocalMappingUnavailableError
} from "../src/main/LocalMappingPreview"

const rootId = "11111111-1111-4111-8111-111111111111"

const sample = (relativePath: string): IndexedRootSample => ({
  relative_path: relativePath as IndexedRootSample["relative_path"],
  kind: "archive",
  format_evidence: ["jpeg"],
  size_bytes: 1
})

const imageSample = (relativePath: string): IndexedRootSample => ({
  relative_path: relativePath as IndexedRootSample["relative_path"],
  kind: "image-directory",
  format_evidence: ["jpeg"],
  size_bytes: 1
})

const missingNativePath = async (): Promise<never> => {
  const error = new Error("missing native path") as NodeJS.ErrnoException
  error.code = "ENOENT"
  throw error
}

describe("local mapping preview boundary", () => {
  it("rejects traversal before touching a relative target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-boundary-"))
    try {
      await expect(inspectLocalMapping(rootId, root, [sample("../outside")], false))
        .rejects.toBeInstanceOf(LocalMappingUnavailableError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports a link escape as unsafe without following it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-root-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-outside-"))
    try {
      await writeFile(path.join(outside, "book.cbz"), "source")
      await symlink(outside, path.join(root, "escape"), "dir")
      const result = await inspectLocalMapping(rootId, root, [sample("escape/book.cbz")], false)
      expect(result.samples).toMatchObject([{ relative_path: "escape/book.cbz", status: "unsafe" }])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("keeps exact and missing claims distinct on a case-sensitive volume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-collision-"))
    try {
      await writeFile(path.join(root, "A.cbz"), "case")
      await writeFile(path.join(root, "physical.cbz"), "same")
      await link(path.join(root, "physical.cbz"), path.join(root, "physical-alias.cbz"))
      const caseSensitiveLookup = async (parentPath: string, requestedName: string) =>
        requestedName === "a.cbz" ? missingNativePath() : lstat(path.join(parentPath, requestedName))
      const result = await inspectLocalMapping(rootId, root, [
        sample("A.cbz"),
        sample("a.cbz"),
        sample("physical.cbz"),
        sample("physical-alias.cbz")
      ], false, caseSensitiveLookup)
      expect(result.samples).toMatchObject([
        { relative_path: "A.cbz", status: "found" },
        { relative_path: "a.cbz", status: "missing" },
        { relative_path: "physical.cbz", status: "collision", collision_kind: "physical-identity" },
        { relative_path: "physical-alias.cbz", status: "collision", collision_kind: "physical-identity" }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps an exact single library claim found beside an equivalent local sibling", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-equivalent-sibling-"))
    try {
      await writeFile(path.join(root, "Book.cbz"), "book")
      await writeFile(path.join(root, "book.cbz"), "unrelated local file")
      const result = await inspectLocalMapping(rootId, root, [sample("Book.cbz")], false)
      expect(result.samples).toMatchObject([{ relative_path: "Book.cbz", status: "found" }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not accept an ambiguous native alias without a physical identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-no-identity-"))
    try {
      await writeFile(path.join(root, "book.cbz"), "book")
      const nativeAliasLookup = async (parentPath: string, requestedName: string) => {
        const stats = await lstat(path.join(parentPath, requestedName === "Book.cbz" ? "book.cbz" : requestedName))
        Object.defineProperty(stats, "ino", { value: 0 })
        return stats
      }
      const result = await inspectLocalMapping(rootId, root, [sample("Book.cbz"), sample("book.cbz")], false, nativeAliasLookup)
      expect(result.samples).toMatchObject([
        { relative_path: "Book.cbz", status: "unsupported", local_error: "unsupported" },
        { relative_path: "book.cbz", status: "found" }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("uses lstat metadata instead of unknown directory-entry type flags for image pages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-unknown-dirent-"))
    const isFile = vi.spyOn(Dirent.prototype, "isFile").mockReturnValue(false)
    try {
      const book = path.join(root, "unknown-types")
      await mkdir(book)
      await writeFile(path.join(book, "001.jpg"), "page")
      const result = await inspectLocalMapping(rootId, root, [imageSample("unknown-types")], false)
      expect(result.samples).toMatchObject([{
        status: "found",
        local_evidence_status: "complete",
        local_format_evidence: ["jpeg"],
        local_size_bytes: 4
      }])
    } finally {
      isFile.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("accepts a unique native alias and collides two claims sharing its physical file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-native-alias-"))
    try {
      await writeFile(path.join(root, "book.cbz"), "book")
      const nativeAliasLookup = async (parentPath: string, requestedName: string) =>
        requestedName === "Book.cbz"
          ? lstat(path.join(parentPath, "book.cbz"))
          : lstat(path.join(parentPath, requestedName))
      const aliasResult = await inspectLocalMapping(rootId, root, [sample("Book.cbz")], false, nativeAliasLookup)
      expect(aliasResult.samples).toMatchObject([{ relative_path: "Book.cbz", status: "found" }])

      const claimResult = await inspectLocalMapping(
        rootId,
        root,
        [sample("Book.cbz"), sample("book.cbz")],
        false,
        nativeAliasLookup
      )
      expect(claimResult.samples).toMatchObject([
        { relative_path: "Book.cbz", status: "collision", collision_kind: "physical-identity" },
        { relative_path: "book.cbz", status: "collision", collision_kind: "physical-identity" }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("completes direct-image size evidence for a 100-page directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-large-"))
    try {
      const book = path.join(root, "large-book")
      await mkdir(book)
      for (let index = 0; index < 101; index += 1) {
        await writeFile(path.join(book, `${index.toString().padStart(3, "0")}.jpg`), "page")
      }
      const result = await inspectLocalMapping(rootId, root, [imageSample("large-book")], false)
      expect(result.samples).toMatchObject([{
        status: "found",
        local_evidence_status: "complete",
        local_error: null,
        local_size_bytes: 404
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not let the directory cap hide an exact sample", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-directory-cap-"))
    try {
      await writeFile(path.join(root, "0000-target.cbz"), "target")
      for (let index = 1; index <= 4_096; index += 1) {
        await writeFile(path.join(root, `${index.toString().padStart(4, "0")}-other.cbz`), "other")
      }
      const result = await inspectLocalMapping(rootId, root, [sample("0000-target.cbz")], false)
      expect(result.samples).toMatchObject([{ relative_path: "0000-target.cbz", status: "found" }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("returns partial evidence when the local time budget expires", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-budget-"))
    const now = vi.spyOn(Date, "now")
    let calls = 0
    now.mockImplementation(() => calls++ < 20 ? 0 : 5_001)
    try {
      const book = path.join(root, "slow-book")
      await mkdir(book)
      for (let index = 0; index < 20; index += 1) {
        await writeFile(path.join(book, `${index.toString().padStart(3, "0")}.jpg`), "page")
      }
      const result = await inspectLocalMapping(rootId, root, [imageSample("slow-book")], false)
      expect(result.local_budget_exhausted).toBe(true)
      expect(result.samples).toMatchObject([{
        status: "found",
        local_evidence_status: "partial",
        local_error: "budget-exceeded",
        local_size_bytes: null
      }])
    } finally {
      now.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports an overlong local segment as unsupported", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-long-name-"))
    try {
      const overlongSegment = "a".repeat(300)
      const result = await inspectLocalMapping(rootId, root, [sample(`${overlongSegment}.cbz`)], false)
      expect(result.samples).toMatchObject([{
        status: "unsupported",
        local_error: "unsupported"
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not create a physical collision from an unavailable inode", () => {
    expect(localPhysicalIdentity({ dev: 1, ino: 0 })).toBeUndefined()
    expect(localPhysicalIdentity({ dev: 1, ino: 9 })).toBe("1:9")
  })

  it("recognizes Windows-invalid segments without depending on the host volume", () => {
    expect(isWindowsInvalidSegment("AUX.zip", "win32")).toBe(true)
    expect(isWindowsInvalidSegment("COM¹", "win32")).toBe(true)
    expect(isWindowsInvalidSegment("book:stream.cbz", "win32")).toBe(true)
    expect(isWindowsInvalidSegment("book. ", "win32")).toBe(true)
    expect(isWindowsInvalidSegment("page\n1.zip", "win32")).toBe(true)
    expect(isWindowsInvalidSegment("book.cbz", "win32")).toBe(false)
    expect(isWindowsInvalidSegment("AUX.zip", "darwin")).toBe(false)
  })

  it("isolates a failed sample from other samples in the same bounded check", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-partial-"))
    try {
      await writeFile(path.join(root, "good.cbz"), "good")
      await writeFile(path.join(root, "not-directory"), "not a directory")
      const result = await inspectLocalMapping(rootId, root, [sample("good.cbz"), sample("not-directory/child")], false)
      expect(result.samples).toMatchObject([
        { relative_path: "good.cbz", status: "found" },
        { relative_path: "not-directory/child", status: "error", local_error: "unavailable" }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
