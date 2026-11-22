import { join } from "node:path"
import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { vi } from "vitest"
import { BlobWriter, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js"

vi.mock("node:url", async () => {
  const actual = await vi.importActual<typeof import("node:url")>("node:url")
  return {
    ...actual,
    fileURLToPath: () => join(process.cwd(), "apps/server/dist/thumbnail-decoder.mjs")
  }
})

import sharp from "sharp"
import { Effect, Layer, PlatformError } from "effect"
import { ChildProcessSpawner } from "effect/process"
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

const makeServices = async (
  cachePublish: "succeed" | "fail",
  sourceKind: "directory" | "archive" = "directory",
  options: {
    readonly legacyObservations?: boolean
    readonly nonNaturalArchiveOrder?: boolean
    readonly warmCache?: Uint8Array
    readonly cacheReadFails?: boolean
    readonly rootUnavailable?: boolean
    readonly allPagesCorrupt?: boolean
    readonly transientFirstDecode?: boolean
  } = {}
) => {
  const rootPath = await mkdtemp(join(os.tmpdir(), "henshin-thumbnail-producer-"))
  temporaryRoots.push(rootPath)
  const bookPath = sourceKind === "directory" ? join(rootPath, "book") : join(rootPath, "book.cbz")
  const goodPage = await sharp({ create: { width: 640, height: 800, channels: 3, background: { r: 30, g: 90, b: 220 } } }).png().toBuffer()
  const alternatePage = await sharp({ create: { width: 640, height: 800, channels: 3, background: { r: 220, g: 30, b: 40 } } }).png().toBuffer()
  if (sourceKind === "directory") {
    await mkdir(bookPath)
    await writeFile(join(bookPath, "001.png"), Buffer.from("corrupt page"))
    await writeFile(join(bookPath, "002.png"), options.allPagesCorrupt ? Buffer.from("also corrupt") : goodPage)
  } else {
    const writer = new ZipWriter(new BlobWriter("application/zip"))
    const entries: ReadonlyArray<readonly [string, Uint8Array]> = options.nonNaturalArchiveOrder
      ? [
          ["10.png", alternatePage],
          ["2.png", goodPage],
          ["3.png", new Uint8Array(Buffer.from("later corrupt page"))]
        ]
      : [
          ["001.png", new Uint8Array(Buffer.from("corrupt page"))],
          ["002.png", goodPage],
          ["003.png", new Uint8Array(Buffer.from("later corrupt page"))]
        ]
    for (const [name, bytes] of entries) {
      await writer.add(name, new Uint8ArrayReader(bytes), { compressionMethod: 0 })
    }
    const blob = await writer.close()
    const bytes = Buffer.from(await blob.arrayBuffer())
    const localHeaders: Array<number> = []
    let searchFrom = 0
    while (localHeaders.length < 3) {
      const offset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), searchFrom)
      if (offset < 0) break
      localHeaders.push(offset)
      searchFrom = offset + 4
    }
    const third = localHeaders[2]
    if (third === undefined) throw new Error("expected third CBZ member")
    const dataStart = third + 30 + bytes.readUInt16LE(third + 26) + bytes.readUInt16LE(third + 28)
    bytes[dataStart] = (bytes[dataStart] ?? 0) ^ 0xff
    await writeFile(bookPath, bytes)
  }
  const manifest = await Effect.runPromise(analyzeSourceManifest({ sourcePath: bookPath }))
  const selected = await selectSourceRoot(rootPath)
  if (!selected.ok) throw new Error("fixture root could not be selected")
  const entryId = randomUUID()
  const rootId = randomUUID()
  const root: ServerRootRow = {
    libraryId: randomUUID(),
    rootId,
    label: "Books",
    selectedPath: options.rootUnavailable ? join(rootPath, "unavailable-root") : selected.value.selectedPath,
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
    relative_path: sourceKind === "directory" ? "book" : "book.cbz",
    kind: sourceKind === "directory" ? "image-directory" as const : "archive" as const,
    content_version: "1",
    manifest_json: JSON.stringify(manifestView(manifest))
  }
  if (options.legacyObservations) {
    const legacyManifest = JSON.parse(accepted.manifest_json) as {
      before: { observation_token?: string }
      after: { observation_token?: string }
    }
    delete legacyManifest.before.observation_token
    delete legacyManifest.after.observation_token
    accepted.manifest_json = JSON.stringify(legacyManifest)
  }
  let published: Uint8Array | undefined
  const library = {
    acceptedThumbnailEntry: () => Effect.succeed(accepted)
  } as unknown as LibraryStore["Service"]
  let cacheReads = 0
  const cache = {
    read: () => options.cacheReadFails
      ? Effect.fail(new ThumbnailCacheError({ message: "simulated cache read failure" }))
      : Effect.sync(() => {
          cacheReads += 1
          return options.warmCache ?? null
        }),
    publish: (_key: string, bytes: Uint8Array) => cachePublish === "fail"
      ? Effect.fail(new ThumbnailCacheError({ message: "simulated cache publication failure" }))
      : Effect.sync(() => { published = bytes })
  } as unknown as ThumbnailCache["Service"]
  const rootService = {
    list: () => Effect.succeed([root])
  } as unknown as RootStore["Service"]
  const nodeLayer = options.transientFirstDecode
    ? Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function*() {
          const actual = yield* ChildProcessSpawner.ChildProcessSpawner
          let first = true
          return ChildProcessSpawner.make((command) => {
            if (first) {
              first = false
              return Effect.fail(PlatformError.systemError({
                _tag: "Unknown",
                module: "thumbnail-test",
                method: "spawn",
                description: "simulated transient decoder startup failure"
              }))
            }
            return actual.spawn(command)
          })
        })
      ).pipe(Layer.provide(NodeServices.layer))
    : NodeServices.layer
  const layer = ThumbnailProducer.layer.pipe(
    Layer.provide(Layer.mergeAll(
      Layer.succeed(LibraryStore, library),
      Layer.succeed(RootStore, rootService),
      Layer.succeed(ThumbnailCache, cache),
      nodeLayer
    ))
  )
  return { entryId, layer, bookPath, getPublished: () => published, getCacheReads: () => cacheReads }
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

  it("renders the first good page from a real CBZ without touching a later corrupt member", async () => {
    const fixture = await makeServices("succeed", "archive")
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const producer = yield* ThumbnailProducer
        return yield* producer.load(`default-v1.${fixture.entryId}.1`)
      }).pipe(Effect.provide(fixture.layer))
    )
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") throw new Error("expected rendered CBZ cover")
    await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "webp", width: 320, height: 480 })
  })

  it("falls through a transient first-page decoder failure to a later CBZ cover", async () => {
    const fixture = await makeServices("succeed", "archive", { transientFirstDecode: true })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const producer = yield* ThumbnailProducer
        return yield* producer.load(`default-v1.${fixture.entryId}.1`)
      }).pipe(Effect.provide(fixture.layer))
    )
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") throw new Error("expected fallback cover")
    await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "webp", width: 320, height: 480 })
  })

  it("keeps a transient decoder failure retryable when no candidate succeeds", async () => {
    const fixture = await makeServices("succeed", "directory", {
      allPagesCorrupt: true,
      transientFirstDecode: true
    })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const producer = yield* ThumbnailProducer
        return yield* producer.load(`default-v1.${fixture.entryId}.1`)
      }).pipe(Effect.provide(fixture.layer))
    )
    expect(result).toEqual({ kind: "updating" })
  })

  it("keeps a permanently over-limit accepted archive terminal", async () => {
    const fixture = await makeServices("succeed", "archive")
    await truncate(fixture.bookPath, 4 * 1024 ** 3 + 1)
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const producer = yield* ThumbnailProducer
        return yield* producer.load(`default-v1.${fixture.entryId}.1`)
      }).pipe(Effect.provide(fixture.layer))
    )
    expect(result).toEqual({ kind: "missing" })
  })

  it("renders the accepted manifest's first page when ZIP order is non-natural", async () => {
    const fixture = await makeServices("succeed", "archive", { nonNaturalArchiveOrder: true })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const producer = yield* ThumbnailProducer
        return yield* producer.load(`default-v1.${fixture.entryId}.1`)
      }).pipe(Effect.provide(fixture.layer))
    )
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") throw new Error("expected rendered CBZ cover")
    const stats = await sharp(result.bytes).stats()
    expect(stats.channels[2]?.mean).toBeGreaterThan(stats.channels[0]?.mean ?? 0)
  })

  it("renders an accepted entry whose observations predate observation tokens", async () => {
    const fixture = await makeServices("succeed", "directory", { legacyObservations: true })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const producer = yield* ThumbnailProducer
        return yield* producer.load(`default-v1.${fixture.entryId}.1`)
      }).pipe(Effect.provide(fixture.layer))
    )
    expect(result.kind).toBe("ready")
  })

  it("does not serve a warm legacy cache entry after the source changes", async () => {
    const fixture = await makeServices("succeed", "directory", {
      legacyObservations: true,
      warmCache: new Uint8Array([1, 2, 3])
    })
    await writeFile(join(fixture.bookPath, "002.png"), Buffer.from("changed page"))
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const producer = yield* ThumbnailProducer
        return yield* producer.load(`default-v1.${fixture.entryId}.1`)
      }).pipe(Effect.provide(fixture.layer))
    )
    expect(result).toEqual({ kind: "missing" })
    expect(fixture.getCacheReads()).toBe(0)
  })

  it("regenerates when reading the optional cache fails", async () => {
    const fixture = await makeServices("succeed", "directory", { cacheReadFails: true })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const producer = yield* ThumbnailProducer
        return yield* producer.load(`default-v1.${fixture.entryId}.1`)
      }).pipe(Effect.provide(fixture.layer))
    )
    expect(result.kind).toBe("ready")
  })

  it("keeps an unavailable accepted root retryable", async () => {
    const fixture = await makeServices("succeed", "directory", { rootUnavailable: true })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const producer = yield* ThumbnailProducer
        return yield* producer.load(`default-v1.${fixture.entryId}.1`)
      }).pipe(Effect.provide(fixture.layer))
    )
    expect(result).toEqual({ kind: "updating" })
  })

  it("keeps a genuinely unhealthy accepted source terminal", async () => {
    const fixture = await makeServices("succeed", "directory", { allPagesCorrupt: true })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const producer = yield* ThumbnailProducer
        return yield* producer.load(`default-v1.${fixture.entryId}.1`)
      }).pipe(Effect.provide(fixture.layer))
    )
    expect(result).toEqual({ kind: "missing" })
  })

  it("keeps a budget timeout retryable and backs off the next render", async () => {
    const fixture = await makeServices("succeed")
    const values = [0, 31_000]
    const now = vi.spyOn(Date, "now").mockImplementation(() => values.shift() ?? 31_000)
    try {
      const [first, second] = await Effect.runPromise(
        Effect.gen(function*() {
          const producer = yield* ThumbnailProducer
          const first = yield* producer.load(`default-v1.${fixture.entryId}.1`)
          const second = yield* producer.load(`default-v1.${fixture.entryId}.1`)
          return [first, second] as const
        }).pipe(Effect.provide(fixture.layer))
      )
      expect(first).toEqual({ kind: "updating" })
      expect(second).toEqual({ kind: "updating" })
    } finally {
      now.mockRestore()
    }
  })
})
