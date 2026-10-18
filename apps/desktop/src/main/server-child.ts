import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { app } from "electron"

const TOKEN_BYTES = 32
const READY_TIMEOUT_MS = 20_000
const SHUTDOWN_TIMEOUT_MS = 5_000

export interface ServerChild {
  readonly baseUrl: string
  readonly bearerToken: string
  readonly stop: () => Promise<void>
}

interface ReadyLine {
  readonly event: "ready"
  readonly port: number
  readonly instance_id: string
  readonly epoch: string
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitForReady = (child: ChildProcessWithoutNullStreams): Promise<ReadyLine> =>
  new Promise((resolve, reject) => {
    let buffer = ""
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("server readiness timed out"))
    }, READY_TIMEOUT_MS)

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

/**
 * Starts the independent server as a child of this Electron process.
 *
 * The bearer token is generated here and sent over the child's stdin (the
 * private control channel), never through argv, the environment, or logs. The
 * bundled Electron Node runtime runs the server via ELECTRON_RUN_AS_NODE so the
 * packaged desktop does not depend on a system Node installation.
 *
 * If startup fails or times out, this function stops only the child it created
 * before rejecting; it never leaves an owned process behind.
 */
export const startServerChild = async (dbPath: string): Promise<ServerChild> => {
  const bearerToken = randomBytes(TOKEN_BYTES).toString("base64url")
  const serverPath = path.join(app.getAppPath(), "dist", "server", "server.mjs")

  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  })

  // Surface server diagnostics on stderr for local debugging only; they never
  // include the token.
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim()
    if (text.length > 0) console.error(`[server] ${text}`)
  })

  const stop = async () => {
    if (child.exitCode !== null) return
    try {
      child.stdin.end()
    } catch {
      // Channel already closed.
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    await Promise.race([exited, delay(SHUTDOWN_TIMEOUT_MS)])
    if (child.exitCode === null) child.kill("SIGKILL")
  }

  try {
    child.stdin.write(JSON.stringify({ bearerToken, dbPath }) + "\n")
    const ready = await waitForReady(child)
    // Keep stdout drained so a later write cannot block the server.
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
