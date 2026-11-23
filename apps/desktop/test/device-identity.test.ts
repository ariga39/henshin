import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, it } from "vitest"
import { loadDeviceId } from "../src/main/device-identity"

const withDirectory = async <A>(run: (directory: string) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "henshin-device-identity-"))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

it("retains a created device identity across repeated initialization", async () => {
  await withDirectory(async (directory) => {
    const first = await loadDeviceId(directory)
    const before = await readFile(path.join(directory, "device-id"))
    const second = await loadDeviceId(directory)
    const after = await readFile(path.join(directory, "device-id"))

    expect(second).toBe(first)
    expect(after).toEqual(before)
  })
})

it("fails visibly on a corrupt identity without replacing its bytes", async () => {
  await withDirectory(async (directory) => {
    const identityPath = path.join(directory, "device-id")
    const corrupt = Buffer.from("not-a-device-id\n", "utf8")
    await writeFile(identityPath, corrupt)

    await expect(loadDeviceId(directory)).rejects.toThrow("the existing device identity is invalid")
    expect(await readFile(identityPath)).toEqual(corrupt)
  })
})

it("fails visibly when an existing identity cannot be read", async () => {
  await withDirectory(async (directory) => {
    const identityPath = path.join(directory, "device-id")
    await mkdir(identityPath)

    await expect(loadDeviceId(directory)).rejects.toThrow("the existing device identity could not be read")
  })
})

it("converges concurrent first initialization on one completely published identity", async () => {
  await withDirectory(async (directory) => {
    const identities = await Promise.all(Array.from({ length: 16 }, () => loadDeviceId(directory)))
    const stored = await readFile(path.join(directory, "device-id"), "utf8")
    const files = await readdir(directory)

    expect(new Set(identities).size).toBe(1)
    expect(stored).toBe(`${identities[0]}\n`)
    expect(files).toEqual(["device-id"])
  })
})
