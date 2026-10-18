import { cp, mkdir, copyFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const dir = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(dir, "dist")

await mkdir(dist, { recursive: true })

// Electron main: CJS, self-contained apart from Electron itself.
await build({
  entryPoints: [path.join(dir, "src/main/main.ts")],
  outfile: path.join(dist, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "info"
})

// Sandboxed preload: CJS, only Electron and the dependency-free channel names.
await build({
  entryPoints: [path.join(dir, "src/preload/preload.ts")],
  outfile: path.join(dist, "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "info"
})

// Renderer: a classic script (IIFE) so it loads from a file:// origin under a
// strict CSP without ES module CORS restrictions.
await build({
  entryPoints: [path.join(dir, "src/renderer/main.tsx")],
  outfile: path.join(dist, "renderer.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome130",
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"' }
})

await copyFile(path.join(dir, "src/renderer/index.html"), path.join(dist, "index.html"))

// Ship the built independent server beside the desktop app so main can spawn it
// from the bundled Electron Node runtime.
await cp(path.join(dir, "..", "server", "dist"), path.join(dist, "server"), { recursive: true })
