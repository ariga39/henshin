import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { isAbsolute, relative, sep } from "node:path"
import { parentPort, workerData } from "node:worker_threads"
import { Option, Schema } from "effect"
import { canonicalEditPayload } from "@henshin/contracts/canonical"
import { RootExclusions } from "@henshin/contracts/root"
import {
  WorkerMessage,
  WorkerResponse,
  type CommitOutcome,
  type NoteRow,
  type OperationLookupOutcome,
  type OperationResultRow,
  type ServerRootRow,
  RootRegistrationOutcome,
  RootReplayLookup,
  type WorkerRequest
} from "./worker-protocol"

/**
 * Dedicated SQLite worker. The synchronous `node:sqlite` driver never touches
 * the HTTP event loop; the server process talks to it only over validated
 * messages.
 *
 * Driver choice is backed by an executed experiment (see
 * docs/validation/g1-g2-runtime-persistence-prototype.md): `node:sqlite` loads
 * and preserves embedded U+0000 in the supported Node 24 runtimes (Node 24.19.0
 * and Electron 44.9.0 main, Node 24.22.0), so no native rebuild is required.
 * Node 22's adapter truncates TEXT at U+0000 and is unsupported.
 *
 * Revisions are handled as canonical decimal strings and converted to `BigInt`
 * for arithmetic and binding, never through `Number`, so an exact INTEGER
 * survives the full range of the column.
 */

const SEED_NOTE_ID = "note-1"
const SEED_NOTE_TEXT = "hello"
const CURRENT_SCHEMA_VERSION = 3
/** Shipped prototype policy: seven days and 64 retained rows per database. */
const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_OPERATION_RESULTS = 64
const COMPACTION_BATCH = 64

const dbPath = (workerData as { readonly dbPath: string }).dbPath
const db = new DatabaseSync(dbPath)

db.exec("PRAGMA journal_mode = WAL")
db.exec("PRAGMA synchronous = FULL")
db.exec("PRAGMA foreign_keys = ON")
db.exec(`
  CREATE TABLE IF NOT EXISTS server_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    instance_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS server_library (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    library_id TEXT NOT NULL UNIQUE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS server_library_library_id_unique
    ON server_library(library_id);
  CREATE TABLE IF NOT EXISTS prototype_note (
    note_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    revision INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operation_results (
    epoch TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (epoch, operation_id)
  );
  CREATE TABLE IF NOT EXISTS server_roots (
    library_id TEXT NOT NULL REFERENCES server_library(library_id),
    root_id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    selected_path TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    device TEXT NOT NULL,
    inode TEXT NOT NULL,
    mapping_revision INTEGER NOT NULL,
    policy_revision INTEGER NOT NULL DEFAULT 0,
    exclusions TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL CHECK (state = 'active')
  );
  CREATE TABLE IF NOT EXISTS root_operations (
    operation_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    result TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS root_policy_operations (
    epoch TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    root_id TEXT NOT NULL REFERENCES server_roots(root_id),
    payload TEXT NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY (epoch, operation_id)
  );
`)

const rootColumns = new Set(
  (db.prepare("PRAGMA table_info(server_roots)").all() as unknown as ReadonlyArray<{ name: string }>).map(
    (column) => column.name
  )
)
if (!rootColumns.has("policy_revision")) {
  db.exec("ALTER TABLE server_roots ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 0")
}
if (!rootColumns.has("exclusions")) {
  db.exec("ALTER TABLE server_roots ADD COLUMN exclusions TEXT NOT NULL DEFAULT '[]'")
}

