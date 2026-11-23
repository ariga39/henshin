import { randomUUID } from "node:crypto"
import { chmod, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export const DESKTOP_RECOVERY_STATE_NAME = "desktop-recovery-state.json"

export interface DesktopRecoveryState {
  readonly format_version: 1
  readonly installation_id: string
  readonly recovery_point: string
  readonly requires_fresh_authentication: boolean
  readonly mappings_require_review: boolean
  readonly reader_profiles_require_review: boolean
  readonly automatic_reader_launch_disabled: boolean
  readonly unresolved_dispatches: "unknown"
  readonly drafts_require_fresh_state_reapplication: true
  readonly command_attempts_require_reconciliation: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const readDesktopRecoveryState = async (dataDirectory: string): Promise<DesktopRecoveryState | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(dataDirectory, DESKTOP_RECOVERY_STATE_NAME), "utf8"))
    if (!isRecord(value) || value.format_version !== 1 || typeof value.installation_id !== "string" || typeof value.recovery_point !== "string") {
      throw new Error("desktop recovery state is invalid")
    }
    if (
      typeof value.requires_fresh_authentication !== "boolean" ||
      typeof value.mappings_require_review !== "boolean" ||
      typeof value.reader_profiles_require_review !== "boolean" ||
      typeof value.automatic_reader_launch_disabled !== "boolean" ||
      value.unresolved_dispatches !== "unknown" ||
      value.drafts_require_fresh_state_reapplication !== true ||
      value.command_attempts_require_reconciliation !== true
    ) throw new Error("desktop recovery state is invalid")
    return value as unknown as DesktopRecoveryState
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

export const writeDesktopRecoveryState = async (dataDirectory: string, state: DesktopRecoveryState): Promise<void> => {
  const destination = path.join(dataDirectory, DESKTOP_RECOVERY_STATE_NAME)
  const temporaryPath = `${destination}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
  try {
    await chmod(temporaryPath, 0o600)
    const file = await open(temporaryPath, "r+")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporaryPath, destination)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
