import { execFileSync } from "node:child_process"
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "electron-builder"

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryDirectory = path.resolve(desktopDirectory, "../..")
const desktopPackage = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"))
const serverPackage = JSON.parse(await readFile(path.join(repositoryDirectory, "apps/server/package.json"), "utf8"))
const require = createRequire(import.meta.url)
const electronExecutable = require("electron")
const electronDirectory = path.dirname(electronExecutable)
const platform = `${process.platform}-${process.arch}`
const outputDirectory = path.resolve(
  process.env.HENSHIN_DESKTOP_ARTIFACT_DIR ?? path.join(repositoryDirectory, "dist", "desktop-linux")
)
const configuredServerArchive = process.env.HENSHIN_SERVER_ARCHIVE

const run = (executable, argumentsList, options = {}) => {
  execFileSync(executable, argumentsList, { cwd: repositoryDirectory, stdio: "inherit", ...options })
}

const appRun = `#!/bin/bash
set -u

APPDIR="\${APPDIR:-\$(CDPATH= cd -- "\$(dirname -- "\$(readlink -f -- "\$0")")" && pwd)}"
export APPDIR
export PATH="\$APPDIR:\$APPDIR/usr/bin\${PATH:+:\$PATH}"
export LD_LIBRARY_PATH="\$APPDIR/usr/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
export XDG_DATA_DIRS="\$APPDIR/usr/share\${XDG_DATA_DIRS:+:\$XDG_DATA_DIRS}"
export GSETTINGS_SCHEMA_DIR="\$APPDIR/usr/share/glib-2.0/schemas\${GSETTINGS_SCHEMA_DIR:+:\$GSETTINGS_SCHEMA_DIR}"

CHROME_DEVEL_SANDBOX="\${CHROME_DEVEL_SANDBOX:-\$APPDIR/chrome-sandbox}"
export CHROME_DEVEL_SANDBOX
if [ ! -f "\$CHROME_DEVEL_SANDBOX" ] || [ ! -x "\$CHROME_DEVEL_SANDBOX" ]; then
  echo "Henshin cannot start: the Electron sandbox helper is missing or not executable: \$CHROME_DEVEL_SANDBOX" >&2
  exit 1
fi
if [ "\$(stat -c '%u' -- "\$CHROME_DEVEL_SANDBOX" 2>/dev/null)" != 0 ] || [ "\$(stat -c '%a' -- "\$CHROME_DEVEL_SANDBOX" 2>/dev/null)" != 4755 ]; then
  echo "Henshin cannot start: the Electron sandbox helper must be root-owned with mode 04755: \$CHROME_DEVEL_SANDBOX" >&2
  exit 1
fi

exec "\$APPDIR/henshin" "\$@"
`

const emptyDirectory = async (directory) => {
  await mkdir(directory, { recursive: true })
  for (const entry of await readdir(directory)) {
    await rm(path.join(directory, entry), { recursive: true, force: true })
  }
}

await mkdir(outputDirectory, { recursive: true })
await run(process.execPath, [path.join(repositoryDirectory, "apps/server/build.mjs")])
await run(process.execPath, [path.join(desktopDirectory, "build.mjs")])

let generatedServerArtifactDirectory
let serverArchive
if (configuredServerArchive !== undefined) {
  serverArchive = path.resolve(configuredServerArchive)
} else {
  generatedServerArtifactDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-server-artifact-"))
  run(process.execPath, [path.join(repositoryDirectory, "apps/server/distribution.mjs")], {
    env: { ...process.env, HENSHIN_ARTIFACT_DIR: generatedServerArtifactDirectory }
  })
  serverArchive = path.join(
    generatedServerArtifactDirectory,
    `henshin-server-${serverPackage.version}-${platform}.tar.gz`
  )
}

const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-linux-"))
const buildOutputDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-output-"))
try {
  await cp(path.join(desktopDirectory, "dist"), path.join(stagingDirectory, "dist"), { recursive: true })
  const packagedServerDirectory = path.join(stagingDirectory, "dist/server")
  await rm(packagedServerDirectory, { recursive: true, force: true })
  await mkdir(packagedServerDirectory, { recursive: true })
  run("tar", ["-xzf", path.resolve(serverArchive), "-C", packagedServerDirectory])
  await writeFile(
    path.join(stagingDirectory, "package.json"),
    `${JSON.stringify({ name: "henshin-desktop", version: desktopPackage.version, private: true, main: "dist/main.cjs" }, null, 2)}\n`,
    "utf8"
  )

  await build({
    projectDir: desktopDirectory,
    config: {
      appId: "com.henshin.desktop",
      productName: "Henshin",
      executableName: "henshin",
      artifactName: `henshin-desktop-${desktopPackage.version}-${platform}.AppImage`,
      asar: false,
      electronDist: electronDirectory,
      toolsets: { appimage: "1.0.3" },
      directories: { app: stagingDirectory, output: buildOutputDirectory },
      files: ["dist/**/*", "package.json"],
      linux: {
        category: "Utility",
        target: [{ target: "AppImage", arch: ["arm64"] }]
      },
      afterPack: async (context) => {
        await writeFile(path.join(context.appOutDir, "AppRun"), appRun, { mode: 0o755 })
        await chmod(path.join(context.appOutDir, "AppRun"), 0o755)
        await chmod(path.join(context.appOutDir, "chrome-sandbox"), 0o4755)
      }
    }
  })

  const artifactName = `henshin-desktop-${desktopPackage.version}-${platform}.AppImage`
  await emptyDirectory(outputDirectory)
  await copyFile(path.join(buildOutputDirectory, artifactName), path.join(outputDirectory, artifactName))
  console.log(`desktop artifact: ${path.join(outputDirectory, artifactName)}`)
} finally {
  await rm(stagingDirectory, { recursive: true, force: true })
  await rm(buildOutputDirectory, { recursive: true, force: true })
  if (generatedServerArtifactDirectory !== undefined) {
    await rm(generatedServerArtifactDirectory, { recursive: true, force: true })
  }
}
