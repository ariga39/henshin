import { DatabaseSync } from "node:sqlite"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { recoverInterruptedDesktopRecovery } from "../src/main/DesktopRecoveryStartup"

const workspaces: Array<string> = []

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

describe("desktop recovery startup", () => {
  it("rolls back every interrupted replacement phase before serving", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "henshin-desktop-recovery-startup-"))
    workspaces.push(workspace)
    const rollback = path.join(workspace, ".desktop-recovery-rollback-test")
    await mkdir(rollback)
    const current = new DatabaseSync(path.join(workspace, "prototype-client.db"))
    current.exec("CREATE TABLE marker(value TEXT NOT NULL); INSERT INTO marker VALUES('replacement');")
    current.close()
    const previous = new DatabaseSync(path.join(rollback, "prototype-client.db"))
    previous.exec("CREATE TABLE marker(value TEXT NOT NULL); INSERT INTO marker VALUES('previous');")
    previous.close()
    await writeFile(path.join(workspace, "device-id"), "replacement\n")
    await writeFile(path.join(rollback, "device-id"), "previous\n")
    await copyFile(path.join(workspace, "prototype-client.db"), path.join(workspace, "prototype-client.db-wal"))
    await writeFile(path.join(workspace, ".desktop-recovery-in-progress.json"), JSON.stringify({
      format_version: 1,
      phase: "state-written",
      rollback_directory: rollback,
      had_recovery_state: false
    }))
    await writeFile(path.join(workspace, "desktop-recovery-state.json"), "replacement state")

    await recoverInterruptedDesktopRecovery(workspace)

    const restored = new DatabaseSync(path.join(workspace, "prototype-client.db"), { readOnly: true })
    expect((restored.prepare("SELECT value FROM marker").get() as { value: string }).value).toBe("previous")
    restored.close()
    expect(await readFile(path.join(workspace, "device-id"), "utf8")).toBe("previous\n")
    await expect(readFile(path.join(workspace, ".desktop-recovery-in-progress.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(path.join(workspace, "desktop-recovery-state.json"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await readdir(workspace)).filter((name) => name.includes("rollback-tmp"))).toEqual([])
  })
})
