import { DatabaseSync } from "node:sqlite"
import { realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import { parentPort, workerData } from "node:worker_threads"
import { Option, Schema } from "effect"
import {
  CommandAttemptAdmission,
  CommandAttemptMutation,
  CommandAttemptRows,
  DraftWorkerMessage,
  DraftWorkerResponse,
  type ReaderProfileRow,
  type CommandAttemptRow,
  type LocalMappingRow,
  type DraftRow,
  type DraftWorkerRequest
} from "./draft-worker-protocol"

const MAX_DRAFT_ROWS = 64
const MAX_COMMAND_ATTEMPTS = 64
const MAX_READER_PROFILES = 64
const COMMAND_ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const COMMAND_ATTEMPT_COMPACTION_BATCH = 64
const dbPath = (workerData as { readonly dbPath: string }).dbPath
const db = new DatabaseSync(dbPath)

const rollbackIfActive = (): void => {
  if (!db.isTransaction) return
  try {
    db.exec("ROLLBACK")
  } catch {
    // Preserve the operation's original failure if rollback itself fails.
  }
}

db.exec("PRAGMA journal_mode = WAL")
db.exec("PRAGMA synchronous = FULL")
db.exec("PRAGMA foreign_keys = ON")
db.exec(`
  CREATE TABLE IF NOT EXISTS unsent_drafts (
    instance_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    form_id TEXT NOT NULL,
    text TEXT NOT NULL,
    local_revision INTEGER NOT NULL,
    base_server_revision INTEGER NOT NULL,
    base_epoch TEXT NOT NULL,
    present INTEGER NOT NULL CHECK (present IN (0, 1)),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (instance_id, note_id, form_id)
  );
  CREATE TABLE IF NOT EXISTS command_attempts (
    instance_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    intent_text TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    epoch TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'unresolved', 'succeeded', 'rejected')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    result_note TEXT,
    expires_at_ms INTEGER,
    error_code TEXT,
    error_message TEXT,
    current_revision INTEGER,
    dismissed INTEGER NOT NULL CHECK (dismissed IN (0, 1)),
    PRIMARY KEY (instance_id, operation_id)
  );
  CREATE TABLE IF NOT EXISTS client_mappings (
    instance_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    selected_path TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    mapping_revision INTEGER NOT NULL,
    selected_identity TEXT,
    canonical_identity TEXT,
    selected_resolution TEXT,
    canonical_resolution TEXT,
    state TEXT NOT NULL CHECK (state = 'active'),
    PRIMARY KEY (instance_id, root_id)
  );
  CREATE TABLE IF NOT EXISTS reader_profiles (
    profile_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    name TEXT NOT NULL,
    launch_mode TEXT NOT NULL CHECK (launch_mode IN ('explicit-executable', 'system-association')),
    supported_formats TEXT NOT NULL,
    target_mode TEXT NOT NULL CHECK (target_mode IN ('archive', 'directory', 'first-image')),
    executable_path TEXT,
    argument_tokens TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
`)

const clientMappingColumns = new Set(
  (db.prepare("PRAGMA table_info(client_mappings)").all() as unknown as ReadonlyArray<{ name: string }>).map(
    (column) => column.name
  )
)
if (!clientMappingColumns.has("selected_identity")) {
  db.exec("ALTER TABLE client_mappings ADD COLUMN selected_identity TEXT")
}
if (!clientMappingColumns.has("canonical_identity")) {
  db.exec("ALTER TABLE client_mappings ADD COLUMN canonical_identity TEXT")
}
if (!clientMappingColumns.has("selected_resolution")) {
  db.exec("ALTER TABLE client_mappings ADD COLUMN selected_resolution TEXT")
}
if (!clientMappingColumns.has("canonical_resolution")) {
  db.exec("ALTER TABLE client_mappings ADD COLUMN canonical_resolution TEXT")
}

const selectDraft = db.prepare(`
  SELECT instance_id, note_id, form_id, text, local_revision,
         base_server_revision, base_epoch, present
  FROM unsent_drafts
  WHERE instance_id = ? AND note_id = ? AND form_id = ?
`)
selectDraft.setReadBigInts(true)

const selectCount = db.prepare("SELECT COUNT(*) AS count FROM unsent_drafts")
selectCount.setReadBigInts(true)
const upsertDraft = db.prepare(`
  INSERT INTO unsent_drafts(
    instance_id, note_id, form_id, text, local_revision,
    base_server_revision, base_epoch, present, updated_at_ms
  ) VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(instance_id, note_id, form_id) DO UPDATE SET
    text = excluded.text,
    local_revision = excluded.local_revision,
    base_server_revision = excluded.base_server_revision,
    base_epoch = excluded.base_epoch,
    present = 1,
    updated_at_ms = excluded.updated_at_ms
`)
const tombstoneDraft = db.prepare(`
  UPDATE unsent_drafts
  SET text = '', local_revision = ?, present = 0, updated_at_ms = ?
  WHERE instance_id = ? AND note_id = ? AND form_id = ?
`)

const selectReaderProfile = db.prepare(`
  SELECT profile_id, revision, name, launch_mode, supported_formats, target_mode,
         executable_path, argument_tokens
  FROM reader_profiles
  WHERE profile_id = ?
`)
selectReaderProfile.setReadBigInts(true)
const listReaderProfiles = db.prepare(`
  SELECT profile_id, revision, name, launch_mode, supported_formats, target_mode,
         executable_path, argument_tokens
  FROM reader_profiles
  ORDER BY name COLLATE NOCASE ASC, profile_id ASC
`)
listReaderProfiles.setReadBigInts(true)
const selectReaderProfileCount = db.prepare("SELECT COUNT(*) AS count FROM reader_profiles")
selectReaderProfileCount.setReadBigInts(true)
const insertReaderProfile = db.prepare(`
  INSERT INTO reader_profiles(
    profile_id, revision, name, launch_mode, supported_formats, target_mode,
    executable_path, argument_tokens, updated_at_ms
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const updateReaderProfile = db.prepare(`
  UPDATE reader_profiles
  SET revision = ?, name = ?, launch_mode = ?, supported_formats = ?, target_mode = ?,
      executable_path = ?, argument_tokens = ?, updated_at_ms = ?
  WHERE profile_id = ? AND revision = ?
`)

const selectCommandAttempt = db.prepare(`
  SELECT instance_id, operation_id, note_id, intent_text, base_revision,
         epoch, status, created_at_ms, updated_at_ms, result_note,
         expires_at_ms, error_code, error_message, current_revision, dismissed
  FROM command_attempts
  WHERE instance_id = ? AND operation_id = ?
`)
selectCommandAttempt.setReadBigInts(true)
const selectCommandAttemptCount = db.prepare("SELECT COUNT(*) AS count FROM command_attempts")
selectCommandAttemptCount.setReadBigInts(true)
const compactCommandAttempts = db.prepare(`
  DELETE FROM command_attempts
  WHERE rowid IN (
    SELECT rowid
    FROM command_attempts
    WHERE (
      status IN ('succeeded', 'rejected')
      OR (status IN ('prepared', 'submitted', 'unresolved') AND dismissed = 1)
    )
      AND updated_at_ms + ? <= ?
    ORDER BY updated_at_ms ASC, rowid ASC
    LIMIT ?
  )
`)
const insertCommandAttempt = db.prepare(`
  INSERT INTO command_attempts(
    instance_id, operation_id, note_id, intent_text, base_revision, epoch,
    status, created_at_ms, updated_at_ms, result_note, expires_at_ms,
    error_code, error_message, current_revision, dismissed
  ) VALUES(?, ?, ?, ?, ?, ?, 'prepared', ?, ?, NULL, NULL, NULL, NULL, NULL, 0)
`)
const updateCommandStatus = db.prepare(
  "UPDATE command_attempts SET status = ?, updated_at_ms = ? WHERE instance_id = ? AND operation_id = ? AND status IN ('prepared', 'submitted', 'unresolved')"
)
const updateCommandSuccess = db.prepare(`
  UPDATE command_attempts
  SET status = 'succeeded', updated_at_ms = ?, result_note = ?, expires_at_ms = ?,
      error_code = NULL, error_message = NULL, current_revision = NULL
  WHERE instance_id = ? AND operation_id = ?
    AND status IN ('prepared', 'submitted', 'unresolved')
`)
const updateCommandRejection = db.prepare(`
  UPDATE command_attempts
  SET status = 'rejected', updated_at_ms = ?, error_code = ?, error_message = ?,
      current_revision = ?, result_note = NULL, expires_at_ms = NULL
  WHERE instance_id = ? AND operation_id = ?
    AND status IN ('prepared', 'submitted', 'unresolved')
`)
const dismissCommandAttempt = db.prepare(
  "UPDATE command_attempts SET dismissed = 1, updated_at_ms = ? WHERE instance_id = ? AND operation_id = ?"
)
const listCommandAttempts = db.prepare(`
  SELECT instance_id, operation_id, note_id, intent_text, base_revision,
         epoch, status, created_at_ms, updated_at_ms, result_note,
         expires_at_ms, error_code, error_message, current_revision, dismissed
  FROM command_attempts
  WHERE instance_id = ? AND dismissed = 0
  ORDER BY updated_at_ms DESC, operation_id ASC
`)
listCommandAttempts.setReadBigInts(true)

const selectLocalMapping = db.prepare(`
  SELECT instance_id, root_id, selected_path, canonical_path, mapping_revision,
         selected_identity, canonical_identity, selected_resolution, canonical_resolution
  FROM client_mappings
  WHERE instance_id = ? AND root_id = ? AND state = 'active'
`)
selectLocalMapping.setReadBigInts(true)
const listLocalMappings = db.prepare(`
  SELECT instance_id, root_id, selected_path, canonical_path, mapping_revision,
         selected_identity, canonical_identity, selected_resolution, canonical_resolution
  FROM client_mappings
  WHERE instance_id = ? AND state = 'active'
  ORDER BY rowid ASC
`)
listLocalMappings.setReadBigInts(true)
const upsertLocalMapping = db.prepare(`
  INSERT INTO client_mappings(
    instance_id, root_id, selected_path, canonical_path, mapping_revision,
    selected_identity, canonical_identity, selected_resolution, canonical_resolution, state
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  ON CONFLICT(instance_id, root_id) DO UPDATE SET
    selected_path = excluded.selected_path,
    canonical_path = excluded.canonical_path,
    mapping_revision = excluded.mapping_revision,
    selected_identity = excluded.selected_identity,
    canonical_identity = excluded.canonical_identity,
    selected_resolution = excluded.selected_resolution,
    canonical_resolution = excluded.canonical_resolution,
    state = 'active'
`)

const readDraft = (instanceId: string, noteId: string, formId: string): DraftRow | undefined => {
  const row = selectDraft.get(instanceId, noteId, formId) as
    | {
        instance_id: string
        note_id: string
        form_id: string
        text: string
        local_revision: bigint
        base_server_revision: bigint
        base_epoch: string
        present: bigint
      }
    | undefined
  if (row === undefined) return undefined
  return {
    instanceId: row.instance_id,
    noteId: row.note_id,
    formId: row.form_id,
    text: row.text,
    localRevision: row.local_revision.toString(),
    baseServerRevision: row.base_server_revision.toString(),
    baseEpoch: row.base_epoch,
    present: row.present === 1n
  }
}

const toReaderProfileRow = (row: {
  profile_id: string
  revision: bigint
  name: string
  launch_mode: ReaderProfileRow["launchMode"]
  supported_formats: string
  target_mode: ReaderProfileRow["targetMode"]
  executable_path: string | null
  argument_tokens: string
}): ReaderProfileRow => ({
  profileId: row.profile_id,
  revision: row.revision.toString(),
  name: row.name,
  launchMode: row.launch_mode,
  supportedFormats: JSON.parse(row.supported_formats),
  targetMode: row.target_mode,
  executablePath: row.executable_path,
  argumentTokens: JSON.parse(row.argument_tokens)
})

const readReaderProfile = (profileId: string): ReaderProfileRow | undefined => {
  const row = selectReaderProfile.get(profileId) as {
    profile_id: string
    revision: bigint
    name: string
    launch_mode: ReaderProfileRow["launchMode"]
    supported_formats: string
    target_mode: ReaderProfileRow["targetMode"]
    executable_path: string | null
    argument_tokens: string
  } | undefined
  return row === undefined ? undefined : toReaderProfileRow(row)
}

const readReaderProfiles = (): ReadonlyArray<ReaderProfileRow> =>
  (listReaderProfiles.all() as unknown as ReadonlyArray<{
    profile_id: string
    revision: bigint
    name: string
    launch_mode: ReaderProfileRow["launchMode"]
    supported_formats: string
    target_mode: ReaderProfileRow["targetMode"]
    executable_path: string | null
    argument_tokens: string
  }>).map(toReaderProfileRow)

const readCommandAttempt = (instanceId: string, operationId: string): CommandAttemptRow | undefined => {
  const row = selectCommandAttempt.get(instanceId, operationId) as
    | {
        instance_id: string
        operation_id: string
        note_id: string
        intent_text: string
        base_revision: bigint
        epoch: string
        status: CommandAttemptRow["status"]
        created_at_ms: bigint
        updated_at_ms: bigint
        result_note: string | null
        expires_at_ms: bigint | null
        error_code: string | null
        error_message: string | null
        current_revision: bigint | null
        dismissed: bigint
      }
    | undefined
  if (row === undefined) return undefined
  return {
    instanceId: row.instance_id,
    operationId: row.operation_id,
    noteId: row.note_id,
    intentText: row.intent_text,
    baseRevision: row.base_revision.toString(),
    epoch: row.epoch,
    status: row.status,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    resultNote: row.result_note === null ? null : JSON.parse(row.result_note),
    expiresAtMs: row.expires_at_ms === null ? null : Number(row.expires_at_ms),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    currentRevision: row.current_revision === null ? null : row.current_revision.toString(),
    dismissed: row.dismissed === 1n
  }
}

const readCommandAttempts = (instanceId: string): ReadonlyArray<CommandAttemptRow> => {
  const rows = listCommandAttempts.all(instanceId) as unknown as ReadonlyArray<{
    instance_id: string
    operation_id: string
    note_id: string
    intent_text: string
    base_revision: bigint
    epoch: string
    status: CommandAttemptRow["status"]
    created_at_ms: bigint
    updated_at_ms: bigint
    result_note: string | null
    expires_at_ms: bigint | null
    error_code: string | null
    error_message: string | null
    current_revision: bigint | null
    dismissed: bigint
  }>
  return rows.map((row) => {
    const attempt = readCommandAttempt(row.instance_id, row.operation_id)
    if (attempt === undefined) throw new Error("command attempt disappeared during list")
    return attempt
  })
}

type PersistedLocalMapping = {
  readonly instance_id: string
  readonly root_id: string
  readonly selected_path: string
  readonly canonical_path: string
  readonly mapping_revision: bigint
  readonly selected_identity: string | null
  readonly canonical_identity: string | null
  readonly selected_resolution: string | null
  readonly canonical_resolution: string | null
}

const readLocalMappingRow = (row: PersistedLocalMapping): LocalMappingRow => ({
  instanceId: row.instance_id,
  rootId: row.root_id,
  selectedPath: row.selected_path,
  canonicalPath: row.canonical_path,
  mappingRevision: row.mapping_revision.toString()
})

const readLocalMapping = (instanceId: string, rootId: string): LocalMappingRow | undefined => {
  const row = selectLocalMapping.get(instanceId, rootId) as PersistedLocalMapping | undefined
  return row === undefined ? undefined : readLocalMappingRow(row)
}

const readPersistedLocalMappings = (instanceId: string): ReadonlyArray<PersistedLocalMapping> =>
  listLocalMappings.all(instanceId) as unknown as ReadonlyArray<PersistedLocalMapping>

const readLocalMappings = (instanceId: string): ReadonlyArray<LocalMappingRow> =>
  readPersistedLocalMappings(instanceId).map(readLocalMappingRow)

type ResolvedLocalPath = {
  readonly comparisonPath: string
  readonly endpointIdentity: string | null
  readonly ancestorIdentities: ReadonlyArray<string>
  readonly resolutionError: string | null
  readonly exact: boolean
  readonly directory: boolean
}

const LocalPathResolution = Schema.Struct({
  comparisonPath: Schema.String,
  endpointIdentity: Schema.NullOr(Schema.String),
  ancestorIdentities: Schema.Array(Schema.String),
  resolutionError: Schema.optional(Schema.NullOr(Schema.String)),
  exact: Schema.Boolean,
  directory: Schema.Boolean
})

const localPhysicalIdentity = (stats: { readonly dev: number | bigint; readonly ino: number | bigint }): string | undefined =>
  stats.ino.toString() === "0" ? undefined : `${stats.dev.toString()}:${stats.ino.toString()}`

const identityOf = (path: string): string | undefined => {
  const stats = statSync(path, { bigint: true })
  return localPhysicalIdentity(stats)
}

const ancestorIdentitiesOf = (path: string): ReadonlyArray<string> => {
  const identities: Array<string> = []
  let current = path
  while (true) {
    const identity = identityOf(current)
    if (identity !== undefined) identities.push(identity)
    const parent = dirname(current)
    if (parent === current) return identities
    current = parent
  }
}

const pathErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined

const resolveLocalPath = (input: string): ResolvedLocalPath => {
  let current = input
  const missingSuffix: Array<string> = []

  while (true) {
    try {
      const realCurrent = realpathSync.native(current)
      const stats = statSync(current, { bigint: true })
      const ancestorIdentities = ancestorIdentitiesOf(realCurrent)
      return {
        comparisonPath: missingSuffix.length === 0 ? realCurrent : join(realCurrent, ...missingSuffix),
        endpointIdentity: missingSuffix.length === 0 ? identityOf(realCurrent) ?? null : null,
        ancestorIdentities,
        resolutionError: null,
        exact: missingSuffix.length === 0,
        directory: missingSuffix.length === 0 && stats.isDirectory()
      }
    } catch (error) {
      const code = pathErrorCode(error)
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return {
          comparisonPath: input,
          endpointIdentity: null,
          ancestorIdentities: [],
          resolutionError: code ?? "unknown",
          exact: false,
          directory: false
        }
      }
      const parent = dirname(current)
      if (parent === current) {
        return {
          comparisonPath: input,
          endpointIdentity: null,
          ancestorIdentities: [],
          resolutionError: null,
          exact: false,
          directory: false
        }
      }
      missingSuffix.unshift(basename(current))
      current = parent
    }
  }
}

const usableIdentity = (identity: string | null | undefined): string | null =>
  identity === null || identity === undefined || identity.endsWith(":0") ? null : identity

const persistedPath = (path: string, identity: string | null): ResolvedLocalPath => {
  const normalizedIdentity = usableIdentity(identity)
  return {
    comparisonPath: path,
    endpointIdentity: normalizedIdentity,
    ancestorIdentities: normalizedIdentity === null ? [] : [normalizedIdentity],
    resolutionError: null,
    exact: normalizedIdentity !== null,
    directory: normalizedIdentity !== null
  }
}

const normalizeResolution = (resolution: typeof LocalPathResolution.Type): ResolvedLocalPath => ({
  ...resolution,
  endpointIdentity: usableIdentity(resolution.endpointIdentity),
  ancestorIdentities: resolution.ancestorIdentities.filter((identity) => usableIdentity(identity) !== null),
  resolutionError: resolution.resolutionError ?? null
})

const persistedResolution = (
  path: string,
  identity: string | null,
  resolution: string | null
): ResolvedLocalPath => {
  if (resolution !== null) {
    try {
      const decoded = Schema.decodeUnknownOption(LocalPathResolution)(JSON.parse(resolution))
      if (Option.isSome(decoded)) return normalizeResolution(decoded.value)
    } catch {
      // Fall through to the legacy path and identity evidence.
    }
  }
  return persistedPath(path, identity)
}

const encodeResolution = (resolution: ResolvedLocalPath): string => JSON.stringify(resolution)

const identityOverlaps = (left: ResolvedLocalPath, right: ResolvedLocalPath): boolean => {
  if (left.endpointIdentity !== null && right.ancestorIdentities.includes(left.endpointIdentity)) return true
  if (right.endpointIdentity !== null && left.ancestorIdentities.includes(right.endpointIdentity)) return true
  return false
}

const isPathWithin = (parent: string, candidate: string): boolean => {
  if (process.platform === "win32") {
    return isPathWithinWindows(parent, candidate)
  }
  const remainder = relative(parent, candidate)
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
}

const isPathWithinWindows = (parent: string, candidate: string): boolean => {
  const normalize = (value: string): string => value.replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase()
  const normalizedParent = normalize(parent)
  const normalizedCandidate = normalize(candidate)
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}\\`)
}

const pathsOverlap = (left: string, right: string): boolean =>
  isPathWithin(left, right) || isPathWithin(right, left)

type MappingPathEvidence = {
  readonly selectedPath: ResolvedLocalPath
  readonly canonicalPath: ResolvedLocalPath
}

const pathsOverlapWithEvidence = (left: ResolvedLocalPath, right: ResolvedLocalPath): boolean =>
  pathsOverlap(left.comparisonPath, right.comparisonPath) || identityOverlaps(left, right)

const mappingPathsOverlap = (
  selectedPath: ResolvedLocalPath,
  canonicalPath: ResolvedLocalPath,
  mapping: MappingPathEvidence
): boolean =>
  pathsOverlapWithEvidence(selectedPath, mapping.selectedPath) ||
  pathsOverlapWithEvidence(selectedPath, mapping.canonicalPath) ||
  pathsOverlapWithEvidence(canonicalPath, mapping.selectedPath) ||
  pathsOverlapWithEvidence(canonicalPath, mapping.canonicalPath)

const storedMappingPathEvidence = (mapping: PersistedLocalMapping): MappingPathEvidence => ({
  selectedPath: persistedResolution(
    mapping.selected_path,
    mapping.selected_identity,
    mapping.selected_resolution
  ),
  canonicalPath: persistedResolution(
    mapping.canonical_path,
    mapping.canonical_identity,
    mapping.canonical_resolution
  )
})

const refreshedMappingPathEvidence = (mapping: PersistedLocalMapping): MappingPathEvidence => {
  const stored = storedMappingPathEvidence(mapping)
  const selectedPath = resolveLocalPath(mapping.selected_path)
  const canonicalPath = resolveLocalPath(mapping.canonical_path)
  return {
    selectedPath: selectedPath.resolutionError === null ? selectedPath : stored.selectedPath,
    canonicalPath: canonicalPath.resolutionError === null ? canonicalPath : stored.canonicalPath
  }
}

const handle = (request: DraftWorkerRequest): unknown => {
  switch (request.op) {
    case "listReaderProfiles":
      return readReaderProfiles()
    case "getReaderProfile":
      return readReaderProfile(request.profileId) ?? null
    case "saveReaderProfile": {
      db.exec("BEGIN IMMEDIATE")
      try {
        const current = readReaderProfile(request.profileId)
        if (current === undefined) {
          if (request.expectedRevision !== "0") {
            db.exec("ROLLBACK")
            return { kind: "conflict", currentRevision: "0" }
          }
          const count = (selectReaderProfileCount.get() as { count: bigint }).count
          if (count >= BigInt(MAX_READER_PROFILES)) {
            db.exec("ROLLBACK")
            return { kind: "full" }
          }
          const profile: ReaderProfileRow = {
            profileId: request.profileId,
            revision: "1",
            name: request.name,
            launchMode: request.launchMode,
            supportedFormats: request.supportedFormats,
            targetMode: request.targetMode,
            executablePath: request.executablePath,
            argumentTokens: request.argumentTokens
          }
          insertReaderProfile.run(
            profile.profileId,
            BigInt(profile.revision),
            profile.name,
            profile.launchMode,
            JSON.stringify(profile.supportedFormats),
            profile.targetMode,
            profile.executablePath,
            JSON.stringify(profile.argumentTokens),
            Date.now()
          )
          db.exec("COMMIT")
          return { kind: "saved", profile }
        }
        if (current.revision !== request.expectedRevision) {
          db.exec("ROLLBACK")
          return { kind: "conflict", currentRevision: current.revision }
        }
        const profile: ReaderProfileRow = {
          profileId: request.profileId,
          revision: (BigInt(current.revision) + 1n).toString(),
          name: request.name,
          launchMode: request.launchMode,
          supportedFormats: request.supportedFormats,
          targetMode: request.targetMode,
          executablePath: request.executablePath,
          argumentTokens: request.argumentTokens
        }
        updateReaderProfile.run(
          BigInt(profile.revision),
          profile.name,
          profile.launchMode,
          JSON.stringify(profile.supportedFormats),
          profile.targetMode,
          profile.executablePath,
          JSON.stringify(profile.argumentTokens),
          Date.now(),
          profile.profileId,
          BigInt(request.expectedRevision)
        )
        db.exec("COMMIT")
        return { kind: "saved", profile }
      } catch (error) {
        rollbackIfActive()
        throw error
      }
    }
    case "load": {
      const row = readDraft(request.instanceId, request.noteId, request.formId)
      return row === undefined
        ? null
        : row.present
          ? row
          : {
              kind: "absent",
              instanceId: row.instanceId,
              noteId: row.noteId,
              formId: row.formId,
              localRevision: row.localRevision
            }
    }
    case "save": {
      db.exec("BEGIN IMMEDIATE")
      try {
        const current = readDraft(request.instanceId, request.noteId, request.formId)
        if (current === undefined && request.expectedLocalRevision !== "0") {
          db.exec("ROLLBACK")
          return { kind: "conflict", currentLocalRevision: "0" }
        }
        if (current !== undefined && current.localRevision !== request.expectedLocalRevision) {
          db.exec("ROLLBACK")
          return { kind: "conflict", currentLocalRevision: current.localRevision }
        }
        if (current === undefined) {
          const count = (selectCount.get() as { count: bigint }).count
          if (count >= BigInt(MAX_DRAFT_ROWS)) {
            db.exec("ROLLBACK")
            return { kind: "full" }
          }
        }
        const localRevision = (BigInt(request.expectedLocalRevision) + 1n).toString()
        const draft: DraftRow = {
          instanceId: request.instanceId,
          noteId: request.noteId,
          formId: request.formId,
          text: request.text,
          localRevision,
          baseServerRevision: request.baseServerRevision,
          baseEpoch: request.baseEpoch,
          present: true
        }
        upsertDraft.run(
          draft.instanceId,
          draft.noteId,
          draft.formId,
          draft.text,
          BigInt(draft.localRevision),
          BigInt(draft.baseServerRevision),
          draft.baseEpoch,
          Date.now()
        )
        db.exec("COMMIT")
        return { kind: "saved", draft }
      } catch (error) {
        rollbackIfActive()
        throw error
      }
    }
    case "discard": {
      db.exec("BEGIN IMMEDIATE")
      try {
        const current = readDraft(request.instanceId, request.noteId, request.formId)
        if (current === undefined) {
          if (request.expectedLocalRevision !== "0") {
            db.exec("ROLLBACK")
            return { kind: "conflict", currentLocalRevision: "0" }
          }
          db.exec("COMMIT")
          return {
            kind: "discarded",
            instanceId: request.instanceId,
            noteId: request.noteId,
            formId: request.formId,
            localRevision: "0"
          }
        }
        if (current.localRevision !== request.expectedLocalRevision) {
          db.exec("ROLLBACK")
          return { kind: "conflict", currentLocalRevision: current.localRevision }
        }
        const localRevision = (BigInt(current.localRevision) + 1n).toString()
        tombstoneDraft.run(
          BigInt(localRevision),
          Date.now(),
          request.instanceId,
          request.noteId,
          request.formId
        )
        db.exec("COMMIT")
        return {
          kind: "discarded",
          instanceId: request.instanceId,
          noteId: request.noteId,
          formId: request.formId,
          localRevision
        }
      } catch (error) {
        rollbackIfActive()
        throw error
      }
    }
    case "admitCommand": {
      db.exec("BEGIN IMMEDIATE")
      try {
        const existing = readCommandAttempt(request.instanceId, request.operationId)
        if (existing !== undefined) {
          const sameIntent =
            existing.noteId === request.noteId &&
            existing.intentText === request.intentText &&
            existing.baseRevision === request.baseRevision &&
            existing.epoch === request.epoch
          db.exec("COMMIT")
          return sameIntent ? { kind: "existing", attempt: existing } : { kind: "conflict" }
        }

        const now = Date.now()
        // Explicit dismissal is the only way a nonterminal attempt becomes
        // eligible for this bounded seven-day cleanup. Undismissed unresolved
        // attempts are never evicted for capacity.
        compactCommandAttempts.run(COMMAND_ATTEMPT_RETENTION_MS, now, COMMAND_ATTEMPT_COMPACTION_BATCH)
        const count = (selectCommandAttemptCount.get() as { count: bigint }).count
        if (count >= BigInt(MAX_COMMAND_ATTEMPTS)) {
          db.exec("COMMIT")
          return { kind: "full" }
        }

        insertCommandAttempt.run(
          request.instanceId,
          request.operationId,
          request.noteId,
          request.intentText,
          BigInt(request.baseRevision),
          request.epoch,
          now,
          now
        )
        db.exec("COMMIT")
        const attempt = readCommandAttempt(request.instanceId, request.operationId)
        if (attempt === undefined) throw new Error("admitted command attempt was not readable")
        return { kind: "admitted", attempt }
      } catch (error) {
        rollbackIfActive()
        throw error
      }
    }
    case "markCommandSubmitted": {
      db.exec("BEGIN IMMEDIATE")
      try {
        const current = readCommandAttempt(request.instanceId, request.operationId)
        if (current === undefined) {
          db.exec("ROLLBACK")
          return { kind: "not_found" }
        }
        updateCommandStatus.run("submitted", Date.now(), request.instanceId, request.operationId)
        db.exec("COMMIT")
        const attempt = readCommandAttempt(request.instanceId, request.operationId)
        if (attempt === undefined) throw new Error("submitted command attempt was not readable")
        return { kind: "updated", attempt }
      } catch (error) {
        rollbackIfActive()
        throw error
      }
    }
    case "markCommandUnresolved": {
      db.exec("BEGIN IMMEDIATE")
      try {
        const current = readCommandAttempt(request.instanceId, request.operationId)
        if (current === undefined) {
          db.exec("ROLLBACK")
          return { kind: "not_found" }
        }
        updateCommandStatus.run("unresolved", Date.now(), request.instanceId, request.operationId)
        db.exec("COMMIT")
        const attempt = readCommandAttempt(request.instanceId, request.operationId)
        if (attempt === undefined) throw new Error("unresolved command attempt was not readable")
        return { kind: "updated", attempt }
      } catch (error) {
        rollbackIfActive()
        throw error
      }
    }
    case "markCommandSucceeded": {
      db.exec("BEGIN IMMEDIATE")
      try {
        const current = readCommandAttempt(request.instanceId, request.operationId)
        if (current === undefined) {
          db.exec("ROLLBACK")
          return { kind: "not_found" }
        }
        updateCommandSuccess.run(
          Date.now(),
          JSON.stringify(request.resultNote),
          request.expiresAtMs,
          request.instanceId,
          request.operationId
        )
        db.exec("COMMIT")
        const attempt = readCommandAttempt(request.instanceId, request.operationId)
        if (attempt === undefined) throw new Error("succeeded command attempt was not readable")
        return { kind: "updated", attempt }
      } catch (error) {
        rollbackIfActive()
        throw error
      }
    }
    case "markCommandRejected": {
      db.exec("BEGIN IMMEDIATE")
      try {
        const current = readCommandAttempt(request.instanceId, request.operationId)
        if (current === undefined) {
          db.exec("ROLLBACK")
          return { kind: "not_found" }
        }
        updateCommandRejection.run(
          Date.now(),
          request.errorCode,
          request.errorMessage,
          request.currentRevision === null ? null : BigInt(request.currentRevision),
          request.instanceId,
          request.operationId
        )
        db.exec("COMMIT")
        const attempt = readCommandAttempt(request.instanceId, request.operationId)
        if (attempt === undefined) throw new Error("rejected command attempt was not readable")
        return { kind: "updated", attempt }
      } catch (error) {
        rollbackIfActive()
        throw error
      }
    }
    case "listCommandAttempts":
      return readCommandAttempts(request.instanceId)
    case "getCommandAttempt":
      return readCommandAttempt(request.instanceId, request.operationId) ?? null
    case "dismissCommand": {
      db.exec("BEGIN IMMEDIATE")
      try {
        const current = readCommandAttempt(request.instanceId, request.operationId)
        if (current === undefined) {
          db.exec("ROLLBACK")
          return { kind: "not_found" }
        }
        dismissCommandAttempt.run(Date.now(), request.instanceId, request.operationId)
        db.exec("COMMIT")
        const attempt = readCommandAttempt(request.instanceId, request.operationId)
        if (attempt === undefined) throw new Error("dismissed command attempt was not readable")
        return { kind: "updated", attempt }
      } catch (error) {
        rollbackIfActive()
        throw error
      }
    }
    case "loadLocalMapping":
      return readLocalMapping(request.instanceId, request.rootId) ?? null
    case "listLocalMappings":
      return readLocalMappings(request.instanceId)
    case "activateLocalMapping": {
      const activationDeadlineMs = request.activationDeadlineMs ?? Date.now() + 4_000
      const ensureBeforeDeadline = (): void => {
        if (Date.now() >= activationDeadlineMs) {
          throw new Error("local mapping activation deadline exceeded")
        }
      }

      ensureBeforeDeadline()
      const selectedPath = resolveLocalPath(request.selectedPath)
      const canonicalHint = resolveLocalPath(request.canonicalPath)
      const protectedWritablePaths = request.protectedWritablePaths.map(resolveLocalPath)
      if (!selectedPath.exact || !selectedPath.directory || !canonicalHint.exact || !canonicalHint.directory) {
        throw new Error("local mapping roots must be existing directories")
      }
      const sameNativeTarget =
        selectedPath.comparisonPath === canonicalHint.comparisonPath ||
        (selectedPath.endpointIdentity !== null && selectedPath.endpointIdentity === canonicalHint.endpointIdentity)
      if (!sameNativeTarget) {
        throw new Error("local mapping canonical path does not match selected path")
      }
      if (protectedWritablePaths.some((path) => path.resolutionError !== null)) {
        throw new Error("protected writable path could not be resolved")
      }
      const canonicalPath = selectedPath

      const preparedMappings = new Map<string, {
        readonly mappingRevision: string
        readonly selectedPath: string
        readonly canonicalPath: string
        readonly evidence: MappingPathEvidence
      }>()
      for (const mapping of readPersistedLocalMappings(request.instanceId)) {
        preparedMappings.set(mapping.root_id, {
          mappingRevision: mapping.mapping_revision.toString(),
          selectedPath: mapping.selected_path,
          canonicalPath: mapping.canonical_path,
          evidence: refreshedMappingPathEvidence(mapping)
        })
      }
      ensureBeforeDeadline()

      db.exec("BEGIN IMMEDIATE")
      try {
        ensureBeforeDeadline()
        const current = readLocalMapping(request.instanceId, request.rootId)
        const currentRevision = current?.mappingRevision ?? "0"
        if (currentRevision !== request.expectedMappingRevision) {
          db.exec("ROLLBACK")
          return { kind: "revision_conflict", currentMapping: current ?? null }
        }

        const overlapsRoot = readPersistedLocalMappings(request.instanceId).some(
          (mapping) => {
            if (mapping.root_id === request.rootId) return false
            const prepared = preparedMappings.get(mapping.root_id)
            const evidence = prepared !== undefined &&
              prepared.mappingRevision === mapping.mapping_revision.toString() &&
              prepared.selectedPath === mapping.selected_path &&
              prepared.canonicalPath === mapping.canonical_path
              ? prepared.evidence
              : storedMappingPathEvidence(mapping)
            return mappingPathsOverlap(selectedPath, canonicalPath, evidence)
          }
        )
        if (overlapsRoot) {
          db.exec("ROLLBACK")
          return { kind: "root_conflict" }
        }

        const overlapsWritable = protectedWritablePaths.some(
          (writablePath) =>
            pathsOverlapWithEvidence(selectedPath, writablePath) ||
            pathsOverlapWithEvidence(canonicalPath, writablePath)
        )
        if (overlapsWritable) {
          db.exec("ROLLBACK")
          return { kind: "writable_overlap" }
        }

        const mapping: LocalMappingRow = {
          instanceId: request.instanceId,
          rootId: request.rootId,
          selectedPath: request.selectedPath,
          canonicalPath: canonicalPath.comparisonPath,
          mappingRevision: (BigInt(request.expectedMappingRevision) + 1n).toString()
        }
        ensureBeforeDeadline()
        upsertLocalMapping.run(
          mapping.instanceId,
          mapping.rootId,
          mapping.selectedPath,
          mapping.canonicalPath,
          BigInt(mapping.mappingRevision),
          selectedPath.endpointIdentity,
          canonicalPath.endpointIdentity,
          encodeResolution(selectedPath),
          encodeResolution(canonicalPath)
        )
        ensureBeforeDeadline()
        db.exec("COMMIT")
        return { kind: "activated", mapping }
      } catch (error) {
        rollbackIfActive()
        throw error
      }
    }
    case "close":
      db.close()
      return null
  }
}

parentPort?.on("message", (raw: unknown) => {
  const decoded = Schema.decodeUnknownOption(DraftWorkerMessage)(raw)
  if (Option.isNone(decoded)) {
    const id =
      typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "number"
        ? raw.id
        : -1
    parentPort?.postMessage({ id, ok: false, error: "invalid draft worker request" } satisfies DraftWorkerResponse)
    return
  }

  const { id, request } = decoded.value
  try {
    parentPort?.postMessage({ id, ok: true, value: handle(request) } satisfies DraftWorkerResponse)
  } catch (error) {
    parentPort?.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    } satisfies DraftWorkerResponse)
  }
})
