import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const isMac = process.platform === "darwin"
const isWindows = process.platform === "win32" && process.arch === "x64"
if (!isMac && !isWindows) {
  throw new Error("Build the desktop package on macOS or Windows x64.")
}

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryDirectory = path.resolve(desktopDirectory, "../..")
const desktopPackage = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"))
const serverPackage = JSON.parse(await readFile(path.join(repositoryDirectory, "apps/server/package.json"), "utf8"))
const platform = `${process.platform}-${process.arch}`
const outputDirectory = path.resolve(
  process.env.HENSHIN_DESKTOP_ARTIFACT_DIR ?? path.join(repositoryDirectory, "dist", "desktop")
)
const appName = isMac ? "Henshin.app" : "Henshin"
const appPath = path.join(outputDirectory, appName)
const archivePath = path.join(
  outputDirectory,
  `henshin-desktop-${desktopPackage.version}-${platform}.${isMac ? "tar.gz" : "zip"}`
)
const checksumPath = `${archivePath}.sha256`
const signingStatusPath = path.join(
  outputDirectory,
  `henshin-desktop-${desktopPackage.version}-${platform}.signing-status.txt`
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

const resourcesDirectory = isMac
  ? path.join(appPath, "Contents/Resources")
  : path.join(appPath, "resources")
const appResourcesDirectory = path.join(resourcesDirectory, "app")

await mkdir(outputDirectory, { recursive: true })
await rm(appPath, { recursive: true, force: true })

run(process.execPath, [path.join(repositoryDirectory, "apps/server/build.mjs")])
run(process.execPath, [path.join(desktopDirectory, "build.mjs")])

// Requiring Electron uses its pinned package resolver and materializes the
// platform runtime when the package install omitted its postinstall binary.
const electronExecutable = createRequire(import.meta.url)("electron")
const electronRuntime = isMac
  ? path.dirname(path.dirname(path.dirname(electronExecutable)))
  : path.dirname(electronExecutable)
await cp(electronRuntime, appPath, { recursive: true, verbatimSymlinks: true })
if (isWindows) {
  await rename(path.join(appPath, "electron.exe"), path.join(appPath, "Henshin.exe"))
}
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

if (isMac) {
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
} else {
  await writeFile(
    path.join(appPath, "SIGNING-STATUS.txt"),
    "Windows Authenticode signing status: UNSIGNED\nReason: no release signing certificate is configured for this development artifact.\n",
    "utf8"
  )
  run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Compress-Archive -LiteralPath $env:HENSHIN_PACKAGE_PATH -DestinationPath $env:HENSHIN_ARCHIVE_PATH -Force"
    ],
    {
      env: {
        ...process.env,
        HENSHIN_PACKAGE_PATH: appPath,
        HENSHIN_ARCHIVE_PATH: archivePath
      }
    }
  )
}

const archiveDigest = createHash("sha256").update(await readFile(archivePath)).digest("hex")
await writeFile(checksumPath, `${archiveDigest}  ${path.basename(archivePath)}\n`, "utf8")
await writeFile(
  signingStatusPath,
  isMac
    ? "macOS code signing status: AD HOC\nThis development artifact is not Developer ID signed or notarized for public distribution.\n"
    : "Windows Authenticode signing status: UNSIGNED\nThis development artifact has no release signing certificate and must not be presented as signed.\n",
  "utf8"
)
console.log(`desktop artifact: ${appPath}`)
console.log(`desktop archive: ${archivePath}`)
console.log(`desktop archive sha256: ${archiveDigest}`)
console.log(`desktop signing status: ${isMac ? "ad hoc (not notarized)" : "unsigned (no Authenticode certificate)"}`)
