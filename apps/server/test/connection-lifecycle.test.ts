import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import { Deferred, Effect, ManagedRuntime } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PrototypeHttpClient } from "@henshin/contracts"
import {
  ConnectionLifecycle,
  ConnectionPausedError
} from "../../desktop/src/main/ConnectionLifecycle"

vi.mock("effect", async (importOriginal) => {
  const effect = await importOriginal<typeof import("effect")>()
  return {
    ...effect,
    ManagedRuntime: {
      ...effect.ManagedRuntime,
      make: vi.fn(effect.ManagedRuntime.make)
    }
  }
})

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111"
const EPOCH = "22222222-2222-4222-8222-222222222222"

interface Fixture {
  readonly baseUrl: string
  readonly requests: Array<string>
  readonly noteReceived: Promise<void>
  readonly releaseNote: () => void
  readonly socketClosed: Promise<void>
  readonly handshakeReceived: Promise<void>
  readonly blockNextHandshake: () => Promise<void>
  readonly setHandshakeInstance: (instanceId: string) => void
  readonly rejectHandshake: () => void
  readonly allowHandshake: () => void
  readonly releaseHandshake: () => void
  readonly close: () => Promise<void>
}

const json = (response: ServerResponse, data: unknown): void => {
  const body = JSON.stringify(data)
  response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  response.end(body)
}

const startFixture = async (holdNote: boolean): Promise<Fixture> => {
  const requests: Array<string> = []
  let noteReceivedResolve!: () => void
  const noteReceived = new Promise<void>((resolve) => {
    noteReceivedResolve = resolve
  })
  let releaseNote!: () => void
  const noteGate = new Promise<void>((resolve) => {
    releaseNote = resolve
  })
  let socketClosedResolve!: () => void
  const socketClosed = new Promise<void>((resolve) => {
    socketClosedResolve = resolve
  })
  let gatedHandshakeSocketClosed: Promise<void> | null = null
  let gatedHandshakeSocketClosedResolve: (() => void) | null = null
  let handshakeReceivedResolve!: () => void
  const handshakeReceived = new Promise<void>((resolve) => {
    handshakeReceivedResolve = resolve
  })
  let blockHandshake = false
  let handshakeInstance = INSTANCE_ID
  let rejectHandshake = false
  let releaseHandshake!: () => void
  const handshakeGate = new Promise<void>((resolve) => {
    releaseHandshake = resolve
  })

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    requests.push(request.url ?? "")
    if (request.url === "/prototype/v1/handshake") {
      if (blockHandshake) {
        blockHandshake = false
        const resolveGatedHandshakeSocketClosed = gatedHandshakeSocketClosedResolve
        if (resolveGatedHandshakeSocketClosed === null) throw new Error("gated handshake socket was not registered")
        request.socket.once("close", resolveGatedHandshakeSocketClosed)
        handshakeReceivedResolve()
        await handshakeGate
      }
      if (rejectHandshake) {
        response.writeHead(401, { "content-type": "application/json" })
        response.end(JSON.stringify({ code: "authentication_required", message: "authentication required" }))
        return
      }
      json(response, {
        instance_id: handshakeInstance,
        epoch: EPOCH,
        request_id: randomUUID(),
        server_time: Date.now(),
        data: { api_version: "prototype/1", capabilities: ["prototype-note-edit"] }
      })
      return
    }
    if (request.url === "/prototype/v1/note/note-1") {
      request.socket.once("close", socketClosedResolve)
      noteReceivedResolve()
      if (holdNote) await noteGate
      json(response, {
        instance_id: INSTANCE_ID,
        epoch: EPOCH,
        request_id: randomUUID(),
        server_time: Date.now(),
        data: { note_id: "note-1", text: "hello", revision: "0" }
      })
      return
    }
    response.writeHead(404)
    response.end()
  }
  const server = createServer((request, response) => void handler(request, response))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("fixture did not bind a TCP port")

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    noteReceived,
    releaseNote,
    socketClosed,
    handshakeReceived,
    blockNextHandshake: () => {
      blockHandshake = true
      gatedHandshakeSocketClosed = new Promise<void>((resolve) => {
        gatedHandshakeSocketClosedResolve = resolve
      })
      return gatedHandshakeSocketClosed
    },
    setHandshakeInstance: (instanceId) => {
      handshakeInstance = instanceId
    },
    rejectHandshake: () => {
      rejectHandshake = true
    },
    allowHandshake: () => {
      rejectHandshake = false
    },
    releaseHandshake,
    close: () => {
      releaseNote()
      releaseHandshake()
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
}

