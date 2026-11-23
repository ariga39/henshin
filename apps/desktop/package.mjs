import { execFileSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "darwin") throw new Error("Build the macOS desktop package on a Mac.")

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryDirectory = path.resolve(desktopDirectory, "../..")
const desktopPackage = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"))
const serverPackage = JSON.parse(await readFile(path.join(repositoryDirectory, "apps/server/package.json"), "utf8"))
const platform = `${process.platform}-${process.arch}`
const outputDirectory = path.resolve(
  process.env.HENSHIN_DESKTOP_ARTIFACT_DIR ?? path.join(repositoryDirectory, "dist", "desktop")
)
const appName = "Henshin.app"
const appPath = path.join(outputDirectory, appName)
const archivePath = path.join(
  outputDirectory,
  `henshin-desktop-${desktopPackage.version}-${platform}.tar.gz`
)

const run = (executable, argumentsList, options = {}) => {
  execFileSync(executable, argumentsList, { cwd: repositoryDirectory, stdio: "inherit", ...options })
}

const resolveServerArchive = async () => {
  const configuredArchive = process.env.HENSHIN_SERVER_ARCHIVE
  if (configuredArchive !== undefined) return path.resolve(configuredArchive)

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-server-"))
  run(process.execPath, [path.join(repositoryDirectory, "apps/server/distribution.mjs")], {
    env: { ...process.env, HENSHIN_ARTIFACT_DIR: temporaryDirectory }
  })
  return path.join(temporaryDirectory, `henshin-server-${serverPackage.version}-${platform}.tar.gz`)
}

const resourcesDirectory = path.join(appPath, "Contents/Resources")
const appResourcesDirectory = path.join(resourcesDirectory, "app")

await mkdir(outputDirectory, { recursive: true })
await rm(appPath, { recursive: true, force: true })

run(process.execPath, [path.join(repositoryDirectory, "apps/server/build.mjs")])
run(process.execPath, [path.join(desktopDirectory, "build.mjs")])

// Requiring Electron uses its pinned package resolver and materializes the
// platform runtime when the package install omitted its postinstall binary.
const electronExecutable = createRequire(import.meta.url)("electron")
const electronApp = path.dirname(path.dirname(path.dirname(electronExecutable)))
await cp(electronApp, appPath, { recursive: true, verbatimSymlinks: true })
await mkdir(appResourcesDirectory, { recursive: true })
await cp(path.join(desktopDirectory, "dist"), path.join(appResourcesDirectory, "dist"), {
  recursive: true
})

const serverArchive = await resolveServerArchive()

const packagedServerDirectory = path.join(appResourcesDirectory, "dist/server")
await rm(packagedServerDirectory, { recursive: true, force: true })
await mkdir(packagedServerDirectory, { recursive: true })
run("tar", ["-xzf", serverArchive, "-C", packagedServerDirectory])

await writeFile(
  path.join(appResourcesDirectory, "package.json"),
  `${JSON.stringify({ name: "henshin-desktop", version: desktopPackage.version, private: true, main: "dist/main.cjs" }, null, 2)}\n`,
  "utf8"
)

const infoPlist = path.join(appPath, "Contents/Info.plist")
run("/usr/libexec/PlistBuddy", [
  "-c",
  "Set :CFBundleDisplayName Henshin",
  infoPlist
])
run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleName Henshin", infoPlist])
run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleIdentifier com.henshin.desktop", infoPlist])

run("codesign", ["--deep", "--force", "--sign", "-", appPath])
run("codesign", ["--verify", "--deep", "--strict", appPath])
run("tar", ["-czf", archivePath, "-C", outputDirectory, appName])
console.log(`desktop artifact: ${appPath}`)
console.log(`desktop archive: ${archivePath}`)
