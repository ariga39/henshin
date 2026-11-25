import { Data, Duration, Effect, Fiber, Layer, ManagedRuntime, Schema } from "effect"
import * as HttpClientError from "effect/http/HttpClientError"
import { NodeHttpClient } from "@effect/platform-node"
import {
  HANDSHAKE_API_VERSION,
  HANDSHAKE_CAPABILITY,
  LibraryHttpClient,
  OpenEventHttpClient,
  PrototypeHttpClient,
  ReviewHttpClient,
  ServerHttpClient,
  TaskHttpClient,
  ThumbnailHttpClient,
  type ConnectionStatusView
} from "@henshin/contracts"

const NETWORK_DEADLINE = Duration.seconds(5)
const CLEANUP_DEADLINE_MS = 5_000

export class ConnectionPausedError extends Data.TaggedError("ConnectionPausedError")<{
  readonly state: ConnectionStatusView["state"]
}> {}

export class ConnectionInstanceMismatchError extends Data.TaggedError("ConnectionInstanceMismatchError")<{
  readonly expectedInstanceId: string
  readonly actualInstanceId: string
}> {}

export type ConnectionFailureCode =
  | "connection_authentication_failed"
  | "connection_tls_expired"
  | "connection_tls_hostname"
  | "connection_tls_untrusted"
  | "connection_tls_failed"
  | "connection_redirect_refused"
  | "connection_endpoint_failed"
  | "connection_server_failed"
  | "connection_response_invalid"
  | "connection_failed"

export interface ConnectionFailureInfo {
  readonly code: ConnectionFailureCode
  readonly message: string
  readonly retryable: boolean
}

export class ConnectionCompatibilityError extends Data.TaggedError("ConnectionCompatibilityError")<{
  readonly message: string
  readonly apiVersion: string
  readonly missingCapabilities: ReadonlyArray<string>
}> {}

export class ConnectionFailureError extends Data.TaggedError("ConnectionFailureError")<ConnectionFailureInfo> {}

export class ConnectionEndpointError extends Data.TaggedError("ConnectionEndpointError")<{
  readonly message: string
}> {}

export class ConnectionConfirmationError extends Data.TaggedError("ConnectionConfirmationError")<{
  readonly message: string
}> {}

export interface ConnectionLifecycleOptions {
  readonly baseUrl: string
  readonly bearerToken: string
  readonly expectedInstanceId?: string | null
}

interface Lease {
  readonly generation: number
  readonly runtime: ManagedRuntime.ManagedRuntime<
    PrototypeHttpClient | ServerHttpClient | LibraryHttpClient | TaskHttpClient | ReviewHttpClient | OpenEventHttpClient | ThumbnailHttpClient,
    never
  >
  readonly instanceId: string
  readonly epoch: string
}

interface Candidate {
  readonly generation: number
  readonly runtime: ManagedRuntime.ManagedRuntime<
    PrototypeHttpClient | ServerHttpClient | LibraryHttpClient | TaskHttpClient | ReviewHttpClient | OpenEventHttpClient | ThumbnailHttpClient,
    never
  >
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const tlsCauseCodes = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
])

type TlsFailureKind = "expired" | "not-yet-valid" | "revoked" | "hostname" | "untrusted" | "certificate"

const tlsFailureKind = (cause: unknown): TlsFailureKind | null => {
  if (cause === null || typeof cause !== "object") return null
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : ""
  const message = "message" in cause && typeof cause.message === "string" ? cause.message : ""
  const details = `${code} ${message}`
  if (code === "CERT_HAS_EXPIRED" || /certificate has expired/iu.test(details)) return "expired"
  if (code === "CERT_NOT_YET_VALID" || /certificate is not yet valid|notBefore/iu.test(details)) return "not-yet-valid"
  if (code === "CERT_REVOKED" || /certificate.*revoked/iu.test(details)) return "revoked"
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID" || /hostname|host name|altname|ip address.*(match|mismatch)/iu.test(details)) {
    return "hostname"
  }
  if (
    tlsCauseCodes.has(code) ||
    /self[- ]signed certificate|unable to (get|verify).*issuer certificate|unable to verify (?:the )?(?:first )?certificate/iu.test(details)
  ) return "untrusted"
  if (/certificate|cert_/iu.test(details)) return "certificate"
  return null
}

