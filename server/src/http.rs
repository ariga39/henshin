use crate::{app::AppState, roots, scanner};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, RawQuery, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use rusqlite::{OptionalExtension, params, params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use unicode_normalization::UnicodeNormalization;

const ENTRY_COLUMNS: &str = concat!(
    "id,root_id,relative_path,status,title,custom_title,note,",
    "page_count,file_size,file_mtime,cover_key,cover_sha1,eh_gid,eh_token,",
    "eh_domain,eh_title,eh_title_jpn,eh_refreshed_at,eh_error,",
    "open_count,last_opened_at,created_at,updated_at",
);

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/roots", get(list_roots).post(create_root))
        .route("/api/roots/{id}", patch(update_root).delete(delete_root))
        .route("/api/roots/{id}/scan", post(scan_root))
        .route("/api/scans", get(list_scans))
        .route("/api/entries", get(list_entries))
        .route("/api/entries/{id}", get(get_entry).patch(patch_entry))
        .route("/api/tags", get(list_tags))
        .route("/api/entries/{id}/open", post(open_entry))
        .route("/api/covers/{key}", get(get_cover))
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state)
}

async fn auth(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let expected = format!("Bearer {}", state.token);
    let valid = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|got| {
            got.as_bytes().len() == expected.len()
                && subtle::ConstantTimeEq::ct_eq(got.as_bytes(), expected.as_bytes()).into()
        });
    if valid {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized"})),
        )
            .into_response()
    }
}
fn err(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({"error":message.into()}))).into_response()
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