const clientEffect = <A>(effect: Effect.Effect<A, unknown, PrototypeHttpClient>) => effect

describe("main-owned connection lifecycle", () => {
  const fixtures: Array<Fixture> = []
  const lifecycles: Array<ConnectionLifecycle> = []

  afterEach(async () => {
    for (const lifecycle of lifecycles.splice(0)) await lifecycle.close()
    for (const fixture of fixtures.splice(0)) await fixture.close()
  })

  it("interrupts a real pending read and closes the generation-owned socket on disconnect", async () => {
    const fixture = await startFixture(true)
    fixtures.push(fixture)
    const lifecycle = new ConnectionLifecycle({ baseUrl: fixture.baseUrl, bearerToken: "test-token" })
    lifecycles.push(lifecycle)
    fixture.releaseHandshake()
    await lifecycle.connect()

    const pending = lifecycle.run(
      clientEffect(
        Effect.gen(function*() {
          const client = yield* PrototypeHttpClient
          return yield* client.getNote({ params: { id: "note-1" } })
        })
      )
    ).then(
      () => null,
      (error) => error
    )
    await fixture.noteReceived
    const disconnected = await lifecycle.disconnect()
    fixture.releaseNote()

    expect(await pending).toBeInstanceOf(Error)
    await fixture.socketClosed
    expect(disconnected.state).toBe("disconnected")
    expect(fixture.requests.filter((url) => url === "/prototype/v1/note/note-1")).toHaveLength(1)
  })

  it("does not let a stale handshake reopen a later disconnected generation", async () => {
    const fixture = await startFixture(false)
    fixtures.push(fixture)
    const lifecycle = new ConnectionLifecycle({ baseUrl: fixture.baseUrl, bearerToken: "test-token" })
    lifecycles.push(lifecycle)

    await lifecycle.connect()
    const gatedHandshakeSocketClosed = fixture.blockNextHandshake()
    const reconnect = lifecycle.connect()
    await fixture.handshakeReceived
    const disconnected = lifecycle.disconnect()
    await gatedHandshakeSocketClosed
    fixture.releaseHandshake()

    await Promise.all([reconnect, disconnected])
    expect(lifecycle.getStatus().state).toBe("disconnected")
    expect(lifecycle.getSession()).toBeNull()
    await expect(
      lifecycle.run(
        clientEffect(
          Effect.gen(function*() {
            const client = yield* PrototypeHttpClient
            return yield* client.getNote({ params: { id: "note-1" } })
          })
        )
      )
    ).rejects.toBeInstanceOf(ConnectionPausedError)
  })

  it("keeps a newer candidate while an older lease cleanup is still held", async () => {
    const fixture = await startFixture(false)
    fixtures.push(fixture)
    const lifecycle = new ConnectionLifecycle({ baseUrl: fixture.baseUrl, bearerToken: "test-token" })
    lifecycles.push(lifecycle)
    await lifecycle.connect()

    const cleanupStarted = await Effect.runPromise(Deferred.make<void>())
    const releaseCleanup = await Effect.runPromise(Deferred.make<void>())
    const heldWork = lifecycle.run(
      Effect.uninterruptible(
        Effect.andThen(
          Deferred.succeed(cleanupStarted, undefined),
          Deferred.await(releaseCleanup)
        )
      )
    ).then(
      () => null,
      (error) => error
    )

    const oldReconnect = lifecycle.connect()
    await Effect.runPromise(Deferred.await(cleanupStarted))
    const gatedHandshakeSocketClosed = fixture.blockNextHandshake()
    const newerReconnect = lifecycle.connect()
    await fixture.handshakeReceived
    const disconnected = lifecycle.disconnect()
    await gatedHandshakeSocketClosed

    await Effect.runPromise(Deferred.succeed(releaseCleanup, undefined))
    fixture.releaseHandshake()
    await Promise.all([oldReconnect, newerReconnect, disconnected])
    expect(await heldWork).toBeInstanceOf(Error)
    expect(lifecycle.getStatus().state).toBe("disconnected")
    expect(lifecycle.getSession()).toBeNull()
  })

  it("blocks a reconnect that changes endpoint identity without rebinding the retained namespace", async () => {
    const fixture = await startFixture(false)
    fixtures.push(fixture)
    const lifecycle = new ConnectionLifecycle({ baseUrl: fixture.baseUrl, bearerToken: "test-token" })
    lifecycles.push(lifecycle)
    await lifecycle.connect()
    await lifecycle.disconnect()

    fixture.setHandshakeInstance("99999999-9999-4999-8999-999999999999")
    await expect(lifecycle.connect()).rejects.toThrow()
    expect(lifecycle.getStatus()).toMatchObject({
      state: "blocked",
      instance_id: INSTANCE_ID,
      reason: "instance_mismatch"
    })
    expect(lifecycle.getNamespace()).toBe(INSTANCE_ID)
    expect(lifecycle.getSession()).toBeNull()

    fixture.setHandshakeInstance(INSTANCE_ID)
    fixture.rejectHandshake()
    await expect(lifecycle.connect()).rejects.toThrow()
    expect(lifecycle.getStatus()).toMatchObject({
      state: "blocked",
      instance_id: INSTANCE_ID,
      reason: "authentication_or_network_failure"
    })
  })

  it("blocks an explicit authentication failure without mutation or namespace loss", async () => {
    const fixture = await startFixture(false)
    fixtures.push(fixture)
    const lifecycle = new ConnectionLifecycle({ baseUrl: fixture.baseUrl, bearerToken: "test-token" })
    lifecycles.push(lifecycle)
    await lifecycle.connect()
    await lifecycle.disconnect()

    fixture.rejectHandshake()
    await expect(lifecycle.connect()).rejects.toThrow()

    expect(lifecycle.getStatus()).toMatchObject({
      state: "blocked",
      instance_id: INSTANCE_ID,
      epoch: null,
      reason: "authentication_or_network_failure"
    })
    expect(lifecycle.getNamespace()).toBe(INSTANCE_ID)
    expect(lifecycle.getSession()).toBeNull()
    await expect(
      lifecycle.run(
        clientEffect(
          Effect.gen(function*() {
            const client = yield* PrototypeHttpClient
            return yield* client.editNote({
              params: { id: "note-1" },
              payload: {
                operation_id: randomUUID(),
                expected_revision: "0",
                text: "must-not-send",
                instance_id: INSTANCE_ID,
                epoch: EPOCH
              }
            })
          })
        )
      )
    ).rejects.toBeInstanceOf(ConnectionPausedError)
    expect(fixture.requests.filter((url) => url === "/prototype/v1/note/note-1")).toHaveLength(0)
  })

  it("blocks on the handshake error when owned runtime disposal rejects and permits reconnect", async () => {
    const fixture = await startFixture(false)
    fixtures.push(fixture)
    const lifecycle = new ConnectionLifecycle({ baseUrl: fixture.baseUrl, bearerToken: "test-token" })
    lifecycles.push(lifecycle)
    fixture.rejectHandshake()

    const make = vi.mocked(ManagedRuntime.make)
    const originalMake = make.getMockImplementation()
    if (originalMake === undefined) throw new Error("ManagedRuntime.make mock has no implementation")
    const disposeError = new Error("runtime disposal failed")
    let rejectNextDispose = true
    make.mockImplementation((layer, options) => {
      const runtime = originalMake(layer, options)
      if (rejectNextDispose) {
        rejectNextDispose = false
        const actualDispose = runtime.dispose
        return {
          ...runtime,
          dispose: async () => {
            await actualDispose()
            throw disposeError
          }
        }
      }
      return runtime
    })

    try {
      let handshakeError: unknown
      try {
        await lifecycle.connect()
      } catch (error) {
        handshakeError = error
      }

      expect(handshakeError).toMatchObject({ _tag: "HttpClientError" })
      expect(String(handshakeError)).toContain("401")
      expect(handshakeError).not.toBe(disposeError)
      expect(lifecycle.getStatus()).toMatchObject({
        state: "blocked",
        reason: "authentication_or_network_failure"
      })

      fixture.allowHandshake()
      await expect(lifecycle.connect()).resolves.toMatchObject({ state: "connected" })
    } finally {
      make.mockImplementation(originalMake)
    }
  })
})
