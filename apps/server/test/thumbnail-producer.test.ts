import { join } from "node:path"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { vi } from "vitest"

vi.mock("node:url", async () => {
  const actual = await vi.importActual<typeof import("node:url")>("node:url")
  return {
    ...actual,
    fileURLToPath: () => join(process.cwd(), "apps/server/dist/thumbnail-decoder.mjs")
  }
})

import sharp from "sharp"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { afterEach, describe, expect, it } from "vitest"
import {
  analyzeSourceManifest,
  type SourceManifest
} from "../src/analysis/SourceManifestAnalysis"
import { selectSourceRoot } from "../src/analysis/NativeSourceBoundary"
import { LibraryStore } from "../src/persistence/LibraryStore"
import { RootStore } from "../src/persistence/RootStore"
import type { ServerRootRow } from "../src/persistence/worker-protocol"
import {
  ThumbnailCache,
  ThumbnailCacheError
} from "../src/thumbnails/ThumbnailCache"
import { ThumbnailProducer } from "../src/thumbnails/ThumbnailProducer"

const temporaryRoots: Array<string> = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

const manifestView = (manifest: SourceManifest) => ({
  source_kind: manifest.sourceKind,
  pages: manifest.pages.map((page) => ({
    name: page.name,
    format: page.format,
    declared_bytes: page.declaredBytes
  })),
  diagnostics: {
    supported_pages: manifest.diagnostics.supportedPages,
    unsupported_pages: manifest.diagnostics.unsupportedPages,
    ignored_entries: manifest.diagnostics.ignoredEntries,
    directory_records: manifest.diagnostics.directoryRecords
  },
  before: {
    kind: manifest.before.kind,
    bytes: manifest.before.bytes,
    mtime_ms: manifest.before.mtimeMs,
    entry_count: manifest.before.entryCount,
    observation_token: manifest.before.observationToken
  },
  after: {
    kind: manifest.after.kind,
    bytes: manifest.after.bytes,
    mtime_ms: manifest.after.mtimeMs,
    entry_count: manifest.after.entryCount,
    observation_token: manifest.after.observationToken
  }
})

const makeServices = async (cachePublish: "succeed" | "fail") => {
  const rootPath = await mkdtemp(join(os.tmpdir(), "henshin-thumbnail-producer-"))
  temporaryRoots.push(rootPath)
  const bookPath = join(rootPath, "book")
  await mkdir(bookPath)
  await writeFile(join(bookPath, "001.png"), Buffer.from("corrupt page"))
  await writeFile(
    join(bookPath, "002.png"),
    await sharp({ create: { width: 640, height: 800, channels: 3, background: { r: 30, g: 90, b: 220 } } }).png().toBuffer()
  )
  const manifest = await Effect.runPromise(analyzeSourceManifest({ sourcePath: bookPath }))
  const selected = await selectSourceRoot(rootPath)
  if (!selected.ok) throw new Error("fixture root could not be selected")
  const entryId = randomUUID()
  const rootId = randomUUID()
  const root: ServerRootRow = {
    libraryId: randomUUID(),
    rootId,
    label: "Books",
    selectedPath: selected.value.selectedPath,
    canonicalPath: selected.value.canonicalPath,
    device: selected.value.identity.device,
    inode: selected.value.identity.inode,
    mappingRevision: "1",
    policyRevision: "1",
    exclusions: [],
    state: "active"
  }
  const accepted = {
    entry_id: entryId,
    root_id: rootId,
    relative_path: "book",
    kind: "image-directory" as const,
    content_version: "1",
    manifest_json: JSON.stringify(manifestView(manifest))
  }
  let published: Uint8Array | undefined
  const library = {
    acceptedThumbnailEntry: () => Effect.succeed(accepted)
  } as unknown as LibraryStore["Service"]
  const roots = {
    list: () => Effect.succeed([root])
  } as unknown as RootStore["Service"]
  const cache = {
    read: () => Effect.succeed(null),
    publish: (_key: string, bytes: Uint8Array) => cachePublish === "fail"
      ? Effect.fail(new ThumbnailCacheError({ message: "simulated cache publication failure" }))
      : Effect.sync(() => { published = bytes })
  } as unknown as ThumbnailCache["Service"]
  const layer = ThumbnailProducer.layer.pipe(
    Layer.provide(Layer.mergeAll(
      Layer.succeed(LibraryStore, library),
      Layer.succeed(RootStore, roots),
      Layer.succeed(ThumbnailCache, cache),
      NodeServices.layer
    ))
  )
  return { entryId, layer, getPublished: () => published }
}

describe("real default-cover producer", () => {
  it("skips a corrupt first page and renders the next page through the decoder", async () => {
    const fixture = await makeServices("succeed")
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const producer = yield* ThumbnailProducer
        return yield* producer.load(`default-v1.${fixture.entryId}.1`)
      }).pipe(Effect.provide(fixture.layer))
    )
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") throw new Error("expected rendered cover")
    await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "webp", width: 320, height: 480 })
    expect(fixture.getPublished()).toEqual(result.bytes)
  })

  it("returns rendered bytes when cache publication fails", async () => {
    const fixture = await makeServices("fail")
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const producer = yield* ThumbnailProducer
        return yield* producer.load(`default-v1.${fixture.entryId}.1`)
      }).pipe(Effect.provide(fixture.layer))
    )
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") throw new Error("expected rendered cover")
    await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "webp", width: 320, height: 480 })
  })
})
