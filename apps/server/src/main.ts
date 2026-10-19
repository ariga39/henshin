import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { makeAppLayer } from "./app"
import { DatabaseWorkerError } from "./persistence/DatabaseWorker"
import { canonicalizeDatabasePath, ServerOwnershipError } from "./persistence/ServerOwnership"

interface Bootstrap {
  readonly bearerToken: string
  readonly dbPath: string
}

const startupDiagnostic = (error: unknown): string | undefined => {
  if (error instanceof ServerOwnershipError) return error.message
  if (error instanceof DatabaseWorkerError) {
    return "server startup failed at database: database initialization failed"
  }
  if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "ServeError") {
    return "server startup failed at readiness: server is unavailable"
  }
  return undefined
}

/**
 * Reads the private bootstrap payload (bearer token + database path) from
 * stdin. The token never appears in argv, the environment, or logs.
 */
const readBootstrap = (): Promise<Bootstrap> =>
  new Promise((resolve, reject) => {
    let buffer = ""
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      process.stdin.off("data", onData)
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Bootstrap)
      } catch (error) {
        reject(error)
      }
    }
    process.stdin.on("data", onData)
    process.stdin.once("error", reject)
  })

const main = async () => {
  const bootstrap = await readBootstrap()

  // Closing the private parent channel is a shutdown request, so a crashed
  // desktop never leaves an unmanaged server behind.
  process.stdin.resume()
  let startupFailed = false
  const requestShutdown = () => {
    if (!startupFailed) process.kill(process.pid, "SIGTERM")
  }
  process.stdin.on("end", requestShutdown)
  process.stdin.on("close", requestShutdown)

  const failStartup = (diagnostic: string | undefined): void => {
    startupFailed = true
    if (diagnostic !== undefined) console.error(diagnostic)
    process.stdin.destroy()
    process.exitCode = 1
  }

  let dbPath: string
  try {
    dbPath = await canonicalizeDatabasePath(bootstrap.dbPath)
  } catch (error) {
    failStartup(
      error instanceof ServerOwnershipError
        ? error.message
        : "server startup failed at data-directory: data directory is unavailable"
    )
    return
  }

  const appLayer = makeAppLayer({ dbPath, bearerToken: bootstrap.bearerToken })
  NodeRuntime.runMain(
    Layer.launch(appLayer).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          failStartup(startupDiagnostic(error))
        })
      )
    ),
    { disableErrorReporting: true }
  )
}

void main().catch(() => {
  console.error("server bootstrap failed: invalid or unavailable bootstrap channel")
  process.stdin.destroy()
  process.exitCode = 1
})