const errorCode = (error: unknown): string | null => {
  if (error === null || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return null
  return error.code
}

const classifyHttpStatus = (status: number): ConnectionFailureInfo | null => {
  if (status === 401 || status === 403) {
    return {
      code: "connection_authentication_failed",
      message: "The server rejected the owner credential. Verify the token and try again.",
      retryable: false
    }
  }
  if (status >= 300 && status < 400) {
    return {
      code: "connection_redirect_refused",
      message: "The endpoint redirected the request. Enter the final HTTPS endpoint; credentials are not sent through redirects.",
      retryable: false
    }
  }
  if (status >= 400 && status < 500) {
    return {
      code: "connection_endpoint_failed",
      message: `The endpoint returned HTTP ${status}. Check that the URL points to the Henshin HTTPS endpoint, then try again.`,
      retryable: false
    }
  }
  if (status >= 500) {
    return {
      code: "connection_server_failed",
      message: `The remote server returned HTTP ${status}. Check the server health and logs, fix the service, then retry.`,
      retryable: true
    }
  }
  return null
}

export const classifyConnectionFailure = (error: unknown): ConnectionFailureInfo => {
  if (errorCode(error) === "authentication_required") {
    return {
      code: "connection_authentication_failed",
      message: "The server rejected the owner credential. Verify the token and try again.",
      retryable: false
    }
  }
  if (HttpClientError.isHttpClientError(error)) {
    const reason = error.reason
    if ("response" in reason) {
      const statusFailure = classifyHttpStatus(reason.response.status)
      if (statusFailure !== null) return statusFailure
    }
    if (reason._tag === "DecodeError" || reason._tag === "EmptyBodyError") {
      return {
        code: "connection_response_invalid",
        message: "The endpoint returned an invalid or incomplete handshake. Check that the URL points to a compatible Henshin server, then try again.",
        retryable: false
      }
    }
    if (reason._tag === "TransportError") {
      const kind = tlsFailureKind(reason.cause)
      if (kind === "expired") {
        return {
          code: "connection_tls_expired",
          message: "The server certificate has expired. Renew the certificate on the server, then retry.",
          retryable: false
        }
      }
      if (kind === "hostname") {
        return {
          code: "connection_tls_hostname",
          message: "The server certificate does not cover this hostname. Use the hostname covered by the certificate, or fix the certificate, then retry.",
          retryable: false
        }
      }
      if (kind === "not-yet-valid") {
        return {
          code: "connection_tls_failed",
          message: "The server certificate is not valid yet. Check the server certificate's start date and the desktop's clock, then retry.",
          retryable: false
        }
      }
      if (kind === "revoked") {
        return {
          code: "connection_tls_failed",
          message: "The server certificate has been revoked. Replace it with a valid certificate, then retry.",
          retryable: false
        }
      }
      if (kind === "untrusted") {
        return {
          code: "connection_tls_untrusted",
          message: "The server certificate is not trusted. Configure the desktop's Node HTTPS trust store (for example with NODE_EXTRA_CA_CERTS), restart the desktop so Node loads it, then retry.",
          retryable: false
        }
      }
      if (kind === "certificate") {
        return {
          code: "connection_tls_failed",
          message: "The server certificate failed TLS validation. Check its validity and signature, then configure a valid certificate before retrying.",
          retryable: false
        }
      }
    }
  }
  if (Schema.isSchemaError(error)) {
    return {
      code: "connection_response_invalid",
      message: "The endpoint returned an invalid or incomplete handshake. Check that the URL points to a compatible Henshin server, then try again.",
      retryable: false
    }
  }
  return {
    code: "connection_failed",
    message: "The HTTPS server could not be reached. Check the endpoint and that the service is running, then retry.",
    retryable: true
  }
}

const disposeBounded = async (
  runtime: ManagedRuntime.ManagedRuntime<
    PrototypeHttpClient | ServerHttpClient | LibraryHttpClient | TaskHttpClient | ReviewHttpClient | OpenEventHttpClient | ThumbnailHttpClient,
    never
  >
): Promise<void> => {
  await Promise.race([runtime.dispose().catch(() => undefined), delay(CLEANUP_DEADLINE_MS)])
}

/**
 * Main-owned lifecycle for one managed endpoint. Local persistence is not part
 * of this scope: disconnect only fences and disposes authenticated HTTP work.
 */
export class ConnectionLifecycle {
  private readonly options: ConnectionLifecycleOptions
  private generation = 0
  private lease: Lease | null = null
  private status: ConnectionStatusView = {
    state: "disconnected",
    instance_id: null,
    epoch: null,
    reason: null
  }
  private expectedInstanceId: string | null = null
  private cachedSession: { readonly instanceId: string; readonly epoch: string } | null = null
  private readonly candidates = new Map<number, Candidate>()
  private readonly activeFibers = new Map<number, Set<Fiber.Fiber<unknown, unknown>>>()

  constructor(options: ConnectionLifecycleOptions) {
    this.options = options
    this.expectedInstanceId = options.expectedInstanceId ?? null
  }

  static validateRemoteEndpoint(raw: string): string {
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new ConnectionEndpointError({ message: "enter a valid HTTPS server endpoint" })
    }
    if (parsed.protocol !== "https:") {
      throw new ConnectionEndpointError({ message: "remote server endpoints must use HTTPS" })
    }
    if (/[?#]/u.test(raw) || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
      throw new ConnectionEndpointError({ message: "server endpoints cannot contain credentials, queries, or fragments" })
    }
    if (parsed.hostname === "") {
      throw new ConnectionEndpointError({ message: "enter a valid HTTPS server endpoint" })
    }
    return parsed.toString().replace(/\/+$/u, "")
  }

  getStatus(): ConnectionStatusView {
    return this.status
  }

  markBlocked(reason: string): void {
    this.status = {
      state: "blocked",
      instance_id: this.expectedInstanceId,
      epoch: null,
      reason
    }
  }

  getSession(): { readonly instanceId: string; readonly epoch: string } | null {
    if (this.lease === null) return null
    return { instanceId: this.lease.instanceId, epoch: this.lease.epoch }
  }

  getNamespace(): string | null {
    return this.expectedInstanceId
  }

  getCachedSession(): { readonly instanceId: string; readonly epoch: string } | null {
    return this.cachedSession
  }

  currentGeneration(): number | null {
    return this.lease?.generation ?? null
  }

  assertGeneration(generation: number): void {
    if (this.generation !== generation || this.lease?.generation !== generation) {
      throw new ConnectionPausedError({ state: this.status.state })
    }
  }

  handshakeView(): { readonly instance_id: string; readonly epoch: string } {
    if (this.lease === null) {
      throw new ConnectionPausedError({ state: this.status.state })
    }
    return { instance_id: this.lease.instanceId, epoch: this.lease.epoch }
  }

  async connect(): Promise<ConnectionStatusView> {
    const generation = ++this.generation
    this.status = {
      state: "connecting",
      instance_id: this.expectedInstanceId,
      epoch: null,
      reason: null
    }

    const oldLease = this.lease
    this.lease = null
    const oldCandidates = Array.from(this.candidates.values())
    this.candidates.clear()
    await Promise.all([
      ...(oldLease === null ? [] : [this.stopLease(oldLease)]),
      ...oldCandidates.map((candidate) => disposeBounded(candidate.runtime))
    ])
    if (generation !== this.generation) return this.status

    const options = { ...this.options, transportLayer: NodeHttpClient.layerUndici }
    const runtime = ManagedRuntime.make(Layer.mergeAll(
      PrototypeHttpClient.layer(options),
      ServerHttpClient.layer(options),
      LibraryHttpClient.layer(options),
      TaskHttpClient.layer(options),
      ReviewHttpClient.layer(options),
      OpenEventHttpClient.layer(options),
      ThumbnailHttpClient.layer(options)
    ))
    const candidate = { generation, runtime }
    this.candidates.set(generation, candidate)

    try {
      const handshake = await runtime.runPromise(
        Effect.gen(function*() {
          const client = yield* PrototypeHttpClient
          return yield* client.handshake()
        }).pipe(Effect.timeout(Duration.seconds(5)))
      )
      this.candidates.delete(generation)
      if (generation !== this.generation) {
        await disposeBounded(runtime)
        return this.status
      }
      const missingCapabilities = [HANDSHAKE_CAPABILITY.libraryBrowse].filter(
        (capability) => !handshake.data.capabilities.includes(capability)
      )
      if (handshake.data.api_version !== HANDSHAKE_API_VERSION || missingCapabilities.length > 0) {
        throw new ConnectionCompatibilityError({
          message: "The server does not support the desktop Library API; use a compatible Henshin server.",
          apiVersion: handshake.data.api_version,
          missingCapabilities
        })
      }
      if (this.expectedInstanceId !== null && handshake.instance_id !== this.expectedInstanceId) {
        throw new ConnectionInstanceMismatchError({
          expectedInstanceId: this.expectedInstanceId,
          actualInstanceId: handshake.instance_id
        })
      }
      this.expectedInstanceId = handshake.instance_id
      this.lease = {
        generation,
        runtime,
        instanceId: handshake.instance_id,
        epoch: handshake.epoch
      }
      this.cachedSession = { instanceId: handshake.instance_id, epoch: handshake.epoch }
      this.status = {
        state: "connected",
        instance_id: handshake.instance_id,
        epoch: handshake.epoch,
        reason: null
      }
      return this.status
    } catch (error) {
      this.candidates.delete(generation)
      await disposeBounded(runtime)
      if (generation !== this.generation) return this.status
      const failure = error instanceof ConnectionInstanceMismatchError || error instanceof ConnectionCompatibilityError
        ? error
        : new ConnectionFailureError(classifyConnectionFailure(error))
      this.lease = null
      this.status = {
        state: "blocked",
        instance_id: this.expectedInstanceId,
        epoch: null,
        reason: failure instanceof ConnectionInstanceMismatchError
          ? "instance_mismatch"
          : failure.message
      }
      throw failure
    }
  }

  async disconnect(): Promise<ConnectionStatusView> {
    ++this.generation
    this.status = {
      state: "disconnected",
      instance_id: this.expectedInstanceId,
      epoch: null,
      reason: "explicit_disconnect"
    }
    const lease = this.lease
    this.lease = null
    const candidates = Array.from(this.candidates.values())
    this.candidates.clear()
    await Promise.all([
      ...(lease === null ? [] : [this.stopLease(lease)]),
      ...candidates.map((candidate) => disposeBounded(candidate.runtime))
    ])
    return this.status
  }

  async close(): Promise<void> {
    await this.disconnect()
  }

  run<A, E>(
    effect: Effect.Effect<
      A,
      E,
      PrototypeHttpClient | ServerHttpClient | LibraryHttpClient | TaskHttpClient | ReviewHttpClient | OpenEventHttpClient | ThumbnailHttpClient
    >,
    timeout = NETWORK_DEADLINE
  ): Promise<A> {
    const lease = this.lease
    if (lease === null) return Promise.reject(new ConnectionPausedError({ state: this.status.state }))
    const fiber = lease.runtime.runFork(effect.pipe(Effect.timeout(timeout))) as Fiber.Fiber<A, E | never>
    const fibers = this.activeFibers.get(lease.generation) ?? new Set<Fiber.Fiber<unknown, unknown>>()
    fibers.add(fiber as Fiber.Fiber<unknown, unknown>)
    this.activeFibers.set(lease.generation, fibers)
    return Effect.runPromise(Fiber.join(fiber)).then(
      (value) => {
        if (this.generation !== lease.generation || this.lease !== lease) {
          throw new ConnectionPausedError({ state: this.status.state })
        }
        return value
      },
      (error) => Promise.reject(error)
    ).finally(() => {
      fibers.delete(fiber as Fiber.Fiber<unknown, unknown>)
      if (fibers.size === 0) this.activeFibers.delete(lease.generation)
    })
  }

  private async stopLease(lease: Lease): Promise<void> {
    const fibers = Array.from(this.activeFibers.get(lease.generation) ?? [])
    const interrupt = Promise.all(
      fibers.map((fiber) => Effect.runPromise(Fiber.interrupt(fiber)).catch(() => undefined))
    )
    // Start disposal immediately: the scoped NodeHttpClient finalizer destroys
    // the owned dispatcher even if an interrupted request is slow to settle.
    const dispose = lease.runtime.dispose().catch(() => undefined)
    await Promise.race([Promise.all([interrupt, dispose]), delay(CLEANUP_DEADLINE_MS)])
    this.activeFibers.delete(lease.generation)
  }
}
