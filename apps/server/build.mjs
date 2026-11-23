import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const dir = path.dirname(fileURLToPath(import.meta.url))

const removeWorkspaceSourceAnnotations = async (file) => {
  const source = await readFile(file, "utf8")
  await writeFile(file, source.replace(/^\/\/ (?:apps|packages)\/[^\n]+\n/gmu, ""))
}

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "none",
  // Effect and the Node platform adapter stay external and are resolved from
  // node_modules; the workspace contracts package is bundled in.
  external: ["effect", "effect/*", "@effect/*", "sharp"],
  logLevel: "info"
}

await build({
  ...shared,
  entryPoints: [path.join(dir, "src/main.ts")],
  outfile: path.join(dir, "dist/server.mjs")
})

await build({
  ...shared,
  entryPoints: [path.join(dir, "src/persistence/worker.ts")],
  outfile: path.join(dir, "dist/worker.mjs")
})

await build({
  ...shared,
  entryPoints: [path.join(dir, "src/analysis/manifest-probe.ts")],
  outfile: path.join(dir, "dist/manifest-probe.mjs")
})

await build({
  ...shared,
  entryPoints: [path.join(dir, "src/thumbnails/thumbnail-decoder.ts")],
  outfile: path.join(dir, "dist/thumbnail-decoder.mjs")
})

for (const file of ["server.mjs", "worker.mjs", "manifest-probe.mjs", "thumbnail-decoder.mjs"]) {
  await removeWorkspaceSourceAnnotations(path.join(dir, "dist", file))
}
