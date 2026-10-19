import { Data, Duration, Effect, Fiber, ManagedRuntime } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { PrototypeHttpClient, type ConnectionStatusView } from "@henshin/contracts"

const NETWORK_DEADLINE = Duration.seconds(5)
const CLEANUP_DEADLINE_MS = 5_000

export class ConnectionPausedError extends Data.TaggedError("ConnectionPausedError")<{
  readonly state: ConnectionStatusView["state"]
}> {}

export class ConnectionInstanceMismatchError extends Data.TaggedError("ConnectionInstanceMismatchError")<{
  readonly expectedInstanceId: string
  readonly actualInstanceId: string
}> {}

export interface ConnectionLifecycleOptions {
  readonly baseUrl: string
  readonly bearerToken: string
}

interface Lease {
  readonly generation: number
  readonly runtime: ManagedRuntime.ManagedRuntime<PrototypeHttpClient, never>
  readonly instanceId: string
  readonly epoch: string
}

interface Candidate {
  readonly generation: number
  readonly runtime: ManagedRuntime.ManagedRuntime<PrototypeHttpClient, never>
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const disposeBounded = async (runtime: ManagedRuntime.ManagedRuntime<PrototypeHttpClient, never>): Promise<void> => {
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
  private readonly candidates = new Map<number, Candidate>()
  private readonly activeFibers = new Map<number, Set<Fiber.Fiber<unknown, unknown>>>()

  constructor(options: ConnectionLifecycleOptions) {
    this.options = options
  }

  getStatus(): ConnectionStatusView {
    return this.status
  }

  getSession(): { readonly instanceId: string; readonly epoch: string } | null {
    if (this.lease === null) return null
    return { instanceId: this.lease.instanceId, epoch: this.lease.epoch }
  }

  getNamespace(): string | null {
    return this.expectedInstanceId
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

    const runtime = ManagedRuntime.make(
      PrototypeHttpClient.layer({
        baseUrl: this.options.baseUrl,
        bearerToken: this.options.bearerToken,
        transportLayer: NodeHttpClient.layerUndici
      })
    )
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
      this.lease = null
      this.status = {
        state: "blocked",
        instance_id: this.expectedInstanceId,
        epoch: null,
        reason: error instanceof ConnectionInstanceMismatchError ? "instance_mismatch" : "authentication_or_network_failure"
      }
      throw error
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

  run<A, E>(effect: Effect.Effect<A, E, PrototypeHttpClient>): Promise<A> {
    const lease = this.lease
    if (lease === null) return Promise.reject(new ConnectionPausedError({ state: this.status.state }))
    const fiber = lease.runtime.runFork(effect.pipe(Effect.timeout(NETWORK_DEADLINE))) as Fiber.Fiber<A, E | never>
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
