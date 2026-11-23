import { safeStorage } from "electron"
import { Option, Schema } from "effect"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

const StoredRemoteProfile = Schema.Struct({
  base_url: Schema.String,
  encrypted_bearer_token: Schema.String,
  instance_id: Schema.String
})

const StoredConnectionState = Schema.Struct({
  active: Schema.Union([Schema.Literal("managed"), Schema.Literal("remote")]),
  remote: Schema.NullOr(StoredRemoteProfile)
})

type StoredConnectionState = typeof StoredConnectionState.Type

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

const decodeStoredState = (value: unknown): StoredConnectionState | null => {
  const decoded = Schema.decodeUnknownOption(StoredConnectionState)(value)
  if (Option.isNone(decoded)) return null
  return decoded.value.active === "remote" && decoded.value.remote === null ? null : decoded.value
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
    let state: StoredConnectionState
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

    if (state.active === "managed" || state.remote === null) return { active: state.active, remote: null }
    if (!this.credentialStore.isAvailable()) {
      throw new ConnectionProfileStoreError("platform-protected credential storage is unavailable; saved remote credential could not be recovered")
    }
    try {
      return {
        active: state.active,
        remote: {
          baseUrl: state.remote.base_url,
          bearerToken: this.credentialStore.decrypt(state.remote.encrypted_bearer_token),
          instanceId: state.remote.instance_id
        }
      }
    } catch {
      throw new ConnectionProfileStoreError("saved remote credential could not be recovered")
    }
  }

  async saveRemote(profile: RemoteConnectionProfile): Promise<void> {
    assertProtectedStorage(this.credentialStore)
    const state: StoredConnectionState = {
      active: "remote",
      remote: {
        base_url: profile.baseUrl,
        encrypted_bearer_token: this.credentialStore.encrypt(profile.bearerToken),
        instance_id: profile.instanceId
      }
    }
    await this.write(state)
  }

  async useManaged(): Promise<void> {
    await this.write({ active: "managed", remote: null })
  }

  private async write(state: StoredConnectionState): Promise<void> {
    const temporaryPath = `${this.path}.tmp`
    await writeFile(temporaryPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, this.path)
  }
}
