import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SERVER_PATH = fileURLToPath(new URL("../../dist/server.mjs", import.meta.url))
const READY_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 5_000

export interface RunningServer {
  readonly baseUrl: string
  readonly bearerToken: string
  readonly instanceId: string
  readonly epoch: string
  readonly dbPath: string
  stop(): Promise<void>
}

interface ReadyLine {
  readonly event: "ready"
  readonly port: number
  readonly instance_id: string
  readonly epoch: string
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const makeTempDbPath = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "henshin-prototype-"))
  return path.join(dir, "prototype.db")
}

/**
 * Spawns the built independent server with the same private bootstrap channel
 * the desktop uses, and waits for its readiness line.
 */
export const startServer = async (dbPath: string): Promise<RunningServer> => {
  const bearerToken = randomBytes(32).toString("base64url")
  const child = spawn(process.execPath, [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] })

  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })

  child.stdin.write(JSON.stringify({ bearerToken, dbPath }) + "\n")

  const stop = async () => {
    if (child.exitCode !== null) return
    try {
      child.stdin.end()
    } catch {
      // Already closed.
    }
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      delay(STOP_TIMEOUT_MS)
    ])
    if (child.exitCode === null) child.kill("SIGKILL")
  }

  const ready = await new Promise<ReadyLine>((resolve, reject) => {
    let buffer = ""
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`server readiness timed out; stderr=${stderr}`))
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
            // Ignore non-JSON stdout.
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
      reject(new Error(`server exited before readiness; stderr=${stderr}`))
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
  }).catch(async (error) => {
    await stop()
    throw error
  })

  return {
    baseUrl: `http://127.0.0.1:${ready.port}`,
    bearerToken,
    instanceId: ready.instance_id,
    epoch: ready.epoch,
    dbPath,
    stop
  }
}
