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

const mapping = async (
  root: string,
  canonicalPath = root,
  admittedRootIdentity: string | null | undefined = undefined
) => {
  const resolvedCanonicalPath = await realpath(canonicalPath)
  const identity = admittedRootIdentity === undefined
    ? (async () => {
        const metadata = await stat(resolvedCanonicalPath, { bigint: true })
        return `${metadata.dev}:${metadata.ino}`
      })()
    : Promise.resolve(admittedRootIdentity)
  return identity.then((value) => ({
    selectedPath: root,
    canonicalPath: resolvedCanonicalPath,
    admittedRootIdentity: value,
    mappingRevision: "1"
  }))
}

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

      await expect(resolveAcceptedTarget(await mapping(root), resolution, archiveProfile)).rejects.toThrow(
        "ambiguous with another entry"
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects collisions from equivalent parent spellings", async () => {
    const cases = [
      ["Books/Book.zip", "books/book.zip"],
      ["Café/Book.zip", "Cafe\u0301/book.zip"]
    ] as const
    for (const [targetRelativePath, siblingRelativePath] of cases) {
      const root = await mkdtemp(path.join(os.tmpdir(), "henshin-open-parent-equivalence-"))
      try {
        const targetPath = path.join(root, targetRelativePath)
        const siblingPath = path.join(root, siblingRelativePath)
        await mkdir(path.dirname(targetPath), { recursive: true })
        await mkdir(path.dirname(siblingPath), { recursive: true })
        await writeFile(targetPath, "fixture")
        await link(targetPath, siblingPath).catch(async () => {
          await stat(siblingPath)
        })
        const resolution = await archiveResolution(root, targetRelativePath, [{
          entry_id: randomUUID(),
          relative_path: siblingRelativePath
        }])

        await expect(resolveAcceptedTarget(await mapping(root), resolution, archiveProfile)).rejects.toThrow(
          "ambiguous with another entry"
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
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
      const configured = await mapping(selectedPath, canonicalPath)

      await expect(resolveAcceptedTarget(configured, resolution, archiveProfile)).resolves.toBe(
        path.join(configured.canonicalPath, "fixture.cbz")
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

  it("rejects a canonical root replaced at its admitted path", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "henshin-open-canonical-retarget-"))
    try {
      const canonicalPath = path.join(parent, "canonical")
      const replacementPath = path.join(parent, "replacement")
      const selectedPath = path.join(parent, "selected")
      await mkdir(canonicalPath)
      await mkdir(replacementPath)
      await writeFile(path.join(canonicalPath, "fixture.cbz"), "first")
      await writeFile(path.join(replacementPath, "fixture.cbz"), "second")
      await symlink(canonicalPath, selectedPath)
      const resolution = await archiveResolution(canonicalPath, "fixture.cbz")
      const configured = await mapping(selectedPath, canonicalPath)

      await expect(resolveAcceptedTarget(configured, resolution, archiveProfile)).resolves.toBe(
        path.join(configured.canonicalPath, "fixture.cbz")
      )
      await rm(canonicalPath, { recursive: true, force: true })
      await symlink(replacementPath, canonicalPath)
      await expect(resolveAcceptedTarget(configured, resolution, archiveProfile)).rejects.toThrow(
        "configured local mapping root changed"
      )
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it("fails closed when admitted or current native identity is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-open-identity-"))
    try {
      await writeFile(path.join(root, "fixture.cbz"), "fixture")
      const resolution = await archiveResolution(root, "fixture.cbz")
      for (const identity of [null, "0:123", "123:0"]) {
        await expect(resolveAcceptedTarget(await mapping(root, root, identity), resolution, archiveProfile)).rejects.toThrow(
          "mapping before opening"
        )
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("uses exact decimal bigint identity and skips missing sibling claims", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-open-bigint-identity-"))
    try {
      await writeFile(path.join(root, "fixture.cbz"), "fixture")
      await writeFile(path.join(root, "not-a-directory"), "fixture")
      const rootMetadata = await stat(root, { bigint: true })
      const admittedRootIdentity = `${rootMetadata.dev}:${rootMetadata.ino}`
      expect(admittedRootIdentity).toMatch(/^[1-9][0-9]*:[1-9][0-9]*$/u)
      const resolution = await archiveResolution(root, "fixture.cbz", [{
        entry_id: randomUUID(),
        relative_path: "missing.cbz"
      }, {
        entry_id: randomUUID(),
        relative_path: "not-a-directory/child.cbz"
      }])

      const configured = await mapping(root, root, admittedRootIdentity)
      await expect(resolveAcceptedTarget(configured, resolution, archiveProfile)).resolves.toBe(
        path.join(configured.canonicalPath, "fixture.cbz")
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports an unavailable root instead of a root change for an inaccessible path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-open-unavailable-root-"))
    try {
      const filePath = path.join(root, "not-a-directory")
      await writeFile(filePath, "fixture")
      const resolution = await archiveResolution(root, "not-a-directory")
      const configured = {
        selectedPath: path.join(filePath, "child"),
        canonicalPath: path.join(filePath, "child"),
        admittedRootIdentity: "1:1"
      }

      await expect(resolveAcceptedTarget(configured, resolution, archiveProfile)).rejects.toThrow(
        "mapping root is unavailable"
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === "win32")("rejects Windows-invalid path and page components before access", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-open-native-name-"))
    try {
      await writeFile(path.join(root, "fixture.cbz"), "fixture")
      const configured = await mapping(root)
      const archive = await archiveResolution(root, "fixture.cbz")
      for (const relativePath of ["book/.. ", "book/CON", "book/a:b"]) {
        await expect(resolveAcceptedTarget({ ...configured }, { ...archive, relative_path: relativePath }, archiveProfile)).rejects.toThrow(
          "native-invalid Windows name"
        )
      }

      const firstPageResolution: EntryResolution = {
        ...archive,
        relative_path: "book",
        kind: "image-directory",
        accepted_observation: {
          ...archive.accepted_observation,
          kind: "directory"
        },
        first_page: { name: "page. ", format: "jpeg", declared_bytes: 1 }
      }
      await expect(resolveAcceptedTarget(configured, firstPageResolution, firstImageProfile)).rejects.toThrow(
        "native-invalid Windows name"
      )
    } finally {
      await rm(root, { recursive: true, force: true })
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

      await expect(resolveAcceptedTarget(await mapping(root), resolution, firstImageProfile)).rejects.toThrow(
        "accepted first page changed"
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
