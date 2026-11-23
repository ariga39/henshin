import { execFile as execFileCallback } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

const execFile = promisify(execFileCallback)
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const temporaryDirectories = new Set<string>()

const runAdmin = async (args: ReadonlyArray<string>) => {
  const result = await execFile(process.execPath, [SERVER_PATH, "backup-destination", ...args], {
    cwd: path.resolve(".")
  }).catch((error: unknown) => {
    const failure = error as { stdout?: string; stderr?: string; code?: number }
    return Promise.reject(new Error(`${failure.code ?? "unknown"}: ${failure.stderr ?? ""}`, { cause: error }))
  })
  return JSON.parse(result.stdout) as {
    destinations?: ReadonlyArray<Record<string, string>>
    destination?: Record<string, string>
  }
}

const expectAdminFailure = async (args: ReadonlyArray<string>) => {
  await expect(runAdmin(args)).rejects.toThrow()
}

const list = (dataDirectory: string) => runAdmin(["list", "--data-dir", dataDirectory])

afterEach(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe("backup destination administration", () => {
  it("enrolls, inspects, replaces and re-confirms a destination without touching a collection", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-backup-destination-"))
    temporaryDirectories.add(workspace)
    const dataDirectory = path.join(workspace, "data")
    const source = path.join(workspace, "source")
    const destination = path.join(workspace, "destination")
    const replacement = path.join(workspace, "replacement")
    const secondaryDestination = path.join(workspace, "secondary")
    const tertiaryDestination = path.join(workspace, "tertiary")
    const remounted = path.join(workspace, "remounted")
    const alias = path.join(workspace, "source-alias")
    await Promise.all([
      mkdir(dataDirectory),
      mkdir(source),
      mkdir(destination),
      mkdir(replacement),
      mkdir(secondaryDestination),
      mkdir(tertiaryDestination)
    ])
    const sourceFile = path.join(source, "keep.txt")
    const sourceBytes = Buffer.from("collection bytes")
    await writeFile(sourceFile, sourceBytes)
    await symlink(source, alias)

    const registered = await runAdmin([
      "register", "--data-dir", dataDirectory, "--name", "primary", "--path", destination
    ])
    const saved = registered.destination
    if (saved === undefined) throw new Error("expected a registered destination")

    const retry = await runAdmin([
      "register", "--data-dir", dataDirectory, "--name", "primary", "--path", destination
    ])
    expect(retry.destination).toEqual(saved)

    const inspected = await list(dataDirectory)
    expect(inspected.destinations).toEqual([saved])

    const dataChild = path.join(dataDirectory, "managed-child")
    await mkdir(dataChild)
    await expectAdminFailure([
      "register", "--data-dir", dataDirectory, "--name", "data-child", "--path", dataChild
    ])

    const secondary = await runAdmin([
      "register", "--data-dir", dataDirectory, "--name", "secondary", "--path", secondaryDestination
    ])
    if (secondary.destination === undefined) throw new Error("expected a second registered destination")
    const nestedDestination = path.join(destination, "nested")
    await mkdir(nestedDestination)
    await expectAdminFailure([
      "register", "--data-dir", dataDirectory, "--name", "nested", "--path", nestedDestination
    ])
    await expectAdminFailure([
      "replace", "--data-dir", dataDirectory, "--id", saved.destination_id, "--path", secondaryDestination, "--confirm"
    ])

    const selfReplaced = await runAdmin([
      "replace", "--data-dir", dataDirectory, "--id", saved.destination_id, "--path", destination, "--confirm"
    ])
    expect(selfReplaced.destination).toMatchObject({ destination_id: saved.destination_id, state: "active" })

    await rename(secondaryDestination, path.join(workspace, "offline-secondary"))
    const tertiary = await runAdmin([
      "register", "--data-dir", dataDirectory, "--name", "tertiary", "--path", tertiaryDestination
    ])
    expect(tertiary.destination).toMatchObject({ name: "tertiary", state: "active" })

    const database = new DatabaseSync(path.join(dataDirectory, "server.sqlite"))
    try {
      const library = database.prepare("SELECT library_id FROM server_library WHERE id = 1").get() as { library_id: string }
      const sourceIdentity = await stat(source)
      const canonicalSource = await realpath(source)
      database.prepare(`
        INSERT INTO server_roots(
          library_id, root_id, label, selected_path, canonical_path, device, inode,
          mapping_revision, policy_revision, exclusions, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, '[]', 'active')
      `).run(
        library.library_id,
        randomUUID(),
        "Books",
        source,
        canonicalSource,
        String(sourceIdentity.dev),
        String(sourceIdentity.ino)
      )
    } finally {
      database.close()
    }

    await expectAdminFailure([
      "register", "--data-dir", dataDirectory, "--name", "alias", "--path", alias
    ])
    await expectAdminFailure([
      "replace", "--data-dir", dataDirectory, "--id", saved.destination_id, "--path", source, "--confirm"
    ])
    expect(await readFile(sourceFile)).toEqual(sourceBytes)
    expect((await list(dataDirectory)).destinations).toEqual(expect.arrayContaining([saved]))

    const replaced = await runAdmin([
      "replace", "--data-dir", dataDirectory, "--id", saved.destination_id, "--path", replacement, "--confirm"
    ])
    expect(replaced.destination).toMatchObject({
      destination_id: saved.destination_id,
      canonical_path: await realpath(replacement),
      state: "active"
    })

    await rename(replacement, remounted)
    await mkdir(replacement)
    expect((await list(dataDirectory)).destinations?.[0]).toMatchObject({
      destination_id: saved.destination_id,
      state: "needs-reconfirmation"
    })

    const reconfirmed = await runAdmin([
      "replace", "--data-dir", dataDirectory, "--id", saved.destination_id, "--path", replacement, "--confirm"
    ])
    expect(reconfirmed.destination).toMatchObject({
      destination_id: saved.destination_id,
      canonical_path: await realpath(replacement),
      state: "active"
    })
    expect(await readFile(sourceFile)).toEqual(sourceBytes)
  })
})
