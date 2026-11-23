import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { basename, isAbsolute, join, relative, sep } from "node:path"
import { parentPort, workerData } from "node:worker_threads"
import { Option, Schema } from "effect"
import { canonicalEditPayload, canonicalOpenEventPayload } from "@henshin/contracts/canonical"
import {
  INDEXED_ROOT_SAMPLE_LIMIT,
  ReplacementCandidateObservation,
  ReplacementObservation,
  ScanManifest
} from "@henshin/contracts"
import { MAX_ROOT_EXCLUSIONS, RootExclusions, ScanAnalysisError } from "@henshin/contracts/root"
import { caseFold } from "unicode-case-folding"
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
const CURRENT_SCHEMA_VERSION = 8
/** Shipped prototype policy: seven days and 64 retained rows per database. */
const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_OPERATION_RESULTS = 64
const MAX_POLICY_OPERATION_RESULTS = 1024
const COMPACTION_BATCH = 64
const MAX_REPORTED_DEFERRED_PATHS = 32

const persistedManifest = (value: string, field: string): typeof ScanManifest.Type => {
  const decoded = Schema.decodeUnknownOption(ScanManifest)(JSON.parse(value))
  if (Option.isNone(decoded)) throw new Error(`invalid persisted ${field}`)
  return decoded.value
}

const persistedAnalysisError = (value: string | null): typeof ScanAnalysisError.Type | null => {
  if (value === null) return null
  const decoded = Schema.decodeUnknownOption(ScanAnalysisError)(JSON.parse(value))
  if (Option.isNone(decoded)) throw new Error("invalid persisted candidate analysis error")
  return decoded.value
}

const replacementObservation = (
  manifest: typeof ScanManifest.Type,
  kind: "archive" | "image-directory"
): import("@henshin/contracts").ReplacementObservation => ({
  kind,
  page_count: manifest.pages.length,
  format_evidence: Array.from(new Set(manifest.pages.map((page) => page.format))).slice(0, 8),
  size_bytes: kind === "archive"
    ? manifest.after.bytes
    : manifest.pages.reduce((total, page) => total + page.declared_bytes, 0),
  entry_count: manifest.after.entry_count,
  diagnostics: manifest.diagnostics
})

const emptyDiagnostics = {
  supported_pages: 0,
  unsupported_pages: 0,
  ignored_entries: 0,
  directory_records: 0
} as const

const replacementCandidateObservation = (
  kind: "archive" | "image-directory",
  analysisStatus: "ready" | "error",
  manifestJson: string | null,
  analysisErrorJson: string | null
): import("@henshin/contracts").ReplacementCandidateObservation => {
  const analysisError = persistedAnalysisError(analysisErrorJson)
  const observation = manifestJson === null
    ? {
        kind,
        page_count: 0,
        format_evidence: [],
        size_bytes: null,
        entry_count: 0,
        diagnostics: analysisError?.diagnostics ?? emptyDiagnostics
      }
    : replacementObservation(persistedManifest(manifestJson, "candidate manifest"), kind)
  return {
    ...observation,
    analysis_status: analysisStatus,
    analysis_error: analysisError
  }
}

const persistedReplacementObservation = (value: string, field: string): import("@henshin/contracts").ReplacementObservation => {
  const decoded = Schema.decodeUnknownOption(ReplacementObservation)(JSON.parse(value))
  if (Option.isNone(decoded)) throw new Error(`invalid persisted ${field}`)
  return decoded.value
}

const persistedReplacementCandidateObservation = (value: string, field: string): import("@henshin/contracts").ReplacementCandidateObservation => {
  const decoded = Schema.decodeUnknownOption(ReplacementCandidateObservation)(JSON.parse(value))
  if (Option.isNone(decoded)) throw new Error(`invalid persisted ${field}`)
  return decoded.value
}

const comparableManifest = (value: string): {
  readonly value: string
  readonly beforeToken?: string
  readonly afterToken?: string
} | null => {
  try {
    const decoded = Schema.decodeUnknownOption(ScanManifest)(JSON.parse(value))
    if (Option.isNone(decoded)) return null
    const { observation_token: beforeToken, ...before } = decoded.value.before
    const { observation_token: afterToken, ...after } = decoded.value.after
    return {
      value: JSON.stringify({ ...decoded.value, before, after }),
      beforeToken,
      afterToken
    }
  } catch {
    return null
  }
}

const observationsEquivalent = (left: string | undefined, right: string | undefined): boolean =>
  left === undefined || left.length === 0 || right === undefined || right.length === 0 || left === right

const manifestsEquivalent = (left: string, right: string): boolean => {
  const comparableLeft = comparableManifest(left)
  const comparableRight = comparableManifest(right)
  return comparableLeft !== null && comparableRight !== null &&
    comparableLeft.value === comparableRight.value &&
    observationsEquivalent(comparableLeft.beforeToken, comparableRight.beforeToken) &&
    observationsEquivalent(comparableLeft.afterToken, comparableRight.afterToken)
}

type ReplacementEvidence = "confirmed-change" | "recoverable" | "insufficient"

const CONFIRMED_REPLACEMENT_ERROR_CODES = new Set([
  "candidate-changed",
  "source-changed",
  "source-link",
  "unsupported-source",
  "unsupported-candidate",
  "not-a-directory",
  "unsafe-name",
  "lossy-name-decoding",
  "duplicate-name",
  "unsupported-pages",
  "encrypted",
  "structural-corruption",
  "zero-pages"
])

const RECOVERABLE_REPLACEMENT_ERROR_CODES = new Set([
  "location-unavailable",
  "missing-target",
  "read-failure",
  "root-changed",
  "root-unavailable"
])

const classifyReplacement = (
  acceptedKind: unknown,
  candidateKind: unknown,
  analysisStatus: unknown,
  acceptedManifest: unknown,
  candidateManifest: unknown,
  analysisError: unknown
): ReplacementEvidence => {
  if (acceptedKind !== candidateKind) return "confirmed-change"
  if (analysisStatus === "ready" && typeof acceptedManifest === "string" && typeof candidateManifest === "string") {
    return manifestsEquivalent(acceptedManifest, candidateManifest) ? "recoverable" : "confirmed-change"
  }
  if (analysisStatus === "error" && typeof analysisError === "string") {
    try {
      const decoded = Schema.decodeUnknownOption(ScanAnalysisError)(JSON.parse(analysisError))
      if (Option.isNone(decoded)) return "insufficient"
      if (CONFIRMED_REPLACEMENT_ERROR_CODES.has(decoded.value.code)) return "confirmed-change"
      if (RECOVERABLE_REPLACEMENT_ERROR_CODES.has(decoded.value.code)) return "recoverable"
      return "insufficient"
    } catch {
      return "insufficient"
    }
  }
  return "insufficient"
}

const confirmedReplacement = (
  acceptedKind: unknown,
  candidateKind: unknown,
  analysisStatus: unknown,
  acceptedManifest: unknown,
  candidateManifest: unknown,
  analysisError: unknown
): number => classifyReplacement(
  acceptedKind,
  candidateKind,
  analysisStatus,
  acceptedManifest,
  candidateManifest,
  analysisError
) === "confirmed-change" ? 1 : 0

const resolutionReplacementReason = (...args: Parameters<typeof classifyReplacement>): "known-change" | "insufficient-evidence" | null => {
  const evidence = classifyReplacement(...args)
  return evidence === "confirmed-change"
    ? "known-change"
    : evidence === "insufficient"
      ? "insufficient-evidence"
      : null
}

const resolutionParentKey = (relativePath: string): string => {
  const separator = relativePath.lastIndexOf("/")
  const parentPath = separator < 0 ? "" : relativePath.slice(0, separator)
  const foldedParent = caseFold(parentPath.normalize("NFC")).normalize("NFC")
  return foldedParent.split("/").map((component) => component.replace(/[ .]+$/gu, "")).join("/")
}

const ResolutionCursor = Schema.Struct({
  version: Schema.Literal(1),
  target_entry_id: Schema.String,
  root_id: Schema.String,
  sibling_claims_revision: Schema.String,
  relative_path: Schema.String,
  entry_id: Schema.String
})

const encodeResolutionCursor = (value: typeof ResolutionCursor.Type): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

const decodeResolutionCursor = (value: string): typeof ResolutionCursor.Type | undefined => {
  try {
    const decoded = Schema.decodeUnknownOption(ResolutionCursor)(JSON.parse(Buffer.from(value, "base64url").toString("utf8")))
    return Option.isNone(decoded) ? undefined : decoded.value
  } catch {
    return undefined
  }
}

