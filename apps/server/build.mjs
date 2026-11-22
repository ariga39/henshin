import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const dir = path.dirname(fileURLToPath(import.meta.url))

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Effect and the Node platform adapter stay external and are resolved from
  // node_modules; the workspace contracts package is bundled in.
  external: ["effect", "effect/*", "@effect/*"],
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
