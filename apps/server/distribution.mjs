import { execFileSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const repositoryDir = path.resolve(serverDir, "../..")
const serverPackage = JSON.parse(await readFile(path.join(serverDir, "package.json"), "utf8"))
const version = serverPackage.version
const platform = `${process.platform}-${process.arch}`
const artifactDirectory = path.resolve(
  process.env.HENSHIN_ARTIFACT_DIR ?? path.join(repositoryDir, "dist", "standalone")
)
const archiveName = `henshin-server-${version}-${platform}.tar.gz`
const outputPath = path.join(artifactDirectory, archiveName)
const entrypoints = ["server.mjs", "worker.mjs", "manifest-probe.mjs", "thumbnail-decoder.mjs"]

const exists = async (target) => {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

const packageLicenseFiles = async (packageDirectory) => {
  const files = await readdir(packageDirectory, { withFileTypes: true })
  return files
    .filter(
      (entry) =>
        entry.isFile() && /^(?:license|copying|notice)(?:\..*)?$/iu.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort()
}

const findPackageDirectories = async (directory) => {
  if (!(await exists(directory))) return []
  const packageJsonPath = path.join(directory, "package.json")
  if (await exists(packageJsonPath)) return [directory]

  const children = await readdir(directory, { withFileTypes: true })
  const directories = []
  for (const child of children) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue
    directories.push(...(await findPackageDirectories(path.join(directory, child.name))))
  }
  return directories
}

const collectNotices = async (nodeModulesDirectory) => {
  const virtualStore = path.join(nodeModulesDirectory, ".pnpm")
  const packages = new Map()
  const packageDirectories = []
  if (await exists(virtualStore)) {
    const storeEntries = await readdir(virtualStore, { withFileTypes: true })
    for (const entry of storeEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      packageDirectories.push(...(await findPackageDirectories(
        path.join(virtualStore, entry.name, "node_modules")
      )))
    }
  }
  if (packageDirectories.length === 0) {
    const topLevelEntries = await readdir(nodeModulesDirectory, { withFileTypes: true })
    for (const entry of topLevelEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".bin" || entry.name === ".pnpm") continue
      const packageDirectory = path.join(nodeModulesDirectory, entry.name)
      if (entry.name.startsWith("@")) {
        const scopedEntries = await readdir(packageDirectory, { withFileTypes: true })
        for (const scopedEntry of scopedEntries) {
          if (!scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) continue
          const scopedPackageDirectory = path.join(packageDirectory, scopedEntry.name)
          if (await exists(path.join(scopedPackageDirectory, "package.json"))) {
            packageDirectories.push(scopedPackageDirectory)
          }
        }
      } else if (await exists(path.join(packageDirectory, "package.json"))) {
        packageDirectories.push(packageDirectory)
      }
    }
  }
  for (const packageDirectory of packageDirectories) {
    const packageJsonPath = path.join(packageDirectory, "package.json")
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"))
    if (packageJson.name === "@henshin/contracts") continue
    const key = `${packageJson.name}@${packageJson.version}`
    if (!packages.has(key)) packages.set(key, { packageDirectory, packageJson })
  }

  const lines = [
    "# Henshin standalone server third-party notices",
    "",
    "The runtime dependencies below are redistributed under their stated licenses.",
    "Their package license files remain under node_modules in this archive.",
    ""
  ]

  for (const { packageDirectory, packageJson } of [...packages.values()].sort((left, right) =>
    `${left.packageJson.name}@${left.packageJson.version}`.localeCompare(
      `${right.packageJson.name}@${right.packageJson.version}`
    )
  )) {
    const license =
      typeof packageJson.license === "string" ? packageJson.license : JSON.stringify(packageJson.license ?? "unspecified")
    const files = await packageLicenseFiles(packageDirectory)
    lines.push(`## ${packageJson.name}@${packageJson.version}`)
    lines.push(`License: ${license}`)
    lines.push(`License files: ${files.length > 0 ? files.join(", ") : "package metadata only"}`)
    for (const file of files) {
      lines.push("")
      lines.push(`### ${file}`)
      lines.push((await readFile(path.join(packageDirectory, file), "utf8")).trim())
    }
    lines.push("", "")
  }

  return lines.join("\n")
}

const removeWorkspacePackages = async (nodeModulesDirectory) => {
  await rm(path.join(nodeModulesDirectory, "@henshin"), { recursive: true, force: true })
  const virtualStore = path.join(nodeModulesDirectory, ".pnpm")
  await rm(path.join(virtualStore, "node_modules", "@henshin"), { recursive: true, force: true })
  const entries = await readdir(virtualStore, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const packageJsonPath = path.join(virtualStore, entry.name, "node_modules", "@henshin", "contracts", "package.json")
    if (await exists(packageJsonPath)) {
      await rm(path.join(virtualStore, entry.name), { recursive: true, force: true })
    }
  }
}

const pruneEffectSources = async (nodeModulesDirectory) => {
  const effectDirectories = [
    path.join(nodeModulesDirectory, "effect"),
    path.join(nodeModulesDirectory, ".pnpm", "effect@4.0.5", "node_modules", "effect")
  ]
  for (const effectDirectory of effectDirectories) {
    if (!(await exists(effectDirectory))) continue
    await rm(path.join(effectDirectory, "src"), { recursive: true, force: true })
    await rm(path.join(effectDirectory, "ai-docs"), { recursive: true, force: true })
  }
}

const removeBinaryDirectories = async (directory) => {
  if (!(await exists(directory))) return
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const child = path.join(directory, entry.name)
    if (entry.isDirectory() && entry.name === ".bin") {
      await rm(child, { recursive: true, force: true })
      continue
    }
    if (entry.isDirectory()) await removeBinaryDirectories(child)
  }
}

