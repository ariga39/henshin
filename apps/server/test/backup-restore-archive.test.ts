import { execFile as execFileCallback } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { loadArchive, readRestorePoint, type RestoreArtifact } from "../src/maintenance/BackupRestoreArchive"

const execFile = promisify(execFileCallback)
const SERVER_PATH = path.resolve("apps/server/dist/server.mjs")
const workspaces: Array<string> = []

const runJson = async (args: ReadonlyArray<string>) => {
  const result = await execFile(process.execPath, [SERVER_PATH, ...args], { cwd: path.resolve(".") })
  return JSON.parse(result.stdout) as Record<string, any>
}

const runFailure = async (args: ReadonlyArray<string>) => {
  try {
    await execFile(process.execPath, [SERVER_PATH, ...args], { cwd: path.resolve(".") })
    throw new Error("expected command failure")
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number }
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" }
  }
}

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

describe("ordinary server restore archive validation", () => {
  it("previews, stages, and rejects mismatched or damaged recovery points", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-backup-restore-archive-"))
    workspaces.push(workspace)
    const dataDir = path.join(workspace, "data")
    const destination = path.join(workspace, "destination")
    await Promise.all([mkdir(dataDir), mkdir(destination)])

    const registered = await runJson(["backup-destination", "register", "--data-dir", dataDir, "--name", "primary", "--path", destination])
    const destinationId = registered.destination.destination_id as string
    await execFile(process.execPath, [SERVER_PATH, "--data-dir", dataDir, "--initialize-owner"], { cwd: path.resolve(".") })
    const created = await runJson(["backup", "create", "--data-dir", dataDir, "--destination-id", destinationId])
    const archivePath = created.archive_path as string
    const database = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    const row = database.prepare(`
      SELECT a.artifact_id, a.destination_id, a.operation_id, a.relative_path, a.publication_order,
             a.label, a.manifest_digest, a.size_bytes, a.created_at_ms, a.completed_at_ms,
             d.selected_path, d.canonical_path, d.device, d.inode
      FROM backup_artifacts a JOIN backup_destinations d ON d.destination_id = a.destination_id
      WHERE a.artifact_id = ?
    `).get(created.artifact_id) as any
    const identity = database.prepare("SELECT instance_id FROM server_state WHERE id = 1").get() as { instance_id: string }
    database.close()
    const artifact: RestoreArtifact = {
      artifactId: row.artifact_id,
      destinationId: row.destination_id,
      operationId: row.operation_id,
      relativePath: row.relative_path,
      publicationOrder: row.publication_order,
      label: row.label,
      manifestDigest: row.manifest_digest,
      sizeBytes: row.size_bytes,
      createdAtMs: row.created_at_ms,
      completedAtMs: row.completed_at_ms,
      destination: { selectedPath: row.selected_path, canonicalPath: row.canonical_path, device: row.device, inode: row.inode }
    }

    const preview = await runJson(["backup", "restore", "preview", "--data-dir", dataDir, "--artifact-id", artifact.artifactId])
    expect(preview.requiresConfirmation).toBe(true)
    expect(preview.identity).toMatchObject({ instanceId: identity.instance_id })
    expect(await readRestorePoint(artifact, path.join(dataDir, "server.sqlite"))).toMatchObject({ artifactId: artifact.artifactId })

    const defaultPreview = await runJson(["backup", "restore", "--data-dir", dataDir, "--artifact-id", artifact.artifactId])
    expect(defaultPreview).toMatchObject({ artifactId: artifact.artifactId, requiresConfirmation: true })
    const listed = await runJson(["backup", "restore", "list", "--data-dir", dataDir])
    expect(listed.recovery_points).toHaveLength(1)
    const unknownSubcommand = await runFailure(["backup", "restore", "inspect", "--data-dir", dataDir, "--artifact-id", artifact.artifactId])
    expect(unknownSubcommand.code).toBe(2)
    expect(unknownSubcommand.stderr).toContain("usage: server.mjs")

    const stagingDirectory = await mkdtemp(path.join(dataDir, ".restore-stage-"))
    const archiveDigest = createHash("sha256").update(await readFile(archivePath)).digest("hex")
    const staged = await loadArchive(archivePath, stagingDirectory, artifact, preview.recoveryPoint.libraryChangeRevision as number)
    const snapshot = new DatabaseSync(staged.statePath, { readOnly: true })
    expect(snapshot.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" })
    snapshot.close()
    expect(createHash("sha256").update(await readFile(archivePath)).digest("hex")).toBe(archiveDigest)
    await rm(stagingDirectory, { recursive: true, force: true })

    const mismatchDatabase = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    mismatchDatabase.prepare("UPDATE server_state SET instance_id = ? WHERE id = 1").run(randomUUID())
    mismatchDatabase.close()
    const mismatch = await runFailure(["backup", "restore", "preview", "--data-dir", dataDir, "--artifact-id", artifact.artifactId])
    expect(mismatch.code).toBe(1)
    expect(mismatch.stderr).toContain("another server instance")

    const restoreIdentity = new DatabaseSync(path.join(dataDir, "server.sqlite"))
    restoreIdentity.prepare("UPDATE server_state SET instance_id = ? WHERE id = 1").run(identity.instance_id)
    restoreIdentity.close()
    const damaged = await readFile(archivePath)
    damaged[0] = (damaged[0] ?? 0) ^ 0xff
    await writeFile(archivePath, damaged)
    const damagedResult = await runFailure(["backup", "restore", "preview", "--data-dir", dataDir, "--artifact-id", artifact.artifactId])
    expect(damagedResult.code).toBe(1)
    expect(damagedResult.stderr).toContain("backup artifact")

    const unreadableTarget = path.join(workspace, "unreadable.sqlite")
    await writeFile(unreadableTarget, "not a sqlite database")
    const unreadable = await runFailure(["backup", "restore", "preview", "--database", unreadableTarget, "--artifact-id", artifact.artifactId])
    expect(unreadable.code).toBe(1)
    expect(unreadable.stderr).toContain("existing target cannot be read")
  })
})