const selectNote = db.prepare("SELECT note_id, text, revision FROM prototype_note WHERE note_id = ?")
selectNote.setReadBigInts(true)
const selectOperation = db.prepare(
  "SELECT payload, result, created_at_ms FROM operation_results WHERE epoch = ? AND operation_id = ?"
)
const updateNote = db.prepare("UPDATE prototype_note SET text = ?, revision = ? WHERE note_id = ?")
const insertOperation = db.prepare(
  "INSERT INTO operation_results(epoch, operation_id, payload, result, created_at_ms) VALUES(?, ?, ?, ?, ?)"
)
const countOperations = db.prepare("SELECT COUNT(*) AS count FROM operation_results")
const compactOperations = db.prepare(`
  DELETE FROM operation_results
  WHERE rowid IN (
    SELECT rowid
    FROM operation_results
    WHERE created_at_ms + ? <= ? OR epoch <> ?
    ORDER BY created_at_ms ASC, rowid ASC
    LIMIT ?
  )
`)
const selectRoots = db.prepare(
  "SELECT library_id, root_id, label, selected_path, canonical_path, device, inode, mapping_revision, policy_revision, exclusions, state FROM server_roots ORDER BY rowid ASC"
)
selectRoots.setReadBigInts(true)
const selectRoot = db.prepare(
  "SELECT library_id, root_id, label, selected_path, canonical_path, device, inode, mapping_revision, policy_revision, exclusions, state FROM server_roots WHERE root_id = ?"
)
selectRoot.setReadBigInts(true)
const selectLibrary = db.prepare("SELECT library_id FROM server_library WHERE id = 1")
const selectRootOperation = db.prepare("SELECT payload, result FROM root_operations WHERE operation_id = ?")
const insertRoot = db.prepare(
  "INSERT INTO server_roots(library_id, root_id, label, selected_path, canonical_path, device, inode, mapping_revision, policy_revision, exclusions, state) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')"
)
const insertRootOperation = db.prepare(
  "INSERT INTO root_operations(operation_id, payload, result) VALUES(?, ?, ?)"
)
const selectRootPolicyOperation = db.prepare(
  "SELECT payload, result FROM root_policy_operations WHERE epoch = ? AND operation_id = ?"
)
const insertRootPolicyOperation = db.prepare(
  "INSERT INTO root_policy_operations(epoch, operation_id, root_id, payload, result) VALUES(?, ?, ?, ?, ?)"
)
const updateRootPolicy = db.prepare(
  "UPDATE server_roots SET policy_revision = ?, exclusions = ? WHERE root_id = ?"
)

let closed = false

const readNoteRow = (noteId: string): NoteRow | undefined => {
  const row = selectNote.get(noteId) as
    | { note_id: string; text: string; revision: bigint }
    | undefined
  if (row === undefined) return undefined
  return { note_id: row.note_id, text: row.text, revision: row.revision.toString() }
}

const rootRow = (row: {
  library_id: string
  root_id: string
  label: string
  selected_path: string
  canonical_path: string
  device: string
  inode: string
  mapping_revision: bigint
  policy_revision: bigint
  exclusions: string
  state: "active"
}): ServerRootRow => {
  const exclusions = Schema.decodeUnknownOption(RootExclusions)(JSON.parse(row.exclusions))
  if (Option.isNone(exclusions)) throw new Error("invalid persisted root exclusions")
  return {
    libraryId: row.library_id,
    rootId: row.root_id,
    label: row.label,
    selectedPath: row.selected_path,
    canonicalPath: row.canonical_path,
    device: row.device,
    inode: row.inode,
    mappingRevision: row.mapping_revision.toString(),
    policyRevision: row.policy_revision.toString(),
    exclusions: exclusions.value,
    state: row.state
  }
}

const rootRows = (): ReadonlyArray<ServerRootRow> =>
  (selectRoots.all() as unknown as ReadonlyArray<{
    library_id: string
    root_id: string
    label: string
    selected_path: string
    canonical_path: string
    device: string
    inode: string
    mapping_revision: bigint
    policy_revision: bigint
    exclusions: string
    state: "active"
  }>).map(rootRow)

const rootById = (rootId: string): ServerRootRow | undefined => {
  const row = selectRoot.get(rootId) as
    | {
        library_id: string
        root_id: string
        label: string
        selected_path: string
        canonical_path: string
        device: string
        inode: string
        mapping_revision: bigint
        policy_revision: bigint
        exclusions: string
        state: "active"
      }
    | undefined
  return row === undefined ? undefined : rootRow(row)
}

