import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const require = createRequire(new URL("../../../package.json", import.meta.url))
const { _electron: electron } = require("@playwright/test")
const executablePath = process.env.HENSHIN_PACKAGED_EXECUTABLE
const profile = process.env.HENSHIN_PACKAGED_PROFILE
const collection = process.env.HENSHIN_PACKAGED_COLLECTION
if (executablePath === undefined || profile === undefined || collection === undefined) {
  throw new Error("HENSHIN_PACKAGED_EXECUTABLE, HENSHIN_PACKAGED_PROFILE, and HENSHIN_PACKAGED_COLLECTION are required")
}

const cbz = path.join(collection, "relocation-proof.cbz")
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (check, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}`)
}
const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex")
const childProcesses = (parentPid) => {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
  return output.split("\n").map((line) => line.trim()).filter((line) => {
    const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
    return match !== null && Number(match[2]) === parentPid && match[3].includes("dist/server/server.mjs")
  })
}
const processCommand = (pid) => {
  const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" })
  return output.trim()
}

await mkdir(profile, { recursive: true })
await mkdir(collection, { recursive: true })
await writeFile(path.join(collection, "cover.png"), validPng)
execFileSync("zip", ["-q", cbz, "cover.png"], { cwd: collection })
const sourceBefore = await sha256(cbz)

const executableDirectory = path.dirname(executablePath)
const sandboxPath = process.env.HENSHIN_PACKAGED_SANDBOX ?? path.join(executableDirectory, "chrome-sandbox")
const sandboxMode = (await stat(sandboxPath)).mode & 0o7777
if ((sandboxMode & 0o4000) === 0) throw new Error(`Electron sandbox helper is not setuid: mode=${sandboxMode.toString(8)}`)

const launch = async () => {
  const app = await electron.launch({
    chromiumSandbox: true,
    executablePath,
    args: [],
    env: {
      ...process.env,
      HOME: profile,
      XDG_CONFIG_HOME: path.join(profile, ".config"),
      XDG_CACHE_HOME: path.join(profile, ".cache"),
      XDG_DATA_HOME: path.join(profile, ".local", "share")
    }
  })
  if (processCommand(app.process().pid).includes("--no-sandbox")) throw new Error("packaged launch disabled the Electron sandbox")
  return { app, window: await app.firstWindow() }
}

const first = await launch()
const firstPid = first.app.process().pid
const firstWindow = first.window
await firstWindow.getByRole("heading", { name: "Collection setup" }).waitFor({ state: "visible" })
await firstWindow.getByTestId("root-preview-path").fill(collection)
await firstWindow.getByTestId("root-preview-submit").click()
await firstWindow.getByTestId("root-label").fill("Relocation proof")
await firstWindow.getByTestId("root-save").click()
await waitFor(() => firstWindow.getByTestId("root-saved").count().then((count) => count === 1), "saved root")
await firstWindow.getByTestId("root-saved-preview").click()
await firstWindow.getByTestId("scan-hold-new-discoveries").uncheck()
await firstWindow.getByTestId("start-held-scan").click()
await waitFor(() => firstWindow.getByTestId("library-entries").locator("li").count().then((count) => count === 1), "indexed book")
const firstCover = firstWindow.getByTestId("library-entry").first().getByTestId("library-cover-image")
await firstCover.waitFor({ state: "visible", timeout: 30_000 })
const firstNaturalWidth = await firstCover.evaluate((image) => image.naturalWidth)
if (firstNaturalWidth <= 0) throw new Error("first-run cover did not decode")
if (childProcesses(firstPid).length !== 1) throw new Error("first managed server child was not observed")
await first.app.close()
await waitFor(() => childProcesses(firstPid).length === 0, "first managed server shutdown")

const second = await launch()
const secondPid = second.app.process().pid
await second.window.getByTestId("open-library").click()
await waitFor(() => second.window.getByTestId("library-entries").locator("li").count().then((count) => count === 1), "relaunch retained book")
const secondCover = second.window.getByTestId("library-entry").first().getByTestId("library-cover-image")
await secondCover.waitFor({ state: "visible", timeout: 30_000 })
const secondNaturalWidth = await secondCover.evaluate((image) => image.naturalWidth)
if (secondNaturalWidth <= 0) throw new Error("relaunch cover did not decode")
if (childProcesses(secondPid).length !== 1) throw new Error("relaunched managed server child was not observed")
await second.app.close()
await waitFor(() => childProcesses(secondPid).length === 0, "second managed server shutdown")

const sourceAfter = await sha256(cbz)
if (sourceAfter !== sourceBefore) throw new Error("source CBZ bytes changed")
console.log(JSON.stringify({
  platform: process.platform,
  arch: process.arch,
  uid: process.getuid?.(),
  executablePath,
  sandboxMode: `0${sandboxMode.toString(8)}`,
  firstNaturalWidth,
  secondNaturalWidth,
  sourceSha256: sourceAfter,
  sourceBytesUnchanged: true,
  managedServiceShutdown: true
}, null, 2))
