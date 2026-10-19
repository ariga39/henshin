import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import {
  resolveSourceCandidate,
  selectSourceRoot,
  validateLocationSeparation,
  validatePortableRelativePath,
  type SourceRootObservation
} from "../src/analysis/NativeSourceBoundary"

const temporaryRoots: Array<string> = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

const makeTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "henshin-native-boundary-"))
  temporaryRoots.push(root)
  return root
}

const selectedRoot = async (path: string): Promise<SourceRootObservation> => {
  const result = await selectSourceRoot(path)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error("expected a selected source root")
  return result.value
}

describe("native source boundary precursor", () => {
  it("rejects invalid portable paths before touching the native root", async () => {
    const pureCases = ["", "/book.zip", "book.zip/", "a//b", "a/./b", "a/../b", "a\\b", "C:book.zip", "C:/book.zip", "a\u0000b"]
    for (const input of pureCases) {
      expect(validatePortableRelativePath(input)).toMatchObject({ ok: false, code: "invalid-portable-path" })
    }

    const result = await resolveSourceCandidate(
      {
        selectedPath: "/does-not-exist/native-root",
        canonicalPath: "/does-not-exist/native-root",
        identity: { device: "0", inode: "0" }
      },
      "../outside.zip"
    )
    expect(result).toMatchObject({ ok: false, code: "invalid-portable-path" })

    const bounded = await resolveSourceCandidate(
      {
        selectedPath: "/does-not-exist/native-root",
        canonicalPath: "/does-not-exist/native-root",
        identity: { device: "0", inode: "0" }
      },
      "a/b.zip",
      { limits: { maxLogicalSegments: 1, deadlineMs: Number.NaN } }
    )
    expect(bounded).toMatchObject({ ok: false, code: "directory-limit" })
  })

  it("resolves exact Unicode and literal metacharacter names without rewriting them", async () => {
    const root = await makeTempRoot()
    const sourceRoot = join(root, "Collection")
    await mkdir(sourceRoot)
    const archiveName = "100% [vol]! café.zip"
    await writeFile(join(sourceRoot, archiveName), Buffer.from("archive-fixture"))
    const imageDirectoryName = "图书 [1]"
    await mkdir(join(sourceRoot, imageDirectoryName))
    await writeFile(join(sourceRoot, imageDirectoryName, "page 1!.jpg"), Buffer.from("image-fixture"))

    const observation = await selectedRoot(sourceRoot)
    const archive = await resolveSourceCandidate(observation, archiveName)
    expect(archive).toMatchObject({
      ok: true,
      value: {
        kind: "archive",
        requestedRelativePath: archiveName,
        observedRelativePath: archiveName,
        nativePath: join(observation.canonicalPath, archiveName)
      }
    })
    const directory = await resolveSourceCandidate(observation, imageDirectoryName)
    expect(directory).toMatchObject({
      ok: true,
      value: {
        kind: "image-directory",
        observedRelativePath: imageDirectoryName
      }
    })
  })

  it("preserves a leading BOM in an exact native filename", async () => {
    const root = await makeTempRoot()
    const sourceRoot = join(root, "collection")
    await mkdir(sourceRoot)
    const archiveName = "\uFEFFbook.zip"
    await writeFile(join(sourceRoot, archiveName), Buffer.from("archive-fixture"))

    const observation = await selectedRoot(sourceRoot)
    await expect(resolveSourceCandidate(observation, archiveName)).resolves.toMatchObject({
      ok: true,
      value: {
        requestedRelativePath: archiveName,
        observedRelativePath: archiveName,
        nativePath: join(observation.canonicalPath, archiveName)
      }
    })
  })

  it("accepts a root symlink, records its target, and rejects retargeting", async () => {
    const root = await makeTempRoot()
    const targetA = join(root, "target-a")
    const targetB = join(root, "target-b")
    const selected = join(root, "selected-root")
    await mkdir(targetA)
    await mkdir(targetB)
    await writeFile(join(targetA, "book.zip"), Buffer.from("a"))
    await writeFile(join(targetB, "book.zip"), Buffer.from("b"))
    await symlink(targetA, selected)

    const observation = await selectedRoot(selected)
    expect(observation.canonicalPath).toBe(await realpath(targetA))
    expect((await resolveSourceCandidate(observation, "book.zip")).ok).toBe(true)

    await unlink(selected)
    await symlink(targetB, selected)
    const changed = await resolveSourceCandidate(observation, "book.zip")
    expect(changed).toMatchObject({ ok: false, code: "root-changed" })
  })

  it("rejects configured dot components instead of lexically reinterpreting symlink traversal", async () => {
    const root = await makeTempRoot()
    const lexicalTarget = join(root, "a", "root")
    const nativeTarget = join(root, "b", "root")
    await mkdir(lexicalTarget, { recursive: true })
    await mkdir(nativeTarget, { recursive: true })
    await mkdir(join(root, "b", "child"))
    await symlink(join(root, "b", "child"), join(root, "a", "link"))

    const selected = await selectSourceRoot(`${root}/a/link/../root`)
    expect(selected).toMatchObject({ ok: false, code: "invalid-root" })
    expect(selected).not.toMatchObject({ ok: true, value: { canonicalPath: lexicalTarget } })
  })

  it("does not follow intermediate, final, or dangling child links", async () => {
    const root = await makeTempRoot()
    const sourceRoot = join(root, "collection")
    const linkedDirectory = join(root, "linked-directory")
    await mkdir(sourceRoot)
    await mkdir(linkedDirectory)
    await writeFile(join(linkedDirectory, "book.zip"), Buffer.from("archive"))
    await writeFile(join(sourceRoot, "real.zip"), Buffer.from("archive"))
    await symlink(linkedDirectory, join(sourceRoot, "linked"))
    await symlink(join(sourceRoot, "real.zip"), join(sourceRoot, "alias.zip"))
    await symlink(join(sourceRoot, "missing.zip"), join(sourceRoot, "dangling.zip"))

    const observation = await selectedRoot(sourceRoot)
    for (const path of ["linked/book.zip", "alias.zip", "dangling.zip"]) {
      const result = await resolveSourceCandidate(observation, path)
      expect(result).toMatchObject({ ok: false, code: "source-link" })
    }
  })

  it("rejects nonexact native aliases instead of guessing case or Unicode equivalence", async () => {
    const root = await makeTempRoot()
    const sourceRoot = join(root, "collection")
    await mkdir(sourceRoot)
    await writeFile(join(sourceRoot, "Case.zip"), Buffer.from("archive"))

    const observation = await selectedRoot(sourceRoot)
    const result = await resolveSourceCandidate(observation, "case.zip")
    expect(result).toMatchObject({ ok: false, code: "unsupported-name" })
    if (!result.ok) expect(result.message).not.toContain(root)
  })

  it("checks source/output overlap in both setup orders, including aliases and missing output leaves", async () => {
    const root = await makeTempRoot()
    const collection = join(root, "books")
    const application = join(root, "application")
    const nestedSource = join(application, "source")
    await mkdir(collection)
    await mkdir(application)
    await mkdir(nestedSource)

    const sourceFirst = await validateLocationSeparation({
      sourceRoots: [collection],
      writableLocations: [join(collection, "new", "cache")]
    })
    expect(sourceFirst).toMatchObject({ ok: false, code: "location-overlap" })

    const outputFirst = await validateLocationSeparation({
      sourceRoots: [nestedSource],
      writableLocations: [application]
    })
    expect(outputFirst).toMatchObject({ ok: false, code: "location-overlap" })

    const alias = join(root, "application-alias")
    await symlink(collection, alias)
    const knownAlias = await validateLocationSeparation({
      sourceRoots: [collection],
      writableLocations: [alias]
    })
    expect(knownAlias).toMatchObject({ ok: false, code: "location-overlap" })

    const danglingOutput = join(root, "dangling-output")
    await symlink(join(collection, "removed-target"), danglingOutput)
    const dangling = await validateLocationSeparation({
      sourceRoots: [collection],
      writableLocations: [danglingOutput]
    })
    expect(dangling).toMatchObject({ ok: false, code: "location-unavailable" })

    const fileParent = join(root, "file-parent")
    await writeFile(fileParent, Buffer.from("not-a-directory"))
    const fileAsParent = await validateLocationSeparation({
      sourceRoots: [collection],
      writableLocations: [join(fileParent, "child")]
    })
    expect(fileAsParent).toMatchObject({ ok: false, code: "location-unavailable" })

    const nestedWritableLocations = await validateLocationSeparation({
      sourceRoots: [collection],
      writableLocations: [application, join(application, "cache")]
    })
    expect(nestedWritableLocations).toMatchObject({ ok: true })

    await access(application)
    await expect(access(join(collection, "new"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("allows sibling-prefix locations and canonicalizes a nonexistent output parent without creating it", async () => {
    const root = await makeTempRoot()
    const books = join(root, "books")
    const books2 = join(root, "books2")
    await mkdir(books)
    await mkdir(books2)
    const result = await validateLocationSeparation({
      sourceRoots: [books],
      writableLocations: [join(books2, "new", "cache")]
    })
    expect(result).toMatchObject({ ok: true })
    await expect(access(join(books2, "new"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("uses identity rather than mutable directory timestamps for ordinary collection edits", async () => {
    const root = await makeTempRoot()
    const sourceRoot = join(root, "collection")
    await mkdir(sourceRoot)
    const observation = await selectedRoot(sourceRoot)
    await writeFile(join(sourceRoot, "added-after-selection.zip"), Buffer.from("archive"))
    const result = await resolveSourceCandidate(observation, "added-after-selection.zip")
    expect(result).toMatchObject({ ok: true, value: { kind: "archive" } })
  })

  it("does not mutate archive bytes during boundary validation", async () => {
    const root = await makeTempRoot()
    const sourceRoot = join(root, "collection")
    const archive = join(sourceRoot, "book.zip")
    await mkdir(sourceRoot)
    await writeFile(archive, Buffer.from("archive-fixture"))
    const before = await readFile(archive)
    const observation = await selectedRoot(sourceRoot)
    expect((await resolveSourceCandidate(observation, "book.zip")).ok).toBe(true)
    expect(await readFile(archive)).toEqual(before)
  })
})