const containsPath = (ancestor: string, descendant: string): boolean => {
  const child = relative(ancestor, descendant)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

const rootsOverlap = (
  left: { canonicalPath: string; device: string; inode: string },
  right: { canonicalPath: string; device: string; inode: string }
): boolean =>
  (left.device === right.device && left.inode === right.inode) ||
  containsPath(left.canonicalPath, right.canonicalPath) ||
  containsPath(right.canonicalPath, left.canonicalPath)

const registerRoot = (
  request: Extract<WorkerRequest, { op: "registerRoot" }>
): RootRegistrationOutcome => {
  const payload = rootPayload({
    label: request.label,
    selectedPath: request.selectedPath,
    canonicalPath: request.canonicalPath,
    device: request.device,
    inode: request.inode
  })

  db.exec("BEGIN IMMEDIATE")
  try {
    const existing = selectRootOperation.get(request.operationId) as
      | { payload: string; result: string }
      | undefined
    if (existing !== undefined) {
      if (existing.payload !== payload) {
        db.exec("ROLLBACK")
        return { kind: "operation_conflict" }
      }
      const stored = JSON.parse(existing.result) as { rootId?: string }
      const current = stored.rootId === undefined ? undefined : rootById(stored.rootId)
      if (current === undefined) throw new Error("registered root is missing")
      db.exec("COMMIT")
      return { kind: "replayed", root: current }
    }

    const existingRoots = rootRows()
    const candidate = {
      canonicalPath: request.canonicalPath,
      device: request.device,
      inode: request.inode
    }
    if (existingRoots.some((root) => rootsOverlap(candidate, root))) {
      db.exec("ROLLBACK")
      return { kind: "root_overlap" }
    }

    const library = selectLibrary.get() as { library_id: string } | undefined
    if (library === undefined) throw new Error("server library is not initialized")
    const root: ServerRootRow = {
      libraryId: library.library_id,
      rootId: randomUUID(),
      label: request.label,
      selectedPath: request.selectedPath,
      canonicalPath: request.canonicalPath,
      device: request.device,
      inode: request.inode,
      mappingRevision: "1",
      policyRevision: "0",
      exclusions: [],
      state: "active"
    }
    insertRoot.run(
      root.libraryId,
      root.rootId,
      root.label,
      root.selectedPath,
      root.canonicalPath,
      root.device,
      root.inode,
      BigInt(root.mappingRevision),
      BigInt(root.policyRevision),
      JSON.stringify(root.exclusions)
    )
    insertRootOperation.run(request.operationId, payload, JSON.stringify(root))
    db.exec("COMMIT")
    return { kind: "registered", root }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

const rootPayload = (input: {
  readonly label: string
  readonly selectedPath: string
  readonly canonicalPath: string
  readonly device: string
  readonly inode: string
}): string => JSON.stringify(input)

const lookupRootOperation = (
  request: Extract<WorkerRequest, { op: "lookupRootOperation" }>
): RootReplayLookup => {
  const existing = selectRootOperation.get(request.operationId) as
    | { payload: string; result: string }
    | undefined
  if (existing === undefined) return { kind: "not_found" }
  const payload = rootPayload({
    label: request.label,
    selectedPath: request.selectedPath,
    canonicalPath: request.canonicalPath,
    device: request.device,
    inode: request.inode
  })
  return existing.payload === payload
    ? (() => {
        const stored = JSON.parse(existing.result) as { rootId?: string }
        const root = stored.rootId === undefined ? undefined : rootById(stored.rootId)
        if (root === undefined) throw new Error("registered root is missing")
        return { kind: "replay", root }
      })()
    : { kind: "operation_conflict" }
}

const rootPolicyPayload = (input: {
  readonly rootId: string
  readonly expectedPolicyRevision: string
  readonly command: Extract<WorkerRequest, { op: "commitRootPolicy" }>["command"]
}): string =>
  JSON.stringify({
    command: input.command,
    expected_policy_revision: input.expectedPolicyRevision,
    root_id: input.rootId
  })

const commitRootPolicy = (
  request: Extract<WorkerRequest, { op: "commitRootPolicy" }>
): import("./worker-protocol").RootPolicyCommandOutcome => {
  const payload = rootPolicyPayload({
    rootId: request.rootId,
    expectedPolicyRevision: request.expectedPolicyRevision,
    command: request.command
  })

  db.exec("BEGIN IMMEDIATE")
  try {
    const existing = selectRootPolicyOperation.get(request.epoch, request.operationId) as
      | { payload: string; result: string }
      | undefined
    if (existing !== undefined) {
      if (existing.payload !== payload) {
        db.exec("ROLLBACK")
        return { kind: "operation_conflict" }
      }
      const root = JSON.parse(existing.result) as ServerRootRow
      db.exec("COMMIT")
      return { kind: "replayed", root }
    }

    const current = rootById(request.rootId)
    if (current === undefined) {
      db.exec("ROLLBACK")
      return { kind: "root_not_found" }
    }
    if (current.policyRevision !== request.expectedPolicyRevision) {
      db.exec("ROLLBACK")
      return { kind: "policy_revision_conflict", currentPolicyRevision: current.policyRevision }
    }

    const hasExclusion = current.exclusions.some(
      (exclusion) =>
        exclusion.path === request.command.exclusion.path && exclusion.scope === request.command.exclusion.scope
    )
    const exclusions = request.command.type === "exclude"
      ? hasExclusion ? current.exclusions : [...current.exclusions, request.command.exclusion]
      : hasExclusion
        ? current.exclusions.filter(
            (exclusion) =>
              exclusion.path !== request.command.exclusion.path || exclusion.scope !== request.command.exclusion.scope
          )
        : current.exclusions
    const changed = exclusions.length !== current.exclusions.length
    const nextRevision =
      !changed
        ? current.policyRevision
        : (BigInt(current.policyRevision) + 1n).toString()
    const root: ServerRootRow = { ...current, policyRevision: nextRevision, exclusions }
    updateRootPolicy.run(BigInt(root.policyRevision), JSON.stringify(root.exclusions), root.rootId)
    insertRootPolicyOperation.run(
      request.epoch,
      request.operationId,
      root.rootId,
      payload,
      JSON.stringify(root)
    )
    db.exec("COMMIT")
    return { kind: "committed", root }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

const operationResult = (
  operationId: string,
  note: NoteRow,
  createdAtMs: number
): OperationResultRow => ({
  operationId,
  note,
  expiresAtMs: createdAtMs + RESULT_RETENTION_MS
})

const readOperation = (
  request: Extract<WorkerRequest, { op: "readOperation" }>
): OperationLookupOutcome => {
  const row = selectOperation.get(request.epoch, request.operationId) as
    | { payload: string; result: string; created_at_ms: number }
    | undefined
  if (row === undefined || row.created_at_ms + RESULT_RETENTION_MS <= Date.now()) {
    return { kind: "expired" }
  }
  return {
    kind: "found",
    result: operationResult(
      request.operationId,
      JSON.parse(row.result) as NoteRow,
      row.created_at_ms
    )
  }
}

const commitNote = (request: Extract<WorkerRequest, { op: "commitNote" }>): CommitOutcome => {
  // Derive canonical command identity from validated fields inside the worker.
  const canonicalPayload = canonicalEditPayload({
    noteId: request.noteId,
    text: request.text,
    expectedRevision: request.expectedRevision
  })
  db.exec("BEGIN IMMEDIATE")
  try {
    const existing = selectOperation.get(request.epoch, request.operationId) as
      | { payload: string; result: string; created_at_ms: number }
      | undefined

    if (existing !== undefined) {
      if (existing.payload !== canonicalPayload) {
        db.exec("ROLLBACK")
        return { kind: "operation_conflict" }
      }
      if (existing.created_at_ms + RESULT_RETENTION_MS <= Date.now()) {
        db.exec("ROLLBACK")
        return { kind: "operation_expired" }
      }
      db.exec("COMMIT")
      return {
        kind: "replayed",
        result: operationResult(
          request.operationId,
          JSON.parse(existing.result) as NoteRow,
          existing.created_at_ms
        )
      }
    }

    const current = readNoteRow(request.noteId)
    if (current === undefined) {
      db.exec("ROLLBACK")
      return { kind: "not_found" }
    }
    if (current.revision !== request.expectedRevision) {
      db.exec("ROLLBACK")
      return { kind: "revision_conflict", currentRevision: current.revision }
    }

    // Reclaim only expired rows or rows from an obsolete authority epoch.
    // This is bounded and runs before admission; current-epoch unexpired
    // results are never evicted to make room for a new mutation.
    compactOperations.run(RESULT_RETENTION_MS, Date.now(), request.epoch, COMPACTION_BATCH)
    const operationCount = (countOperations.get() as { count: number }).count
    if (operationCount >= MAX_OPERATION_RESULTS) {
      // Cleanup is safe independently of the rejected mutation. Commit only
      // this bounded reclamation so a legacy store with many obsolete rows
      // can make progress across repeated storage_full responses; the note
      // and the requested operation result remain unchanged.
      db.exec("COMMIT")
      return { kind: "storage_full" }
    }

    const revision = (BigInt(current.revision) + 1n).toString()
    const note: NoteRow = { note_id: request.noteId, text: request.text, revision }
    const createdAtMs = Date.now()
    updateNote.run(note.text, BigInt(revision), note.note_id)
    insertOperation.run(
      request.epoch,
      request.operationId,
      canonicalPayload,
      JSON.stringify(note),
      createdAtMs
    )
    db.exec("COMMIT")
    return { kind: "committed", result: operationResult(request.operationId, note, createdAtMs) }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

const handle = (request: WorkerRequest): unknown => {
  switch (request.op) {
    case "init": {
      const existing = db.prepare("SELECT instance_id, schema_version FROM server_state WHERE id = 1").get() as
        | { instance_id: string; schema_version: number }
        | undefined
      const schemaVersion = existing?.schema_version
      if (schemaVersion !== undefined && schemaVersion > CURRENT_SCHEMA_VERSION) {
        throw new Error("unsupported server database schema version")
      }
      const instanceId = existing?.instance_id ?? randomUUID()
      if (existing === undefined) {
        db.prepare("INSERT INTO server_state(id, instance_id, schema_version) VALUES(1, ?, ?)").run(
          instanceId,
          CURRENT_SCHEMA_VERSION
        )
      }
      const library = selectLibrary.get() as { library_id: string } | undefined
      if (library === undefined) {
        db.prepare("INSERT INTO server_library(id, library_id) VALUES(1, ?)").run(randomUUID())
      }
      if (schemaVersion !== undefined && schemaVersion < CURRENT_SCHEMA_VERSION) {
        db.prepare("UPDATE server_state SET schema_version = ? WHERE id = 1").run(CURRENT_SCHEMA_VERSION)
      }
      db.prepare("INSERT OR IGNORE INTO prototype_note(note_id, text, revision) VALUES(?, ?, 0)").run(
        SEED_NOTE_ID,
        SEED_NOTE_TEXT
      )
      return instanceId
    }
    case "readNote":
      return readNoteRow(request.noteId) ?? null
    case "listRoots":
      return rootRows()
    case "lookupRootOperation":
      return lookupRootOperation(request)
    case "readOperation":
      return readOperation(request)
    case "commitNote":
      return commitNote(request)
    case "registerRoot":
      return registerRoot(request)
    case "commitRootPolicy":
      return commitRootPolicy(request)
    case "close":
      if (!closed) {
        closed = true
        db.close()
      }
      return null
  }
}

parentPort?.on("message", (raw: unknown) => {
  const decoded = Schema.decodeUnknownOption(WorkerMessage)(raw)
  if (Option.isNone(decoded)) {
    const id =
      typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "number"
        ? raw.id
        : -1
    parentPort?.postMessage({ id, ok: false, error: "invalid worker request" } satisfies WorkerResponse)
    return
  }

  const { id, request } = decoded.value
  try {
    parentPort?.postMessage({ id, ok: true, value: handle(request) } satisfies WorkerResponse)
  } catch (error) {
    parentPort?.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    } satisfies WorkerResponse)
  }
})
