import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { IndexedRootSample } from "@henshin/contracts"
import { inspectLocalMapping, LocalMappingUnavailableError } from "../src/main/LocalMappingPreview"

const rootId = "11111111-1111-4111-8111-111111111111"

const sample = (relativePath: string): IndexedRootSample => ({
  relative_path: relativePath as IndexedRootSample["relative_path"],
  kind: "archive",
  format_evidence: ["jpg"],
  size_bytes: 1
})

const imageSample = (relativePath: string): IndexedRootSample => ({
  relative_path: relativePath as IndexedRootSample["relative_path"],
  kind: "image-directory",
  format_evidence: ["jpg"],
  size_bytes: 1
})

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

  it("reports name-equivalent and physical-identity collisions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-collision-"))
    try {
      await writeFile(path.join(root, "case.cbz"), "case")
      await writeFile(path.join(root, "physical.cbz"), "same")
      await link(path.join(root, "physical.cbz"), path.join(root, "physical-alias.cbz"))
      const result = await inspectLocalMapping(rootId, root, [
        sample("Case.cbz"),
        sample("physical.cbz"),
        sample("physical-alias.cbz")
      ], false)
      expect(result.samples).toMatchObject([
        { relative_path: "Case.cbz", status: "collision", collision_kind: "name-equivalence" },
        { relative_path: "physical.cbz", status: "collision", collision_kind: "physical-identity" },
        { relative_path: "physical-alias.cbz", status: "collision", collision_kind: "physical-identity" }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("marks large image-directory evidence partial without presenting a subtotal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-local-mapping-large-"))
    try {
      const book = path.join(root, "large-book")
      await mkdir(book)
      for (let index = 0; index < 65; index += 1) {
        await writeFile(path.join(book, `${index.toString().padStart(3, "0")}.jpg`), "page")
      }
      const result = await inspectLocalMapping(rootId, root, [imageSample("large-book")], false)
      expect(result.samples).toMatchObject([{
        status: "found",
        local_evidence_status: "partial",
        local_error: "directory-limit",
        local_size_bytes: null
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
