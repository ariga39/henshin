import { link, mkdir, mkdtemp, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { EntryResolution } from "@henshin/contracts"
import type { StoredReaderProfile } from "../src/main/persistence/ReaderProfileStore"
import { resolveAcceptedTarget } from "../src/main/open-target"

const archiveProfile: StoredReaderProfile = {
  profile_id: randomUUID(),
  revision: "1",
  name: "Fixture archive reader",
  launch_mode: "explicit-executable",
  supported_formats: ["archive"],
  target_mode: "archive",
  executable_name: "fixture-reader",
  argument_tokens: ["{target}"],
  executablePath: process.execPath
}

const firstImageProfile: StoredReaderProfile = {
  ...archiveProfile,
  profile_id: randomUUID(),
  supported_formats: ["image-directory"],
  target_mode: "first-image"
}

const archiveResolution = async (
  root: string,
  relativePath: string,
  siblingClaims: EntryResolution["sibling_claims"] = []
): Promise<EntryResolution> => {
  const metadata = await stat(path.join(root, relativePath))
  return {
    entry_id: randomUUID(),
    root_id: randomUUID(),
    relative_path: relativePath,
    kind: "archive",
    decision_version: "2",
    location_revision: "3",
    content_version: "4",
    status: "usable",
    reason: null,
    accepted_observation: {
      kind: "archive",
      bytes: metadata.size,
      mtime_ms: metadata.mtimeMs,
      entry_count: 1,
      observation_token: "fixture"
    },
    first_page: null,
    sibling_claims: siblingClaims,
    sibling_claims_truncated: false,
    sibling_claims_next_cursor: null,
    sibling_claims_revision: "5"
  }
}

const mapping = (root: string, canonicalPath = root) => ({
  selectedPath: root,
  canonicalPath,
  mappingRevision: "1"
})

describe("accepted local target evidence", () => {
  it("rejects a sibling alias that resolves to the same native file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-open-alias-"))
    try {
      const targetPath = path.join(root, "a.cbz")
      const siblingPath = path.join(root, "A.cbz")
      await writeFile(targetPath, "fixture")
      await link(targetPath, siblingPath).catch(async () => {
        await stat(siblingPath)
      })
      const resolution = await archiveResolution(root, "a.cbz", [{
        entry_id: randomUUID(),
        relative_path: "A.cbz"
      }])

      await expect(resolveAcceptedTarget(mapping(root), resolution, archiveProfile)).rejects.toThrow(
        "ambiguous with another entry"
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects a selected mapping root retargeted after activation", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "henshin-open-retarget-"))
    try {
      const firstRoot = path.join(parent, "first")
      const secondRoot = path.join(parent, "second")
      const selectedPath = path.join(parent, "selected")
      await mkdir(firstRoot)
      await mkdir(secondRoot)
      await writeFile(path.join(firstRoot, "fixture.cbz"), "first")
      await writeFile(path.join(secondRoot, "fixture.cbz"), "second")
      await symlink(firstRoot, selectedPath)
      const canonicalPath = await realpath(firstRoot)
      const resolution = await archiveResolution(firstRoot, "fixture.cbz")
      const configured = mapping(selectedPath, canonicalPath)

      await expect(resolveAcceptedTarget(configured, resolution, archiveProfile)).resolves.toBe(
        path.join(canonicalPath, "fixture.cbz")
      )
      await unlink(selectedPath)
      await symlink(secondRoot, selectedPath)
      await expect(resolveAcceptedTarget(configured, resolution, archiveProfile)).rejects.toThrow(
        "configured local mapping root changed"
      )
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it("rejects a first page whose native size differs from the accepted manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-open-first-page-"))
    try {
      const bookPath = path.join(root, "book")
      const pagePath = path.join(bookPath, "001.jpg")
      await mkdir(bookPath)
      await writeFile(pagePath, "actual page")
      const bookMetadata = await stat(bookPath)
      const pageMetadata = await stat(pagePath)
      const resolution: EntryResolution = {
        entry_id: randomUUID(),
        root_id: randomUUID(),
        relative_path: "book",
        kind: "image-directory",
        decision_version: "2",
        location_revision: "3",
        content_version: "4",
        status: "usable",
        reason: null,
        accepted_observation: {
          kind: "directory",
          bytes: 0,
          mtime_ms: bookMetadata.mtimeMs,
          entry_count: 1,
          observation_token: "fixture"
        },
        first_page: {
          name: "001.jpg",
          format: "jpeg",
          declared_bytes: pageMetadata.size + 1
        },
        sibling_claims: [],
        sibling_claims_truncated: false,
        sibling_claims_next_cursor: null,
        sibling_claims_revision: "5"
      }

      await expect(resolveAcceptedTarget(mapping(root), resolution, firstImageProfile)).rejects.toThrow(
        "accepted first page changed"
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