const assertNoSymbolicLinks = async (directory, links = []) => {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const child = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      links.push(child)
      continue
    }
    if (entry.isDirectory()) await assertNoSymbolicLinks(child, links)
  }
  return links
}

const prunePnpmMetadata = async (nodeModulesDirectory) => {
  await rm(path.join(nodeModulesDirectory, ".modules.yaml"), { force: true })
  await rm(path.join(nodeModulesDirectory, ".package-map.json"), { force: true })
  await rm(path.join(nodeModulesDirectory, ".pnpm", "lock.yaml"), { force: true })
}

const writeRuntimeReadme = async (directory) => {
  await writeFile(
    path.join(directory, "README.md"),
    `# Henshin standalone server\n\n` +
      `This archive targets **${platform}** and contains the server workers and the host-native ` +
      `Sharp/libvips codec selected at build time. It does not require a repository checkout or ` +
      `pnpm at runtime.\n\n` +
      `## Prerequisite\n\n` +
      `Install Node.js **>=24.19.0**. This archive was built and exercised with Node.js ` +
      `24.19.0.\n\n` +
      `## Foreground startup\n\n` +
      `Create a new data directory, initialize the owner token once, and save the printed token ` +
      `in a protected operator password store:\n\n` +
      `\`\`\`sh\n` +
      `mkdir -p server-data\n` +
      `node server.mjs --data-dir server-data --initialize-owner\n` +
      `node server.mjs --data-dir server-data --port 4317\n` +
      `\`\`\`\n\n` +
      `The service binds to loopback HTTP by default. Send the saved token as ` +
      `\`Authorization: Bearer <token>\` on every API request. Restarting with the same data ` +
      `directory preserves the instance and starts a new authority epoch. The data directory ` +
      `must exist before startup.\n\n` +
      `## Scope and limitations\n\n` +
      `- This archive is validated only on ${platform}; other operating systems and architectures ` +
      `need a separately built archive with their native codec.\n` +
      `- ZIP/CBZ books and image directories containing JPEG, PNG, or WebP are supported by this ` +
      `validation. RAR/CBR and 7z are not included.\n` +
      `- LAN or remote access requires an operator-managed HTTPS reverse proxy; this archive does ` +
      `not provide direct TLS, service-manager units, signing, or release upload.\n`,
    "utf8"
  )
}

const build = async () => {
  await mkdir(artifactDirectory, { recursive: true })

  const deployDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-server-deploy-"))
  const bundleDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-server-bundle-"))
  try {
    execFileSync(process.execPath, [path.join(serverDir, "build.mjs")], {
      cwd: repositoryDir,
      stdio: "inherit"
    })

    const pnpmArguments = [
      "--filter",
      "@henshin/server",
      "deploy",
      "--prod",
      "--legacy",
      "--config.node-linker=hoisted",
      "--config.confirmModulesPurge=false",
      deployDirectory
    ]
    const packageManagerEntrypoint = process.env.npm_execpath
    if (packageManagerEntrypoint === undefined && process.platform === "win32") {
      throw new Error("Windows distribution builds must be invoked through pnpm")
    }
    execFileSync(
      packageManagerEntrypoint === undefined ? "pnpm" : process.execPath,
      packageManagerEntrypoint === undefined ? pnpmArguments : [packageManagerEntrypoint, ...pnpmArguments],
      {
        cwd: repositoryDir,
        env: { ...process.env, CI: "true" },
        stdio: "inherit"
      }
    )

    await rename(path.join(deployDirectory, "node_modules"), path.join(bundleDirectory, "node_modules"))
    const nodeModulesDirectory = path.join(bundleDirectory, "node_modules")
    await removeWorkspacePackages(nodeModulesDirectory)
    await removeBinaryDirectories(nodeModulesDirectory)
    await pruneEffectSources(nodeModulesDirectory)
    await prunePnpmMetadata(nodeModulesDirectory)
    const symbolicLinks = await assertNoSymbolicLinks(nodeModulesDirectory)
    if (symbolicLinks.length > 0) {
      throw new Error(`standalone runtime contains unsupported symbolic links: ${symbolicLinks.join(", ")}`)
    }

    for (const entrypoint of entrypoints) {
      await cp(path.join(serverDir, "dist", entrypoint), path.join(bundleDirectory, entrypoint))
    }
    await writeFile(
      path.join(bundleDirectory, "package.json"),
      `${JSON.stringify({
        name: "henshin-server-standalone",
        version,
        private: true,
        type: "module",
        main: "server.mjs",
        engines: { node: ">=24.19.0" }
      }, null, 2)}\n`,
      "utf8"
    )
    await writeRuntimeReadme(bundleDirectory)
    await writeFile(
      path.join(bundleDirectory, "THIRD-PARTY-NOTICES.txt"),
      await collectNotices(nodeModulesDirectory),
      "utf8"
    )

    execFileSync("tar", ["-czf", outputPath, "-C", bundleDirectory, "."], {
      cwd: repositoryDir,
      stdio: "inherit"
    })
    console.log(`standalone artifact: ${outputPath}`)
  } finally {
    await rm(deployDirectory, { recursive: true, force: true })
    await rm(bundleDirectory, { recursive: true, force: true })
  }
}

await build()
