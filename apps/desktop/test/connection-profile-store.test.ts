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

const protectedRecord = (payload: unknown, version = 1): string => JSON.stringify({
  version,
  encrypted_payload: controlledProtectedStore().encrypt(JSON.stringify(payload))
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
      expect(raw).not.toContain(profile.baseUrl)
      expect(raw).not.toContain(profile.bearerToken)
      expect(raw).not.toContain(profile.instanceId)
      expect(JSON.parse(raw)).toEqual({ version: 1, encrypted_payload: expect.any(String) })
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

  it("keeps the credential-free managed profile usable without decrypting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-connection-profile-"))
    let decryptCalls = 0
    try {
      await writeFile(path.join(root, "connection-profile.json"), JSON.stringify({
        active: "managed",
        remote: null
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

  it("fails closed on legacy remote records without exposing their fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-connection-profile-"))
    const endpoint = "https://legacy.example.test"
    const instanceId = "00000000-0000-4000-8000-000000000001"
    try {
      await writeFile(path.join(root, "connection-profile.json"), JSON.stringify({
        active: "remote",
        remote: { base_url: endpoint, encrypted_bearer_token: "dummy-ciphertext", instance_id: instanceId }
      }))

      let diagnostic = ""
      try {
        await new ConnectionProfileStore(root, controlledProtectedStore()).load()
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : String(error)
      }
      expect(diagnostic).toBe("saved connection profile is unreadable")
      expect(diagnostic).not.toContain(endpoint)
      expect(diagnostic).not.toContain(instanceId)
      expect(diagnostic).not.toContain("dummy-ciphertext")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { base_url: "", bearer_token: "dummy-token", instance_id: "00000000-0000-4000-8000-000000000001" },
    { base_url: "https://malformed.example.test", bearer_token: "", instance_id: "00000000-0000-4000-8000-000000000001" },
    { base_url: "https://malformed.example.test", bearer_token: "dummy-token", instance_id: "not-a-uuid" },
    { base_url: "https://malformed.example.test", bearer_token: "dummy-token", instance_id: "00000000-0000-4000-8000-000000000001", active: "remote" }
  ])("rejects malformed protected payloads without exposing decrypted values", async (payload) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-connection-profile-"))
    const endpoint = "https://malformed.example.test"
    try {
      await writeFile(path.join(root, "connection-profile.json"), protectedRecord(payload))

      let diagnostic = ""
      try {
        await new ConnectionProfileStore(root, controlledProtectedStore()).load()
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : String(error)
      }
      expect(diagnostic).toBe("saved remote credential could not be recovered")
      expect(diagnostic).not.toContain(endpoint)
      expect(diagnostic).not.toContain("dummy-token")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      active: "managed",
      remote: null,
      base_url: "https://legacy.example.test",
      instance_id: "00000000-0000-4000-8000-000000000001"
    },
    {
      active: "managed",
      remote: {
        base_url: "https://legacy.example.test",
        encrypted_bearer_token: "dummy-ciphertext",
        instance_id: "00000000-0000-4000-8000-000000000001"
      }
    },
    {
      version: 1,
      encrypted_payload: "dummy-ciphertext",
      active: "managed",
      remote: null
    }
  ])("rejects ambiguous outer profile records", async (record) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "henshin-connection-profile-"))
    try {
      await writeFile(path.join(root, "connection-profile.json"), JSON.stringify(record))
      await expect(new ConnectionProfileStore(root, controlledProtectedStore()).load())
        .rejects.toMatchObject({ message: "saved connection profile is unreadable" })
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
      await writeFile(path.join(root, "connection-profile.json"), protectedRecord({
        base_url: "https://library.example.test",
        bearer_token: "dummy-token",
        instance_id: "00000000-0000-4000-8000-000000000001"
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
