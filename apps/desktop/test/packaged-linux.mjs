import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const require = createRequire(new URL("../../../package.json", import.meta.url))
const { _electron: electron } = require("@playwright/test")
const executablePath = process.env.HENSHIN_PACKAGED_EXECUTABLE
const profile = process.env.HENSHIN_PACKAGED_PROFILE
const collection = process.env.HENSHIN_PACKAGED_COLLECTION
if (executablePath === undefined || profile === undefined || collection === undefined) {
  throw new Error("HENSHIN_PACKAGED_EXECUTABLE, HENSHIN_PACKAGED_PROFILE, and HENSHIN_PACKAGED_COLLECTION are required")
}
if (process.platform !== "linux") throw new Error("packaged-linux.mjs requires Linux process observations")

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
const linuxProcessObservation = (pid) => {
  let stat
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
  const commandEnd = stat.lastIndexOf(")")
  if (commandEnd < 0) throw new Error(`invalid Linux process stat for pid ${pid}`)
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u)
  const state = fields[0]
  const linuxStartTimeTicks = fields[19]
  if (state === undefined || linuxStartTimeTicks === undefined) {
    throw new Error(`incomplete Linux process stat for pid ${pid}`)
  }
  return { state, linuxStartTimeTicks }
}
const managedServerProcesses = (parentPid) => {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
  return output.split("\n").map((line) => line.trim()).flatMap((line) => {
    const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (match === null || Number(match[2]) !== parentPid || !match[3].includes("dist/server/server.mjs")) return []
    const observation = linuxProcessObservation(Number(match[1]))
    return observation === undefined ? [] : [{
      pid: Number(match[1]),
      command: match[3],
      ...observation
    }]
  })
}
const processCommand = (pid) => {
  const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" })
  return output.trim()
}
const waitForManagedServer = async (parentPid, label) => {
  let observation
  await waitFor(() => {
    const processes = managedServerProcesses(parentPid)
    if (processes.length !== 1) return false
    observation = processes[0]
    return true
  }, `${label} managed server`)
  return observation
}
const managedServerExitObservation = (observation) => {
  try {
    process.kill(observation.pid, 0)
  } catch (error) {
    if (error.code === "ESRCH") return { exited: true, reason: "esrch" }
    throw error
  }
  const current = linuxProcessObservation(observation.pid)
  if (current === undefined) return { exited: true, reason: "proc-missing" }
  if (current.linuxStartTimeTicks !== observation.linuxStartTimeTicks) {
    return { exited: true, reason: "pid-reused", replacementLinuxStartTimeTicks: current.linuxStartTimeTicks }
  }
  return { exited: false }
}
const waitForManagedServerExit = async (observation, label) => {
  let exitObservation
  await waitFor(() => {
    exitObservation = managedServerExitObservation(observation)
    return exitObservation.exited
  }, `${label} managed server shutdown`)
  return exitObservation
}
const sandboxObservation = (pid) => {
  const command = processCommand(pid)
  const noSandboxFlag = /(?:^|\s)--no-sandbox(?:\s|$)/u.test(command)
  if (noSandboxFlag) throw new Error(`packaged launch disabled the Electron sandbox: ${command}`)
  return { pid, command, noSandboxFlag }
}
const waitForDecodedCover = async (cover, label) => {
  await cover.waitFor({ state: "visible", timeout: 30_000 })
  await waitFor(
    () => cover.evaluate((image) => image.complete && image.naturalWidth > 0),
    `${label} cover decode`
  )
  return cover.evaluate((image) => image.naturalWidth)
}

await mkdir(profile, { recursive: true })
await mkdir(collection, { recursive: true })
await writeFile(path.join(collection, "cover.png"), validPng)
execFileSync("zip", ["-q", cbz, "cover.png"], { cwd: collection })
const sourceBefore = await sha256(cbz)

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
  const pid = app.process().pid
  return { app, window: await app.firstWindow(), sandbox: sandboxObservation(pid) }
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
const firstNaturalWidth = await waitForDecodedCover(firstCover, "first-run")
const firstManagedServer = await waitForManagedServer(firstPid, "first")
await first.app.close()
const firstShutdown = await waitForManagedServerExit(firstManagedServer, "first")

const second = await launch()
const secondPid = second.app.process().pid
await second.window.getByTestId("open-library").click()
await waitFor(() => second.window.getByTestId("library-entries").locator("li").count().then((count) => count === 1), "relaunch retained book")
const secondCover = second.window.getByTestId("library-entry").first().getByTestId("library-cover-image")
const secondNaturalWidth = await waitForDecodedCover(secondCover, "relaunch")
const secondManagedServer = await waitForManagedServer(secondPid, "relaunch")
await second.app.close()
const secondShutdown = await waitForManagedServerExit(secondManagedServer, "relaunch")

const sourceAfter = await sha256(cbz)
const sourceBytesUnchanged = sourceAfter === sourceBefore
if (!sourceBytesUnchanged) throw new Error("source CBZ bytes changed")
const managedServiceShutdown = firstShutdown.exited && secondShutdown.exited
const sandboxEnabled = !first.sandbox.noSandboxFlag && !second.sandbox.noSandboxFlag
console.log(JSON.stringify({
  platform: process.platform,
  arch: process.arch,
  uid: process.getuid?.(),
  executablePath,
  sandboxEnabled,
  sandboxEvidence: {
    first: first.sandbox,
    second: second.sandbox
  },
  firstNaturalWidth,
  secondNaturalWidth,
  sourceSha256: sourceAfter,
  sourceBytesUnchanged,
  managedServiceShutdown,
  managedServices: {
    first: { ...firstManagedServer, shutdown: firstShutdown },
    second: { ...secondManagedServer, shutdown: secondShutdown }
  }
}, null, 2))
