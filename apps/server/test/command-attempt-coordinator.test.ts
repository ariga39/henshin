import { randomUUID } from "node:crypto"
import http from "node:http"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { PrototypeHttpClient, type NoteView } from "@henshin/contracts"
import {
  CommandAttemptStore,
  type CommandAttemptInput
} from "../../desktop/src/main/persistence/CommandAttemptStore"
import {
  LocalDatabaseWorker,
  LocalDatabaseWorkerError
} from "../../desktop/src/main/persistence/LocalDatabaseWorker"
import {
  executeNoteEdit,
  reconcileNoteCommand,
  type NoteCommandClient,
  type VerifiedSession
} from "../../desktop/src/main/CommandCoordinator"
import { ConnectionLifecycle } from "../../desktop/src/main/ConnectionLifecycle"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const localWorkerUrl = new URL("../../desktop/dist/draft-worker.mjs", import.meta.url)
const servers: RunningServer[] = []
const paths = new Set<string>()
const proxies: Array<{ readonly close: () => Promise<void> }> = []

const makeLocalDbPath = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "henshin-command-attempts-"))
  const dbPath = path.join(directory, "desktop.db")
  paths.add(dbPath)
  return dbPath
}

const startOwnedServer = async (): Promise<RunningServer> => {
  const dbPath = await makeTempDbPath()
  paths.add(dbPath)
  const server = await startServer(dbPath)
  servers.push(server)
  return server
}

const sessionFor = (server: RunningServer): VerifiedSession => ({
  instanceId: server.instanceId,
  epoch: server.epoch
})

const startDroppingProxy = async (targetBaseUrl: string): Promise<string> => {
  const target = new URL(targetBaseUrl)
  let dropped = false
  const proxy = http.createServer((request, response) => {
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: Number(target.port),
        method: request.method,
        path: request.url,
        headers: request.headers
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        if (!dropped && request.method === "PUT" && upstreamResponse.statusCode === 200) {
          dropped = true
          upstreamResponse.resume()
          response.destroy()
          return
        }
        upstreamResponse.pipe(response)
      }
    )
    upstream.on("error", () => response.destroy())
    request.pipe(upstream)
  })
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject)
    proxy.listen(0, "127.0.0.1", () => resolve())
  })
  const address = proxy.address()
  if (address === null || typeof address === "string") throw new Error("proxy did not bind")
  const close = (): Promise<void> => new Promise((resolve) => proxy.close(() => resolve()))
  proxies.push({ close })
  return `http://127.0.0.1:${address.port}`
}

const startCountingDroppingProxy = async (
  targetBaseUrl: string
): Promise<{ readonly baseUrl: string; readonly putCount: () => number }> => {
  const target = new URL(targetBaseUrl)
  let dropped = false
  let putCount = 0
  const proxy = http.createServer((request, response) => {
    if (request.method === "PUT") putCount += 1
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: Number(target.port),
        method: request.method,
        path: request.url,
        headers: request.headers
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        if (!dropped && request.method === "PUT" && upstreamResponse.statusCode === 200) {
          dropped = true
          upstreamResponse.resume()
          response.destroy()
          return
        }
        upstreamResponse.pipe(response)
      }
    )
    upstream.on("error", () => response.destroy())
    request.pipe(upstream)
  })
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject)
    proxy.listen(0, "127.0.0.1", () => resolve())
  })
  const address = proxy.address()
  if (address === null || typeof address === "string") throw new Error("proxy did not bind")
  proxies.push({ close: () => new Promise((resolve) => proxy.close(() => resolve())) })
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    putCount: () => putCount
  }
}

const startGatedPutProxy = async (
  targetBaseUrl: string
): Promise<{
  readonly baseUrl: string
  readonly putReceived: Promise<void>
  readonly releasePut: () => void
}> => {
  const target = new URL(targetBaseUrl)
  let putReceivedResolve!: () => void
  const putReceived = new Promise<void>((resolve) => {
    putReceivedResolve = resolve
  })
  let releasePutResolve!: () => void
  const putReleased = new Promise<void>((resolve) => {
    releasePutResolve = resolve
  })

  const proxy = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      if (request.method === "PUT") {
        putReceivedResolve()
        await putReleased
      }
      const upstream = http.request(
        {
          hostname: target.hostname,
          port: Number(target.port),
          method: request.method,
          path: request.url,
          headers: request.headers
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
          upstreamResponse.pipe(response)
        }
      )
      upstream.on("error", () => response.destroy())
      upstream.end(Buffer.concat(chunks))
    })().catch(() => response.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject)
    proxy.listen(0, "127.0.0.1", () => resolve())
  })
  const address = proxy.address()
  if (address === null || typeof address === "string") throw new Error("proxy did not bind")
  const close = (): Promise<void> => new Promise((resolve) => proxy.close(() => resolve()))
  proxies.push({ close })
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    putReceived,
    releasePut: releasePutResolve
  }
}

