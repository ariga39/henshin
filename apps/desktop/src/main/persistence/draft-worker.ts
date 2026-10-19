import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { Option, Schema } from "effect"
import {
  DraftWorkerMessage,
  DraftWorkerResponse,
  type DraftRow,
  type DraftWorkerRequest
} from "./draft-worker-protocol"

const MAX_DRAFT_ROWS = 64
const dbPath = (workerData as { readonly dbPath: string }).dbPath
const db = new DatabaseSync(dbPath)

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

const handle = (request: DraftWorkerRequest): unknown => {
  switch (request.op) {
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
        db.exec("ROLLBACK")
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
        db.exec("ROLLBACK")
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
