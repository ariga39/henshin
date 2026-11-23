import path from "node:path"
import { readdir } from "node:fs/promises"
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Option, Schema } from "effect"
import { makeAppLayer } from "./app"
import {
  writeOwnerCredential,
  OwnerCredentialError,
  readOwnerCredential
} from "./owner-credential"
import {
  acquireServerOwnership,
  canonicalizeDatabasePath,
  ServerOwnershipError
} from "./persistence/ServerOwnership"
import { DatabaseWorker, DatabaseWorkerError } from "./persistence/DatabaseWorker"
import {
  BackupDestinationRegistrationOutcome,
  BackupDestinationRow,
  ServerRootRow,
} from "./persistence/worker-protocol"
import {
  selectWritableLocation,
  validateWritableLocationSeparation,
  type SourceRootObservation
} from "./analysis/NativeSourceBoundary"

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
  readonly ownerCommand?: "initialize" | "rotate"
}

const usage = (): string =>
  "usage: server.mjs (--data-dir <directory> | --database <path>) [--port <1-65535>] [--initialize-owner | --rotate-owner]\n" +
  "       server.mjs backup-destination <list|register|replace> (--data-dir <directory> | --database <path>) [--name <name>] [--path <directory>] [--id <destination-id>] [--confirm]"

interface BackupDestinationOptions {
  readonly command: "list" | "register" | "replace"
  readonly dataDir?: string
  readonly database?: string
  readonly name?: string
  readonly destinationPath?: string
  readonly destinationId?: string
  readonly confirmed: boolean
}

const parseBackupDestinationOptions = (args: ReadonlyArray<string>): BackupDestinationOptions => {
  const command = args[1]
  if (command !== "list" && command !== "register" && command !== "replace") throw new Error(usage())

  let dataDir: string | undefined
  let database: string | undefined
  let name: string | undefined
  let destinationPath: string | undefined
  let destinationId: string | undefined
  let confirmed = false
  for (let index = 2; index < args.length; index += 1) {
    switch (args[index]) {
      case "--data-dir":
        dataDir = args[++index]
        if (dataDir === undefined || dataDir.startsWith("--")) throw new Error(usage())
        break
      case "--database":
        database = args[++index]
        if (database === undefined || database.startsWith("--")) throw new Error(usage())
        break
      case "--name":
        name = args[++index]
        if (name === undefined || name.startsWith("--")) throw new Error(usage())
        break
      case "--path":
        destinationPath = args[++index]
        if (destinationPath === undefined || destinationPath.startsWith("--")) throw new Error(usage())
        break
      case "--id":
        destinationId = args[++index]
        if (destinationId === undefined || destinationId.startsWith("--")) throw new Error(usage())
        break
      case "--confirm":
        confirmed = true
        break
      case "--help":
        throw new Error(usage())
      default:
        throw new Error(usage())
    }
  }

  if ((dataDir === undefined) === (database === undefined)) throw new Error(usage())
  if (command === "register" && (name === undefined || destinationPath === undefined)) throw new Error(usage())
  if (command === "replace" && (destinationId === undefined || destinationPath === undefined || !confirmed)) {
    throw new Error(usage())
  }
  if (command === "list" && (name !== undefined || destinationPath !== undefined || destinationId !== undefined || confirmed)) {
    throw new Error(usage())
  }
  return { command, dataDir, database, name, destinationPath, destinationId, confirmed }
}

const parseIndependentOptions = (args: ReadonlyArray<string>): IndependentOptions => {
  let dataDir: string | undefined
  let database: string | undefined
  let port = 4317
  let ownerCommand: IndependentOptions["ownerCommand"]

  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--data-dir":
        dataDir = args[++index]
        if (dataDir === undefined || dataDir.length === 0 || dataDir.startsWith("--")) {
          throw new Error(usage())
        }
        break
      case "--database":
        database = args[++index]
        if (database === undefined || database.length === 0 || database.startsWith("--")) {
          throw new Error(usage())
        }
        break
      case "--port": {
        const value = args[++index]
        if (value === undefined || !/^[0-9]+$/u.test(value)) throw new Error(usage())
        port = Number(value)
        if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(usage())
        break
      }
      case "--initialize-owner":
      case "--rotate-owner":
        if (ownerCommand !== undefined) throw new Error(usage())
        ownerCommand = args[index] === "--rotate-owner" ? "rotate" : "initialize"
        break
      case "--help":
        throw new Error(usage())
      default:
        throw new Error(usage())
    }
  }

  if ((dataDir === undefined) === (database === undefined)) throw new Error(usage())
  return { dataDir, database, port, ownerCommand }
}

