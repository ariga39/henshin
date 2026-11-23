import { createServer } from "node:http"
import { access, readFile, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const SERVER_PATH = fileURLToPath(new URL("../dist/server.mjs", import.meta.url))
const READY_TIMEOUT_MS = 5_000
const EXIT_TIMEOUT_MS = 5_000

interface Attempt {
  readonly child: ChildProcessWithoutNullStreams
  readonly stdout: () => string
  readonly stderr: () => string
}

interface RunningServer extends Attempt {
  readonly baseUrl: string
  readonly instanceId: string
  readonly epoch: string
}

interface ReadyLine {
  readonly event: "ready"
  readonly port: number
  readonly instance_id: string
  readonly epoch: string
}

const attempts = new Set<Attempt>()
const dataDirectories = new Set<string>()

const waitForExit = (
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      reject(new Error("independent server did not exit before the test deadline"))
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve({ code: child.exitCode, signal: child.signalCode })
    }
    child.once("exit", onExit)
  })
}

const launch = (args: ReadonlyArray<string>): Attempt => {
  const child = spawn(process.execPath, [SERVER_PATH, ...args], {
    stdio: ["pipe", "pipe", "pipe"]
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })
  const attempt = { child, stdout: () => stdout, stderr: () => stderr }
  attempts.add(attempt)
  return attempt
}

