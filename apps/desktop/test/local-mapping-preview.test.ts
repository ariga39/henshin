import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
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
})
