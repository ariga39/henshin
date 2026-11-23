import path from "node:path"
import { lstat, readdir } from "node:fs/promises"
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { makeAppLayer } from "./app"
import {
  initializeOwnerCredential,
  OwnerCredentialError,
  readOwnerCredential
} from "./owner-credential"
import { DatabaseWorkerError } from "./persistence/DatabaseWorker"
import {
  acquireServerOwnership,
  canonicalizeDatabasePath,
  ServerOwnershipError
} from "./persistence/ServerOwnership"

interface Bootstrap {
  readonly bearerToken: string
  readonly dbPath: string
}

const startupDiagnostic = (error: unknown): string | undefined => {
  if (error instanceof ServerOwnershipError) return error.message
  if (error instanceof OwnerCredentialError) return error.message
  if (error instanceof DatabaseWorkerError) {
    return "server startup failed at database: database initialization failed"
  }
  if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "ServeError") {
    return "server startup failed at readiness: server is unavailable"
  }
  return undefined
}

interface IndependentOptions {
  readonly dataDir?: string
  readonly database?: string
  readonly port: number
  readonly initializeOwner: boolean
}

const usage = (): string =>
  "usage: server.mjs (--data-dir <directory> | --database <path>) [--port <1-65535>] [--initialize-owner]"

const parseIndependentOptions = (args: ReadonlyArray<string>): IndependentOptions => {
  let dataDir: string | undefined
  let database: string | undefined
  let port = 4317
  let initializeOwner = false

  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--data-dir":
        dataDir = args[++index]
        if (dataDir === undefined || dataDir.startsWith("--")) throw new Error(usage())
        break
      case "--database":
        database = args[++index]
        if (database === undefined || database.startsWith("--")) throw new Error(usage())
        break
      case "--port": {
        const value = args[++index]
        if (value === undefined || !/^[0-9]+$/u.test(value)) throw new Error(usage())
        port = Number(value)
        if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(usage())
        break
      }
      case "--initialize-owner":
        initializeOwner = true
        break
      case "--help":
        throw new Error(usage())
      default:
        throw new Error(usage())
    }
  }

  if ((dataDir === undefined) === (database === undefined)) throw new Error(usage())
  return { dataDir, database, port, initializeOwner }
}

const isMissingPath = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT"

const resolveIndependentDatabasePath = async (options: IndependentOptions): Promise<string> => {
  if (options.database !== undefined) return canonicalizeDatabasePath(options.database)
  const dataDir = options.dataDir
  if (dataDir === undefined) throw new Error(usage())

  const defaultPath = path.join(dataDir, "server.sqlite")
  try {
    await lstat(defaultPath)
    return canonicalizeDatabasePath(defaultPath)
  } catch (error) {
    if (!isMissingPath(error)) throw error
  }

  try {
    const candidates = (await readdir(dataDir, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() && !entry.name.startsWith(".") && /\.(?:db|sqlite|sqlite3)$/u.test(entry.name)
      )
      .map((entry) => entry.name)
    if (candidates.length > 0) {
      throw new Error(
        "server startup failed at data-directory: existing database requires explicit --database selection"
      )
    }
  } catch (error) {
    if (!isMissingPath(error)) throw error
  }
  return canonicalizeDatabasePath(defaultPath)
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

const runManaged = async () => {
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

  const appLayer = makeAppLayer({
    dbPath,
    auth: { kind: "bootstrap", token: bootstrap.bearerToken },
    port: 0
  })
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

const runIndependent = async (options: IndependentOptions): Promise<void> => {
  let dbPath: string
  try {
    dbPath = await resolveIndependentDatabasePath(options)
  } catch (error) {
    console.error(
      startupDiagnostic(error) ??
        (error instanceof Error
          ? error.message
          : "server startup failed at data-directory: data directory is unavailable")
    )
    process.exitCode = 1
    return
  }

  if (options.initializeOwner) {
    let guard
    try {
      guard = await acquireServerOwnership(dbPath)
      const token = await initializeOwnerCredential(dbPath)
      process.stdout.write(`owner_token=${token}\n`)
    } catch (error) {
      console.error(startupDiagnostic(error) ?? "server initialization failed")
      process.exitCode = 1
    } finally {
      guard?.close()
    }
    return
  }

  let guard: Awaited<ReturnType<typeof acquireServerOwnership>> | undefined
  let handedOff = false
  try {
    // Read the verifier only after the existing directory guard is held. A
    // stopped rotation command cannot replace the credential between these
    // two operations.
    guard = await acquireServerOwnership(dbPath)
    const credential = await readOwnerCredential(dbPath)
    if (credential.databaseName !== path.basename(dbPath)) {
      throw new OwnerCredentialError(
        "server startup failed at authentication: owner credential belongs to another database; select it with --database"
      )
    }
    const verifier = credential.verifier

    const appLayer = makeAppLayer({
      dbPath,
      auth: { kind: "owner", verifier },
      port: options.port,
      ownershipGuard: guard
    })
    NodeRuntime.runMain(
      Layer.launch(appLayer).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            const diagnostic = startupDiagnostic(error)
            if (diagnostic !== undefined) {
              console.error(diagnostic)
              process.exitCode = 1
            }
          })
        )
      ),
      { disableErrorReporting: true }
    )
    handedOff = true
  } catch (error) {
    console.error(
      startupDiagnostic(error) ??
        "server startup failed at authentication: owner credential is unavailable"
    )
    process.exitCode = 1
  } finally {
    if (!handedOff) guard?.close()
  }
}

const main = async () => {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    await runManaged()
    return
  }

  let options: IndependentOptions
  try {
    options = parseIndependentOptions(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : usage())
    process.exitCode = 2
    return
  }
  await runIndependent(options)
}

void main().catch(() => {
  console.error("server bootstrap failed: invalid or unavailable bootstrap channel")
  process.stdin.destroy()
  process.exitCode = 1
})