const dbPath = (workerData as { readonly dbPath: string }).dbPath
const db = new DatabaseSync(dbPath)
db.function(
  "henshin_resolution_parent_key",
  { deterministic: true },
  (relativePath) => typeof relativePath === "string" ? resolutionParentKey(relativePath) : null
)
db.function(
  "henshin_confirmed_replacement",
  { deterministic: true },
  confirmedReplacement
)

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
    library_id TEXT NOT NULL UNIQUE,
    change_revision INTEGER NOT NULL DEFAULT 0
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
  CREATE TABLE IF NOT EXISTS scan_tasks (
    task_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    epoch TEXT NOT NULL,
    root_id TEXT NOT NULL REFERENCES server_roots(root_id),
    mapping_revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'completed_with_errors', 'failed', 'interrupted')),
    hold_new_discoveries INTEGER NOT NULL CHECK (hold_new_discoveries IN (0, 1)),
    directories_visited INTEGER NOT NULL,
    candidates_discovered INTEGER NOT NULL,
    candidates_analyzed INTEGER NOT NULL,
    analysis_error_count INTEGER NOT NULL,
    review_needed_count INTEGER NOT NULL,
    coverage_json TEXT,
    readiness_error_code TEXT,
    readiness_error_message TEXT,
    error_code TEXT,
    error_message TEXT,
    command_payload TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (epoch, operation_id)
  );
  CREATE TABLE IF NOT EXISTS scan_start_aliases (
    epoch TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES scan_tasks(task_id) ON DELETE CASCADE,
    PRIMARY KEY(epoch, operation_id)
  );
  CREATE TABLE IF NOT EXISTS staged_discoveries (
    candidate_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES scan_tasks(task_id),
    root_id TEXT NOT NULL REFERENCES server_roots(root_id),
    relative_path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('archive', 'image-directory')),
    candidate_version INTEGER NOT NULL,
    hold_state TEXT NOT NULL CHECK (hold_state IN ('held', 'eligible')),
    analysis_status TEXT NOT NULL CHECK (analysis_status IN ('ready', 'error')),
    manifest_json TEXT,
    analysis_error_json TEXT,
    updated_at_ms INTEGER NOT NULL,
    candidate_observation_json TEXT,
    UNIQUE (root_id, relative_path)
  );
  CREATE TABLE IF NOT EXISTS root_policy_operations (
    epoch TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    root_id TEXT NOT NULL REFERENCES server_roots(root_id),
    payload TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (epoch, operation_id)
  );
  CREATE TABLE IF NOT EXISTS review_operations (
    epoch TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (epoch, operation_id)
  );
  CREATE TABLE IF NOT EXISTS library_entries (
    entry_id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES server_library(library_id),
    root_id TEXT NOT NULL REFERENCES server_roots(root_id),
    relative_path TEXT NOT NULL,
    source_path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('archive', 'image-directory')),
    title TEXT NOT NULL,
    page_count INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('accepted', 'replacement-pending')),
    content_version INTEGER NOT NULL,
    location_revision INTEGER NOT NULL,
    decision_version INTEGER NOT NULL DEFAULT 1,
    manifest_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    accepted_observation_json TEXT,
    UNIQUE (root_id, relative_path)
  );
  CREATE TABLE IF NOT EXISTS open_events (
    event_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    entry_id TEXT NOT NULL REFERENCES library_entries(entry_id),
    device_id TEXT NOT NULL,
    observed_location_revision INTEGER NOT NULL,
    observed_content_version INTEGER NOT NULL,
    occurred_at_ms INTEGER NOT NULL,
    receipt_at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS open_events_entry_occurrence
    ON open_events(entry_id, occurred_at_ms DESC, event_id ASC);
  CREATE TABLE IF NOT EXISTS entry_statistics (
    entry_id TEXT PRIMARY KEY REFERENCES library_entries(entry_id) ON DELETE CASCADE,
    open_count INTEGER NOT NULL DEFAULT 0,
    last_opened_at_ms INTEGER
  );
`)

const existingServerState = db.prepare(
  "SELECT schema_version FROM server_state WHERE id = 1"
).get() as { schema_version: number } | undefined

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

const serverLibraryColumns = db.prepare("PRAGMA table_info(server_library)").all() as unknown as ReadonlyArray<{ name: string }>
if (!serverLibraryColumns.some((column) => column.name === "change_revision")) {
  db.exec("ALTER TABLE server_library ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0")
}

const libraryEntryColumns = db.prepare("PRAGMA table_info(library_entries)").all() as unknown as ReadonlyArray<{ name: string }>
if (!libraryEntryColumns.some((column) => column.name === "decision_version")) {
  db.exec("ALTER TABLE library_entries ADD COLUMN decision_version INTEGER NOT NULL DEFAULT 1")
}
const addedAcceptedObservationSummary = !libraryEntryColumns.some((column) => column.name === "accepted_observation_json")
if (addedAcceptedObservationSummary) {
  db.exec("ALTER TABLE library_entries ADD COLUMN accepted_observation_json TEXT")
}

const stagedDiscoveryColumns = db.prepare("PRAGMA table_info(staged_discoveries)").all() as unknown as ReadonlyArray<{ name: string }>
const addedCandidateObservationSummary = !stagedDiscoveryColumns.some((column) => column.name === "candidate_observation_json")
if (addedCandidateObservationSummary) {
  db.exec("ALTER TABLE staged_discoveries ADD COLUMN candidate_observation_json TEXT")
}

const scanTaskTable = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scan_tasks'"
).get() as { sql: string } | undefined
const stagedDiscoveryTable = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'staged_discoveries'"
).get() as { sql: string } | undefined
const needsScanSchemaMigration =
  scanTaskTable?.sql.includes("hold_new_discoveries IN (0, 1)") !== true ||
  stagedDiscoveryTable?.sql.includes("hold_state IN ('held', 'eligible')") !== true

if (needsScanSchemaMigration) {
  db.exec("PRAGMA foreign_keys = OFF")
  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec(`
      CREATE TABLE scan_tasks_v4 (
        task_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        epoch TEXT NOT NULL,
        root_id TEXT NOT NULL REFERENCES server_roots(root_id),
        mapping_revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'completed_with_errors', 'failed', 'interrupted')),
        hold_new_discoveries INTEGER NOT NULL CHECK (hold_new_discoveries IN (0, 1)),
        directories_visited INTEGER NOT NULL,
        candidates_discovered INTEGER NOT NULL,
        candidates_analyzed INTEGER NOT NULL,
        analysis_error_count INTEGER NOT NULL,
        review_needed_count INTEGER NOT NULL,
        coverage_json TEXT,
        readiness_error_code TEXT,
        readiness_error_message TEXT,
        error_code TEXT,
        error_message TEXT,
        command_payload TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (epoch, operation_id)
      );
      CREATE TABLE staged_discoveries_v4 (
        candidate_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES scan_tasks(task_id),
        root_id TEXT NOT NULL REFERENCES server_roots(root_id),
        relative_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('archive', 'image-directory')),
        candidate_version INTEGER NOT NULL,
        hold_state TEXT NOT NULL CHECK (hold_state IN ('held', 'eligible')),
        analysis_status TEXT NOT NULL CHECK (analysis_status IN ('ready', 'error')),
        manifest_json TEXT,
        analysis_error_json TEXT,
        updated_at_ms INTEGER NOT NULL,
        candidate_observation_json TEXT,
        UNIQUE (root_id, relative_path)
      );
      INSERT INTO scan_tasks_v4 SELECT * FROM scan_tasks;
      INSERT INTO staged_discoveries_v4 SELECT * FROM staged_discoveries;
      DROP TABLE staged_discoveries;
      DROP TABLE scan_tasks;
      ALTER TABLE scan_tasks_v4 RENAME TO scan_tasks;
      ALTER TABLE staged_discoveries_v4 RENAME TO staged_discoveries;
    `)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  } finally {
    db.exec("PRAGMA foreign_keys = ON")
  }
}

if (!db.prepare("SELECT 1 FROM pragma_table_info('root_policy_operations') WHERE name = 'created_at_ms'").get()) {
  db.exec("ALTER TABLE root_policy_operations ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0")
  db.prepare("UPDATE root_policy_operations SET created_at_ms = ?").run(Date.now())
}

const libraryEntriesTable = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'library_entries'"
).get() as { sql: string } | undefined
if (libraryEntriesTable !== undefined && !libraryEntriesTable.sql.includes("replacement-pending")) {
  db.exec("PRAGMA foreign_keys = OFF")
  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec(`
      CREATE TABLE library_entries_v7 (
        entry_id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES server_library(library_id),
        root_id TEXT NOT NULL REFERENCES server_roots(root_id),
        relative_path TEXT NOT NULL,
        source_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('archive', 'image-directory')),
        title TEXT NOT NULL,
        page_count INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'replacement-pending')),
        content_version INTEGER NOT NULL,
        location_revision INTEGER NOT NULL,
        decision_version INTEGER NOT NULL DEFAULT 1,
        manifest_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        accepted_observation_json TEXT,
        UNIQUE (root_id, relative_path)
      );
      INSERT INTO library_entries_v7
        SELECT entry_id, library_id, root_id, relative_path, source_path, kind, title, page_count,
          state, content_version, location_revision, decision_version, manifest_json, created_at_ms, updated_at_ms,
          accepted_observation_json
        FROM library_entries;
      DROP TABLE library_entries;
      ALTER TABLE library_entries_v7 RENAME TO library_entries;
    `)
    const migratedAt = Date.now()
    const migrated = db.prepare(`
      UPDATE library_entries
      SET state = 'replacement-pending', updated_at_ms = ?
      WHERE state = 'accepted'
        AND EXISTS (
          SELECT 1 FROM staged_discoveries s
          WHERE s.root_id = library_entries.root_id
            AND s.relative_path = library_entries.relative_path
            AND henshin_confirmed_replacement(
              library_entries.kind,
              s.kind,
              s.analysis_status,
              library_entries.manifest_json,
              s.manifest_json,
              s.analysis_error_json
            ) = 1
        )
    `).run(migratedAt)
    if (Number(migrated.changes) > 0) {
      db.prepare("UPDATE server_library SET change_revision = change_revision + 1 WHERE id = 1").run()
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  } finally {
    db.exec("PRAGMA foreign_keys = ON")
  }
}

const needsSummaryBackfill = addedAcceptedObservationSummary || addedCandidateObservationSummary ||
  (existingServerState !== undefined && existingServerState.schema_version < CURRENT_SCHEMA_VERSION)

if (needsSummaryBackfill) {
  db.exec("BEGIN IMMEDIATE")
  try {
    const acceptedWithoutSummary = db.prepare(
      "SELECT entry_id, kind, manifest_json FROM library_entries WHERE accepted_observation_json IS NULL"
    ).iterate() as unknown as Iterable<{
      entry_id: string
      kind: "archive" | "image-directory"
      manifest_json: string
    }>
    const updateAcceptedSummary = db.prepare(
      "UPDATE library_entries SET accepted_observation_json = ? WHERE entry_id = ?"
    )
    for (const row of acceptedWithoutSummary) {
      updateAcceptedSummary.run(
        JSON.stringify(replacementObservation(persistedManifest(row.manifest_json, "accepted manifest"), row.kind)),
        row.entry_id
      )
    }

    const candidatesWithoutSummary = db.prepare(
      "SELECT candidate_id, kind, analysis_status, manifest_json, analysis_error_json FROM staged_discoveries WHERE candidate_observation_json IS NULL"
    ).iterate() as unknown as Iterable<{
      candidate_id: string
      kind: "archive" | "image-directory"
      analysis_status: "ready" | "error"
      manifest_json: string | null
      analysis_error_json: string | null
    }>
    const updateCandidateSummary = db.prepare(
      "UPDATE staged_discoveries SET candidate_observation_json = ? WHERE candidate_id = ?"
    )
    for (const row of candidatesWithoutSummary) {
      updateCandidateSummary.run(
        JSON.stringify(replacementCandidateObservation(row.kind, row.analysis_status, row.manifest_json, row.analysis_error_json)),
        row.candidate_id
      )
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
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
const selectLibraryState = db.prepare("SELECT library_id, change_revision FROM server_library WHERE id = 1")
const selectRootOperation = db.prepare("SELECT payload, result FROM root_operations WHERE operation_id = ?")
const insertRoot = db.prepare(
  "INSERT INTO server_roots(library_id, root_id, label, selected_path, canonical_path, device, inode, mapping_revision, policy_revision, exclusions, state) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')"
)
const insertRootOperation = db.prepare(
  "INSERT INTO root_operations(operation_id, payload, result) VALUES(?, ?, ?)"
)
const selectScanOperation = db.prepare(
  `SELECT task_id, command_payload FROM scan_tasks WHERE epoch = ? AND operation_id = ?
   UNION ALL
   SELECT t.task_id, t.command_payload FROM scan_start_aliases a JOIN scan_tasks t ON t.task_id = a.task_id
   WHERE a.epoch = ? AND a.operation_id = ?`
)
const selectScanTask = db.prepare(
  "SELECT task_id, operation_id, epoch, root_id, mapping_revision, status, hold_new_discoveries, directories_visited, candidates_discovered, candidates_analyzed, analysis_error_count, review_needed_count, coverage_json, readiness_error_code, readiness_error_message, error_code, error_message, created_at_ms, updated_at_ms FROM scan_tasks WHERE task_id = ?"
)
selectScanTask.setReadBigInts(true)
const selectScanTasks = db.prepare(
  "SELECT task_id, operation_id, epoch, root_id, mapping_revision, status, hold_new_discoveries, directories_visited, candidates_discovered, candidates_analyzed, analysis_error_count, review_needed_count, coverage_json, readiness_error_code, readiness_error_message, error_code, error_message, created_at_ms, updated_at_ms FROM scan_tasks ORDER BY created_at_ms ASC, rowid ASC"
)
selectScanTasks.setReadBigInts(true)
const selectStagedDiscoveries = db.prepare(
  "SELECT candidate_id, task_id, root_id, relative_path, kind, candidate_version, hold_state, analysis_status, manifest_json, analysis_error_json, updated_at_ms FROM staged_discoveries ORDER BY updated_at_ms ASC, rowid ASC"
)
selectStagedDiscoveries.setReadBigInts(true)
const selectStaged = db.prepare(
  "SELECT candidate_id, candidate_version, task_id, kind, analysis_status, hold_state, manifest_json, analysis_error_json FROM staged_discoveries WHERE root_id = ? AND relative_path = ?"
)
selectStaged.setReadBigInts(true)
const selectAcceptedThumbnailEntry = db.prepare(
  "SELECT entry_id, root_id, relative_path, kind, state, content_version, manifest_json FROM library_entries WHERE entry_id = ? AND state IN ('accepted', 'replacement-pending')"
)
selectAcceptedThumbnailEntry.setReadBigInts(true)
const selectStagedById = db.prepare(
  "SELECT candidate_id, task_id, root_id, relative_path, kind, candidate_version, hold_state, analysis_status, manifest_json, analysis_error_json, updated_at_ms FROM staged_discoveries WHERE candidate_id = ? AND root_id = ?"
)
selectStagedById.setReadBigInts(true)
const selectEntriesForRoot = db.prepare("SELECT relative_path FROM library_entries WHERE root_id = ? AND state IN ('accepted', 'replacement-pending') ORDER BY relative_path ASC")
const selectEntry = db.prepare("SELECT entry_id, manifest_json, kind, title, source_path, state, decision_version, location_revision, content_version, page_count FROM library_entries WHERE root_id = ? AND relative_path = ? AND state IN ('accepted', 'replacement-pending')")
const selectEntryResolution = db.prepare(
  "SELECT entry_id, root_id, relative_path, kind, state, decision_version, location_revision, content_version, manifest_json FROM library_entries WHERE entry_id = ? AND state IN ('accepted', 'replacement-pending')"
)
selectEntryResolution.setReadBigInts(true)
const selectStagedForResolution = db.prepare(
  "SELECT kind, analysis_status, manifest_json, analysis_error_json FROM staged_discoveries WHERE root_id = ? AND relative_path = ?"
)
const selectEntryForResolution = db.prepare("SELECT entry_id, library_id, root_id, relative_path, source_path, kind, title, page_count, state, decision_version, content_version, location_revision, accepted_observation_json, NULL AS candidate_id, NULL AS candidate_version, NULL AS candidate_kind, NULL AS candidate_analysis_status, NULL AS candidate_observation_json FROM library_entries WHERE entry_id = ? AND root_id = ?")
selectEntryForResolution.setReadBigInts(true)
const selectResolutionSiblingClaims = db.prepare(
  "SELECT entry_id, relative_path FROM library_entries WHERE root_id = ? AND state IN ('accepted', 'replacement-pending') AND entry_id <> ? AND henshin_resolution_parent_key(relative_path) = ? ORDER BY relative_path ASC, entry_id ASC LIMIT ?"
)
const selectResolutionSiblingClaimsAfter = db.prepare(
  "SELECT entry_id, relative_path FROM library_entries WHERE root_id = ? AND state IN ('accepted', 'replacement-pending') AND entry_id <> ? AND henshin_resolution_parent_key(relative_path) = ? AND (relative_path > ? OR (relative_path = ? AND entry_id > ?)) ORDER BY relative_path ASC, entry_id ASC LIMIT ?"
)
const selectResolutionSiblingCursor = db.prepare(
  "SELECT entry_id, root_id, relative_path FROM library_entries WHERE entry_id = ? AND state IN ('accepted', 'replacement-pending')"
)
const MAX_RESOLUTION_SIBLINGS = 128
const selectEntryById = db.prepare("SELECT entry_id FROM library_entries WHERE entry_id = ?")
const selectOpenEvent = db.prepare(
  "SELECT event_id, instance_id, entry_id, device_id, observed_location_revision, observed_content_version, occurred_at_ms, receipt_at_ms FROM open_events WHERE event_id = ?"
)
selectOpenEvent.setReadBigInts(true)
const insertOpenEvent = db.prepare(
  "INSERT INTO open_events(event_id, instance_id, entry_id, device_id, observed_location_revision, observed_content_version, occurred_at_ms, receipt_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?)"
)
const insertEntryStatistics = db.prepare(
  "INSERT OR IGNORE INTO entry_statistics(entry_id, open_count, last_opened_at_ms) VALUES(?, 0, NULL)"
)
const updateEntryStatistics = db.prepare(
  "UPDATE entry_statistics SET open_count = open_count + 1, last_opened_at_ms = CASE WHEN last_opened_at_ms IS NULL OR last_opened_at_ms < ? THEN ? ELSE last_opened_at_ms END WHERE entry_id = ?"
)
const insertEntry = db.prepare(
  "INSERT INTO library_entries(entry_id, library_id, root_id, relative_path, source_path, kind, title, page_count, state, content_version, location_revision, decision_version, manifest_json, created_at_ms, updated_at_ms, accepted_observation_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 1, 1, 1, ?, ?, ?, ?)"
)
const markEntryPending = db.prepare(
  "UPDATE library_entries SET state = 'replacement-pending', updated_at_ms = ? WHERE entry_id = ? AND state = 'accepted'"
)
const acceptReplacement = db.prepare(
  "UPDATE library_entries SET kind = ?, title = ?, page_count = ?, state = 'accepted', decision_version = decision_version + 1, content_version = content_version + 1, manifest_json = ?, accepted_observation_json = ?, updated_at_ms = ? WHERE entry_id = ? AND state = 'replacement-pending'"
)
const deleteStaged = db.prepare("DELETE FROM staged_discoveries WHERE candidate_id = ?")
const selectStagedPathsForRoot = db.prepare("SELECT relative_path FROM staged_discoveries WHERE root_id = ?")
const bumpLibraryRevision = db.prepare("UPDATE server_library SET change_revision = change_revision + 1 WHERE id = 1")
const selectLibraryEntries = (cursor: string | null, limit: number) => {
  const statement = db.prepare(cursor === null
    ? `SELECT e.entry_id, e.library_id, e.root_id, e.relative_path, e.source_path, e.kind, e.title,
         e.page_count, e.state, e.decision_version, e.content_version, e.location_revision,
         CASE WHEN e.state = 'replacement-pending' AND s.candidate_id IS NOT NULL THEN e.accepted_observation_json ELSE NULL END AS accepted_observation_json,
         s.candidate_id, s.candidate_version, s.kind AS candidate_kind, s.analysis_status AS candidate_analysis_status,
         s.candidate_observation_json
       FROM library_entries e
       LEFT JOIN staged_discoveries s ON s.root_id = e.root_id AND s.relative_path = e.relative_path
       WHERE e.state IN ('accepted', 'replacement-pending')
       ORDER BY e.entry_id ASC LIMIT ?`
    : `SELECT e.entry_id, e.library_id, e.root_id, e.relative_path, e.source_path, e.kind, e.title,
         e.page_count, e.state, e.decision_version, e.content_version, e.location_revision,
         CASE WHEN e.state = 'replacement-pending' AND s.candidate_id IS NOT NULL THEN e.accepted_observation_json ELSE NULL END AS accepted_observation_json,
         s.candidate_id, s.candidate_version, s.kind AS candidate_kind, s.analysis_status AS candidate_analysis_status,
         s.candidate_observation_json
       FROM library_entries e
       LEFT JOIN staged_discoveries s ON s.root_id = e.root_id AND s.relative_path = e.relative_path
       WHERE e.entry_id > ? AND e.state IN ('accepted', 'replacement-pending')
       ORDER BY e.entry_id ASC LIMIT ?`)
  statement.setReadBigInts(true)
  return cursor === null ? statement.all(limit) : statement.all(cursor, limit)
}
const selectIndexedRootSamples = db.prepare(
  "SELECT relative_path, kind, manifest_json FROM library_entries WHERE root_id = ? AND state = 'accepted' ORDER BY relative_path ASC LIMIT ?"
)
const insertScanTask = db.prepare(
  "INSERT INTO scan_tasks(task_id, operation_id, epoch, root_id, mapping_revision, status, hold_new_discoveries, directories_visited, candidates_discovered, candidates_analyzed, analysis_error_count, review_needed_count, coverage_json, readiness_error_code, readiness_error_message, error_code, error_message, command_payload, created_at_ms, updated_at_ms) VALUES(?, ?, ?, ?, ?, 'queued', ?, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)"
)
const updateScanRunning = db.prepare("UPDATE scan_tasks SET status = 'running', updated_at_ms = ? WHERE task_id = ? AND status = 'queued'")
const updateScanTask = db.prepare(
  "UPDATE scan_tasks SET status = ?, directories_visited = ?, candidates_discovered = ?, candidates_analyzed = ?, analysis_error_count = ?, review_needed_count = ?, coverage_json = ?, readiness_error_code = ?, readiness_error_message = ?, error_code = ?, error_message = ?, updated_at_ms = ? WHERE task_id = ? AND status IN ('running', 'queued')"
)
const selectScanFence = db.prepare(`
  SELECT t.mapping_revision AS captured_mapping_revision,
    json_extract(t.command_payload, '$.expected_policy_revision') AS captured_policy_revision,
    r.mapping_revision AS current_mapping_revision,
    r.policy_revision AS current_policy_revision
  FROM scan_tasks t
  JOIN server_roots r ON r.root_id = t.root_id
  WHERE t.task_id = ? AND t.root_id = ? AND t.status = 'running'
