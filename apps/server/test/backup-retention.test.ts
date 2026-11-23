import { execFile as execFileCallback } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

const execFile = promisify(execFileCallback)
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const workspaces: Array<string> = []

const run = async (args: ReadonlyArray<string>): Promise<Record<string, any>> => {
  const result = await execFile(process.execPath, [SERVER_PATH, ...args], { cwd: path.resolve(".") })
  return JSON.parse(result.stdout) as Record<string, any>
}

const runFailure = async (args: ReadonlyArray<string>): Promise<{ readonly stderr: string; readonly code: number }> => {
  try {
    await execFile(process.execPath, [SERVER_PATH, ...args], { cwd: path.resolve(".") })
    throw new Error("expected command failure")
  } catch (error) {
    const failure = error as { stderr?: string; code?: number }
    return { stderr: failure.stderr ?? "", code: Number(failure.code ?? 1) }
  }
}

const setup = async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-backup-retention-"))
  workspaces.push(workspace)
  const dataDir = path.join(workspace, "data")
  const destination = path.join(workspace, "destination")
  await Promise.all([mkdir(dataDir), mkdir(destination)])
  const registered = await run([
    "backup-destination", "register", "--data-dir", dataDir,
    "--name", "primary", "--path", destination
  ])
  const destinationId = registered.destination.destination_id as string
  await execFile(process.execPath, [SERVER_PATH, "--data-dir", dataDir, "--initialize-owner"], { cwd: path.resolve(".") })
  return { workspace, dataDir, destination, destinationId }
}

const publishRotating = (dataDir: string, destinationId: string, label: string) => run([
  "backup", "create", "--data-dir", dataDir,
  "--destination-id", destinationId, "--retention-class", "rotating", "--label", label
])

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

