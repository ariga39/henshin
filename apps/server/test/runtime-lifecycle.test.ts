import { readFile } from "node:fs/promises"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Duration, Exit, Fiber, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import { startServerChildProcess } from "../../desktop/src/main/server-child-supervisor"
import { DatabaseWorker, type DatabaseWorkerOptions } from "../src/persistence/DatabaseWorker"
import {
  cleanupTempDb,
  makeTempDbPath,
  startServer
} from "./support/server-process"

const workerFixture = new URL("./support/database-worker-fixture.mjs", import.meta.url)
const neverReadyFixture = fileURLToPath(new URL("./support/never-ready-child.mjs", import.meta.url))
const readRequest = { op: "readNote" as const, noteId: "note-1" }

const runWithWorker = async <A>(
  options: DatabaseWorkerOptions,
  program: (runtime: ManagedRuntime.ManagedRuntime<DatabaseWorker, never>) => Promise<A>
): Promise<A> => {
  const runtime = ManagedRuntime.make(
    DatabaseWorker.layer("unused-test-database.db", { workerUrl: workerFixture, ...options })
  )
  try {
    return await program(runtime)
  } finally {
    await runtime.dispose()
  }
}

const waitForExit = (child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      reject(new Error("child did not exit before the test deadline"))
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve()
    }
    child.once("exit", onExit)
  })
}

const forceCleanup = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.stdin.destroy()
  child.kill("SIGKILL")
  await waitForExit(child, 2_000).catch(() => undefined)
}

const waitForArrivals = async (arrivalPath: string, count: number): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const arrivals = await readFile(arrivalPath, "utf8").catch(() => "")
    if (arrivals.trim().split("\n").filter(Boolean).length >= count) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`worker did not receive ${count} requests before the test deadline`)
}