`)
selectScanFence.setReadBigInts(true)
const upsertStagedDiscovery = db.prepare(
  "INSERT INTO staged_discoveries(candidate_id, task_id, root_id, relative_path, kind, candidate_version, hold_state, analysis_status, manifest_json, analysis_error_json, updated_at_ms, candidate_observation_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(root_id, relative_path) DO UPDATE SET task_id = excluded.task_id, kind = excluded.kind, candidate_version = staged_discoveries.candidate_version + 1, hold_state = excluded.hold_state, analysis_status = excluded.analysis_status, manifest_json = excluded.manifest_json, analysis_error_json = excluded.analysis_error_json, updated_at_ms = excluded.updated_at_ms, candidate_observation_json = excluded.candidate_observation_json"
)
const recoverScanTasks = db.prepare(
  "UPDATE scan_tasks SET status = CASE WHEN status = 'queued' THEN 'failed' ELSE 'interrupted' END, error_code = 'server_restart', error_message = CASE WHEN status = 'queued' THEN 'scan did not start before server restart' ELSE 'scan interrupted by server restart' END, updated_at_ms = ? WHERE status IN ('queued', 'running')"
)
const selectRootPolicyOperation = db.prepare(
  "SELECT payload, result, created_at_ms FROM root_policy_operations WHERE epoch = ? AND operation_id = ?"
)
const compactRootPolicyOperations = db.prepare(`
  DELETE FROM root_policy_operations WHERE rowid IN (
    SELECT rowid FROM root_policy_operations WHERE epoch <> ? OR created_at_ms <= ? LIMIT ?
  )