describe("server backup retention", () => {
  it("requires opt-in and keeps seven rotating artifacts by publication order", async () => {
    const { dataDir, destination, destinationId } = await setup()
    const archive = await run([
      "backup", "create", "--data-dir", dataDir,
      "--destination-id", destinationId, "--retention-class", "archive", "--label", "long-term"
    ])
    const initial = []
    for (let index = 0; index < 8; index += 1) initial.push(await publishRotating(dataDir, destinationId, `initial-${index}`))

    const rotatingDirectory = path.join(destination, "rotating")
    await writeFile(path.join(rotatingDirectory, "foreign.txt"), "foreign")
    await writeFile(path.join(rotatingDirectory, "incomplete.henshin.zip"), "incomplete")
    const initialListing = await run(["backup", "list", "--data-dir", dataDir])
    const initialArtifacts = (initialListing.artifacts as Array<{ artifact_id: string; relative_path: string; publication_order: number; status: string }>)
      .filter((artifact) => artifact.status === "completed" && artifact.relative_path.startsWith("rotating/"))
    for (const [index, artifact] of initialArtifacts.entries()) {
      const timestamp = new Date(Date.UTC(2000, 0, index + 1))
      await utimes(path.join(destination, artifact.relative_path), timestamp, timestamp)
    }

    const disabledPublication = await publishRotating(dataDir, destinationId, "disabled")
    expect(disabledPublication.retention).toMatchObject({ state: "disabled", keep_count: 7, deleted_artifact_ids: [] })
    expect((await readdir(rotatingDirectory)).filter((name) => name.endsWith(".henshin.zip") && name !== "incomplete.henshin.zip")).toHaveLength(9)

    const proposal = await run([
      "backup", "retention", "enable", "--data-dir", dataDir,
      "--destination-id", destinationId
    ])
    expect(proposal.proposal).toEqual({
      store_kind: "server",
      destination_id: destinationId,
      destination_name: "primary",
      keep_count: 7,
      current_state: "disabled",
      requires_confirmation: true
    })
    expect((await readdir(rotatingDirectory)).filter((name) => name.endsWith(".henshin.zip") && name !== "incomplete.henshin.zip")).toHaveLength(9)

    const enabled = await run([
      "backup", "retention", "enable", "--data-dir", dataDir,
      "--destination-id", destinationId, "--confirm"
    ])
    expect(enabled.retention).toMatchObject({ enabled: true, keep_count: 7, state: "enabled" })

    const published = await publishRotating(dataDir, destinationId, "after-opt-in")
    expect(published.retention).toMatchObject({ state: "applied", keep_count: 7, warning: null })
    expect((published.retention.deleted_artifact_ids as Array<string>)).toHaveLength(3)
    expect((await readdir(rotatingDirectory)).filter((name) => name.endsWith(".henshin.zip") && name !== "incomplete.henshin.zip")).toHaveLength(7)
    expect(await readFile(path.join(rotatingDirectory, "foreign.txt"))).toEqual(Buffer.from("foreign"))
    expect(await readFile(path.join(rotatingDirectory, "incomplete.henshin.zip"))).toEqual(Buffer.from("incomplete"))
    await expect(stat(archive.archive_path as string)).resolves.toBeDefined()

    const listing = await run(["backup", "list", "--data-dir", dataDir])
    const artifacts = listing.artifacts as Array<{ artifact_id: string; relative_path: string; status: string; publication_order: number }>
    const completedRotating = artifacts.filter((artifact) => artifact.status === "completed" && artifact.relative_path.startsWith("rotating/"))
    const deletedRotating = artifacts.filter((artifact) => artifact.status === "deleted" && artifact.relative_path.startsWith("rotating/"))
    expect(completedRotating).toHaveLength(7)
    expect(deletedRotating.map((artifact) => artifact.publication_order)).toEqual([2, 3, 4])
    expect(completedRotating.map((artifact) => artifact.publication_order)).toEqual([5, 6, 7, 8, 9, 10, 11])

    const retention = await run(["backup", "retention", "list", "--data-dir", dataDir])
    expect(retention.retention).toEqual([expect.objectContaining({
      destination_id: destinationId,
      destination_name: "primary",
      enabled: true,
      keep_count: 7,
      state: "enabled"
    })])
  })

  it("reconciles missing artifacts after interrupted cleanup and replacement, then requires fresh restore authorization", async () => {
    const { dataDir, destination, destinationId } = await setup()
    for (let index = 0; index < 8; index += 1) await publishRotating(dataDir, destinationId, `before-enable-${index}`)
    await run(["backup", "retention", "enable", "--data-dir", dataDir, "--destination-id", destinationId, "--confirm"])
    const firstListing = await run(["backup", "list", "--data-dir", dataDir])
    const active = (firstListing.artifacts as Array<{ artifact_id: string; relative_path: string; publication_order: number; status: string }>)
      .filter((artifact) => artifact.status === "completed" && artifact.relative_path.startsWith("rotating/"))
      .sort((left, right) => left.publication_order - right.publication_order)
    const missingPath = path.join(destination, active[0].relative_path)
    const missingBackupPath = `${missingPath}.missing`
    await rename(missingPath, missingBackupPath)
    const recoveredCleanup = await publishRotating(dataDir, destinationId, "cleanup-recovery")
    expect(recoveredCleanup.retention).toMatchObject({
      state: "applied",
      deleted_artifact_ids: [active[0].artifact_id, active[1].artifact_id]
    })
    expect(await readFile(missingBackupPath)).not.toHaveLength(0)
    await expect(stat(path.join(destination, recoveredCleanup.relative_path as string))).resolves.toBeDefined()

    const detachedDestination = `${destination}-detached`
    await rename(destination, detachedDestination)
    await mkdir(destination)
    const failedPublication = await runFailure([
      "backup", "create", "--data-dir", dataDir,
      "--destination-id", destinationId, "--retention-class", "rotating"
    ])
    expect(failedPublication.code).toBe(1)
    expect(failedPublication.stderr).toContain("backup destination changed")
    await expect(stat(path.join(detachedDestination, "rotating"))).resolves.toBeDefined()

    const replaced = await run([
      "backup-destination", "replace", "--data-dir", dataDir,
      "--id", destinationId, "--path", destination, "--confirm"
    ])
    expect(replaced.destination.destination_id).toBe(destinationId)
    const afterReplace = await run(["backup", "retention", "list", "--data-dir", dataDir])
    expect(afterReplace.retention).toEqual([expect.objectContaining({
      destination_id: destinationId,
      enabled: false,
      state: "needs-reactivation"
    })])

    await run(["backup", "retention", "enable", "--data-dir", dataDir, "--destination-id", destinationId, "--confirm"])
    const detachedRotating = await readdir(path.join(detachedDestination, "rotating"))
    for (let index = 0; index < 7; index += 1) await publishRotating(dataDir, destinationId, `replacement-${index}`)
    expect((await readdir(path.join(destination, "rotating"))).filter((name) => name.endsWith(".henshin.zip"))).toHaveLength(7)
    for (const name of detachedRotating.filter((candidate) => candidate.endsWith(".henshin.zip"))) {
      await expect(stat(path.join(detachedDestination, "rotating", name))).resolves.toBeDefined()
    }

    const replacementListing = await run(["backup", "list", "--data-dir", dataDir])
    const replacementArtifacts = replacementListing.artifacts as Array<{ status: string; publication_order: number; relative_path: string }>
    expect(replacementArtifacts.filter((artifact) => artifact.status === "completed" && artifact.relative_path.startsWith("rotating/"))).toHaveLength(7)
    expect(replacementArtifacts.filter((artifact) => artifact.status === "deleted" && artifact.relative_path.startsWith("rotating/")).length).toBeGreaterThanOrEqual(9)

    const database = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    try {
      database.exec(`
        CREATE TABLE server_restore_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          status TEXT NOT NULL CHECK (status IN ('normal', 'needs-reconciliation')),
          artifact_id TEXT,
          restored_at_ms INTEGER,
          recovery_point TEXT
        );
        INSERT INTO server_restore_state(id, status, restored_at_ms)
        VALUES (1, 'needs-reconciliation', ${Date.now()});
      `)
    } finally {
      database.close()
    }
    const afterRestore = await run(["backup", "retention", "list", "--data-dir", dataDir])
    expect(afterRestore.retention).toEqual([expect.objectContaining({
      destination_id: destinationId,
      enabled: false,
      state: "needs-reactivation",
      warning: expect.objectContaining({ code: "restore-requires-reactivation" })
    })])
    const rejectedEnable = await runFailure([
      "backup", "retention", "enable", "--data-dir", dataDir,
      "--destination-id", destinationId, "--confirm"
    ])
    expect(rejectedEnable.code).toBe(1)
    expect(rejectedEnable.stderr).toContain("authorization is unavailable until restore reconciliation completes")

    const normalDatabase = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    try {
      normalDatabase.exec("UPDATE server_restore_state SET status = 'normal'")
    } finally {
      normalDatabase.close()
    }
    const reenabled = await run([
      "backup", "retention", "enable", "--data-dir", dataDir,
      "--destination-id", destinationId, "--confirm"
    ])
    expect(reenabled.retention).toMatchObject({ enabled: true, state: "enabled" })
  })

  it("preserves every file when the newest rotating archive is corrupt", async () => {
    const { dataDir, destination, destinationId } = await setup()
    for (let index = 0; index < 8; index += 1) await publishRotating(dataDir, destinationId, `corrupt-newest-${index}`)
    await run(["backup", "retention", "enable", "--data-dir", dataDir, "--destination-id", destinationId, "--confirm"])
    const before = await run(["backup", "list", "--data-dir", dataDir])
    const rotating = (before.artifacts as Array<{ artifact_id: string; relative_path: string; status: string; publication_order: number }>)
      .filter((artifact) => artifact.status === "completed" && artifact.relative_path.startsWith("rotating/"))
      .sort((left, right) => left.publication_order - right.publication_order)
    const newestPath = path.join(destination, rotating[rotating.length - 1].relative_path)
    await writeFile(newestPath, "corrupt archive")

    const publishedArchive = await run([
      "backup", "create", "--data-dir", dataDir,
      "--destination-id", destinationId, "--retention-class", "archive", "--label", "after-corruption"
    ])
    expect(publishedArchive.retention).toMatchObject({
      state: "warning",
      warning: { code: "newest-recovery-point-invalid" },
      deleted_artifact_ids: []
    })
    await expect(readFile(newestPath)).resolves.toEqual(Buffer.from("corrupt archive"))
    for (const artifact of rotating) await expect(stat(path.join(destination, artifact.relative_path))).resolves.toBeDefined()
    await expect(stat(publishedArchive.archive_path as string)).resolves.toBeDefined()
  })

  it("preserves every file when an oldest catalog path contains a foreign archive", async () => {
    const { dataDir, destination, destinationId } = await setup()
    for (let index = 0; index < 8; index += 1) await publishRotating(dataDir, destinationId, `foreign-oldest-${index}`)
    await run(["backup", "retention", "enable", "--data-dir", dataDir, "--destination-id", destinationId, "--confirm"])
    const before = await run(["backup", "list", "--data-dir", dataDir])
    const rotating = (before.artifacts as Array<{ artifact_id: string; relative_path: string; status: string; publication_order: number }>)
      .filter((artifact) => artifact.status === "completed" && artifact.relative_path.startsWith("rotating/"))
      .sort((left, right) => left.publication_order - right.publication_order)
    const oldestPath = path.join(destination, rotating[0].relative_path)
    const originalPath = `${oldestPath}.original`
    await rename(oldestPath, originalPath)
    await writeFile(oldestPath, "foreign regular file")

    const publishedArchive = await run([
      "backup", "create", "--data-dir", dataDir,
      "--destination-id", destinationId, "--retention-class", "archive", "--label", "after-foreign-replacement"
    ])
    expect(publishedArchive.retention).toMatchObject({
      state: "warning",
      warning: { code: "catalog-ownership-uncertain" },
      deleted_artifact_ids: []
    })
    await expect(readFile(oldestPath)).resolves.toEqual(Buffer.from("foreign regular file"))
    await expect(stat(originalPath)).resolves.toBeDefined()
    for (const artifact of rotating.slice(1)) await expect(stat(path.join(destination, artifact.relative_path))).resolves.toBeDefined()
    await expect(stat(publishedArchive.archive_path as string)).resolves.toBeDefined()
  })
})
