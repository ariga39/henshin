import { DatabaseSync } from "node:sqlite"
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