const isMissingPath = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT"

const resolveIndependentDatabasePath = async (options: Pick<IndependentOptions, "dataDir" | "database">): Promise<string> => {
  if (options.database !== undefined) return canonicalizeDatabasePath(options.database)
  const dataDir = options.dataDir
  if (dataDir === undefined) throw new Error(usage())

  const defaultPath = path.join(dataDir, "server.sqlite")
  let candidates: ReadonlyArray<string>
  try {
    candidates = (await readdir(dataDir, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.name !== "server.sqlite" &&
          entry.name !== ".henshin-server-auth.sqlite" &&
          entry.name !== ".henshin-server-owner.sqlite" &&
          (entry.isFile() || entry.isSymbolicLink()) &&
          /\.(?:db|sqlite|sqlite3)$/iu.test(entry.name)
      )
      .map((entry) => entry.name)
  } catch (error) {
    if (isMissingPath(error)) return canonicalizeDatabasePath(defaultPath)
    throw error
  }
  if (candidates.length > 0) {
    throw new Error(
      "server startup failed at data-directory: existing database requires explicit --database selection"
    )
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

  if (options.ownerCommand !== undefined) {
    let guard
    try {
      guard = await acquireServerOwnership(dbPath)
      const token = await writeOwnerCredential(dbPath, options.ownerCommand)
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

type BackupDestination = typeof BackupDestinationRow.Type
type ServerRoot = typeof ServerRootRow.Type

const decodeBackupDestinations = (value: unknown): ReadonlyArray<BackupDestination> => {
  const decoded = Schema.decodeUnknownOption(Schema.Array(BackupDestinationRow))(value)
  if (Option.isNone(decoded)) throw new Error("database returned invalid backup destinations")
  return decoded.value
}

const decodeServerRoots = (value: unknown): ReadonlyArray<ServerRoot> => {
  const decoded = Schema.decodeUnknownOption(Schema.Array(ServerRootRow))(value)
  if (Option.isNone(decoded)) throw new Error("database returned invalid collection roots")
  return decoded.value
}

const decodeBackupDestinationOutcome = (value: unknown): typeof BackupDestinationRegistrationOutcome.Type => {
  const decoded = Schema.decodeUnknownOption(BackupDestinationRegistrationOutcome)(value)
  if (Option.isNone(decoded)) throw new Error("database returned invalid backup destination result")
  return decoded.value
}

const runDestinationWorker = async <A>(
  dbPath: string,
  program: (worker: DatabaseWorker["Service"]) => Effect.Effect<A, DatabaseWorkerError>
): Promise<A> => {
  let guard: Awaited<ReturnType<typeof acquireServerOwnership>> | undefined
  try {
    guard = await acquireServerOwnership(dbPath)
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const worker = yield* DatabaseWorker
          yield* worker.call({ op: "init" })
          return yield* program(worker)
        }).pipe(Effect.provide(DatabaseWorker.layer(dbPath)))
      )
    )
  } finally {
    guard?.close()
  }
}

const sourceRootObservation = (root: ServerRoot): SourceRootObservation => ({
  selectedPath: root.selectedPath,
  canonicalPath: root.canonicalPath,
  identity: { device: root.device, inode: root.inode }
})

const destinationView = (destination: BackupDestination, state: "active" | "needs-reconfirmation" = destination.state) => ({
  destination_id: destination.destinationId,
  name: destination.name,
  selected_path: destination.selectedPath,
  canonical_path: destination.canonicalPath,
  device: destination.device,
  inode: destination.inode,
  state
})

const runBackupDestinationCommand = async (options: BackupDestinationOptions): Promise<void> => {
  const dbPath = await resolveIndependentDatabasePath(options)
  const result = await runDestinationWorker(dbPath, (worker) =>
    Effect.gen(function*() {
      const storedDestinations = decodeBackupDestinations(yield* worker.call({ op: "listBackupDestinations" }))
      if (options.command === "list") {
        const destinations = yield* Effect.promise(() => Promise.all(storedDestinations.map(async (destination) => {
          const current = await selectWritableLocation(destination.selectedPath)
          const unchanged = current.ok &&
            current.value.canonicalPath === destination.canonicalPath &&
            current.value.identity.device === destination.device &&
            current.value.identity.inode === destination.inode
          return destinationView(destination, unchanged ? "active" : "needs-reconfirmation")
        })))
        return { destinations }
      }

      const roots = decodeServerRoots(yield* worker.call({ op: "listRoots" }))
      const destinationPath = options.destinationPath
      if (destinationPath === undefined) return yield* Effect.fail(new DatabaseWorkerError({ message: "destination path is required" }))
      const selected = yield* Effect.promise(() => selectWritableLocation(destinationPath))
      if (!selected.ok) return yield* Effect.fail(new DatabaseWorkerError({ message: selected.message }))

      const excludedDestinationId = options.command === "replace" ? options.destinationId : undefined
      const peerDestinations = storedDestinations.filter(
        (destination) => destination.destinationId !== excludedDestinationId
      )

      const separation = yield* Effect.promise(() => validateWritableLocationSeparation({
        sourceRoots: roots.map(sourceRootObservation),
        writableLocations: [
          path.dirname(dbPath),
          selected.value,
          ...peerDestinations.map((destination) => ({
            selectedPath: destination.selectedPath,
            canonicalPath: destination.canonicalPath,
            identity: { device: destination.device, inode: destination.inode }
          }))
        ]
      }))
      if (!separation.ok) return yield* Effect.fail(new DatabaseWorkerError({ message: separation.message }))

      if (options.command === "register") {
        const name = options.name
        if (name === undefined) return yield* Effect.fail(new DatabaseWorkerError({ message: "destination name is required" }))
        const outcome = decodeBackupDestinationOutcome(yield* worker.call({
          op: "registerBackupDestination",
          name,
          selectedPath: selected.value.selectedPath,
          canonicalPath: selected.value.canonicalPath,
          device: selected.value.identity.device,
          inode: selected.value.identity.inode
        }))
        switch (outcome.kind) {
          case "registered":
          case "replayed":
            return { destination: destinationView(outcome.destination) }
          case "name_conflict":
            return yield* Effect.fail(new DatabaseWorkerError({ message: "backup destination name already exists; use replace with --confirm" }))
          case "destination_overlap":
            return yield* Effect.fail(new DatabaseWorkerError({ message: "backup destination overlaps a registered collection root" }))
          case "destination_not_found":
            return yield* Effect.fail(new DatabaseWorkerError({ message: "backup destination was not found" }))
        }
      }

      const destinationId = options.destinationId
      if (destinationId === undefined) return yield* Effect.fail(new DatabaseWorkerError({ message: "destination id is required" }))
      const outcome = decodeBackupDestinationOutcome(yield* worker.call({
        op: "replaceBackupDestination",
        destinationId,
        selectedPath: selected.value.selectedPath,
        canonicalPath: selected.value.canonicalPath,
        device: selected.value.identity.device,
        inode: selected.value.identity.inode
      }))
      switch (outcome.kind) {
        case "registered":
        case "replayed":
          return { destination: destinationView(outcome.destination) }
        case "destination_not_found":
          return yield* Effect.fail(new DatabaseWorkerError({ message: "backup destination was not found" }))
        case "destination_overlap":
          return yield* Effect.fail(new DatabaseWorkerError({ message: "backup destination overlaps a registered collection root" }))
        case "name_conflict":
          return yield* Effect.fail(new DatabaseWorkerError({ message: "backup destination name already exists" }))
      }
    })
  )
  process.stdout.write(JSON.stringify(result) + "\n")
}

const main = async () => {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    await runManaged()
    return
  }

  if (args[0] === "backup-destination") {
    let options: BackupDestinationOptions
    try {
      options = parseBackupDestinationOptions(args)
    } catch (error) {
      console.error(error instanceof Error ? error.message : usage())
      process.exitCode = 2
      return
    }
    try {
      await runBackupDestinationCommand(options)
    } catch (error) {
      console.error(error instanceof Error ? error.message : "backup destination administration failed")
      process.exitCode = 1
    }
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
