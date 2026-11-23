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

  it("reports recoverable cleanup failure and requires fresh authorization after reattach and restore", async () => {
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
    const failedCleanup = await publishRotating(dataDir, destinationId, "cleanup-warning")
    expect(failedCleanup.retention).toMatchObject({
      state: "warning",
      warning: { code: "eligible-artifact-missing" },
      deleted_artifact_ids: []
    })
    expect(await readFile(missingBackupPath)).not.toHaveLength(0)
    await expect(stat(path.join(destination, failedCleanup.relative_path as string))).resolves.toBeDefined()

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
        VALUES (1, 'normal', ${Date.now() + 10_000});
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
    const preview = await run(["backup", "retention", "enable", "--data-dir", dataDir, "--destination-id", destinationId])
    expect(preview.proposal).toMatchObject({ store_kind: "server", destination_id: destinationId, keep_count: 7, requires_confirmation: true })
  })
})