describe("database worker lifecycle", () => {
  it("settles every pending call when the worker dies", async () => {
    await runWithWorker(
      { workerData: { mode: "exit-after-count", exitAfter: 8 } },
      async (runtime) => {
        const worker = await runtime.runPromise(DatabaseWorker)
        const calls = Array.from({ length: 8 }, () => runtime.runFork(worker.call(readRequest)))
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        const exits = await Promise.all(calls.map((fiber) => runtime.runPromise(Fiber.await(fiber))))
        expect(exits).toHaveLength(8)
        expect(exits.every(Exit.isFailure)).toBe(true)
        const failureCauses = exits.map((exit) =>
          Exit.match({ onSuccess: () => "success", onFailure: (cause) => String(cause) })(exit)
        )
        expect(failureCauses.every((cause) => cause.includes("database worker exited"))).toBe(true)
        await expect(runtime.runPromise(worker.call(readRequest))).rejects.toMatchObject({
          message: "database worker is not running"
        })
      }
    )
  })

  it("enforces deadlines and removes interrupted calls", async () => {
    await runWithWorker(
      {
        workerData: { delayMs: 200 },
        callDeadline: Duration.millis(40)
      },
      async (runtime) => {
        const worker = await runtime.runPromise(DatabaseWorker)
        await expect(runtime.runPromise(worker.call(readRequest))).rejects.toMatchObject({
          message: "database worker call timed out"
        })

        const interrupted = runtime.runFork(worker.call(readRequest))
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        await runtime.runPromise(Fiber.interrupt(interrupted))
        const interruptedExit = await runtime.runPromise(Fiber.await(interrupted))
        expect(Exit.isFailure(interruptedExit)).toBe(true)

        const recovered = runtime.runFork(worker.call(readRequest))
        await runtime.runPromise(Fiber.interrupt(recovered))
        expect(Exit.isFailure(await runtime.runPromise(Fiber.await(recovered)))).toBe(true)
        await expect(runtime.runPromise(worker.call(readRequest))).rejects.toMatchObject({
          message: "database worker call timed out"
        })
      }
    )
  })

  it("rejects the 65th call only after 64 calls are confirmed pending", async () => {
    const dbPath = await makeTempDbPath()
    const arrivalPath = path.join(path.dirname(dbPath), "worker-arrivals")
    try {
      await runWithWorker(
        {
          workerData: { mode: "hold", arrivalPath },
          callDeadline: Duration.seconds(2),
          shutdownDeadlineMs: 40
        },
        async (runtime) => {
          const worker = await runtime.runPromise(DatabaseWorker)
          const pending = Array.from({ length: 64 }, () => runtime.runFork(worker.call(readRequest)))
          await waitForArrivals(arrivalPath, 64)
          await expect(runtime.runPromise(worker.call(readRequest))).rejects.toMatchObject({
            message: "database worker admission limit reached"
          })
          for (const fiber of pending) await runtime.runPromise(Fiber.interrupt(fiber))

          const recovered = runtime.runFork(worker.call(readRequest))
          await waitForArrivals(arrivalPath, 65)
          await runtime.runPromise(Fiber.interrupt(recovered))
          expect(Exit.isFailure(await runtime.runPromise(Fiber.await(recovered)))).toBe(true)
        }
      )
    } finally {
      await cleanupTempDb(dbPath)
    }
  })

  it("bounds graceful close when the worker does not acknowledge close", async () => {
    const started = Date.now()
    await runWithWorker(
      { workerData: { mode: "ignore-close" }, shutdownDeadlineMs: 40 },
      async (runtime) => {
        const worker = await runtime.runPromise(DatabaseWorker)
        await runtime.runPromise(worker.call(readRequest))
      }
    )
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe("owned server child lifecycle", () => {
  const serverPath = fileURLToPath(new URL("../dist/server.mjs", import.meta.url))

  const productionSupervisorOptions = (
    onSpawn: (child: ChildProcessWithoutNullStreams) => void,
    overrides: {
      readonly serverPath?: string
      readonly executablePath?: string
      readonly readyTimeoutMs?: number
      readonly shutdownTimeoutMs?: number
    } = {}
  ) => ({
    serverPath: overrides.serverPath ?? serverPath,
    executablePath: overrides.executablePath ?? process.execPath,
    environment: process.env,
    onSpawn,
    readyTimeoutMs: overrides.readyTimeoutMs,
    shutdownTimeoutMs: overrides.shutdownTimeoutMs
  })

  it("cleans up a failed readiness child through the production supervisor", async () => {
    const seedPath = await makeTempDbPath()
    const badDbPath = path.join(path.dirname(seedPath), "missing", "prototype.db")
    let ownedChild: ChildProcessWithoutNullStreams | undefined
    try {
      await expect(
        startServerChildProcess(
          badDbPath,
          productionSupervisorOptions((child) => {
            ownedChild = child
          })
        )
      ).rejects.toThrow("server exited before it reported readiness")
      expect(ownedChild).toBeDefined()
      if (ownedChild !== undefined) await waitForExit(ownedChild, 2_000)
      expect(ownedChild?.exitCode ?? ownedChild?.signalCode).not.toBeNull()
    } finally {
      if (ownedChild !== undefined) await forceCleanup(ownedChild)
      await cleanupTempDb(seedPath)
    }
  })

  it("force-terminates a never-ready child at the readiness deadline", async () => {
    const dbPath = await makeTempDbPath()
    let ownedChild: ChildProcessWithoutNullStreams | undefined
    try {
      await expect(
        startServerChildProcess(
          dbPath,
          productionSupervisorOptions(
            (child) => {
              ownedChild = child
            },
            { serverPath: neverReadyFixture, readyTimeoutMs: 50, shutdownTimeoutMs: 50 }
          )
        )
      ).rejects.toThrow("server readiness timed out")
      expect(ownedChild).toBeDefined()
      expect(ownedChild?.signalCode).toBe("SIGKILL")
    } finally {
      if (ownedChild !== undefined) await forceCleanup(ownedChild)
      await cleanupTempDb(dbPath)
    }
  })

  it("settles a missing-executable spawn without an unhandled child error", async () => {
    const dbPath = await makeTempDbPath()
    let ownedChild: ChildProcessWithoutNullStreams | undefined
    try {
      await expect(
        startServerChildProcess(
          dbPath,
          productionSupervisorOptions((child) => {
            ownedChild = child
          }, { executablePath: path.join(path.dirname(process.execPath), "missing-server-runtime") })
        )
      ).rejects.toThrow()
      expect(ownedChild).toBeDefined()
    } finally {
      if (ownedChild !== undefined) await forceCleanup(ownedChild)
      await cleanupTempDb(dbPath)
    }
  })

  it("normal stop closes the production-owned child within its deadline", async () => {
    const dbPath = await makeTempDbPath()
    let ownedChild: ChildProcessWithoutNullStreams | undefined
    let managed: Awaited<ReturnType<typeof startServerChildProcess>> | undefined
    try {
      managed = await startServerChildProcess(
        dbPath,
        productionSupervisorOptions((child) => {
          ownedChild = child
        })
      )
      await managed.stop()
      expect(ownedChild).toBeDefined()
      if (ownedChild !== undefined) await waitForExit(ownedChild, 1_000)
      expect(ownedChild?.exitCode ?? ownedChild?.signalCode).not.toBeNull()
    } finally {
      if (managed !== undefined) await managed.stop()
      if (ownedChild !== undefined) await forceCleanup(ownedChild)
      await cleanupTempDb(dbPath)
    }
  })

  it("keeps an independent server alive when the production-owned child loses its parent channel", async () => {
    const managedPath = await makeTempDbPath()
    const independentPath = await makeTempDbPath()
    const independent = await startServer(independentPath)
    let ownedChild: ChildProcessWithoutNullStreams | undefined
    let managed: Awaited<ReturnType<typeof startServerChildProcess>> | undefined
    try {
      managed = await startServerChildProcess(
        managedPath,
        productionSupervisorOptions((child) => {
          ownedChild = child
        })
      )
      expect(ownedChild).toBeDefined()
      ownedChild?.stdin.destroy()
      if (ownedChild !== undefined) await waitForExit(ownedChild, 5_000)
      expect(ownedChild?.exitCode ?? ownedChild?.signalCode).not.toBeNull()

      const response = await fetch(`${independent.baseUrl}/prototype/v1/handshake`, {
        headers: { authorization: `Bearer ${independent.bearerToken}` }
      })
      expect(response.status).toBe(200)
    } finally {
      if (managed !== undefined) await managed.stop()
      await independent.stop()
      if (ownedChild !== undefined) await forceCleanup(ownedChild)
      await cleanupTempDb(managedPath)
      await cleanupTempDb(independentPath)
    }
  })
})