async fn health(State(s): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({"serverId":s.server_id,"version":env!("CARGO_PKG_VERSION")}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootInput {
    label: String,
    server_path: String,
    #[serde(default)]
    exclusions: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RootResponse {
    id: String,
    label: String,
    server_path: String,
    exclusions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<i64>,
}

async fn create_root(State(s): State<Arc<AppState>>, Json(input): Json<RootInput>) -> Response {
    let conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
    let path = match roots::validate(&input.server_path, &s.data_dir, &conn, None) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let exclusions = serde_json::to_string(&input.exclusions).unwrap_or_else(|_| "[]".into());
    let root = RootResponse {
        id,
        label: input.label,
        server_path: path.to_string_lossy().into_owned(),
        exclusions: input.exclusions,
        created_at: Some(now()),
    };
    match conn.execute(
        "INSERT INTO roots(id,label,server_path,exclusions_json,created_at) VALUES(?1,?2,?3,?4,?5)",
        params![
            root.id,
            root.label,
            root.server_path,
            exclusions,
            root.created_at
        ],
    ) {
        Ok(_) => (StatusCode::CREATED, Json(root)).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}
async fn list_roots(State(s): State<Arc<AppState>>) -> Response {
    let conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
    let mut statement = match conn.prepare(
        "SELECT id,label,server_path,exclusions_json,created_at FROM roots ORDER BY created_at,id",
    ) {
        Ok(statement) => statement,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let roots = statement
        .query_map([], |row| {
            let exclusions: String = row.get(3)?;
            Ok(RootResponse {
                id: row.get(0)?,
                label: row.get(1)?,
                server_path: row.get(2)?,
                exclusions: serde_json::from_str(&exclusions).unwrap_or_default(),
                created_at: Some(row.get(4)?),
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>());
    match roots {
        Ok(roots) => Json(json!({"roots": roots})).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootPatch {
    label: Option<String>,
    exclusions: Option<Vec<String>>,
}
async fn update_root(
    State(s): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<RootPatch>,
) -> Response {
    let conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
    let existing = conn
        .query_row(
            "SELECT label,server_path,exclusions_json FROM roots WHERE id=?1",
            [&id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional();
    let Ok(Some((old_label, path, old_exclusions))) = existing else {
        return err(StatusCode::NOT_FOUND, "root not found");
    };
    if let Err(e) = roots::validate(&path, &s.data_dir, &conn, Some(&id)) {
        return err(StatusCode::BAD_REQUEST, e);
    }
    let label = input.label.unwrap_or(old_label);
    let exclusions = input
        .exclusions
        .unwrap_or_else(|| serde_json::from_str(&old_exclusions).unwrap_or_default());
    let exclusions_json = serde_json::to_string(&exclusions).unwrap_or(old_exclusions);
    match conn.execute(
        "UPDATE roots SET label=?1,exclusions_json=?2 WHERE id=?3",
        params![label, exclusions_json, id],
    ) {
        Ok(_) => Json(RootResponse {
            id,
            label,
            server_path: path,
            exclusions,
            created_at: None,
        })
        .into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
async fn delete_root(State(s): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
    let has_entries = match conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM entries WHERE root_id=?1)",
        [&id],
        |row| row.get::<_, bool>(0),
    ) {
        Ok(has_entries) => has_entries,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if has_entries {
        return err(
            StatusCode::CONFLICT,
            "root contains indexed entries; remove its entries before deleting the root",
        );
    }
    match conn.execute("DELETE FROM roots WHERE id=?1", [id]) {
        Ok(0) => err(StatusCode::NOT_FOUND, "root not found"),
        Ok(_) => (StatusCode::NO_CONTENT, Body::empty()).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
async fn scan_root(State(s): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    match scanner::start(s, id) {
        Ok(scan) => (StatusCode::ACCEPTED, Json(scan)).into_response(),
        Err(e) => err(
            if e == "root not found" {
                StatusCode::NOT_FOUND
            } else if e == "scan already running" {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            },
            e,
        ),
    }
}
async fn list_scans(State(s): State<Arc<AppState>>) -> Json<Value> {
    let scans = s
        .scans
        .lock()
        .map(|m| m.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    Json(json!({"scans":scans}))
}

fn normalize_tag(value: &str) -> Result<String, String> {
    let normalized = value.trim().nfkc().collect::<String>().to_lowercase();
    let normalized = if let Some((namespace, tag)) = normalized.split_once(':') {
        let (namespace, tag) = (namespace.trim(), tag.trim());
        if namespace.is_empty() || tag.is_empty() || tag.contains(':') {
            return Err(format!("invalid tag: {value}"));
        }
        format!("{namespace}:{tag}")
    } else {
        normalized.trim().to_owned()
    };
    if normalized.is_empty() {
        Err("tag cannot be empty".into())
    } else {
        Ok(normalized)
    }
}

fn query_params(raw: Option<&str>) -> Vec<(String, String)> {
    form_urlencoded::parse(raw.unwrap_or_default().as_bytes())
        .into_owned()
        .collect()
}

async fn list_entries(State(s): State<Arc<AppState>>, RawQuery(raw): RawQuery) -> Response {
    let pairs = query_params(raw.as_deref());
    let one = |name: &str| {
        pairs
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, v)| v.clone())
    };
    let status = one("status").unwrap_or_else(|| "active".into());
    if status != "active" && status != "missing" {
        return err(StatusCode::BAD_REQUEST, "invalid status");
    }
    let sort = one("sort").unwrap_or_else(|| "added".into());
    let order = match sort.as_str() {
        "added" => "created_at DESC,id ASC",
        "title" => {
            "norm_text(COALESCE(NULLIF(custom_title,''),NULLIF(eh_title_jpn,''),NULLIF(eh_title,''),title)) ASC,id ASC"
        }
        "openCount" => "open_count DESC,id ASC",
        "lastOpened" => {
            "CASE WHEN last_opened_at IS NULL THEN 1 ELSE 0 END ASC,last_opened_at DESC,id ASC"
        }
        _ => return err(StatusCode::BAD_REQUEST, "invalid sort"),
    };
    let limit = one("limit")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(100)
        .clamp(1, 500);
    let offset = one("offset")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    let q = one("q")
        .unwrap_or_default()
        .trim()
        .nfkc()
        .collect::<String>()
        .to_lowercase();
    let root = one("rootId").filter(|v| !v.is_empty());
    let mut include = Vec::new();
    let mut exclude = Vec::new();
    for (key, value) in pairs
        .iter()
        .filter(|(k, _)| k == "includeTags" || k == "excludeTags")
    {
        let tag = match normalize_tag(value) {
            Ok(tag) => tag,
            Err(e) => return err(StatusCode::BAD_REQUEST, e),
        };
        let list = if key == "includeTags" {
            &mut include
        } else {
            &mut exclude
        };
        if !list.contains(&tag) {
            list.push(tag);
        }
    }
    let mut clauses = vec!["status=?".to_owned()];
    let mut values = vec![SqlValue::Text(status)];
    if let Some(root) = root {
        values.push(SqlValue::Text(root));
        clauses.push(format!("root_id=?{}", values.len()));
    }
    if !q.is_empty() {
        values.push(SqlValue::Text(q));
        let n = values.len();
        clauses.push(format!("(instr(norm_text(COALESCE(NULLIF(custom_title,''),NULLIF(eh_title_jpn,''),NULLIF(eh_title,''),title)),?{n})>0 OR instr(norm_text(COALESCE(eh_title,'')),?{n})>0 OR instr(norm_text(COALESCE(eh_title_jpn,'')),?{n})>0 OR instr(norm_text(path_basename(relative_path)),?{n})>0)"));
    }
    for tag in include {
        values.push(SqlValue::Text(tag));
        let n = values.len();
        clauses.push(format!("EXISTS(SELECT 1 FROM entry_tags t WHERE t.entry_id=entries.id AND t.tag=?{n} AND t.origin IN ('eh','local') AND NOT EXISTS(SELECT 1 FROM entry_tags h WHERE h.entry_id=entries.id AND h.tag=t.tag AND h.origin='hidden'))"));
    }
    for tag in exclude {
        values.push(SqlValue::Text(tag));
        let n = values.len();
        clauses.push(format!("NOT EXISTS(SELECT 1 FROM entry_tags t WHERE t.entry_id=entries.id AND t.tag=?{n} AND t.origin IN ('eh','local') AND NOT EXISTS(SELECT 1 FROM entry_tags h WHERE h.entry_id=entries.id AND h.tag=t.tag AND h.origin='hidden'))"));
    }
    let where_sql = clauses.join(" AND ");
    let conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
    let total: i64 = match conn.query_row(
        &format!("SELECT count(*) FROM entries WHERE {where_sql}"),
        params_from_iter(values.iter()),
        |r| r.get(0),
    ) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let mut page_values = values.clone();
    page_values.push(SqlValue::Integer(limit as i64));
    page_values.push(SqlValue::Integer(offset as i64));
    let sql = format!(
        "SELECT {ENTRY_COLUMNS} FROM entries WHERE {where_sql} ORDER BY {order} LIMIT ?{} OFFSET ?{}",
        page_values.len() - 1,
        page_values.len()
    );
    let mut st = match conn.prepare(&sql) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let rows = st.query_map(params_from_iter(page_values.iter()), entry_from_row);
    let mut entries = match rows.and_then(|r| r.collect::<rusqlite::Result<Vec<_>>>()) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    for entry in &mut entries {
        if let Err(e) = attach_tags(&conn, entry) {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    Json(json!({"entries":entries,"total":total,"limit":limit,"offset":offset})).into_response()
}

async fn list_tags(State(s): State<Arc<AppState>>, RawQuery(raw): RawQuery) -> Response {
    let q = query_params(raw.as_deref())
        .into_iter()
        .rev()
        .find(|(k, _)| k == "q")
        .map(|(_, v)| v.trim().nfkc().collect::<String>().to_lowercase())
        .unwrap_or_default();
    let conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
    match conn.prepare("SELECT DISTINCT t.tag FROM entry_tags t WHERE t.origin IN ('eh','local') AND NOT EXISTS(SELECT 1 FROM entry_tags h WHERE h.entry_id=t.entry_id AND h.tag=t.tag AND h.origin='hidden') AND instr(norm_text(t.tag),?1)>0 ORDER BY t.tag ASC").and_then(|mut st|st.query_map([q],|r|r.get::<_,String>(0)).and_then(|r|r.collect::<rusqlite::Result<Vec<_>>>())) {
        Ok(tags)=>Json(json!({"tags":tags})).into_response(),Err(e)=>err(StatusCode::INTERNAL_SERVER_ERROR,e.to_string())
    }
}

async fn get_entry(State(s): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
    match conn.query_row(
        &format!("SELECT {ENTRY_COLUMNS} FROM entries WHERE id=?1"),
        [id],
        entry_from_row,
    ) {
        Ok(mut entry) => match attach_tags(&conn, &mut entry) {
            Ok(()) => Json(entry).into_response(),
            Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        },
        Err(rusqlite::Error::QueryReturnedNoRows) => err(StatusCode::NOT_FOUND, "entry not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

fn attach_tags(conn: &rusqlite::Connection, entry: &mut Entry) -> rusqlite::Result<()> {
    let mut st =
        conn.prepare("SELECT tag,origin FROM entry_tags WHERE entry_id=?1 ORDER BY tag ASC")?;
    for row in st.query_map([&entry.id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (tag, origin) = row?;
        match origin.as_str() {
            "eh" => entry.eh_tags.push(tag),
            "local" => entry.local_tags.push(tag),
            "hidden" => entry.hidden_tags.push(tag),
            _ => {}
        }
    }
    entry.tags = entry
        .eh_tags
        .iter()
        .chain(entry.local_tags.iter())
        .filter(|tag| !entry.hidden_tags.contains(tag))
        .cloned()
        .collect();
    entry.tags.sort();
    entry.tags.dedup();
    entry.effective_title = entry
        .custom_title
        .as_deref()
        .filter(|v| !v.is_empty())
        .or(entry.eh_title_jpn.as_deref().filter(|v| !v.is_empty()))
        .or(entry.eh_title.as_deref().filter(|v| !v.is_empty()))
        .unwrap_or(&entry.title)
        .to_owned();
    Ok(())
}

async fn patch_entry(
    State(s): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let Some(object) = body.as_object() else {
        return err(StatusCode::BAD_REQUEST, "expected an object");
    };
    let custom_present = object.contains_key("customTitle") || object.contains_key("custom_title");
    let custom = object
        .get("customTitle")
        .or_else(|| object.get("custom_title"));
    let custom = match custom {
        Some(Value::Null) => Some(None),
        Some(Value::String(v)) => Some(if v.trim().is_empty() {
            None
        } else {
            Some(v.trim().to_owned())
        }),
        Some(_) => {
            return err(
                StatusCode::BAD_REQUEST,
                "customTitle must be a string or null",
            );
        }
        None => None,
    };
    let note = object.get("note");
    if note.is_some_and(|v| !v.is_string()) {
        return err(StatusCode::BAD_REQUEST, "note must be a string");
    }
    let parse_tags = |camel: &str, snake: &str| -> Result<Option<Vec<String>>, String> {
        let Some(value) = object.get(camel).or_else(|| object.get(snake)) else {
            return Ok(None);
        };
        let Some(values) = value.as_array() else {
            return Err(format!("{camel} must be an array"));
        };
        let mut out = Vec::new();
        for value in values {
            let Some(v) = value.as_str() else {
                return Err(format!("{camel} values must be strings"));
            };
            let tag = normalize_tag(v)?;
            if !out.contains(&tag) {
                out.push(tag)
            }
        }
        Ok(Some(out))
    };
    let local = match parse_tags("localTags", "local_tags") {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let hidden = match parse_tags("hiddenTags", "hidden_tags") {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    if !custom_present && note.is_none() && local.is_none() && hidden.is_none() {
        return err(StatusCode::BAD_REQUEST, "no fields to update");
    }
    let mut conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
    let tx = match conn.transaction() {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if !matches!(
        tx.query_row("SELECT 1 FROM entries WHERE id=?1", [&id], |r| r
            .get::<_, i32>(0))
            .optional(),
        Ok(Some(_))
    ) {
        return err(StatusCode::NOT_FOUND, "entry not found");
    }
    if custom_present {
        if let Err(e) = tx.execute(
            "UPDATE entries SET custom_title=?1 WHERE id=?2",
            params![custom.flatten(), id],
        ) {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    if let Some(note) = note {
        if let Err(e) = tx.execute(
            "UPDATE entries SET note=?1 WHERE id=?2",
            params![note.as_str().unwrap(), id],
        ) {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    for (origin, tags) in [("local", local), ("hidden", hidden)] {
        if let Some(tags) = tags {
            if let Err(e) = tx.execute(
                "DELETE FROM entry_tags WHERE entry_id=?1 AND origin=?2",
                params![id, origin],
            ) {
                return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
            for tag in tags {
                if let Err(e) = tx.execute(
                    "INSERT INTO entry_tags(entry_id,tag,origin) VALUES(?1,?2,?3)",
                    params![id, tag, origin],
                ) {
                    return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
                }
            }
        }
    }
    if let Err(e) = tx.execute(
        "UPDATE entries SET updated_at=?1 WHERE id=?2",
        params![now(), id],
    ) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    if let Err(e) = tx.commit() {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    match conn.query_row(
        &format!("SELECT {ENTRY_COLUMNS} FROM entries WHERE id=?1"),
        [id],
        entry_from_row,
    ) {
        Ok(mut entry) => match attach_tags(&conn, &mut entry) {
            Ok(()) => Json(entry).into_response(),
            Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        },
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    root_id: String,
    relative_path: String,
    status: String,
    title: String,
    custom_title: Option<String>,
    note: String,
    page_count: i64,
    file_size: Option<i64>,
    file_mtime: Option<i64>,
    cover_key: Option<String>,
    cover_sha1: Option<String>,
    eh_gid: Option<String>,
    eh_token: Option<String>,
    eh_domain: Option<String>,
    eh_title: Option<String>,
    eh_title_jpn: Option<String>,
    eh_refreshed_at: Option<i64>,
    eh_error: Option<String>,
    open_count: i64,
    last_opened_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    effective_title: String,
    tags: Vec<String>,
    eh_tags: Vec<String>,
    local_tags: Vec<String>,
    hidden_tags: Vec<String>,
}

fn entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: row.get(0)?,
        root_id: row.get(1)?,
        relative_path: row.get(2)?,
        status: row.get(3)?,
        title: row.get(4)?,
        custom_title: row.get(5)?,
        note: row.get(6)?,
        page_count: row.get(7)?,
        file_size: row.get(8)?,
        file_mtime: row.get(9)?,
        cover_key: row.get(10)?,
        cover_sha1: row.get(11)?,
        eh_gid: row.get(12)?,
        eh_token: row.get(13)?,
        eh_domain: row.get(14)?,
        eh_title: row.get(15)?,
        eh_title_jpn: row.get(16)?,
        eh_refreshed_at: row.get(17)?,
        eh_error: row.get(18)?,
        open_count: row.get(19)?,
        last_opened_at: row.get(20)?,
        created_at: row.get(21)?,
        updated_at: row.get(22)?,
        effective_title: String::new(),
        tags: Vec::new(),
        eh_tags: Vec::new(),
        local_tags: Vec::new(),
        hidden_tags: Vec::new(),
    })
}
#[derive(Deserialize)]
struct OpenInput {
    #[serde(alias = "eventId")]
    event_id: String,
    #[serde(alias = "openedAt")]
    opened_at: i64,
}

#[derive(Serialize)]
struct OpenStats {
    open_count: i64,
    last_opened_at: Option<i64>,
}
async fn open_entry(
    State(s): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<OpenInput>,
) -> Response {
    let mut conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
    let tx = match conn.transaction() {
        Ok(t) => t,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let exists = tx
        .query_row("SELECT 1 FROM entries WHERE id=?1", [&id], |_| Ok(()))
        .optional();
    if !matches!(exists, Ok(Some(()))) {
        return err(StatusCode::NOT_FOUND, "entry not found");
    }
    let inserted = match tx.execute(
        "INSERT OR IGNORE INTO open_events(id,entry_id,opened_at) VALUES(?1,?2,?3)",
        params![input.event_id, id, input.opened_at],
    ) {
        Ok(n) => n,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if inserted > 0 {
        if let Err(e) = tx.execute(
            "UPDATE entries SET \
             open_count=open_count+1, \
             last_opened_at=CASE \
                 WHEN last_opened_at IS NULL OR last_opened_at<?1 THEN ?1 \
                 ELSE last_opened_at \
             END, \
             updated_at=?2 \
             WHERE id=?3",
            params![input.opened_at, now(), id],
        ) {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    match tx.query_row(
        "SELECT open_count,last_opened_at FROM entries WHERE id=?1",
        [id],
        |row| {
            Ok(OpenStats {
                open_count: row.get(0)?,
                last_opened_at: row.get(1)?,
            })
        },
    ) {
        Ok(v) => {
            if let Err(e) = tx.commit() {
                err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
            } else {
                Json(v).into_response()
            }
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
async fn get_cover(State(s): State<Arc<AppState>>, Path(key): Path<String>) -> Response {
    if key.contains('/') || key.contains('\\') || key.contains("..") {
        return err(StatusCode::BAD_REQUEST, "invalid cover key");
    }
    match fs::read(s.covers_dir.join(key)) {
        Ok(bytes) => ([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            err(StatusCode::NOT_FOUND, "cover not found")
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    async fn post_open(app: Router, body: &str) -> (StatusCode, Value) {
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/entries/entry/open")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_owned()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = serde_json::from_slice(&bytes).unwrap();
        (status, body)
    }

    async fn api(app: Router, method: &str, uri: &str, body: Option<&str>) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, "Bearer secret");
        if body.is_some() {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        let response = app
            .oneshot(
                builder
                    .body(Body::from(body.unwrap_or_default().to_owned()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn api_requires_the_persisted_bearer_token() {
        let temp = tempfile::tempdir().unwrap();
        let state =
            Arc::new(AppState::open(temp.path().join("data"), Some("secret".into())).unwrap());
        let app = router(state);
        for authorization in [None, Some("Bearer wrong")] {
            let mut request = Request::builder().uri("/api/health");
            if let Some(value) = authorization {
                request = request.header(header::AUTHORIZATION, value);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn open_accepts_both_field_spellings_and_keeps_latest_timestamp() {
        let temp = tempfile::tempdir().unwrap();
        let state =
            Arc::new(AppState::open(temp.path().join("data"), Some("secret".into())).unwrap());
        {
            let conn = state.db.lock().unwrap();
            conn.execute("INSERT INTO roots VALUES('root','root','/root','[]',0)", [])
                .unwrap();
            conn.execute(
                "INSERT INTO entries(id,root_id,relative_path,title,created_at,updated_at) \
                 VALUES('entry','root','book.zip','book',0,0)",
                [],
            )
            .unwrap();
        }
        let app = router(state);

        let (status, first) =
            post_open(app.clone(), r#"{"event_id":"first","opened_at":30}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["open_count"], 1);
        assert_eq!(first["last_opened_at"], 30);
        assert!(first.get("openCount").is_none());

        let (status, second) =
            post_open(app.clone(), r#"{"eventId":"second","openedAt":40}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(second["open_count"], 2);
        assert_eq!(second["last_opened_at"], 40);

        let (_, older) = post_open(app.clone(), r#"{"event_id":"older","opened_at":25}"#).await;
        assert_eq!(older["open_count"], 3);
        assert_eq!(older["last_opened_at"], 40);

        let (_, duplicate) = post_open(app, r#"{"eventId":"first","openedAt":50}"#).await;
        assert_eq!(duplicate["open_count"], 3);
        assert_eq!(duplicate["last_opened_at"], 40);
    }

    #[tokio::test]
    async fn deleting_a_root_with_entries_conflicts_and_preserves_history() {
        let temp = tempfile::tempdir().unwrap();
        let collection = temp.path().join("collection");
        std::fs::create_dir(&collection).unwrap();
        let state =
            Arc::new(AppState::open(temp.path().join("data"), Some("secret".into())).unwrap());
        {
            let conn = state.db.lock().unwrap();
            conn.execute(
                "INSERT INTO roots VALUES('root','root',?1,'[]',0)",
                [collection.to_string_lossy().as_ref()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO entries(id,root_id,relative_path,status,title,created_at,updated_at) \
                 VALUES('entry','root','book.zip','missing','book',0,0)",
                [],
            )
            .unwrap();
        }
        let app = router(state.clone());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/roots/root")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        {
            let conn = state.db.lock().unwrap();
            assert_eq!(
                conn.query_row("SELECT count(*) FROM roots", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                conn.query_row("SELECT status FROM entries WHERE id='entry'", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
                "missing"
            );
        }

        state
            .db
            .lock()
            .unwrap()
            .execute("DELETE FROM entries WHERE id='entry'", [])
            .unwrap();
        let response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/roots/root")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(collection.is_dir());
    }

    #[tokio::test]
    async fn search_tags_editing_sorting_and_pagination_work_together() {
        let temp = tempfile::tempdir().unwrap();
        let state =
            Arc::new(AppState::open(temp.path().join("data"), Some("secret".into())).unwrap());
        {
            let conn = state.db.lock().unwrap();
            conn.execute("INSERT INTO roots VALUES('root','root','/root','[]',0)", [])
                .unwrap();
            conn.execute("INSERT INTO entries(id,root_id,relative_path,title,eh_title,eh_title_jpn,open_count,last_opened_at,created_at,updated_at) VALUES(?1,'root',?2,?3,?4,?5,?6,?7,?8,?8)", params!["a", "parent/ＡＢＣ.zip", "stored", "猫 EN", "猫の本", 4, 10, 1]).unwrap();
            conn.execute("INSERT INTO entries(id,root_id,relative_path,title,eh_title,eh_title_jpn,open_count,created_at,updated_at) VALUES(?1,'root',?2,?3,'English','',?4,?5,?5)", params!["b", "other/同人作品.zip", "同人作品", 4, 1]).unwrap();
            conn.execute("INSERT INTO entries(id,root_id,relative_path,title,open_count,last_opened_at,created_at,updated_at) VALUES(?1,'root',?2,?3,?4,?5,?6,?6)", params!["c", "artist/under_%'\".zip", "ｶﾞ作品", 9, 20, 3]).unwrap();
            conn.execute("INSERT INTO entry_tags VALUES('a','artist:alice','eh'),('a','language:japanese','local'),('a','female:sole female','eh'),('b','artist:alice','eh')", []).unwrap();
            conn.execute(
                "INSERT INTO entry_tags VALUES('a','female:sole female','hidden')",
                [],
            )
            .unwrap();
        }
        let app = router(state.clone());
        for (q, id) in [
            ("%E7%8C%AB", "a"),
            ("%E5%90%8C%E4%BA%BA", "b"),
            ("ABC", "a"),
            ("%E3%82%AC", "c"),
            ("%E7%8C%AB%20EN", "a"),
            ("English", "b"),
            ("under", "c"),
            ("%5F", "c"),
            ("%25", "c"),
            ("%27", "c"),
            ("%22", "c"),
            ("parent", ""),
        ] {
            let (status, value) =
                api(app.clone(), "GET", &format!("/api/entries?q={q}"), None).await;
            assert_eq!(status, StatusCode::OK);
            if id.is_empty() {
                assert_eq!(value["total"], 0);
            } else {
                assert_eq!(value["total"], 1, "query {q}");
                assert_eq!(value["entries"][0]["id"], id);
            }
        }
        let (status, value) = api(app.clone(), "GET", "/api/entries?includeTags=artist%3Aalice&includeTags=language%3Ajapanese&excludeTags=female%3Asole%20female", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["total"], 1);
        assert_eq!(
            value["entries"][0]["tags"],
            json!(["artist:alice", "language:japanese"])
        );
        let (status, value) = api(
            app.clone(),
            "GET",
            "/api/entries?includeTags=female%3Asole%20female",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["total"], 0);
        let (status, value) = api(app.clone(), "GET", "/api/tags", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["tags"], json!(["artist:alice", "language:japanese"]));
        let (status, detail) = api(app.clone(), "GET", "/api/entries/b", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(detail["effectiveTitle"], "English");
        for (sort, expected) in [
            ("added", vec!["c", "a", "b"]),
            ("title", vec!["b", "c", "a"]),
            ("openCount", vec!["c", "a", "b"]),
            ("lastOpened", vec!["c", "a", "b"]),
        ] {
            let (status, value) = api(
                app.clone(),
                "GET",
                &format!("/api/entries?sort={sort}"),
                None,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let ids = value["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["id"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(ids, expected);
        }
        let (status, first) = api(
            app.clone(),
            "GET",
            "/api/entries?sort=added&limit=1&offset=0",
            None,
        )
        .await;
        let (status2, second) = api(
            app.clone(),
            "GET",
            "/api/entries?sort=added&limit=1&offset=1",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(status2, StatusCode::OK);
        assert_eq!(first["total"], 3);
        assert_eq!(first["entries"][0]["id"], "c");
        assert_eq!(second["entries"][0]["id"], "a");
        let (status, _) = api(app.clone(), "GET", "/api/entries?sort=random", None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = api(app.clone(), "GET", "/api/entries?status=other", None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, value) = api(app.clone(), "PATCH", "/api/entries/a", Some(r#"{"customTitle":"  Personal  ","note":"hello","localTags":["New : Tag","NEW:TAG"]}"#)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["effectiveTitle"], "Personal");
        assert_eq!(value["note"], "hello");
        assert_eq!(value["localTags"], json!(["new:tag"]));
        assert_eq!(
            value["ehTags"],
            json!(["artist:alice", "female:sole female"])
        );
        assert_eq!(value["hiddenTags"], json!(["female:sole female"]));
        let (status, value) = api(app.clone(), "GET", "/api/entries?q=personal", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["total"], 1);
        assert_eq!(value["entries"][0]["id"], "a");
        let (status, value) = api(app.clone(), "GET", "/api/entries?q=%E7%8C%AB", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["total"], 1);
        assert_eq!(value["entries"][0]["id"], "a");
        let (status, first_desktop) = api(
            app.clone(),
            "PATCH",
            "/api/entries/a",
            Some(r#"{"note":"Desktop A note"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, second_desktop) = api(
            app.clone(),
            "PATCH",
            "/api/entries/a",
            Some(r#"{"customTitle":"Desktop B title"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first_desktop["note"], "Desktop A note");
        assert_eq!(second_desktop["note"], "Desktop A note");
        assert_eq!(second_desktop["customTitle"], "Desktop B title");
        let (status, value) = api(
            app.clone(),
            "PATCH",
            "/api/entries/a",
            Some(r#"{"customTitle":" ","localTags":[],"hiddenTags":[]}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["customTitle"], Value::Null);
        assert_eq!(value["effectiveTitle"], "猫の本");
        assert_eq!(value["tags"], json!(["artist:alice", "female:sole female"]));
        let (status, _) = api(
            app.clone(),
            "PATCH",
            "/api/entries/a",
            Some(r#"{"localTags":[":bad"]}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = api(app, "PATCH", "/api/entries/nope", Some(r#"{"note":"x"}"#)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
