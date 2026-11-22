import { afterEach, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReaderTestTargetError, resolveReaderTestTarget } from "../src/main/reader-profile-validation"

const temporaryRoots: Array<string> = []

const makeFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "henshin-reader-test-target-"))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  const roots = temporaryRoots.splice(0)
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })))
})

it("rejects recognized unsupported image formats, including mixed directories", async () => {
  const root = await makeFixture()
  const unsupported = join(root, "unsupported")
  const mixed = join(root, "mixed")
  await mkdir(unsupported)
  await mkdir(mixed)
  for (const name of ["animation.gif", "modern.avif", "bitmap.bmp", "fax.tif", "fax.tiff", "image.jxl", "photo.heic", "photo.heif"]) {
    await writeFile(join(unsupported, name), "unsupported")
  }
  await writeFile(join(mixed, "page.png"), "supported")
  await writeFile(join(mixed, "animation.gif"), "unsupported")

  await expect(resolveReaderTestTarget(unsupported, "first-image")).rejects.toMatchObject<ReaderTestTargetError>({
    code: "reader_test_target_invalid"
  })
  await expect(resolveReaderTestTarget(mixed, "first-image")).rejects.toMatchObject<ReaderTestTargetError>({
    code: "reader_test_target_invalid"
  })
})

it("selects the first direct page using natural numeric and Unicode ordering", async () => {
  const root = await makeFixture()
  const numeric = join(root, "numeric target with spaces")
  const unicode = join(root, "unicode target with spaces")
  await mkdir(numeric)
  await mkdir(unicode)
  await mkdir(join(numeric, "nested"))
  await writeFile(join(numeric, "2.jpg"), "two")
  await writeFile(join(numeric, "10.jpg"), "ten")
  await writeFile(join(numeric, "01.jpg"), "leading")
  await writeFile(join(numeric, "1.jpg"), "one")
  await writeFile(join(numeric, "nested", "0.jpg"), "nested")
  await writeFile(join(numeric, "notes.txt"), "sidecar")

  const privateUseName = "\uE000-page.png"
  const supplementaryName = "\u{10000}-page.webp"
  await writeFile(join(unicode, privateUseName), "private-use")
  await writeFile(join(unicode, supplementaryName), "supplementary")

  await expect(resolveReaderTestTarget(numeric, "first-image")).resolves.toBe(join(numeric, "01.jpg"))
  await expect(resolveReaderTestTarget(unicode, "first-image")).resolves.toBe(join(unicode, privateUseName))
})