`)
const countRootPolicyOperations = db.prepare("SELECT COUNT(*) AS count FROM root_policy_operations")
const insertRootPolicyOperation = db.prepare(
  "INSERT INTO root_policy_operations(epoch, operation_id, root_id, payload, result, created_at_ms) VALUES(?, ?, ?, ?, ?, ?)"
)
const selectReviewOperation = db.prepare(
  "SELECT payload, result, created_at_ms FROM review_operations WHERE epoch = ? AND operation_id = ?"
)
const compactReviewOperations = db.prepare(
  "DELETE FROM review_operations WHERE rowid IN (SELECT rowid FROM review_operations WHERE epoch <> ? OR created_at_ms <= ? ORDER BY created_at_ms ASC, rowid ASC LIMIT ?)"
)
const countReviewOperations = db.prepare("SELECT COUNT(*) AS count FROM review_operations")
const insertReviewOperation = db.prepare(
  "INSERT INTO review_operations(epoch, operation_id, candidate_id, payload, result, created_at_ms) VALUES(?, ?, ?, ?, ?, ?)"
)
const updateStagedHold = db.prepare(
  "UPDATE staged_discoveries SET candidate_version = ?, hold_state = 'eligible', updated_at_ms = ? WHERE candidate_id = ? AND root_id = ? AND candidate_version = ? AND hold_state = 'held'"
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

const scanTaskRow = (row: {
  task_id: string
  operation_id: string
  epoch: string
  root_id: string
  mapping_revision: bigint
  status: "queued" | "running" | "succeeded" | "completed_with_errors" | "failed" | "interrupted"
  hold_new_discoveries: bigint
  directories_visited: bigint
  candidates_discovered: bigint
  candidates_analyzed: bigint
  analysis_error_count: bigint
  review_needed_count: bigint
  coverage_json: string | null
  readiness_error_code: string | null
  readiness_error_message: string | null
  error_code: string | null
  error_message: string | null
  created_at_ms: number
  updated_at_ms: number
}): import("./worker-protocol").ScanTaskRow => ({
  task_id: row.task_id,
  operation_id: row.operation_id,
  epoch: row.epoch,
  root_id: row.root_id,
  mapping_revision: row.mapping_revision.toString(),
  status: row.status,
  hold_new_discoveries: row.hold_new_discoveries === 1n,
  directories_visited: Number(row.directories_visited),
  candidates_discovered: Number(row.candidates_discovered),
  candidates_analyzed: Number(row.candidates_analyzed),
  analysis_error_count: Number(row.analysis_error_count),
  review_needed_count: Number(row.review_needed_count),
  coverage_json: row.coverage_json,
  readiness_error_code: row.readiness_error_code,
  readiness_error_message: row.readiness_error_message,
  error_code: row.error_code,
  error_message: row.error_message,
  created_at_ms: Number(row.created_at_ms),
  updated_at_ms: Number(row.updated_at_ms)
})

const scanTaskById = (taskId: string): import("./worker-protocol").ScanTaskRow | undefined => {
  const row = selectScanTask.get(taskId) as Parameters<typeof scanTaskRow>[0] | undefined
  return row === undefined ? undefined : scanTaskRow(row)
}

const scanTaskRows = (): ReadonlyArray<import("./worker-protocol").ScanTaskRow> =>
  (selectScanTasks.all() as unknown as ReadonlyArray<Parameters<typeof scanTaskRow>[0]>).map(scanTaskRow)

const stagedDiscoveryRow = (row: {
  candidate_id: string
  task_id: string
  root_id: string
  relative_path: string
  kind: "archive" | "image-directory"
  candidate_version: bigint
  hold_state: "held" | "eligible"
  analysis_status: "ready" | "error"
  manifest_json: string | null
  analysis_error_json: string | null
  updated_at_ms: number
}): import("./worker-protocol").StagedDiscoveryRow => ({
  candidate_id: row.candidate_id,
  task_id: row.task_id,
  root_id: row.root_id,
  relative_path: row.relative_path,
  kind: row.kind,
  candidate_version: Number(row.candidate_version),
  hold_state: row.hold_state,
  analysis_status: row.analysis_status,
  manifest_json: row.manifest_json,
  analysis_error_json: row.analysis_error_json,
  updated_at_ms: Number(row.updated_at_ms)
})

const startManualScan = (
  request: Extract<WorkerRequest, { op: "startManualScan" }>
): import("./worker-protocol").ScanStartOutcome => {
  const commandPayload = JSON.stringify({
    root_id: request.rootId,
    expected_mapping_revision: request.expectedMappingRevision,
    expected_policy_revision: request.expectedPolicyRevision,
    hold_new_discoveries: request.holdNewDiscoveries
  })
  db.exec("BEGIN IMMEDIATE")
  try {
    const existing = selectScanOperation.get(request.epoch, request.operationId, request.epoch, request.operationId) as
      | { task_id: string; command_payload: string }
      | undefined
    if (existing !== undefined) {
      if (existing.command_payload !== commandPayload) {
        db.exec("ROLLBACK")
        return { kind: "operation_conflict" }
      }
      const task = scanTaskById(existing.task_id)
      if (task === undefined) throw new Error("scan task is missing")
      db.exec("COMMIT")
      return { kind: "replayed", task }
    }

    const root = rootById(request.rootId)
    if (root === undefined) {
      db.exec("ROLLBACK")
      return { kind: "root_not_found" }
    }
    if (root.mappingRevision !== request.expectedMappingRevision) {
      db.exec("ROLLBACK")
      return { kind: "mapping_revision_conflict", currentMappingRevision: root.mappingRevision }
    }
    if (root.policyRevision !== request.expectedPolicyRevision) {
      db.exec("ROLLBACK")
      return { kind: "policy_revision_conflict", currentPolicyRevision: root.policyRevision }
    }

    db.prepare(`UPDATE scan_tasks SET status = 'interrupted', updated_at_ms = ?, error_code = 'server_restart',
      error_message = 'scan interrupted by server restart' WHERE root_id = ? AND epoch <> ?
      AND status IN ('queued', 'running')`).run(Date.now(), request.rootId, request.epoch)
    const active = db.prepare(
      "SELECT task_id, command_payload, json_extract(command_payload, '$.expected_policy_revision') AS policy_revision FROM scan_tasks WHERE root_id = ? AND mapping_revision = ? AND status IN ('queued', 'running') ORDER BY created_at_ms ASC, rowid ASC LIMIT 1"
    ).get(request.rootId, BigInt(request.expectedMappingRevision)) as { task_id: string; command_payload: string; policy_revision: string } | undefined
    if (active !== undefined) {
      if (active.command_payload !== commandPayload) {
        db.exec("ROLLBACK")
        return { kind: "active_scan_conflict", taskId: active.task_id, policyRevision: active.policy_revision }
      }
      db.prepare("INSERT INTO scan_start_aliases(epoch, operation_id, task_id) VALUES(?, ?, ?)").run(
        request.epoch, request.operationId, active.task_id
      )
      const task = scanTaskById(active.task_id)
      if (task === undefined) throw new Error("active scan task is missing")
      db.exec("COMMIT")
      return { kind: "active", task }
    }

    const taskId = request.taskId
    const now = Date.now()
    insertScanTask.run(
      taskId,
      request.operationId,
      request.epoch,
      request.rootId,
      BigInt(request.expectedMappingRevision),
      request.holdNewDiscoveries ? 1 : 0,
      commandPayload,
      now,
      now
    )
    const task = scanTaskById(taskId)
    if (task === undefined) throw new Error("created scan task is missing")
    db.exec("COMMIT")
    return { kind: "created", task }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
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
    const now = Date.now()
    const existing = selectRootPolicyOperation.get(request.epoch, request.operationId) as
      | { payload: string; result: string; created_at_ms: number }
      | undefined
    if (existing !== undefined) {
      if (existing.payload !== payload) {
        db.exec("ROLLBACK")
        return { kind: "operation_conflict" }
      }
      if (existing.created_at_ms <= now - RESULT_RETENTION_MS) {
        db.exec("ROLLBACK")
        return { kind: "operation_expired" }
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
    if (exclusions.length > MAX_ROOT_EXCLUSIONS) {
      db.exec("ROLLBACK")
      return { kind: "exclusion_limit" }
    }
    compactRootPolicyOperations.run(request.epoch, now - RESULT_RETENTION_MS, COMPACTION_BATCH)
    if (Number(countRootPolicyOperations.get()?.count) >= MAX_POLICY_OPERATION_RESULTS) {
      db.exec("COMMIT")
      return { kind: "storage_full" }
    }
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
      JSON.stringify(root),
      now
    )
    db.exec("COMMIT")
    return { kind: "committed", root }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

const requireScanTransition = (result: { changes: number | bigint }): void => {
  if (Number(result.changes) !== 1) throw new Error("scan task is no longer active for this operation")
}

const requireCurrentScanFence = (taskId: string, rootId: string): void => {
  const row = selectScanFence.get(taskId, rootId) as {
    captured_mapping_revision: bigint
    captured_policy_revision: string | null
    current_mapping_revision: bigint
    current_policy_revision: bigint
  } | undefined
  if (
    row === undefined ||
    row.captured_policy_revision === null ||
    row.captured_mapping_revision !== row.current_mapping_revision ||
    row.captured_policy_revision !== row.current_policy_revision.toString()
  ) {
    throw new Error("scan task no longer matches the current root mapping or policy")
  }
}

const stageDiscovery = (request: Extract<WorkerRequest, { op: "stageDiscovery" }>): void => {
  db.exec("BEGIN IMMEDIATE")
  try {
    requireCurrentScanFence(request.taskId, request.rootId)
    const existing = selectStaged.get(request.rootId, request.relativePath) as
      | {
          candidate_id: string
          candidate_version: bigint
          task_id: string
          kind: "archive" | "image-directory"
          analysis_status: "ready" | "error"
          hold_state: "held" | "eligible"
          manifest_json: string | null
          analysis_error_json: string | null
        }
      | undefined
    const accepted = selectEntry.get(request.rootId, request.relativePath) as {
      entry_id: string
      manifest_json: string
      kind: "archive" | "image-directory"
      title: string
      source_path: string
      state: "accepted" | "replacement-pending"
    } | undefined
    const sameAcceptedObservation = request.holdState === "held" && request.analysisStatus === "ready" && request.manifestJson !== null && accepted !== undefined &&
      accepted.state === "accepted" && accepted.kind === request.kind && accepted.manifest_json === request.manifestJson
    const knownReplacement = accepted !== undefined && accepted.state === "accepted" &&
      confirmedReplacement(
        accepted.kind,
        request.kind,
        request.analysisStatus,
        accepted.manifest_json,
        request.manifestJson,
        request.analysisErrorJson
      ) === 1
    const candidateObservationJson = JSON.stringify(replacementCandidateObservation(
      request.kind,
      request.analysisStatus,
      request.manifestJson,
      request.analysisErrorJson
    ))
    if (sameAcceptedObservation) {
      if (existing !== undefined) deleteStaged.run(existing.candidate_id)
    } else {
      const held = accepted === undefined && (request.holdState === "held" || existing?.hold_state === "held")
      upsertStagedDiscovery.run(
        existing?.candidate_id ?? request.candidateId,
        request.taskId,
        request.rootId,
        request.relativePath,
        request.kind,
        existing === undefined ? 1n : existing.candidate_version + 1n,
        held ? "held" : "eligible",
        request.analysisStatus,
        request.manifestJson,
        request.analysisErrorJson,
        Date.now(),
        candidateObservationJson
      )
      if (
        knownReplacement
      ) {
        if (Number(markEntryPending.run(Date.now(), accepted.entry_id).changes) === 1) bumpLibraryRevision.run()
      } else if (accepted?.state === "replacement-pending" && existing !== undefined) {
        bumpLibraryRevision.run()
      }
    }
    const priorStatus = existing?.task_id === request.taskId ? existing.analysis_status : undefined
    requireScanTransition(db.prepare(`UPDATE scan_tasks SET
      candidates_analyzed = candidates_analyzed + ?, analysis_error_count = analysis_error_count + ?,
      review_needed_count = review_needed_count + ?, updated_at_ms = ? WHERE task_id = ? AND root_id = ? AND status = 'running'`).run(
      Number(request.analysisStatus === "ready") - Number(priorStatus === "ready"),
      Number(request.analysisStatus === "error") - Number(priorStatus === "error"),
      Number(!sameAcceptedObservation && priorStatus === undefined), Date.now(), request.taskId, request.rootId
    ))
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

const reviewReleasePayload = (request: Extract<WorkerRequest, { op: "releaseHeldDiscovery" }>): string => JSON.stringify({
  command: { type: "release-hold" },
  expected_candidate_version: request.expectedCandidateVersion,
  expected_mapping_revision: request.expectedMappingRevision,
  expected_policy_revision: request.expectedPolicyRevision,
  root_id: request.rootId,
  candidate_id: request.candidateId
})

const releaseHeldDiscovery = (
  request: Extract<WorkerRequest, { op: "releaseHeldDiscovery" }>
): import("./worker-protocol").ReleaseHeldDiscoveryOutcome => {
  const payload = reviewReleasePayload(request)
  db.exec("BEGIN IMMEDIATE")
  try {
    const now = Date.now()
    const existing = selectReviewOperation.get(request.epoch, request.operationId) as
      | { payload: string; result: string; created_at_ms: number }
      | undefined
    if (existing !== undefined) {
      if (existing.payload !== payload) {
        db.exec("ROLLBACK")
        return { kind: "operation_conflict" }
      }
      if (existing.created_at_ms <= now - RESULT_RETENTION_MS) {
        db.exec("ROLLBACK")
        return { kind: "operation_expired" }
      }
      const candidate = JSON.parse(existing.result) as import("./worker-protocol").StagedDiscoveryRow
      db.exec("COMMIT")
      return { kind: "replayed", candidate }
    }

    const root = rootById(request.rootId)
    if (root === undefined) {
      db.exec("ROLLBACK")
      return { kind: "root_not_found" }
    }
    if (root.mappingRevision !== request.expectedMappingRevision) {
      db.exec("ROLLBACK")
      return { kind: "mapping_revision_conflict", currentMappingRevision: root.mappingRevision }
    }
    if (root.policyRevision !== request.expectedPolicyRevision) {
      db.exec("ROLLBACK")
      return { kind: "policy_revision_conflict", currentPolicyRevision: root.policyRevision }
    }

    const current = selectStagedById.get(request.candidateId, request.rootId) as
      | Parameters<typeof stagedDiscoveryRow>[0]
      | undefined
    if (current === undefined) {
      db.exec("ROLLBACK")
      return { kind: "candidate_not_found" }
    }
    const currentCandidateVersion = Number(current.candidate_version)
    if (currentCandidateVersion !== request.expectedCandidateVersion) {
      db.exec("ROLLBACK")
      return { kind: "candidate_version_conflict", currentCandidateVersion }
    }
    if (current.hold_state !== "held") {
      db.exec("ROLLBACK")
      return { kind: "candidate_not_held", currentCandidateVersion }
    }

    compactReviewOperations.run(request.epoch, now - RESULT_RETENTION_MS, COMPACTION_BATCH)
    if (Number(countReviewOperations.get()?.count) >= MAX_POLICY_OPERATION_RESULTS) {
      db.exec("COMMIT")
      return { kind: "storage_full" }
    }

    const nextCandidateVersion = BigInt(currentCandidateVersion + 1)
    const updated = updateStagedHold.run(
      nextCandidateVersion,
      now,
      request.candidateId,
      request.rootId,
      BigInt(request.expectedCandidateVersion)
    )
    if (Number(updated.changes) !== 1) throw new Error("staged discovery is no longer held")
    const candidateRow = selectStagedById.get(request.candidateId, request.rootId) as
      | Parameters<typeof stagedDiscoveryRow>[0]
      | undefined
    if (candidateRow === undefined) throw new Error("released staged discovery is missing")
    const candidate = stagedDiscoveryRow(candidateRow)
    insertReviewOperation.run(
      request.epoch,
      request.operationId,
      request.candidateId,
      payload,
      JSON.stringify(candidate),
      now
    )
    db.exec("COMMIT")
    return { kind: "committed", candidate }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

type EntryResolutionRequest = Extract<WorkerRequest, { op: "lookupEntryResolution" | "resolveReplacement" }>

const replacementResolutionPayload = (request: EntryResolutionRequest): string => JSON.stringify({
  command: { type: "resolve-replacement", decision: request.decision, entry_id: request.entryId },
  candidate_id: request.candidateId,
  root_id: request.rootId,
  expected_candidate_version: request.expectedCandidateVersion,
  expected_decision_version: request.expectedDecisionVersion,
  expected_location_revision: request.expectedLocationRevision,
  expected_mapping_revision: request.expectedMappingRevision,
  expected_policy_revision: request.expectedPolicyRevision
})

const lookupEntryResolution = (
  request: Extract<WorkerRequest, { op: "lookupEntryResolution" }>
): import("./worker-protocol").EntryResolutionLookupOutcome => {
  const existing = selectReviewOperation.get(request.epoch, request.operationId) as
    | { payload: string; result: string; created_at_ms: number }
    | undefined
  if (existing === undefined) return { kind: "not_found" }
  if (existing.payload !== replacementResolutionPayload(request)) return { kind: "operation_conflict" }
  if (existing.created_at_ms <= Date.now() - RESULT_RETENTION_MS) return { kind: "operation_expired" }
  return { kind: "replayed", ...JSON.parse(existing.result) }
}

const resolveReplacement = (
  request: Extract<WorkerRequest, { op: "resolveReplacement" }>
): import("./worker-protocol").ResolveReplacementOutcome => {
  const payload = replacementResolutionPayload(request)
  db.exec("BEGIN IMMEDIATE")
  try {
    const now = Date.now()
    const existing = selectReviewOperation.get(request.epoch, request.operationId) as
      | { payload: string; result: string; created_at_ms: number }
      | undefined
    if (existing !== undefined) {
      if (existing.payload !== payload) {
        db.exec("ROLLBACK")
        return { kind: "operation_conflict" }
      }
      if (existing.created_at_ms <= now - RESULT_RETENTION_MS) {
        db.exec("ROLLBACK")
        return { kind: "operation_expired" }
      }
      const result = JSON.parse(existing.result) as {
        decision: "keep"
        candidate: import("./worker-protocol").StagedDiscoveryRow
        entry: import("./worker-protocol").LibraryEntryRow
        detachedEntryId: string | null
      }
      db.exec("COMMIT")
      return { kind: "replayed", ...result }
    }

    const root = rootById(request.rootId)
    if (root === undefined) {
      db.exec("ROLLBACK")
      return { kind: "root_not_found" }
    }
    if (root.mappingRevision !== request.expectedMappingRevision) {
      db.exec("ROLLBACK")
      return { kind: "mapping_revision_conflict", currentMappingRevision: root.mappingRevision }
    }
    if (root.policyRevision !== request.expectedPolicyRevision) {
      db.exec("ROLLBACK")
      return { kind: "policy_revision_conflict", currentPolicyRevision: root.policyRevision }
    }

    const candidate = selectStagedById.get(request.candidateId, request.rootId) as
      | Parameters<typeof stagedDiscoveryRow>[0]
      | undefined
    if (candidate === undefined) {
      db.exec("ROLLBACK")
      return { kind: "candidate_not_found" }
    }
    const currentCandidateVersion = Number(candidate.candidate_version)
    if (currentCandidateVersion !== request.expectedCandidateVersion) {
      db.exec("ROLLBACK")
      return { kind: "candidate_version_conflict", currentCandidateVersion }
    }
    const entry = selectEntryForResolution.get(request.entryId, request.rootId) as {
      entry_id: string
      library_id: string
      root_id: string
      relative_path: string
      source_path: string
      kind: "archive" | "image-directory"
      title: string
      page_count: bigint
      state: "accepted" | "replacement-pending"
      decision_version: bigint
      content_version: bigint
      location_revision: bigint
      accepted_observation_json: string
    } | undefined
    if (entry === undefined || entry.relative_path !== candidate.relative_path) {
      db.exec("ROLLBACK")
      return { kind: "entry_not_found" }
    }
    if (entry.state !== "replacement-pending") {
      db.exec("ROLLBACK")
      return { kind: "entry_not_pending" }
    }
    if (
      entry.decision_version.toString() !== request.expectedDecisionVersion ||
      entry.location_revision.toString() !== request.expectedLocationRevision
    ) {
      db.exec("ROLLBACK")
      return {
        kind: "entry_revision_conflict",
        currentDecisionVersion: entry.decision_version.toString(),
        currentLocationRevision: entry.location_revision.toString()
      }
    }
    if (candidate.analysis_status !== "ready" || candidate.manifest_json === null) {
      db.exec("ROLLBACK")
      return { kind: "candidate_not_ready" }
    }
    if (request.freshManifestJson === null || !manifestsEquivalent(candidate.manifest_json, request.freshManifestJson)) {
      db.exec("ROLLBACK")
      return { kind: "fresh_observation_conflict" }
    }
    const manifest = JSON.parse(candidate.manifest_json) as { pages?: ReadonlyArray<unknown> }
    const pageCount = Array.isArray(manifest.pages) ? manifest.pages.length : 0
    if (pageCount === 0) {
      db.exec("ROLLBACK")
      return { kind: "candidate_not_ready" }
    }

    compactReviewOperations.run(request.epoch, now - RESULT_RETENTION_MS, COMPACTION_BATCH)
    if (Number(countReviewOperations.get()?.count) >= MAX_POLICY_OPERATION_RESULTS) {
      db.exec("COMMIT")
      return { kind: "storage_full" }
    }

    const updated = acceptReplacement.run(
      candidate.kind,
      titleForCandidate(candidate.relative_path, candidate.kind),
      BigInt(pageCount),
      candidate.manifest_json,
      JSON.stringify(replacementObservation(persistedManifest(candidate.manifest_json, "candidate manifest"), candidate.kind)),
      now,
      entry.entry_id
    )
    if (Number(updated.changes) !== 1) throw new Error("replacement entry is no longer pending")
    const candidateView = stagedDiscoveryRow(candidate)
    deleteStaged.run(candidate.candidate_id)
    bumpLibraryRevision.run()
    const resolved = selectEntryForResolution.get(entry.entry_id, request.rootId) as Parameters<typeof entryRow>[0]
    if (resolved === undefined) throw new Error("resolved entry is missing")
    const result = {
      decision: request.decision,
      candidate: candidateView,
      entry: entryRow(resolved),
      detachedEntryId: null
    }
    insertReviewOperation.run(
      request.epoch,
      request.operationId,
      request.candidateId,
      payload,
      JSON.stringify(result),
      now
    )
    db.exec("COMMIT")
    return { kind: "committed", ...result }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

const entryRow = (row: {
  entry_id: string
  library_id: string
  root_id: string
  relative_path: string
  source_path: string
  kind: "archive" | "image-directory"
  title: string
  page_count: bigint
  state: "accepted" | "replacement-pending"
  decision_version: bigint
  content_version: bigint
  location_revision: bigint
  accepted_observation_json: string | null
  candidate_id: string | null
  candidate_version: bigint | null
  candidate_kind: "archive" | "image-directory" | null
  candidate_analysis_status: "ready" | "error" | null
  candidate_observation_json: string | null
}): import("./worker-protocol").LibraryEntryRow => ({
  entry_id: row.entry_id,
  library_id: row.library_id,
  root_id: row.root_id,
  relative_path: row.relative_path,
  source_path: row.source_path,
  kind: row.kind,
  title: row.title,
  page_count: Number(row.page_count),
  state: row.state,
  content_version: row.content_version.toString(),
  location_revision: row.location_revision.toString(),
  replacement: row.candidate_id === null || row.candidate_version === null || row.candidate_kind === null || row.candidate_analysis_status === null || row.accepted_observation_json === null || row.candidate_observation_json === null
    ? null
    : {
        candidate_id: row.candidate_id,
        candidate_version: Number(row.candidate_version),
        old_observation: persistedReplacementObservation(row.accepted_observation_json, "accepted observation summary"),
        candidate_observation: persistedReplacementCandidateObservation(row.candidate_observation_json, "candidate observation summary")
      },
  cover: {
    key: `default-v1.${row.entry_id}.${row.content_version.toString()}`,
    profile: "default-cover-v1"
  }
})

const acceptedThumbnailEntryRow = (row: {
  entry_id: string
  root_id: string
  relative_path: string
  kind: "archive" | "image-directory"
  state: "accepted" | "replacement-pending"
  content_version: bigint
  manifest_json: string
}): import("./worker-protocol").AcceptedThumbnailEntryRow => ({
  entry_id: row.entry_id,
  root_id: row.root_id,
  relative_path: row.relative_path,
  kind: row.kind,
  state: row.state,
  content_version: row.content_version.toString(),
  manifest_json: row.manifest_json
})

const titleForCandidate = (relativePath: string, kind: "archive" | "image-directory"): string => {
  const name = basename(relativePath)
  if (kind === "archive") return name.replace(/\.(?:cbz|zip)$/iu, "")
  return name
}

const publishNormalScan = (request: Extract<WorkerRequest, { op: "publishNormalScan" }>): import("./worker-protocol").NormalPublishOutcome => {
  const observed = new Set(request.observedCandidatePaths)
  db.exec("BEGIN IMMEDIATE")
  try {
    const root = rootById(request.rootId)
    if (root === undefined) {
      db.exec("ROLLBACK")
      return { kind: "root_not_found" }
    }
    if (root.mappingRevision !== request.mappingRevision) {
      db.exec("ROLLBACK")
      return { kind: "mapping_revision_conflict" }
    }
    if (root.policyRevision !== request.expectedPolicyRevision) {
      db.exec("ROLLBACK")
      return { kind: "policy_revision_conflict" }
    }

    const isExcluded = (relativePath: string): boolean => root.exclusions.some(
      (exclusion) => exclusion.scope === "exact"
        ? exclusion.path === relativePath
        : relativePath === exclusion.path || relativePath.startsWith(`${exclusion.path}/`)
    )
    const existingPaths = (selectEntriesForRoot.all(request.rootId) as unknown as ReadonlyArray<{ relative_path: string }>)
      .map((row) => row.relative_path)
    const missingPaths = existingPaths.filter((relativePath) => !observed.has(relativePath) && !isExcluded(relativePath))
    const excludedPaths = existingPaths.filter((relativePath) => !observed.has(relativePath) && isExcluded(relativePath))
    const staged = db.prepare(
      "SELECT candidate_id, relative_path, kind, manifest_json FROM staged_discoveries WHERE task_id = ? AND root_id = ? AND hold_state = 'eligible' AND analysis_status = 'ready' ORDER BY relative_path ASC"
    ).all(request.taskId, request.rootId) as unknown as ReadonlyArray<{
      candidate_id: string
      relative_path: string
      kind: "archive" | "image-directory"
      manifest_json: string | null
    }>
    const sourcePathFor = (relativePath: string): string => join(root.selectedPath, ...relativePath.split("/"))
    const changedPaths: Array<string> = []
    const existingForCandidate = new Map<string, {
      entry_id: string
      manifest_json: string
      kind: "archive" | "image-directory"
      title: string
      source_path: string
      state: "accepted" | "replacement-pending"
    }>()
    for (const candidate of staged) {
      if (!observed.has(candidate.relative_path) || candidate.manifest_json === null) continue
      const manifest = JSON.parse(candidate.manifest_json) as { pages?: ReadonlyArray<unknown> }
      const pageCount = Array.isArray(manifest.pages) ? manifest.pages.length : 0
      if (pageCount === 0) continue
      const sourcePath = sourcePathFor(candidate.relative_path)
      const title = titleForCandidate(candidate.relative_path, candidate.kind)
      const existing = selectEntry.get(request.rootId, candidate.relative_path) as {
        entry_id: string
        manifest_json: string
        kind: "archive" | "image-directory"
        title: string
        source_path: string
        state: "accepted" | "replacement-pending"
      } | undefined
      if (existing !== undefined) {
        existingForCandidate.set(candidate.relative_path, existing)
        if (
          !manifestsEquivalent(existing.manifest_json, candidate.manifest_json) ||
          existing.kind !== candidate.kind ||
          existing.title !== title ||
          existing.source_path !== sourcePath
        ) {
          changedPaths.push(candidate.relative_path)
        }
      }
    }
    let changed = false
    for (const candidate of staged) {
      if (!observed.has(candidate.relative_path) || candidate.manifest_json === null) continue
      const manifest = JSON.parse(candidate.manifest_json) as { pages?: ReadonlyArray<unknown> }
      const pageCount = Array.isArray(manifest.pages) ? manifest.pages.length : 0
      if (pageCount === 0) continue
      const existing = existingForCandidate.get(candidate.relative_path)
      if (existing !== undefined) {
        const title = titleForCandidate(candidate.relative_path, candidate.kind)
        if (
          manifestsEquivalent(existing.manifest_json, candidate.manifest_json) &&
          existing.kind === candidate.kind &&
          existing.title === title &&
          existing.source_path === sourcePathFor(candidate.relative_path)
        ) {
          if (existing.manifest_json !== candidate.manifest_json) {
            db.prepare("UPDATE library_entries SET manifest_json = ?, updated_at_ms = ? WHERE entry_id = ?").run(
              candidate.manifest_json,
              Date.now(),
              existing.entry_id
            )
            db.prepare("UPDATE library_entries SET accepted_observation_json = ? WHERE entry_id = ?").run(
              JSON.stringify(replacementObservation(persistedManifest(candidate.manifest_json, "candidate manifest"), candidate.kind)),
              existing.entry_id
            )
            changed = true
          }
          if (existing.state === "accepted") deleteStaged.run(candidate.candidate_id)
        }
        continue
      }
      if (missingPaths.length > 0 || changedPaths.length > 0) continue
      const title = titleForCandidate(candidate.relative_path, candidate.kind)
      insertEntry.run(
        randomUUID(),
        root.libraryId,
        request.rootId,
        candidate.relative_path,
        sourcePathFor(candidate.relative_path),
        candidate.kind,
        title,
        BigInt(pageCount),
        candidate.manifest_json,
        Date.now(),
        Date.now(),
        JSON.stringify(replacementObservation(persistedManifest(candidate.manifest_json, "candidate manifest"), candidate.kind))
      )
      deleteStaged.run(candidate.candidate_id)
      changed = true
    }
    if (changed) bumpLibraryRevision.run()
    if (missingPaths.length > 0 || changedPaths.length > 0) {
      const stagedPaths = (selectStagedPathsForRoot.all(request.rootId) as unknown as ReadonlyArray<{ relative_path: string }>)
        .map((row) => row.relative_path)
      const reviewPaths = new Set([...stagedPaths, ...missingPaths, ...changedPaths])
      db.exec("COMMIT")
      return {
        kind: "allocation_deferred",
        missingPaths: missingPaths.slice(0, MAX_REPORTED_DEFERRED_PATHS),
        changedPaths: changedPaths.slice(0, MAX_REPORTED_DEFERRED_PATHS),
        excludedPaths: excludedPaths.slice(0, MAX_REPORTED_DEFERRED_PATHS),
        missingPathCount: missingPaths.length,
        changedPathCount: changedPaths.length,
        excludedPathCount: excludedPaths.length,
        reviewNeededCount: reviewPaths.size
      }
    }
    db.exec("COMMIT")
    return { kind: "published" }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

const librarySummary = (): import("./worker-protocol").LibrarySummaryRow => {
  const row = selectLibraryState.get() as { library_id: string; change_revision: bigint } | undefined
  if (row === undefined) throw new Error("server library is not initialized")
  return { library_id: row.library_id, change_revision: row.change_revision.toString() }
}

const libraryEntries = (request: Extract<WorkerRequest, { op: "listLibraryEntries" }>): import("./worker-protocol").LibraryEntryPageRow => {
  const rows = selectLibraryEntries(request.cursor, request.pageSize + 1) as unknown as ReadonlyArray<{
    entry_id: string
    library_id: string
    root_id: string
    relative_path: string
    source_path: string
    kind: "archive" | "image-directory"
    title: string
    page_count: bigint
    state: "accepted" | "replacement-pending"
    decision_version: bigint
    content_version: bigint
    location_revision: bigint
    accepted_observation_json: string | null
    candidate_id: string | null
    candidate_version: bigint | null
    candidate_kind: "archive" | "image-directory" | null
    candidate_analysis_status: "ready" | "error" | null
    candidate_observation_json: string | null
  }>
  const page = rows.slice(0, request.pageSize)
  const hasMore = rows.length > request.pageSize
  return {
    entries: page.map(entryRow),
    has_more: hasMore,
    next_cursor: hasMore ? page[page.length - 1]?.entry_id ?? null : null,
    library_change_revision: librarySummary().change_revision
  }
}

const indexedRootSamples = (
  request: Extract<WorkerRequest, { op: "listIndexedRootSamples" }>
): import("./worker-protocol").IndexedRootSamplePageRow => {
  const rows = selectIndexedRootSamples.all(request.rootId, request.sampleLimit) as unknown as ReadonlyArray<{
    relative_path: string
    kind: "archive" | "image-directory"
    manifest_json: string
  }>
  const page = rows.slice(0, INDEXED_ROOT_SAMPLE_LIMIT)
  return {
    samples: page.map((row) => {
      const parsed = JSON.parse(row.manifest_json) as unknown
      const manifest = Schema.decodeUnknownOption(ScanManifest)(parsed)
      if (Option.isNone(manifest)) throw new Error("invalid accepted manifest")
      const formats = Array.from(new Set(manifest.value.pages.map((entry) => entry.format))).slice(0, 8)
      return {
        relative_path: row.relative_path,
        kind: row.kind,
        format_evidence: formats,
        size_bytes: row.kind === "archive"
          ? manifest.value.after.bytes
          : manifest.value.pages.reduce((total, page) => total + page.declared_bytes, 0)
      }
    }),
    sample_truncated: rows.length > INDEXED_ROOT_SAMPLE_LIMIT,
    library_change_revision: librarySummary().change_revision
  }
}

const entryResolution = (
  request: Extract<WorkerRequest, { op: "readEntryResolution" }>
): import("./worker-protocol").LibraryEntryResolutionResult => {
  const row = selectEntryResolution.get(request.entryId) as {
    entry_id: string
    root_id: string
    relative_path: string
    kind: "archive" | "image-directory"
    state: "accepted" | "replacement-pending"
    decision_version: bigint
    location_revision: bigint
    content_version: bigint
    manifest_json: string
  } | undefined
  if (row === undefined) return null

  const manifest = Schema.decodeUnknownOption(ScanManifest)(JSON.parse(row.manifest_json))
  if (manifest._tag === "None") throw new Error("invalid persisted accepted manifest")

  const libraryState = selectLibraryState.get() as { library_id: string; change_revision: bigint } | undefined
  if (libraryState === undefined) throw new Error("server library is not initialized")
  const siblingClaimsRevision = libraryState.change_revision.toString()

  const targetParentKey = resolutionParentKey(row.relative_path)

  let cursor: { entry_id: string; root_id: string; relative_path: string } | undefined
  if (request.siblingCursor !== undefined) {
    const decodedCursor = decodeResolutionCursor(request.siblingCursor)
    if (
      decodedCursor === undefined ||
      decodedCursor.target_entry_id !== row.entry_id ||
      decodedCursor.root_id !== row.root_id ||
      decodedCursor.sibling_claims_revision !== siblingClaimsRevision ||
      request.siblingClaimsRevision !== siblingClaimsRevision
    ) return { kind: "invalid_cursor" }
    const cursorRow = selectResolutionSiblingCursor.get(decodedCursor.entry_id) as typeof cursor | undefined
    if (
      cursorRow === undefined ||
      cursorRow.root_id !== row.root_id ||
      cursorRow.entry_id === row.entry_id ||
      cursorRow.relative_path !== decodedCursor.relative_path ||
      resolutionParentKey(cursorRow.relative_path) !== targetParentKey
    ) return { kind: "invalid_cursor" }
    cursor = cursorRow
  }

  const pageRows = (cursor === undefined
    ? selectResolutionSiblingClaims.all(row.root_id, row.entry_id, targetParentKey, MAX_RESOLUTION_SIBLINGS + 1)
    : selectResolutionSiblingClaimsAfter.all(
      row.root_id,
      row.entry_id,
      targetParentKey,
      cursor.relative_path,
      cursor.relative_path,
      cursor.entry_id,
      MAX_RESOLUTION_SIBLINGS + 1
    )) as unknown as ReadonlyArray<{
    entry_id: string
    relative_path: string
  }>
  const siblingClaims = pageRows
    .slice(0, MAX_RESOLUTION_SIBLINGS)
    .map((sibling) => ({ entry_id: sibling.entry_id, relative_path: sibling.relative_path }))
  const siblingClaimsTruncated = pageRows.length > MAX_RESOLUTION_SIBLINGS
  const siblingClaimsNextCursor = siblingClaimsTruncated
    ? (() => {
        const last = siblingClaims[siblingClaims.length - 1]
        return last === undefined
          ? null
          : encodeResolutionCursor({
              version: 1,
              target_entry_id: row.entry_id,
              root_id: row.root_id,
              sibling_claims_revision: siblingClaimsRevision,
              relative_path: last.relative_path,
              entry_id: last.entry_id
            })
      })()
    : null

  const staged = selectStagedForResolution.get(row.root_id, row.relative_path) as {
    kind: "archive" | "image-directory"
    analysis_status: "ready" | "error"
    manifest_json: string | null
    analysis_error_json: string | null
  } | undefined
  let reason: "known-change" | "insufficient-evidence" | null = null
  if (row.state === "replacement-pending") {
    reason = "known-change"
  } else if (staged !== undefined) {
    reason = resolutionReplacementReason(
      row.kind,
      staged.kind,
      staged.analysis_status,
      row.manifest_json,
      staged.manifest_json,
      staged.analysis_error_json
    )
  }
  if (manifest.value.pages[0] === undefined) {
    reason = reason ?? "insufficient-evidence"
  }

  return {
    entry_id: row.entry_id,
    root_id: row.root_id,
    relative_path: row.relative_path,
    kind: row.kind,
    decision_version: row.decision_version.toString(),
    location_revision: row.location_revision.toString(),
    content_version: row.content_version.toString(),
    status: reason === null ? "usable" : "unresolved",
    reason,
    accepted_observation: manifest.value.after,
    first_page: manifest.value.pages[0] ?? null,
    sibling_claims: siblingClaims,
    sibling_claims_truncated: siblingClaimsTruncated,
    sibling_claims_next_cursor: siblingClaimsNextCursor,
    sibling_claims_revision: siblingClaimsRevision
  }
}

const openEventPayload = (event: Extract<WorkerRequest, { op: "acceptOpenEvents" }>['events'][number]): string =>
  canonicalOpenEventPayload({
    eventId: event.event_id,
    instanceId: event.instance_id,
    entryId: event.entry_id,
    deviceId: event.device_id,
    observedLocationRevision: event.observed_location_revision,
    observedContentVersion: event.observed_content_version,
    occurredAtMs: event.occurred_at_ms
  })

const storedOpenEventPayload = (row: {
  event_id: string
  instance_id: string
  entry_id: string
  device_id: string
  observed_location_revision: bigint
  observed_content_version: bigint
  occurred_at_ms: bigint
}): string => canonicalOpenEventPayload({
  eventId: row.event_id,
  instanceId: row.instance_id,
  entryId: row.entry_id,
  deviceId: row.device_id,
  observedLocationRevision: row.observed_location_revision.toString(),
  observedContentVersion: row.observed_content_version.toString(),
  occurredAtMs: Number(row.occurred_at_ms)
})

const acceptOpenEvents = (
  request: Extract<WorkerRequest, { op: "acceptOpenEvents" }>
): import("./worker-protocol").OpenEventBatchOutcome => {
  db.exec("BEGIN IMMEDIATE")
  try {
    const results: Array<import("@henshin/contracts/event").OpenEventOutcome> = []
    for (const event of request.events) {
      const existing = selectOpenEvent.get(event.event_id) as {
        event_id: string
        instance_id: string
        entry_id: string
        device_id: string
        observed_location_revision: bigint
        observed_content_version: bigint
        occurred_at_ms: bigint
        receipt_at_ms: bigint
      } | undefined
      if (existing !== undefined) {
        results.push(
          storedOpenEventPayload(existing) === openEventPayload(event)
            ? {
                event_id: event.event_id,
                outcome: "already_accepted",
                receipt_at_ms: Number(existing.receipt_at_ms)
              }
            : { event_id: event.event_id, outcome: "conflict" }
        )
        continue
      }

      if (selectEntryById.get(event.entry_id) === undefined) {
        results.push({ event_id: event.event_id, outcome: "missing_entry" })
        continue
      }

      const receiptAtMs = Date.now()
      insertOpenEvent.run(
        event.event_id,
        event.instance_id,
        event.entry_id,
        event.device_id,
        BigInt(event.observed_location_revision),
        BigInt(event.observed_content_version),
        BigInt(event.occurred_at_ms),
        receiptAtMs
      )
      insertEntryStatistics.run(event.entry_id)
      updateEntryStatistics.run(event.occurred_at_ms, event.occurred_at_ms, event.entry_id)
      bumpLibraryRevision.run()
      results.push({ event_id: event.event_id, outcome: "accepted", receipt_at_ms: receiptAtMs })
    }
    db.exec("COMMIT")
    return { results }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

const finishScan = (request: Extract<WorkerRequest, { op: "finishScan" }>): void => {
  db.exec("BEGIN IMMEDIATE")
  try {
    if (request.status === "succeeded" || request.status === "completed_with_errors") {
      const task = db.prepare("SELECT root_id FROM scan_tasks WHERE task_id = ?").get(request.taskId) as
        | { root_id: string }
        | undefined
      if (task === undefined) throw new Error("scan task is missing")
      requireCurrentScanFence(request.taskId, task.root_id)
    }
    requireScanTransition(updateScanTask.run(
      request.status,
      BigInt(request.directoriesVisited),
      BigInt(request.candidatesDiscovered),
      BigInt(request.candidatesAnalyzed),
      BigInt(request.analysisErrorCount),
      BigInt(request.reviewNeededCount),
      request.coverageJson,
      request.readinessErrorCode,
      request.readinessErrorMessage,
      request.errorCode,
      request.errorMessage,
      Date.now(),
      request.taskId
    ))
    db.exec("COMMIT")
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
      db.exec(`
        INSERT OR IGNORE INTO entry_statistics(entry_id, open_count, last_opened_at_ms)
        SELECT entry_id, 0, NULL FROM library_entries
      `)
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
    case "startManualScan":
      return startManualScan(request)
    case "listScanTasks":
      return scanTaskRows()
    case "readScanTask":
      return scanTaskById(request.taskId) ?? null
    case "listStagedDiscoveries":
      return (selectStagedDiscoveries.all() as unknown as ReadonlyArray<Parameters<typeof stagedDiscoveryRow>[0]>).map(stagedDiscoveryRow)
    case "publishNormalScan":
      return publishNormalScan(request)
    case "releaseHeldDiscovery":
      return releaseHeldDiscovery(request)
    case "lookupEntryResolution":
      return lookupEntryResolution(request)
    case "resolveReplacement":
      return resolveReplacement(request)
    case "readLibrary":
      return librarySummary()
    case "listLibraryEntries":
      return libraryEntries(request)
    case "listIndexedRootSamples":
      return indexedRootSamples(request)
    case "readEntryResolution":
      return entryResolution(request)
    case "acceptOpenEvents":
      return acceptOpenEvents(request)
    case "recordDiscovery":
      requireScanTransition(db.prepare(`UPDATE scan_tasks SET directories_visited = ?, candidates_discovered = ?, coverage_json = ?,
        updated_at_ms = ? WHERE task_id = ? AND status = 'running'`).run(
        request.directories, request.candidates, request.coverageJson, Date.now(), request.taskId
      ))
      return null
    case "readAcceptedThumbnailEntry": {
      const row = selectAcceptedThumbnailEntry.get(request.entryId) as Parameters<typeof acceptedThumbnailEntryRow>[0] | undefined
      return row === undefined ? null : acceptedThumbnailEntryRow(row)
    }
    case "markScanRunning":
      requireScanTransition(updateScanRunning.run(Date.now(), request.taskId))
      return null
    case "stageDiscovery":
      stageDiscovery(request)
      return null
    case "finishScan":
      finishScan(request)
      return null
    case "recoverScans":
      recoverScanTasks.run(Date.now())
      return null
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
