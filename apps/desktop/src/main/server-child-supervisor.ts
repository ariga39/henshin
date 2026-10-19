import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"

const TOKEN_BYTES = 32
const READY_TIMEOUT_MS = 20_000
const SHUTDOWN_TIMEOUT_MS = 5_000

export interface ServerChild {
  readonly baseUrl: string
  readonly bearerToken: string
  readonly stop: () => Promise<void>
}

export interface ServerChildSupervisorOptions {
  readonly serverPath: string
  readonly executablePath: string
  readonly environment?: NodeJS.ProcessEnv
  readonly readyTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  /** Test-only observation of the exact owned process. */
  readonly onSpawn?: (child: ChildProcessWithoutNullStreams) => void
}

interface ReadyLine {
  readonly event: "ready"
  readonly port: number
  readonly instance_id: string
  readonly epoch: string
}

const waitForExit = (child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once("exit", onExit)
  })
}

const waitForReady = (
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<ReadyLine> =>
  new Promise((resolve, reject) => {
    let buffer = ""
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("server readiness timed out"))
    }, timeoutMs)

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line) as Partial<ReadyLine>
            if (parsed.event === "ready" && typeof parsed.port === "number") {
              cleanup()
              resolve(parsed as ReadyLine)
              return
            }
          } catch {
            // Ignore non-JSON diagnostic output on stdout.
          }
        }
        newline = buffer.indexOf("\n")
      }
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = () => {
      cleanup()
      reject(new Error("server exited before it reported readiness"))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off("data", onData)
      child.off("error", onError)
      child.off("exit", onExit)
    }

    child.stdout.on("data", onData)
    child.on("error", onError)
    child.on("exit", onExit)
  })

export const startServerChildProcess = async (
  dbPath: string,
  options: ServerChildSupervisorOptions
): Promise<ServerChild> => {
  const bearerToken = randomBytes(TOKEN_BYTES).toString("base64url")
  const child = spawn(options.executablePath, [options.serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.environment === undefined ? {} : { env: options.environment })
  })
  let spawnFailed = false
  child.on("error", () => {
    spawnFailed = true
  })
  options.onSpawn?.(child)

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim()
    if (text.length > 0) console.error(`[server] ${text}`)
  })

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (spawnFailed) return
    const timeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS
    const exited = waitForExit(child, timeoutMs)
    try {
      child.stdin.end()
    } catch {
      // Channel already closed.
    }
    if (!(await exited) && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
      await waitForExit(child, timeoutMs)
    }
  }

  try {
    child.stdin.write(JSON.stringify({ bearerToken, dbPath }) + "\n")
    const ready = await waitForReady(child, options.readyTimeoutMs ?? READY_TIMEOUT_MS)
    child.stdout.resume()
    return {
      baseUrl: `http://127.0.0.1:${ready.port}`,
      bearerToken,
      stop
    }
  } catch (error) {
    await stop()
    throw error
  }
}