const waitForReady = async (attempt: Attempt): Promise<ReadyLine> =>
  new Promise((resolve, reject) => {
    let buffer = ""
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`server readiness timed out; stderr=${attempt.stderr()}`))
    }, READY_TIMEOUT_MS)
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        try {
          const parsed = JSON.parse(line) as Partial<ReadyLine>
          if (parsed.event === "ready" && typeof parsed.port === "number") {
            cleanup()
            resolve(parsed as ReadyLine)
            return
          }
        } catch {
          // Ignore non-JSON diagnostics on stdout.
        }
        newline = buffer.indexOf("\n")
      }
    }
    const onExit = () => {
      cleanup()
      reject(new Error(`server exited before readiness; stderr=${attempt.stderr()}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      attempt.child.stdout.off("data", onData)
      attempt.child.off("exit", onExit)
    }
    attempt.child.stdout.on("data", onData)
    attempt.child.once("exit", onExit)
  })

const freeLoopbackPort = async (): Promise<number> => {
  const listener = createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", () => resolve())
  })
  const address = listener.address()
  if (address === null || typeof address === "string") throw new Error("failed to reserve a loopback port")
  const port = address.port
  await new Promise<void>((resolve, reject) => listener.close((error) => error === undefined ? resolve() : reject(error)))
  return port
}

const initializeOwner = async (
  selection: ReadonlyArray<string>
): Promise<{ readonly attempt: Attempt; readonly token: string }> => {
  const attempt = launch([...selection, "--initialize-owner"])
  const result = await waitForExit(attempt.child, EXIT_TIMEOUT_MS)
  expect(result).toEqual({ code: 0, signal: null })
  const token = /^owner_token=([^\n]+)$/mu.exec(attempt.stdout())?.[1]
  if (token === undefined) throw new Error(`owner token was not printed; stdout=${attempt.stdout()}`)
  return { attempt, token }
}

const startServer = async (
  selection: ReadonlyArray<string>,
  port: number
): Promise<RunningServer> => {
  const attempt = launch([...selection, "--port", String(port)])
  const ready = await waitForReady(attempt)
  return {
    ...attempt,
    baseUrl: `http://127.0.0.1:${ready.port}`,
    instanceId: ready.instance_id,
    epoch: ready.epoch
  }
}

const stopServer = async (server: RunningServer): Promise<void> => {
  server.child.kill("SIGTERM")
  // Effect's default teardown maps a signal interruption to exit code 130.
  await expect(waitForExit(server.child, EXIT_TIMEOUT_MS)).resolves.toEqual({ code: 130, signal: null })
}

const expectUsageFailure = async (args: ReadonlyArray<string>): Promise<void> => {
  const attempt = launch(args)
  await expect(waitForExit(attempt.child, EXIT_TIMEOUT_MS)).resolves.toEqual({ code: 2, signal: null })
  expect(attempt.stdout()).toBe("")
  expect(attempt.stderr()).toContain("usage: server.mjs")
}

afterEach(async () => {
  for (const attempt of attempts) {
    if (attempt.child.exitCode === null && attempt.child.signalCode === null) {
      attempt.child.kill("SIGKILL")
      await waitForExit(attempt.child, EXIT_TIMEOUT_MS).catch(() => undefined)
    }
  }
  attempts.clear()
  for (const directory of dataDirectories) await rm(directory, { recursive: true, force: true })
  dataDirectories.clear()
})

describe("independent foreground service", () => {
  it("initializes an owner, serves authenticated HTTP on a stable port, and restarts with a new epoch", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "henshin-independent-service-"))
    dataDirectories.add(dataDir)
    const port = await freeLoopbackPort()
    const initialized = await initializeOwner(["--data-dir", dataDir])
    expect(initialized.attempt.child.spawnargs.join(" ")).not.toContain(initialized.token)
    const authPath = path.join(dataDir, ".henshin-server-auth.sqlite")
    const authState = await readFile(authPath)
    expect(authState.includes(Buffer.from(initialized.token))).toBe(false)
    expect((await stat(authPath)).mode & 0o777).toBe(0o600)

    const first = await startServer(["--data-dir", dataDir], port)
    expect(first.stdout()).not.toContain(initialized.token)
    expect(first.stderr()).not.toContain(initialized.token)
    try {
      const unauthorized = await fetch(`${first.baseUrl}/prototype/v1/handshake`)
      const unauthorizedBody = await unauthorized.text()
      expect(unauthorized.status).toBe(401)
      expect(unauthorizedBody).not.toContain(first.instanceId)
      expect(unauthorizedBody).not.toContain(first.epoch)

      const authenticated = await fetch(`${first.baseUrl}/prototype/v1/handshake`, {
        headers: { authorization: `Bearer ${initialized.token}` }
      })
      expect(authenticated.status).toBe(200)
      expect((await authenticated.json()) as { instance_id: string; epoch: string }).toMatchObject({
        instance_id: first.instanceId,
        epoch: first.epoch
      })

      const disconnectedClientCanReconnect = await fetch(`${first.baseUrl}/prototype/v1/note/note-1`, {
        headers: { authorization: `Bearer ${initialized.token}` }
      })
      expect(disconnectedClientCanReconnect.status).toBe(200)

      await stopServer(first)
      const second = await startServer(["--data-dir", dataDir], port)
      try {
        expect(second.instanceId).toBe(first.instanceId)
        expect(second.epoch).not.toBe(first.epoch)
        const afterRestart = await fetch(`${second.baseUrl}/prototype/v1/handshake`, {
          headers: { authorization: `Bearer ${initialized.token}` }
        })
        expect(afterRestart.status).toBe(200)
      } finally {
        await stopServer(second)
      }
    } finally {
      if (first.child.exitCode === null && first.child.signalCode === null) await stopServer(first)
    }
  })

  it("requires explicit database selection when a managed database is not server.sqlite", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "henshin-managed-reuse-"))
    dataDirectories.add(dataDir)
    const database = path.join(dataDir, "Library.DB")
    const initialized = await initializeOwner(["--database", database])
    const port = await freeLoopbackPort()
    const server = await startServer(["--database", database], port)
    try {
      const response = await fetch(`${server.baseUrl}/prototype/v1/handshake`, {
        headers: { authorization: `Bearer ${initialized.token}` }
      })
      expect(response.status).toBe(200)
      await stopServer(server)

      const ambiguous = launch(["--data-dir", dataDir, "--port", String(port)])
      const result = await waitForExit(ambiguous.child, EXIT_TIMEOUT_MS)
      expect(result).toEqual({ code: 1, signal: null })
      expect(ambiguous.stdout()).not.toContain('"event":"ready"')
      expect(ambiguous.stderr()).toContain("existing database requires explicit --database selection")
    } finally {
      if (server.child.exitCode === null && server.child.signalCode === null) await stopServer(server)
    }
  })

  it("detects a symlinked database candidate without creating the default", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "henshin-symlink-guard-"))
    const targetDir = await mkdtemp(path.join(os.tmpdir(), "henshin-symlink-target-"))
    const target = path.join(targetDir, "real-library.sqlite")
    const link = path.join(dataDir, "Library.SQLITE")
    dataDirectories.add(dataDir)
    dataDirectories.add(targetDir)
    await writeFile(target, "fixture")
    await symlink(target, link)

    const attempt = launch(["--data-dir", dataDir, "--port", String(await freeLoopbackPort())])
    await expect(waitForExit(attempt.child, EXIT_TIMEOUT_MS)).resolves.toEqual({ code: 1, signal: null })
    expect(attempt.stderr()).toContain("existing database requires explicit --database selection")
    await expect(access(path.join(dataDir, "server.sqlite"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not turn a dangling database symlink into a new default library", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "henshin-dangling-guard-"))
    const link = path.join(dataDir, "Library.DB")
    dataDirectories.add(dataDir)
    await symlink(path.join(dataDir, "missing.sqlite"), link)

    const attempt = launch(["--data-dir", dataDir, "--port", String(await freeLoopbackPort())])
    await expect(waitForExit(attempt.child, EXIT_TIMEOUT_MS)).resolves.toEqual({ code: 1, signal: null })
    expect(attempt.stderr()).toContain("existing database requires explicit --database selection")
    await expect(access(path.join(dataDir, "server.sqlite"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects empty data-directory and database values", async () => {
    await expectUsageFailure(["--data-dir", ""])
    await expectUsageFailure(["--database", ""])
  })
})
