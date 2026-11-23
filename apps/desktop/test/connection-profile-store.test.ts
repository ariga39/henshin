import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  ConnectionProfileStore,
  ConnectionProfileStoreError,
  type CredentialStoreAdapter
} from "../src/main/ConnectionProfileStore"

const controlledProtectedStore = (): CredentialStoreAdapter => ({
  isAvailable: () => true,
  encrypt: (value) => `wrapped:${Buffer.from(value, "utf8").toString("base64url")}`,
  decrypt: (value) => Buffer.from(value.slice("wrapped:".length), "base64url").toString("utf8")
})

describe("connection profile persistence", () => {
  it("round-trips through a controlled protected adapter without plaintext credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-connection-profile-"))
    try {
      const store = new ConnectionProfileStore(root, controlledProtectedStore())
      const profile = {
        baseUrl: "https://library.example.test",
        bearerToken: "fixture-owner-token",
        instanceId: "00000000-0000-4000-8000-000000000001"
      }

      expect(store.storageMode()).toBe("protected")
      await store.saveRemote(profile)
      const raw = await readFile(path.join(root, "connection-profile.json"), "utf8")
      expect(raw).not.toContain(profile.bearerToken)
      expect(await store.load()).toEqual({ active: "remote", remote: profile })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses persistence when only session credentials are available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-connection-profile-"))
    try {
      const store = new ConnectionProfileStore(root, {
        isAvailable: () => false,
        encrypt: () => "never-used",
        decrypt: () => "never-used"
      })

      expect(store.storageMode()).toBe("session_only")
      await expect(store.saveRemote({
        baseUrl: "https://library.example.test",
        bearerToken: "fixture-owner-token",
        instanceId: "00000000-0000-4000-8000-000000000001"
      })).rejects.toBeInstanceOf(ConnectionProfileStoreError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not decrypt an unused remote credential for a managed profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-connection-profile-"))
    let decryptCalls = 0
    try {
      await writeFile(path.join(root, "connection-profile.json"), JSON.stringify({
        active: "managed",
        remote: {
          base_url: "https://unused.example.test",
          encrypted_bearer_token: "protected-secret",
          instance_id: "00000000-0000-4000-8000-000000000001"
        }
      }))
      const store = new ConnectionProfileStore(root, {
        isAvailable: () => true,
        encrypt: (value) => value,
        decrypt: () => {
          decryptCalls += 1
          throw new Error("unused credential must not be decrypted")
        }
      })

      await expect(store.load()).resolves.toEqual({ active: "managed", remote: null })
      expect(decryptCalls).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("recovers managed mode by replacing a corrupt profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-connection-profile-"))
    try {
      await writeFile(path.join(root, "connection-profile.json"), "not-json")
      const store = new ConnectionProfileStore(root, controlledProtectedStore())

      await store.useManaged()

      await expect(store.load()).resolves.toEqual({ active: "managed", remote: null })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("surfaces protected credential decrypt failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-connection-profile-"))
    try {
      await writeFile(path.join(root, "connection-profile.json"), JSON.stringify({
        active: "remote",
        remote: {
          base_url: "https://library.example.test",
          encrypted_bearer_token: "protected-secret",
          instance_id: "00000000-0000-4000-8000-000000000001"
        }
      }))
      const store = new ConnectionProfileStore(root, {
        isAvailable: () => true,
        encrypt: (value) => value,
        decrypt: () => { throw new Error("keyring failure") }
      })

      await expect(store.load()).rejects.toMatchObject({
        message: "saved remote credential could not be recovered"
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("preserves filesystem write failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-connection-profile-"))
    try {
      const store = new ConnectionProfileStore(path.join(root, "missing-parent"), controlledProtectedStore())

      await expect(store.saveRemote({
        baseUrl: "https://library.example.test",
        bearerToken: "fixture-owner-token",
        instanceId: "00000000-0000-4000-8000-000000000001"
      })).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects an active remote profile without a remote credential", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-connection-profile-"))
    try {
      await writeFile(path.join(root, "connection-profile.json"), JSON.stringify({ active: "remote", remote: null }))
      await expect(new ConnectionProfileStore(root, controlledProtectedStore()).load())
        .rejects.toBeInstanceOf(ConnectionProfileStoreError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
