import { link, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined

const readExistingDeviceId = async (filePath: string): Promise<string> => {
  let stored: string
  try {
    stored = (await readFile(filePath, "utf8")).trim()
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw error
    throw new Error("the existing device identity could not be read")
  }
  if (!DEVICE_ID_PATTERN.test(stored)) {
    throw new Error("the existing device identity is invalid")
  }
  return stored
}

/**
 * Loads the installation identity, creating it only when the final file is
 * absent. A complete temporary file is linked into place so readers never see
 * a partially written identity, and concurrent first launches never replace
 * one another's identity.
 */
export const loadDeviceId = async (userDataPath: string): Promise<string> => {
  const filePath = path.join(userDataPath, "device-id")
  try {
    return await readExistingDeviceId(filePath)
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }

  const created = randomUUID()
  const temporaryPath = path.join(userDataPath, `.device-id.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, `${created}\n`, { encoding: "utf8", mode: 0o600, flag: "wx", flush: true })

    try {
      await link(temporaryPath, filePath)
      return created
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new Error("the device identity could not be initialized")
      }
      return await readExistingDeviceId(filePath)
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}
