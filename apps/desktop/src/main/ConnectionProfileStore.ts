import { safeStorage } from "electron"
import { Uuid } from "@henshin/contracts"
import { Option, Schema } from "effect"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

const RemoteProfilePayload = Schema.Struct({
  base_url: Schema.NonEmptyString,
  bearer_token: Schema.NonEmptyString,
  instance_id: Uuid
})

const StoredRemoteProfile = Schema.Struct({
  version: Schema.Literal(1),
  encrypted_payload: Schema.String
})

const StoredConnectionState = Schema.Struct({
  active: Schema.Literal("managed"),
  remote: Schema.Null
})

const StoredState = Schema.Union([StoredConnectionState, StoredRemoteProfile])

type StoredState = typeof StoredState.Type

const decodeStoredState = (value: unknown): StoredState | null => {
  const decoded = Schema.decodeUnknownOption(StoredState)(value, { onExcessProperty: "error" })
  return Option.isNone(decoded) ? null : decoded.value
}

const decodeRemotePayload = (value: unknown) => {
  const decoded = Schema.decodeUnknownOption(RemoteProfilePayload)(value, { onExcessProperty: "error" })
  return Option.isNone(decoded) ? null : decoded.value
}

export interface RemoteConnectionProfile {
  readonly baseUrl: string
  readonly bearerToken: string
  readonly instanceId: string
}

export type ConnectionStorageMode = "protected" | "session_only"

export interface CredentialStoreAdapter {
  readonly isAvailable: () => boolean
  readonly encrypt: (value: string) => string
  readonly decrypt: (value: string) => string
}

export class ConnectionProfileStoreError extends Error {
  readonly code = "connection_profile_storage_unavailable"

  constructor(message: string) {
    super(message)
    this.name = "ConnectionProfileStoreError"
  }
}

const storedPath = (userDataPath: string): string => path.join(userDataPath, "connection-profile.json")

const electronCredentialStore: CredentialStoreAdapter = {
  isAvailable: () => {
    if (!safeStorage.isEncryptionAvailable()) return false
    return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"
  },
  encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64"))
}

const assertProtectedStorage = (credentialStore: CredentialStoreAdapter): void => {
  if (!credentialStore.isAvailable()) {
    throw new ConnectionProfileStoreError("platform-protected credential storage is unavailable; remote credentials were not saved")
  }
}

export class ConnectionProfileStore {
  private readonly path: string
  private readonly credentialStore: CredentialStoreAdapter

  constructor(userDataPath: string, credentialStore: CredentialStoreAdapter = electronCredentialStore) {
    this.path = storedPath(userDataPath)
    this.credentialStore = credentialStore
  }

  storageMode(): ConnectionStorageMode {
    return this.credentialStore.isAvailable() ? "protected" : "session_only"
  }

  async load(): Promise<{ readonly active: "managed" | "remote"; readonly remote: RemoteConnectionProfile | null }> {
    let state: StoredState
    try {
      const decoded = decodeStoredState(JSON.parse(await readFile(this.path, "utf8")))
      if (decoded === null) throw new ConnectionProfileStoreError("saved connection profile is unreadable")
      state = decoded
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { active: "managed", remote: null }
      }
      throw new ConnectionProfileStoreError("saved connection profile is unreadable")
    }

    if ("active" in state) return { active: "managed", remote: null }
    if (!this.credentialStore.isAvailable()) {
      throw new ConnectionProfileStoreError("platform-protected credential storage is unavailable; saved remote credential could not be recovered")
    }
    try {
      const decoded = decodeRemotePayload(JSON.parse(this.credentialStore.decrypt(state.encrypted_payload)))
      if (decoded === null) throw new Error("invalid protected payload")
      return {
        active: "remote",
        remote: {
          baseUrl: decoded.base_url,
          bearerToken: decoded.bearer_token,
          instanceId: decoded.instance_id
        }
      }
    } catch {
      throw new ConnectionProfileStoreError("saved remote credential could not be recovered")
    }
  }

  async saveRemote(profile: RemoteConnectionProfile): Promise<void> {
    assertProtectedStorage(this.credentialStore)
    const state: StoredState = {
      version: 1,
      encrypted_payload: this.credentialStore.encrypt(JSON.stringify({
        base_url: profile.baseUrl,
        bearer_token: profile.bearerToken,
        instance_id: profile.instanceId
      }))
    }
    await this.write(state)
  }

  async useManaged(): Promise<void> {
    await this.write({ active: "managed", remote: null })
  }

  private async write(state: StoredState): Promise<void> {
    const temporaryPath = `${this.path}.tmp`
    await writeFile(temporaryPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, this.path)
  }
}