const withServices = <A>(
  server: RunningServer,
  localDbPath: string,
  program: Effect.Effect<A, unknown, PrototypeHttpClient | CommandAttemptStore>,
  baseUrl = server.baseUrl
): Promise<A> => {
  const localWorker = LocalDatabaseWorker.layer(localDbPath, { workerUrl: localWorkerUrl })
  return Effect.runPromise(
    Effect.provide(
      program,
      Layer.merge(
        PrototypeHttpClient.layer({ baseUrl, bearerToken: server.bearerToken }),
        CommandAttemptStore.layerFromWorker
      ).pipe(Layer.provide(localWorker))
    )
  )
}

afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of paths) await cleanupTempDb(dbPath)
  paths.clear()
})

describe("main command-attempt coordinator", () => {
  it("retains a committed-but-unacknowledged attempt across lifecycle reconnect without replay", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const operationId = randomUUID()
    const proxy = await startCountingDroppingProxy(server.baseUrl)
    const lifecycle = new ConnectionLifecycle({ baseUrl: proxy.baseUrl, bearerToken: server.bearerToken })

    try {
      await lifecycle.connect()
      const handshake = lifecycle.handshakeView()
      const session = { instanceId: handshake.instance_id, epoch: handshake.epoch }
      const result = await withServices(
        server,
        localDbPath,
        Effect.gen(function*() {
          const store = yield* CommandAttemptStore
          const dispatch = yield* Effect.promise(() => lifecycle.run(
            Effect.gen(function*() {
              const client = yield* PrototypeHttpClient
              return yield* executeNoteEdit(
                client,
                store,
                session,
                { noteId: "note-1", text: "lifecycle-recovery", expectedRevision: "0", operationId }
              )
            }).pipe(Effect.result)
          ))
          const before = yield* store.get({ instanceId: session.instanceId, operationId })
          yield* Effect.promise(() => lifecycle.disconnect())
          yield* Effect.promise(() => lifecycle.connect())
          const reconnectedHandshake = lifecycle.handshakeView()
          const reconnected = {
            instanceId: reconnectedHandshake.instance_id,
            epoch: reconnectedHandshake.epoch
          }
          const recovered = yield* Effect.promise(() => lifecycle.run(
            Effect.gen(function*() {
              const client = yield* PrototypeHttpClient
              return yield* reconcileNoteCommand(client, store, reconnected, operationId)
            })
          ))
          const after = yield* store.get({ instanceId: session.instanceId, operationId })
          return { dispatch, before, recovered, after }
        }),
        proxy.baseUrl
      )

      expect(Result.isFailure(result.dispatch)).toBe(true)
      expect(result.before?.status).toBe("unresolved")
      expect(result.recovered.requires_reconciliation).toBe(false)
      expect(result.recovered.server_result?.note).toEqual({
        note_id: "note-1",
        text: "lifecycle-recovery",
        revision: "1"
      })
      expect(result.after?.status).toBe("succeeded")
      expect(proxy.putCount()).toBe(1)
    } finally {
      await lifecycle.close()
    }
  })

  it("fences a held local admission after disconnect before sending a PUT", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const operationId = randomUUID()
    const proxy = await startCountingDroppingProxy(server.baseUrl)
    const lifecycle = new ConnectionLifecycle({ baseUrl: proxy.baseUrl, bearerToken: server.bearerToken })

    try {
      await lifecycle.connect()
      const handshake = lifecycle.handshakeView()
      const session = { instanceId: handshake.instance_id, epoch: handshake.epoch }
      const result = await withServices(
        server,
        localDbPath,
        Effect.gen(function*() {
          const store = yield* CommandAttemptStore
          let admissionStartedResolve!: () => void
          const admissionStarted = new Promise<void>((resolve) => {
            admissionStartedResolve = resolve
          })
          let releaseAdmission!: () => void
          const admissionGate = new Promise<void>((resolve) => {
            releaseAdmission = resolve
          })
          const heldStore: CommandAttemptStore["Service"] = {
            ...store,
            markSubmitted: (key) =>
              Effect.uninterruptible(
                Effect.promise(() => {
                  admissionStartedResolve()
                  return admissionGate
                }).pipe(Effect.andThen(store.markSubmitted(key)))
              )
          }
          const generation = lifecycle.currentGeneration()
          if (generation === null) return yield* Effect.die("missing lifecycle generation")
          let beforeDispatchCalled = false
          const dispatch = lifecycle.run(
            Effect.gen(function*() {
              const client = yield* PrototypeHttpClient
              return yield* executeNoteEdit(
                client,
                heldStore,
                session,
                { noteId: "note-1", text: "must-not-send", expectedRevision: "0", operationId },
                () => {
                  beforeDispatchCalled = true
                  lifecycle.assertGeneration(generation)
                }
              )
            }).pipe(Effect.result)
          ).then(
            (value) => value,
            (error) => error
          )
          yield* Effect.promise(() => admissionStarted)
          const disconnecting = lifecycle.disconnect()
          releaseAdmission()
          const dispatchOutcome = yield* Effect.promise(() => dispatch)
          yield* Effect.promise(() => disconnecting)
          const attempt = yield* store.get({ instanceId: session.instanceId, operationId })
          return { dispatchOutcome, attempt, beforeDispatchCalled }
        }),
        proxy.baseUrl
      )

      expect(result.dispatchOutcome).toBeInstanceOf(Error)
      expect(result.beforeDispatchCalled).toBe(false)
      expect(result.attempt?.status).toBe("rejected")
      expect(result.attempt?.error_code).toBe("not_dispatched")
      expect(proxy.putCount()).toBe(0)
    } finally {
      await lifecycle.close()
    }
  })

  it("records a synchronous before-dispatch guard failure as a terminal local rejection", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const operationId = randomUUID()
    const result = await withServices(
      server,
      localDbPath,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const store = yield* CommandAttemptStore
        const outcome = yield* executeNoteEdit(
          client,
          store,
          sessionFor(server),
          { noteId: "note-1", text: "guarded-local", expectedRevision: "0", operationId },
          () => {
            throw new Error("connection generation changed")
          }
        ).pipe(Effect.result)
        return { outcome, attempt: yield* store.get({ instanceId: server.instanceId, operationId }) }
      })
    )

    expect(Result.isFailure(result.outcome)).toBe(true)
    expect(result.attempt?.status).toBe("rejected")
    expect(result.attempt?.error_code).toBe("not_dispatched")
    expect(result.attempt?.error_message).toBe("command was not dispatched")
  })

  it("keeps a real SQLite attempt after a loopback response stream is dropped after commit", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const operationId = randomUUID()
    const proxyBaseUrl = await startDroppingProxy(server.baseUrl)

    const result = await withServices(
      server,
      localDbPath,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const store = yield* CommandAttemptStore
        const handshake = yield* client.handshake()

        const lost = yield* executeNoteEdit(
          client,
          store,
          sessionFor(server),
          { noteId: "note-1", text: "coordinator-recovered", expectedRevision: "0", operationId }
        ).pipe(Effect.result)
        const before = yield* store.get({ instanceId: handshake.instance_id, operationId })
        const recovered = yield* reconcileNoteCommand(
          client,
          store,
          sessionFor(server),
          operationId
        )
        const after = yield* store.get({ instanceId: handshake.instance_id, operationId })
        return { lost, before, recovered, after }
      }),
      proxyBaseUrl
    )

    expect(Result.isFailure(result.lost)).toBe(true)
    expect(result.before?.status).toBe("unresolved")
    expect(result.recovered.requires_reconciliation).toBe(false)
    expect(result.recovered.server_result?.note).toEqual({
      note_id: "note-1",
      text: "coordinator-recovered",
      revision: "1"
    })
    expect(result.recovered.current_note).toEqual(result.recovered.server_result?.note)
    expect(result.after?.status).toBe("succeeded")
  })

  it("keeps a terminal worker transition when a stale unresolved write follows it", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const operationId = randomUUID()

    await withServices(
      server,
      localDbPath,
      Effect.gen(function*() {
        const store = yield* CommandAttemptStore
        const input: CommandAttemptInput = {
          instanceId: server.instanceId,
          operationId,
          noteId: "note-1",
          intentText: "race",
          baseRevision: "0",
          epoch: server.epoch
        }
        const fakeClient = {
          editNote: () => Effect.succeed({
            instance_id: server.instanceId,
            epoch: server.epoch,
            request_id: randomUUID(),
            server_time: Date.now(),
            data: {
              operation_id: operationId,
              note: { note_id: "note-1", text: "race", revision: "1" },
              expires_at_ms: Date.now() + 1_000
            }
          }),
          getOperation: () => Effect.die("unused"),
          getNote: () => Effect.die("unused")
        } as unknown as NoteCommandClient
        let release!: () => void
        let persistedResolve!: () => void
        const terminalPersisted = new Promise<void>((resolve) => {
          persistedResolve = resolve
        })
        const terminalGate = new Promise<void>((resolve) => {
          release = resolve
        })
        const gatedStore: CommandAttemptStore["Service"] = {
          ...store,
          markSucceeded: (key) =>
            store.markSucceeded(key).pipe(
              Effect.tap(() =>
                Effect.promise(() => {
                  persistedResolve()
                  return terminalGate
                })
              )
            )
        }
        const running = Effect.runPromise(
          executeNoteEdit(
            fakeClient,
            gatedStore,
            sessionFor(server),
            { noteId: "note-1", text: "race", expectedRevision: "0", operationId }
          )
        )
        // Hold the coordinator after its terminal SQLite commit, then overlap
        // a stale unresolved transition before allowing it to return.
        yield* Effect.promise(() => terminalPersisted)
        yield* store.markUnresolved(input)
        const current = yield* store.get(input)
        release()
        const saved = yield* Effect.promise(() => running)
        expect(saved).toEqual({ note_id: "note-1", text: "race", revision: "1" } satisfies NoteView)
        expect(current?.status).toBe("succeeded")
      })
    )
  })

  it("does not downgrade a committed dispatch when read-only reconciliation captured an absent result", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const operationId = randomUUID()
    const gatedProxy = await startGatedPutProxy(server.baseUrl)

    const result = await withServices(
      server,
      localDbPath,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const store = yield* CommandAttemptStore
        let unresolvedReadyResolve!: () => void
        const unresolvedReady = new Promise<void>((resolve) => {
          unresolvedReadyResolve = resolve
        })
        let releaseUnresolved!: () => void
        const unresolvedGate = new Promise<void>((resolve) => {
          releaseUnresolved = resolve
        })
        let terminalPersistedResolve!: () => void
        const terminalPersisted = new Promise<void>((resolve) => {
          terminalPersistedResolve = resolve
        })
        const coordinatedStore: CommandAttemptStore["Service"] = {
          ...store,
          markSucceeded: (key) => store.markSucceeded(key).pipe(Effect.tap(() => Effect.sync(terminalPersistedResolve))),
          markUnresolved: (key) =>
            Effect.promise(() => {
              unresolvedReadyResolve()
              return unresolvedGate
            }).pipe(Effect.flatMap(() => store.markUnresolved(key)))
        }
        const dispatch = Effect.runPromise(
          executeNoteEdit(
            client,
            coordinatedStore,
            sessionFor(server),
            { noteId: "note-1", text: "race-after-commit", expectedRevision: "0", operationId }
          ).pipe(Effect.result)
        )
        yield* Effect.promise(() => gatedProxy.putReceived)
        const reconciliation = Effect.runPromise(
          reconcileNoteCommand(client, coordinatedStore, sessionFor(server), operationId)
        )
        yield* Effect.promise(() => unresolvedReady)
        gatedProxy.releasePut()
        yield* Effect.promise(() => terminalPersisted)
        releaseUnresolved()
        const [dispatchResult, recovered] = yield* Effect.promise(() => Promise.all([dispatch, reconciliation]))
        const attempt = yield* store.get({ instanceId: server.instanceId, operationId })
        return { attempt, dispatchResult, recovered }
      }),
      gatedProxy.baseUrl
    )

    expect(Result.isSuccess(result.dispatchResult)).toBe(true)
    expect(result.attempt?.status).toBe("succeeded")
    expect(result.recovered.requires_reconciliation).toBe(true)
    expect(result.recovered.current_note).toEqual({
      note_id: "note-1",
      text: "race-after-commit",
      revision: "1"
    })
  })

  it("admits a repeated concurrent IPC operation ID once and performs one real write", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const operationId = randomUUID()

    const result = await withServices(
      server,
      localDbPath,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const store = yield* CommandAttemptStore
        let dispatches = 0
        let releaseDispatch!: () => void
        const dispatchStarted = new Promise<void>((resolve) => {
          releaseDispatch = resolve
        })
        const countingClient: NoteCommandClient = {
          ...client,
          editNote: (request) =>
            Effect.sync(() => {
              dispatches += 1
              releaseDispatch()
            }).pipe(Effect.flatMap(() => client.editNote(request)))
        }
        const input = {
          noteId: "note-1",
          text: "one-dispatch",
          expectedRevision: "0",
          operationId
        }
        const first = Effect.runPromise(executeNoteEdit(countingClient, store, sessionFor(server), input).pipe(Effect.result))
        yield* Effect.promise(() => dispatchStarted)
        const second = Effect.runPromise(executeNoteEdit(countingClient, store, sessionFor(server), input).pipe(Effect.result))
        const outcomes = yield* Effect.promise(() => Promise.all([first, second]))
        const note = yield* client.getNote({ params: { id: "note-1" } })
        return { dispatches, outcomes, note }
      })
    )

    expect(result.note.data).toEqual({ note_id: "note-1", text: "one-dispatch", revision: "1" })
    expect(result.dispatches).toBe(1)
    expect(result.outcomes.some(Result.isSuccess)).toBe(true)
  })

  it("leaves a durable unresolved attempt when terminal result persistence fails", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const operationId = randomUUID()

    const result = await withServices(
      server,
      localDbPath,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const store = yield* CommandAttemptStore
        const failingTerminalStore: CommandAttemptStore["Service"] = {
          ...store,
          markSucceeded: () =>
            Effect.fail(new LocalDatabaseWorkerError({ message: "simulated terminal persistence failure" }))
        }
        const outcome = yield* executeNoteEdit(
          client,
          failingTerminalStore,
          sessionFor(server),
          { noteId: "note-1", text: "persist-then-fail", expectedRevision: "0", operationId }
        ).pipe(Effect.result)
        const attempt = yield* store.get({ instanceId: server.instanceId, operationId })
        const recovered = yield* reconcileNoteCommand(
          client,
          failingTerminalStore,
          sessionFor(server),
          operationId
        )
        const note = yield* client.getNote({ params: { id: "note-1" } })
        return { attempt, outcome, note, recovered }
      })
    )

    expect(Result.isFailure(result.outcome)).toBe(true)
    expect(result.attempt?.status).toBe("unresolved")
    expect(result.note.data).toEqual({ note_id: "note-1", text: "persist-then-fail", revision: "1" })
    expect(result.recovered.attempt.status).toBe("unresolved")
    expect(result.recovered.server_result?.note).toEqual({
      note_id: "note-1",
      text: "persist-then-fail",
      revision: "1"
    })
    expect(result.recovered.requires_reconciliation).toBe(true)
    expect(result.recovered.reconciliation_reason).toBe("persistence_failed")
  })

  it("does not dispatch when local attempt admission persistence fails", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const operationId = randomUUID()

    const result = await withServices(
      server,
      localDbPath,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const store = yield* CommandAttemptStore
        let dispatches = 0
        const countingClient: NoteCommandClient = {
          ...client,
          editNote: (request) =>
            Effect.sync(() => {
              dispatches += 1
            }).pipe(Effect.flatMap(() => client.editNote(request)))
        }
        const failingStore: CommandAttemptStore["Service"] = {
          ...store,
          admit: () =>
            Effect.fail(new LocalDatabaseWorkerError({ message: "simulated admission persistence failure" }))
        }
        const outcome = yield* executeNoteEdit(
          countingClient,
          failingStore,
          sessionFor(server),
          { noteId: "note-1", text: "must-not-dispatch", expectedRevision: "0", operationId }
        ).pipe(Effect.result)
        const note = yield* client.getNote({ params: { id: "note-1" } })
        return { dispatches, outcome, note }
      })
    )

    expect(Result.isFailure(result.outcome)).toBe(true)
    expect(result.dispatches).toBe(0)
    expect(result.note.data).toEqual({ note_id: "note-1", text: "hello", revision: "0" })
  })

  it("keeps unknown outcomes unresolved while retained expired success stays known", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const unknownOperationId = randomUUID()
    const expiredOperationId = randomUUID()

    const result = await withServices(
      server,
      localDbPath,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const store = yield* CommandAttemptStore
        yield* store.admit({
          instanceId: server.instanceId,
          operationId: unknownOperationId,
          noteId: "note-1",
          intentText: "unknown-intent",
          baseRevision: "0",
          epoch: server.epoch
        })
        yield* store.markSubmitted({ instanceId: server.instanceId, operationId: unknownOperationId })
        const unknown = yield* reconcileNoteCommand(
          client,
          store,
          sessionFor(server),
          unknownOperationId
        )

        yield* store.admit({
          instanceId: server.instanceId,
          operationId: expiredOperationId,
          noteId: "note-1",
          intentText: "expired-intent",
          baseRevision: "0",
          epoch: server.epoch
        })
        yield* store.markSucceeded({
          instanceId: server.instanceId,
          operationId: expiredOperationId,
          resultNote: { note_id: "note-1", text: "expired-intent", revision: "1" },
          expiresAtMs: Date.now() - 1
        })
        let dispatches = 0
        const duplicateClient: NoteCommandClient = {
          ...client,
          editNote: (request) =>
            Effect.sync(() => {
              dispatches += 1
            }).pipe(Effect.flatMap(() => client.editNote(request)))
        }
        const duplicate = yield* executeNoteEdit(
          duplicateClient,
          store,
          sessionFor(server),
          {
            noteId: "note-1",
            text: "expired-intent",
            expectedRevision: "0",
            operationId: expiredOperationId
          }
        )
        const expired = yield* reconcileNoteCommand(
          client,
          store,
          sessionFor(server),
          expiredOperationId
        )
        const note = yield* client.getNote({ params: { id: "note-1" } })
        return { dispatches, duplicate, expired, note, unknown }
      })
    )

    expect(result.unknown.attempt.status).toBe("unresolved")
    expect(result.unknown.attempt.intent_text).toBe("unknown-intent")
    expect(result.unknown.server_result).toBeNull()
    expect(result.unknown.reconciliation_reason).toBe("operation_expired")
    expect(result.unknown.requires_reconciliation).toBe(true)
    expect(result.expired.attempt.status).toBe("succeeded")
    expect(result.expired.attempt.intent_text).toBe("expired-intent")
    expect(result.duplicate).toEqual({ note_id: "note-1", text: "expired-intent", revision: "1" })
    expect(result.dispatches).toBe(0)
    expect(result.expired.server_result?.note).toEqual({
      note_id: "note-1",
      text: "expired-intent",
      revision: "1"
    })
    expect(result.expired.server_result?.expires_at_ms).toBeLessThan(Date.now())
    expect(result.expired.reconciliation_reason).toBe("complete")
    expect(result.expired.requires_reconciliation).toBe(false)
    expect(result.note.data).toEqual({ note_id: "note-1", text: "hello", revision: "0" })
  })

  it("settles a hanging dispatch and status read into durable unresolved recovery", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const dispatchOperationId = randomUUID()
    const statusOperationId = randomUUID()

    const result = await withServices(
      server,
      localDbPath,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const store = yield* CommandAttemptStore
        const hangingDispatchClient: NoteCommandClient = {
          ...client,
          editNote: () => Effect.never
        }
        const dispatchOutcome = yield* executeNoteEdit(
          hangingDispatchClient,
          store,
          sessionFor(server),
          { noteId: "note-1", text: "dispatch-timeout", expectedRevision: "0", operationId: dispatchOperationId }
        ).pipe(Effect.result)
        const dispatchAttempt = yield* store.get({ instanceId: server.instanceId, operationId: dispatchOperationId })

        yield* store.admit({
          instanceId: server.instanceId,
          operationId: statusOperationId,
          noteId: "note-1",
          intentText: "status-timeout",
          baseRevision: "0",
          epoch: server.epoch
        })
        yield* store.markSubmitted({ instanceId: server.instanceId, operationId: statusOperationId })
        const hangingStatusClient: NoteCommandClient = {
          ...client,
          getOperation: () => Effect.never
        }
        const statusRecovery = yield* reconcileNoteCommand(
          hangingStatusClient,
          store,
          sessionFor(server),
          statusOperationId
        )
        const statusAttempt = yield* store.get({ instanceId: server.instanceId, operationId: statusOperationId })
        const note = yield* client.getNote({ params: { id: "note-1" } })
        return { dispatchAttempt, dispatchOutcome, note, statusAttempt, statusRecovery }
      })
    )

    expect(Result.isFailure(result.dispatchOutcome)).toBe(true)
    expect(result.dispatchAttempt?.status).toBe("unresolved")
    expect(result.statusAttempt?.status).toBe("unresolved")
    expect(result.statusRecovery.requires_reconciliation).toBe(true)
    expect(result.statusRecovery.reconciliation_reason).toBe("query_unavailable")
    expect(result.note.data).toEqual({ note_id: "note-1", text: "hello", revision: "0" })
  })

  it("does not dispatch when local attempt admission is full", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const operationId = randomUUID()

    const result = await withServices(
      server,
      localDbPath,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const store = yield* CommandAttemptStore
        let dispatches = 0
        const countingClient: NoteCommandClient = {
          ...client,
          editNote: (request) =>
            Effect.sync(() => {
              dispatches += 1
            }).pipe(Effect.flatMap(() => client.editNote(request)))
        }
        for (let index = 0; index < 64; index += 1) {
          yield* store.admit({
            instanceId: server.instanceId,
            operationId: randomUUID(),
            noteId: "note-1",
            intentText: `reserved-${index}`,
            baseRevision: "0",
            epoch: server.epoch
          })
        }
        const rejected = yield* executeNoteEdit(
          countingClient,
          store,
          sessionFor(server),
          { noteId: "note-1", text: "must-not-dispatch", expectedRevision: "0", operationId }
        ).pipe(Effect.result)
        const note = yield* client.getNote({ params: { id: "note-1" } })
        const operation = yield* client
          .getOperation({
            params: { id: operationId },
            query: { instance_id: server.instanceId, epoch: server.epoch }
          })
          .pipe(Effect.result)
        return { dispatches, rejected, note, operation }
      })
    )

    expect(Result.isFailure(result.rejected)).toBe(true)
    expect(result.dispatches).toBe(0)
    expect(result.note.data).toEqual({ note_id: "note-1", text: "hello", revision: "0" })
    expect(Result.isFailure(result.operation)).toBe(true)
  })

  it("retains an unresolved intent across server restart and only reads after epoch change", async () => {
    const server = await startOwnedServer()
    const localDbPath = await makeLocalDbPath()
    const operationId = randomUUID()
    const oldEpoch = server.epoch

    await withServices(
      server,
      localDbPath,
      Effect.gen(function*() {
        const store = yield* CommandAttemptStore
        yield* store.admit({
          instanceId: server.instanceId,
          operationId,
          noteId: "note-1",
          intentText: "survive-restart",
          baseRevision: "0",
          epoch: oldEpoch
        })
        yield* store.markSubmitted({ instanceId: server.instanceId, operationId })
      })
    )

    const dbPath = server.dbPath
    await server.stop()
    const index = servers.indexOf(server)
    if (index >= 0) servers.splice(index, 1)
    const restarted = await startServer(dbPath)
    servers.push(restarted)

    const recovered = await withServices(
      restarted,
      localDbPath,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const store = yield* CommandAttemptStore
        return yield* reconcileNoteCommand(
          client,
          store,
          sessionFor(restarted),
          operationId
        )
      })
    )

    expect(restarted.epoch).not.toBe(oldEpoch)
    expect(recovered.attempt.intent_text).toBe("survive-restart")
    expect(recovered.attempt.epoch).toBe(oldEpoch)
    expect(recovered.server_result).toBeNull()
    expect(recovered.current_note).toEqual({ note_id: "note-1", text: "hello", revision: "0" })
    expect(recovered.requires_reconciliation).toBe(true)
  })
})
