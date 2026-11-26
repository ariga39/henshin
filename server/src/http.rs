use crate::{
    app::AppState,
    eh::{self, GalleryRef},
    roots, scanner,
};
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
    "open_count,last_opened_at,created_at,updated_at,eh_bind_source",
);

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route(
            "/api/settings/eh",
            get(get_eh_settings).put(put_eh_settings),
        )
        .route("/api/roots", get(list_roots).post(create_root))
        .route("/api/roots/{id}", patch(update_root).delete(delete_root))
        .route("/api/roots/{id}/scan", post(scan_root))
        .route("/api/scans", get(list_scans))
        .route("/api/entries", get(list_entries))
        .route("/api/entries/{id}", get(get_entry).patch(patch_entry))
        .route("/api/tags", get(list_tags))
        .route("/api/entries/{id}/open", post(open_entry))
        .route("/api/entries/{id}/eh-lookup", post(eh_lookup))
        .route("/api/entries/{id}/eh-bind", post(eh_bind))
        .route("/api/entries/{id}/eh-refresh", post(eh_refresh))
        .route("/api/eh/refresh", post(eh_refresh_batch))
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

async fn get_eh_settings(State(s): State<Arc<AppState>>) -> Response {
    let settings = match s.eh_settings.lock() {
        Ok(settings) => settings,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "settings unavailable"),
    };
    eh_settings_response(&settings)
}

fn eh_settings_response(settings: &crate::app::EhSettings) -> Response {
    Json(json!({"site":settings.site,"credentialsConfigured":settings.cookie_header.is_some(),"sendCookiesToEHentai":settings.send_cookies_to_e_hentai,"language":settings.language,"useThumbnails":settings.use_thumbnails,"searchGid":settings.search_gid,"preferOriginalTitle":settings.prefer_original_title,"additionalTags":settings.additional_tags,"includeExpunged":settings.include_expunged,"interval":settings.interval})).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EhSettingsInput {
    site: Option<String>,
    cookie_header: Option<String>,
    clear_credentials: Option<bool>,
    send_cookies_to_e_hentai: Option<bool>,
    language: Option<String>,
    use_thumbnails: Option<bool>,
    search_gid: Option<bool>,
    prefer_original_title: Option<bool>,
    additional_tags: Option<bool>,
    include_expunged: Option<bool>,
    interval: Option<u8>,
}

async fn put_eh_settings(
    State(s): State<Arc<AppState>>,
    Json(input): Json<EhSettingsInput>,
) -> Response {
    if input
        .site
        .as_deref()
        .is_some_and(|site| !matches!(site, "e-hentai.org" | "exhentai.org"))
    {
        return err(
            StatusCode::BAD_REQUEST,
            "site must be e-hentai.org or exhentai.org",
        );
    }
    if let Some(cookie) = input.cookie_header.as_deref() {
        if cookie.is_empty()
            || cookie.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0)
            || cookie.split(';').any(|part| {
                let Some((name, value)) = part.trim().split_once('=') else {
                    return true;
                };
                name.trim().is_empty() || value.trim().is_empty()
            })
        {
            return err(
                StatusCode::BAD_REQUEST,
                "Enter a valid Cookie header using name=value pairs",
            );
        }
    }
    if input.interval.is_some_and(|interval| interval > 20) {
        return err(
            StatusCode::BAD_REQUEST,
            "interval must be between 0 and 20 seconds",
        );
    }
    let mut settings = match s.eh_settings.lock() {
        Ok(settings) => settings,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "settings unavailable"),
    };
    let next = crate::app::EhSettings {
        site: input.site.unwrap_or_else(|| settings.site.clone()),
        cookie_header: if input.clear_credentials.unwrap_or(false) {
            None
        } else {
            input
                .cookie_header
                .or_else(|| settings.cookie_header.clone())
        },
        send_cookies_to_e_hentai: input
            .send_cookies_to_e_hentai
            .unwrap_or(settings.send_cookies_to_e_hentai),
        language: input.language.unwrap_or_else(|| settings.language.clone()),
        use_thumbnails: input.use_thumbnails.unwrap_or(settings.use_thumbnails),
        search_gid: input.search_gid.unwrap_or(settings.search_gid),
        prefer_original_title: input
            .prefer_original_title
            .unwrap_or(settings.prefer_original_title),
        additional_tags: input.additional_tags.unwrap_or(settings.additional_tags),
        include_expunged: input.include_expunged.unwrap_or(settings.include_expunged),
        interval: input.interval.unwrap_or(settings.interval),
    };
    if let Err(e) = crate::app::save_eh_settings(&s.data_dir, &next) {
        return err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not save EH settings: {e}"),
        );
    }
    *settings = next;
    let response = eh_settings_response(&settings);
    drop(settings);
    response
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
            if s.eh_settings
                .lock()
                .map(|settings| settings.prefer_original_title)
                .unwrap_or(false)
            {
                "norm_text(COALESCE(NULLIF(custom_title,''),NULLIF(eh_title_jpn,''),NULLIF(eh_title,''),title)) ASC,id ASC"
            } else {
                "norm_text(COALESCE(NULLIF(custom_title,''),NULLIF(eh_title,''),NULLIF(eh_title_jpn,''),title)) ASC,id ASC"
            }
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
    let bind_source = one("ehBindSource");
    if bind_source
        .as_deref()
        .is_some_and(|source| !matches!(source, "auto" | "manual"))
    {
        return err(
            StatusCode::BAD_REQUEST,
            "ehBindSource must be auto or manual",
        );
    }
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
    if let Some(source) = bind_source {
        values.push(SqlValue::Text(source));
        clauses.push(format!("eh_bind_source=?{}", values.len()));
    }
    if !q.is_empty() {
        values.push(SqlValue::Text(q));
        let n = values.len();
        clauses.push(format!("(instr(norm_text(COALESCE(NULLIF(custom_title,''),NULLIF(eh_title_jpn,''),NULLIF(eh_title,''),title)),?{n})>0 OR instr(norm_text(COALESCE(eh_title,'')),?{n})>0 OR instr(norm_text(COALESCE(eh_title_jpn,'')),?{n})>0 OR instr(norm_text(path_basename(relative_path)),?{n})>0)"));
    }
    for tag in include {
        values.push(SqlValue::Text(tag));
        let n = values.len();
        clauses.push(format!("EXISTS(SELECT 1 FROM entry_tags t WHERE t.entry_id=entries.id AND norm_text(t.tag)=norm_text(?{n}) AND t.origin IN ('eh','local') AND NOT EXISTS(SELECT 1 FROM entry_tags h WHERE h.entry_id=entries.id AND norm_text(h.tag)=norm_text(t.tag) AND h.origin='hidden'))"));
    }
    for tag in exclude {
        values.push(SqlValue::Text(tag));
        let n = values.len();
        clauses.push(format!("NOT EXISTS(SELECT 1 FROM entry_tags t WHERE t.entry_id=entries.id AND norm_text(t.tag)=norm_text(?{n}) AND t.origin IN ('eh','local') AND NOT EXISTS(SELECT 1 FROM entry_tags h WHERE h.entry_id=entries.id AND norm_text(h.tag)=norm_text(t.tag) AND h.origin='hidden'))"));
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
        apply_eh_title_preference(&s, entry);
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
    match conn.prepare("SELECT DISTINCT t.tag FROM entry_tags t WHERE t.origin IN ('eh','local') AND NOT EXISTS(SELECT 1 FROM entry_tags h WHERE h.entry_id=t.entry_id AND norm_text(h.tag)=norm_text(t.tag) AND h.origin='hidden') AND instr(norm_text(t.tag),?1)>0 ORDER BY t.tag ASC").and_then(|mut st|st.query_map([q],|r|r.get::<_,String>(0)).and_then(|r|r.collect::<rusqlite::Result<Vec<_>>>())) {
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
            Ok(()) => {
                apply_eh_title_preference(&s, &mut entry);
                Json(entry).into_response()
            }
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
        .filter(|tag| {
            !entry
                .hidden_tags
                .iter()
                .any(|hidden| crate::db::normalize_text(hidden) == crate::db::normalize_text(tag))
        })
        .cloned()
        .collect();
    entry.tags.sort();
    entry.tags.dedup();
    entry.effective_title = entry
        .custom_title
        .as_deref()
        .filter(|v| !v.is_empty())
        .unwrap_or(&entry.title)
        .to_owned();
    Ok(())
}

fn apply_eh_title_preference(state: &AppState, entry: &mut Entry) {
    let prefer_original = state
        .eh_settings
        .lock()
        .map(|settings| settings.prefer_original_title)
        .unwrap_or(false);
    entry.eh_display_title = if prefer_original {
        entry
            .eh_title_jpn
            .as_ref()
            .filter(|title| !title.is_empty())
            .or(entry.eh_title.as_ref().filter(|title| !title.is_empty()))
    } else {
        entry
            .eh_title
            .as_ref()
            .filter(|title| !title.is_empty())
            .or(entry
                .eh_title_jpn
                .as_ref()
                .filter(|title| !title.is_empty()))
    }
    .cloned();
    if entry.custom_title.as_deref().is_none_or(str::is_empty) {
        entry.effective_title = entry
            .eh_display_title
            .as_deref()
            .unwrap_or(&entry.title)
            .to_owned();
    }
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
            Ok(()) => {
                apply_eh_title_preference(&s, &mut entry);
                Json(entry).into_response()
            }
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
    eh_display_title: Option<String>,
    eh_bind_source: Option<String>,
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
        eh_display_title: None,
        eh_bind_source: row.get(23)?,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EhLookupInput {
    mode: Option<String>,
    query: Option<String>,
    include_expunged: Option<bool>,
    site: Option<String>,
    auto_bind: Option<bool>,
}

async fn eh_lookup(
    State(s): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<EhLookupInput>,
) -> Response {
    let mode = input.mode.as_deref().unwrap_or("title");
    let settings_snapshot = {
        let settings = match s.eh_settings.lock() {
            Ok(v) => v,
            Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "settings unavailable"),
        };
        let site = input.site.as_deref().unwrap_or(&settings.site);
        if !matches!(site, "e-hentai.org" | "exhentai.org") {
            return err(
                StatusCode::BAD_REQUEST,
                "site must be e-hentai.org or exhentai.org",
            );
        }
        let mut copy = settings.clone();
        copy.site = site.to_owned();
        copy
    };
    let site = settings_snapshot.site.clone();
    let cookie = settings_snapshot.cookie_header.clone();
    if !matches!(mode, "title" | "cover" | "auto") {
        return err(
            StatusCode::BAD_REQUEST,
            "mode must be title, cover, or auto",
        );
    }
    let (
        title,
        mut cover_sha1,
        hash_version,
        cached_size,
        cached_mtime,
        artist,
        root_path,
        other_roots,
        relative_path,
        existing_binding,
    ) = {
        let conn = match s.db.lock() {
            Ok(c) => c,
            Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
        };
        match conn.query_row(
            "SELECT e.title,e.cover_sha1,e.cover_hash_version,e.file_size,e.file_mtime,e.root_id,e.relative_path,e.eh_gid,e.eh_token,e.eh_domain FROM entries e WHERE e.id=?1",
            [&id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<u64>>(3)?, r.get::<_, Option<i64>>(4)?, r.get::<_, String>(5)?, r.get::<_, String>(6)?, r.get::<_, Option<String>>(7)?, r.get::<_, Option<String>>(8)?, r.get::<_, Option<String>>(9)?)),
        ) {
            Ok((title, hash, hash_version, cached_size, cached_mtime, root_id, relative, gid, token, domain)) => {
                let artist = conn.query_row("SELECT tag FROM entry_tags WHERE entry_id=?1 AND origin IN ('eh','local') AND lower(tag) LIKE 'artist:%' ORDER BY origin='eh' DESC LIMIT 1", [&id], |r| r.get::<_,String>(0)).optional().ok().flatten();
                let root_path = match conn.query_row("SELECT server_path FROM roots WHERE id=?1",[&root_id],|r|r.get::<_,String>(0)) { Ok(path) => path, Err(error) => return err(StatusCode::INTERNAL_SERVER_ERROR,error.to_string()) };
                let mut roots_statement = match conn.prepare("SELECT server_path FROM roots WHERE id<>?1") { Ok(statement) => statement, Err(error) => return err(StatusCode::INTERNAL_SERVER_ERROR,error.to_string()) };
                let other_roots = match roots_statement.query_map([&root_id],|r|r.get::<_,String>(0)).and_then(|rows|rows.collect::<rusqlite::Result<Vec<_>>>()) { Ok(paths) => paths.into_iter().map(std::path::PathBuf::from).collect::<Vec<_>>(), Err(error) => return err(StatusCode::INTERNAL_SERVER_ERROR,error.to_string()) };
                let binding = gid.zip(token).zip(domain).map(|((gid,token),domain)| GalleryRef { gid,token,domain });
                (title, hash, hash_version, cached_size, cached_mtime, artist, root_path, other_roots, relative, binding)
            },
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                return err(StatusCode::NOT_FOUND, "entry not found");
            }
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    };
    if mode == "auto" && input.auto_bind.unwrap_or(true) {
        if let Some(gallery) = existing_binding {
            let result =
                s.eh.gdata_with_options(
                    std::slice::from_ref(&gallery),
                    settings_snapshot.additional_tags,
                )
                .await
                .into_iter()
                .next()
                .unwrap_or_else(|| Err("No metadata returned".into()));
            if let Err(error) = save_eh_result_data(&s, &id, &gallery, result, true) {
                return err(StatusCode::INTERNAL_SERVER_ERROR, error);
            }
            let entry = match entry_value(&s, &id) {
                Ok(entry) => entry,
                Err(error) => return entry_value_error_response(error),
            };
            return Json(json!({"mode":"auto","entry":entry,"candidates":[],"autoBound":false,"refreshedBinding":true})).into_response();
        }
    }
    if mode == "cover" || (mode == "auto" && settings_snapshot.use_thumbnails) {
        let data_dir = s.data_dir.clone();
        let cached_hash = cover_sha1.clone();
        let lookup = tokio::task::spawn_blocking(move || {
            cached_lookup_cover_sha1(
                &root_path,
                &relative_path,
                &data_dir,
                &other_roots,
                hash_version,
                cached_size,
                cached_mtime,
                cached_hash,
            )
        })
        .await
        .ok();
        cover_sha1 = match lookup {
            Some(CoverHashLookup::Current(hash)) => Some(hash),
            Some(CoverHashLookup::Unavailable) if mode == "cover" => cover_sha1,
            _ => None,
        };
    }
    if mode == "auto" {
        let mut queries: Vec<(&str, String, bool)> = Vec::new();
        if settings_snapshot.use_thumbnails {
            if let Some(hash) = cover_sha1 {
                queries.push(("cover", hash, false));
            }
        }
        if settings_snapshot.search_gid {
            if let Some(gid) = eh::first_numeric_bracket(&title) {
                queries.push(("gid", gid, false));
            }
        }
        let mut title_query = format!("\"{title}\"");
        if let Some(artist) = artist
            .and_then(|tag| tag.strip_prefix("artist:").map(str::to_owned))
            .filter(|artist| artist.is_ascii())
        {
            title_query.push_str(&format!(" artist:{artist}"));
        }
        if !settings_snapshot.language.is_empty() {
            title_query.push_str(&format!(" language:{}", settings_snapshot.language));
        }
        queries.push((
            "auto-title",
            title_query,
            settings_snapshot.include_expunged,
        ));
        for (search_mode, query, expunged) in queries {
            match s
                .eh
                .lookup(
                    &site,
                    cookie.as_deref(),
                    search_mode,
                    &query,
                    expunged,
                    settings_snapshot.send_cookies_to_e_hentai,
                )
                .await
            {
                Ok(candidates) if !candidates.is_empty() => {
                    if !input.auto_bind.unwrap_or(true) {
                        let entry = match entry_value(&s, &id) {
                            Ok(entry) => entry,
                            Err(error) => return entry_value_error_response(error),
                        };
                        return Json(json!({"mode":"auto","matchedBy":search_mode,"query":query,"entry":entry,"candidates":candidates,"autoBound":false})).into_response();
                    }
                    let Some(candidate) = candidates.first() else {
                        unreachable!()
                    };
                    let gallery = GalleryRef {
                        gid: candidate.gid.clone(),
                        token: candidate.token.clone(),
                        domain: candidate.domain.clone(),
                    };
                    let changed = {
                        let mut conn = match s.db.lock() {
                            Ok(conn) => conn,
                            Err(_) => {
                                return err(
                                    StatusCode::INTERNAL_SERVER_ERROR,
                                    "database unavailable",
                                );
                            }
                        };
                        let tx = match conn.transaction() {
                            Ok(tx) => tx,
                            Err(error) => {
                                return err(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
                            }
                        };
                        let changed = match tx.execute("UPDATE entries SET eh_gid=?2,eh_token=?3,eh_domain=?4,eh_bind_source='auto',eh_title=NULL,eh_title_jpn=NULL,eh_refreshed_at=NULL,eh_error=NULL,updated_at=?5 WHERE id=?1 AND eh_gid IS NULL AND eh_bind_source IS NULL",params![id,gallery.gid,gallery.token,gallery.domain,now()]) { Ok(changed) => changed, Err(error) => return err(StatusCode::INTERNAL_SERVER_ERROR,error.to_string()) };
                        if changed > 0 {
                            if let Err(error) = tx.execute(
                                "DELETE FROM entry_tags WHERE entry_id=?1 AND origin='eh'",
                                [&id],
                            ) {
                                return err(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
                            }
                        }
                        if let Err(error) = tx.commit() {
                            return err(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
                        }
                        changed
                    };
                    if changed == 0 {
                        let entry = match entry_value(&s, &id) {
                            Ok(entry) => entry,
                            Err(error) => return entry_value_error_response(error),
                        };
                        return Json(json!({"mode":"auto","matchedBy":search_mode,"query":query,"entry":entry,"candidates":candidates,"autoBound":false,"bindingChanged":true})).into_response();
                    }
                    let result =
                        s.eh.gdata_with_options(
                            std::slice::from_ref(&gallery),
                            settings_snapshot.additional_tags,
                        )
                        .await
                        .into_iter()
                        .next()
                        .unwrap_or_else(|| Err("No metadata returned".into()));
                    if let Err(error) = save_eh_result_data(&s, &id, &gallery, result, true) {
                        return err(StatusCode::INTERNAL_SERVER_ERROR, error);
                    }
                    let entry = match entry_value(&s, &id) {
                        Ok(entry) => entry,
                        Err(error) => return entry_value_error_response(error),
                    };
                    return Json(json!({"mode":"auto","matchedBy":search_mode,"query":query,"entry":entry,"candidates":candidates,"autoBound":true})).into_response();
                }
                Ok(_) => {}
                Err((status, message)) => {
                    return err(
                        StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
                        message,
                    );
                }
            }
        }
        let entry = match entry_value(&s, &id) {
            Ok(entry) => entry,
            Err(error) => return entry_value_error_response(error),
        };
        return Json(
            json!({"mode":"auto","query":title,"entry":entry,"candidates":[],"autoBound":false}),
        )
        .into_response();
    }
    let query = if mode == "cover" {
        let Some(hash) = cover_sha1 else {
            return err(StatusCode::BAD_REQUEST, "entry has no cover SHA-1");
        };
        hash
    } else {
        input
            .query
            .filter(|q| !q.trim().is_empty())
            .unwrap_or(title)
    };
    match s
        .eh
        .lookup(
            &site,
            cookie.as_deref(),
            mode,
            &query,
            input.include_expunged.unwrap_or(false),
            settings_snapshot.send_cookies_to_e_hentai,
        )
        .await
    {
        Ok(candidates) => {
            Json(json!({"mode":mode,"query":query,"candidates":candidates})).into_response()
        }
        Err((status, message)) => err(
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            message,
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EhBindInput {
    url: Option<String>,
    gid: Option<String>,
    token: Option<String>,
    domain: Option<String>,
}

async fn eh_bind(
    State(s): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<EhBindInput>,
) -> Response {
    let gallery = if let Some(url) = input.url.as_deref() {
        match eh::parse_gallery_url(url) {
            Ok(g) => g,
            Err(e) => return err(StatusCode::BAD_REQUEST, e),
        }
    } else {
        let (Some(gid), Some(token)) = (input.gid, input.token) else {
            return err(
                StatusCode::BAD_REQUEST,
                "Provide a gallery URL or gid and token",
            );
        };
        let Some(gid) = eh::normalize_gid(&gid) else {
            return err(StatusCode::BAD_REQUEST, "Invalid E-Hentai gallery identity");
        };
        if token.is_empty()
            || !token.bytes().all(|b| b.is_ascii_hexdigit())
            || !matches!(
                input.domain.as_deref().unwrap_or("e-hentai.org"),
                "e-hentai.org" | "exhentai.org"
            )
        {
            return err(StatusCode::BAD_REQUEST, "Invalid E-Hentai gallery identity");
        }
        GalleryRef {
            gid,
            token: token.to_ascii_lowercase(),
            domain: input.domain.unwrap_or_else(|| "e-hentai.org".into()),
        }
    };
    {
        let mut conn = match s.db.lock() {
            Ok(c) => c,
            Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
        };
        let tx = match conn.transaction() {
            Ok(tx) => tx,
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        let current = tx.query_row(
            "SELECT eh_gid,eh_token,eh_domain FROM entries WHERE id=?1",
            [&id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        );
        let (gid, token, domain) = match current {
            Ok(v) => v,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                return err(StatusCode::NOT_FOUND, "entry not found");
            }
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        if (gid.as_deref(), token.as_deref(), domain.as_deref())
            != (
                Some(&gallery.gid),
                Some(&gallery.token),
                Some(&gallery.domain),
            )
        {
            if let Err(e) = tx.execute("UPDATE entries SET eh_gid=?2,eh_token=?3,eh_domain=?4,eh_title=NULL,eh_title_jpn=NULL,eh_refreshed_at=NULL,eh_error=NULL,eh_bind_source='manual',updated_at=?5 WHERE id=?1", params![id,gallery.gid,gallery.token,gallery.domain,now()]) { return err(StatusCode::INTERNAL_SERVER_ERROR,e.to_string()); }
            if let Err(e) = tx.execute(
                "DELETE FROM entry_tags WHERE entry_id=?1 AND origin='eh'",
                [&id],
            ) {
                return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
        }
        if let Err(e) = tx.execute(
            "UPDATE entries SET eh_bind_source='manual',updated_at=?2 WHERE id=?1",
            params![id, now()],
        ) {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        if let Err(e) = tx.commit() {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    let eh_options = s
        .eh_settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_else(|_| crate::app::EhSettings::default());
    let result =
        s.eh.gdata_with_options(std::slice::from_ref(&gallery), eh_options.additional_tags)
            .await
            .into_iter()
            .next()
            .unwrap_or_else(|| Err("No metadata returned".into()));
    save_eh_result(&s, &id, &gallery, result, false)
}

async fn eh_refresh(State(s): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let gallery = match bound_gallery(&s, &id) {
        Ok(g) => g,
        Err(r) => return r,
    };
    let eh_options = s
        .eh_settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_else(|_| crate::app::EhSettings::default());
    let result =
        s.eh.gdata_with_options(std::slice::from_ref(&gallery), eh_options.additional_tags)
            .await
            .into_iter()
            .next()
            .unwrap_or_else(|| Err("No metadata returned".into()));
    save_eh_result(&s, &id, &gallery, result, true)
}

async fn eh_refresh_batch(
    State(s): State<Arc<AppState>>,
    Json(input): Json<EhBatchInput>,
) -> Response {
    let galleries = {
        let conn = match s.db.lock() {
            Ok(c) => c,
            Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
        };
        let mut stmt = match conn.prepare("SELECT id,eh_gid,eh_token,eh_domain FROM entries WHERE eh_gid IS NOT NULL AND status='active' ORDER BY id") { Ok(s)=>s,Err(e)=>return err(StatusCode::INTERNAL_SERVER_ERROR,e.to_string()) };
        match stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        {
            Ok(rows) => rows
                .into_iter()
                .filter(|(id, _, _, _)| input.entry_ids.as_ref().is_none_or(|ids| ids.contains(id)))
                .map(|(id, gid, token, domain)| (id, GalleryRef { gid, token, domain }))
                .collect::<Vec<_>>(),
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    };
    let total = galleries.len();
    let eh_options = s
        .eh_settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_else(|_| crate::app::EhSettings::default());
    let mut refreshed = 0;
    let mut failed = 0;
    let mut errors = Vec::new();
    for (index, (id, gallery)) in galleries.iter().enumerate() {
        let result =
            s.eh.gdata_with_options(std::slice::from_ref(gallery), eh_options.additional_tags)
                .await
                .into_iter()
                .next()
                .unwrap_or_else(|| Err("No metadata returned".into()));
        match save_eh_result_data(&s, id, gallery, result, true) {
            Ok(Some(message)) => {
                failed += 1;
                errors.push(json!({"entryId":id,"error":message}));
            }
            Ok(None) => refreshed += 1,
            Err(message) => {
                failed += 1;
                errors.push(json!({"entryId":id,"error":message}));
            }
        }
        wait_after_batch_book(
            std::time::Duration::from_secs(eh_options.interval as u64),
            index + 1 < total,
        )
        .await;
    }
    Json(json!({"total":total,"refreshed":refreshed,"failed":failed,"errors":errors}))
        .into_response()
}

async fn wait_after_batch_book(interval: std::time::Duration, has_next: bool) {
    if has_next && !interval.is_zero() {
        tokio::time::sleep(interval).await;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EhBatchInput {
    entry_ids: Option<Vec<String>>,
}

enum CoverHashLookup {
    Current(String),
    Unavailable,
    Invalid,
}

fn cached_lookup_cover_sha1(
    root_path: &str,
    relative_path: &str,
    data_dir: &std::path::Path,
    other_roots: &[std::path::PathBuf],
    hash_version: i64,
    cached_size: Option<u64>,
    cached_mtime: Option<i64>,
    cached_hash: Option<String>,
) -> CoverHashLookup {
    let canonical_root = match crate::roots::validate_snapshot(root_path, data_dir, other_roots) {
        Ok(root) => root,
        Err(error)
            if matches!(
                error.as_str(),
                "root directory is unavailable" | "root must be a readable directory"
            ) =>
        {
            return CoverHashLookup::Unavailable;
        }
        Err(_) => return CoverHashLookup::Invalid,
    };
    if canonical_root != std::path::PathBuf::from(root_path) {
        return CoverHashLookup::Invalid;
    }
    let archive_path = match std::fs::canonicalize(canonical_root.join(relative_path)) {
        Ok(path) => path,
        Err(_) => return CoverHashLookup::Unavailable,
    };
    if crate::scanner::relative_path(&canonical_root, &archive_path).is_err() {
        return CoverHashLookup::Invalid;
    }
    let metadata = match std::fs::metadata(&archive_path) {
        Ok(metadata) => metadata,
        Err(_) => return CoverHashLookup::Unavailable,
    };
    let current_mtime = match metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
    {
        Some(mtime) => mtime,
        None => return CoverHashLookup::Unavailable,
    };
    if hash_version == 1
        && cached_size == Some(metadata.len())
        && cached_mtime == Some(current_mtime)
    {
        if let Some(hash) = cached_hash {
            return CoverHashLookup::Current(hash);
        }
    }
    match crate::cover::raw_first_sha1(&archive_path) {
        Ok(hash) => CoverHashLookup::Current(hash),
        Err(_) => CoverHashLookup::Invalid,
    }
}

fn bound_gallery(s: &AppState, id: &str) -> Result<GalleryRef, Response> {
    let conn =
        s.db.lock()
            .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"))?;
    let binding = conn
        .query_row(
            "SELECT eh_gid,eh_token,eh_domain FROM entries WHERE id=?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let Some((Some(gid), Some(token), Some(domain))) = binding else {
        return Err(if binding.is_none() {
            err(StatusCode::NOT_FOUND, "entry not found")
        } else {
            err(StatusCode::BAD_REQUEST, "entry is not bound to E-Hentai")
        });
    };
    Ok(GalleryRef { gid, token, domain })
}

fn save_eh_result(
    s: &AppState,
    id: &str,
    gallery: &GalleryRef,
    result: Result<eh::Metadata, String>,
    preserve_on_error: bool,
) -> Response {
    match save_eh_result_data(s, id, gallery, result, preserve_on_error) {
        Ok(_) => get_entry_response(s, id),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

fn save_eh_result_data(
    s: &AppState,
    id: &str,
    gallery: &GalleryRef,
    result: Result<eh::Metadata, String>,
    preserve_on_error: bool,
) -> Result<Option<String>, String> {
    let mut conn =
        s.db.lock()
            .map_err(|_| "database unavailable".to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    match result {
        Ok(metadata) => {
            let changed=tx.execute("UPDATE entries SET eh_title=?5,eh_title_jpn=?6,eh_refreshed_at=?7,eh_error=NULL,updated_at=?7 WHERE id=?1 AND eh_gid=?2 AND eh_token=?3 AND eh_domain=?4",params![id,gallery.gid,gallery.token,gallery.domain,metadata.title,metadata.title_jpn,now()]).map_err(|e|e.to_string())?;
            if changed > 0 {
                tx.execute(
                    "DELETE FROM entry_tags WHERE entry_id=?1 AND origin='eh'",
                    [id],
                )
                .map_err(|e| e.to_string())?;
                for tag in metadata.tags {
                    tx.execute(
                        "INSERT OR IGNORE INTO entry_tags(entry_id,tag,origin) VALUES(?1,?2,'eh')",
                        params![id, tag],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok(None)
        }
        Err(message) => {
            if preserve_on_error {
                tx.execute("UPDATE entries SET eh_error=?5,updated_at=?6 WHERE id=?1 AND eh_gid=?2 AND eh_token=?3 AND eh_domain=?4",params![id,gallery.gid,gallery.token,gallery.domain,message,now()]).map_err(|e|e.to_string())?;
            } else {
                tx.execute("UPDATE entries SET eh_error=?5,updated_at=?6 WHERE id=?1 AND eh_gid=?2 AND eh_token=?3 AND eh_domain=?4",params![id,gallery.gid,gallery.token,gallery.domain,message,now()]).map_err(|e|e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok(Some(message))
        }
    }
}

enum EntryValueError {
    NotFound,
    Internal(String),
}

fn entry_value(s: &AppState, id: &str) -> Result<Value, EntryValueError> {
    let conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return Err(EntryValueError::Internal("database unavailable".into())),
    };
    match conn.query_row(
        &format!("SELECT {ENTRY_COLUMNS} FROM entries WHERE id=?1"),
        [id],
        entry_from_row,
    ) {
        Ok(mut entry) => {
            attach_tags(&conn, &mut entry)
                .map_err(|error| EntryValueError::Internal(error.to_string()))?;
            apply_eh_title_preference(s, &mut entry);
            serde_json::to_value(entry)
                .map_err(|error| EntryValueError::Internal(error.to_string()))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Err(EntryValueError::NotFound),
        Err(error) => Err(EntryValueError::Internal(error.to_string())),
    }
}

fn entry_value_error_response(error: EntryValueError) -> Response {
    match error {
        EntryValueError::NotFound => err(StatusCode::NOT_FOUND, "entry not found"),
        EntryValueError::Internal(message) => err(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

fn get_entry_response(s: &AppState, id: &str) -> Response {
    match entry_value(s, id) {
        Ok(entry) => Json(entry).into_response(),
        Err(error) => entry_value_error_response(error),
    }
}
async fn get_cover(State(s): State<Arc<AppState>>, Path(key): Path<String>) -> Response {
    if key.contains('/') || key.contains('\\') || key.contains("..") {
        return err(StatusCode::BAD_REQUEST, "invalid cover key");
    }
    let cover_path = s.covers_dir.join(&key);
    match fs::read(&cover_path) {
        Ok(bytes) => ([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let permit = match Arc::clone(&s.scan_gate).acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => {
                    return err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "cover generation is unavailable",
                    );
                }
            };
            if let Ok(bytes) = fs::read(&cover_path) {
                return ([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response();
            }
            let source = {
                let conn = match s.db.lock() {
                    Ok(conn) => conn,
                    Err(_) => {
                        return err(StatusCode::INTERNAL_SERVER_ERROR, "database lock poisoned");
                    }
                };
                conn.query_row(
                    "SELECT e.id,e.relative_path,e.file_mtime,e.file_size,r.server_path FROM entries e JOIN roots r ON r.id=e.root_id WHERE e.cover_key=?1 AND e.status='active'",
                    [&key],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, Option<u64>>(3)?, row.get::<_, String>(4)?)),
                ).ok()
            };
            let Some((entry_id, relative, stamp, size, root)) = source else {
                return err(StatusCode::NOT_FOUND, "cover not found");
            };
            let relative = std::path::PathBuf::from(relative);
            if relative.is_absolute()
                || relative.components().any(|part| {
                    matches!(
                        part,
                        std::path::Component::ParentDir
                            | std::path::Component::RootDir
                            | std::path::Component::Prefix(_)
                    )
                })
            {
                return err(StatusCode::NOT_FOUND, "cover source is unavailable");
            }
            let source_path = match fs::canonicalize(std::path::Path::new(&root).join(relative)) {
                Ok(path) => path,
                Err(_) => return err(StatusCode::NOT_FOUND, "cover source is unavailable"),
            };
            let root_path = match fs::canonicalize(&root) {
                Ok(path) => path,
                Err(_) => return err(StatusCode::NOT_FOUND, "cover source is unavailable"),
            };
            if !source_path.starts_with(root_path) {
                return err(StatusCode::NOT_FOUND, "cover source is unavailable");
            }
            let metadata = match fs::metadata(&source_path) {
                Ok(metadata) => metadata,
                Err(_) => return err(StatusCode::NOT_FOUND, "cover source is unavailable"),
            };
            let modified = metadata
                .modified()
                .unwrap_or(std::time::UNIX_EPOCH)
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            if Some(metadata.len()) != size || Some(modified) != stamp {
                return err(
                    StatusCode::NOT_FOUND,
                    "cover source has changed; rescan the collection root",
                );
            }
            let covers_dir = s.covers_dir.clone();
            let generated = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                crate::cover::extract(
                    &source_path,
                    &covers_dir,
                    &entry_id,
                    stamp.unwrap_or_default(),
                    size.unwrap_or_default(),
                )
            })
            .await;
            match generated {
                Ok(Ok(_)) => match fs::read(&cover_path) {
                    Ok(bytes) => ([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response(),
                    Err(error) => err(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
                },
                _ => err(StatusCode::NOT_FOUND, "cover could not be regenerated"),
            }
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eh::EhClient;
    use axum::{body::Body, http::Request};
    use image::{ImageBuffer, Rgb};
    use std::io::Write;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    use tower::ServiceExt;
    use zip::{ZipWriter, write::SimpleFileOptions};

    fn make_archive(path: &std::path::Path) {
        make_archive_with_width(path, 2);
    }

    fn make_archive_with_width(path: &std::path::Path, width: u32) {
        make_archive_with_pages(path, width, 1);
    }

    fn make_archive_with_pages(path: &std::path::Path, width: u32, pages: usize) {
        let file = fs::File::create(path).unwrap();
        let mut archive = ZipWriter::new(file);
        let image = image::DynamicImage::ImageRgb8(ImageBuffer::from_pixel(
            width,
            width,
            Rgb([20, 40, 60]),
        ));
        let mut bytes = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        for page in 0..pages {
            archive
                .start_file(format!("page-{page:02}.png"), SimpleFileOptions::default())
                .unwrap();
            archive.write_all(&bytes).unwrap();
        }
        archive.finish().unwrap();
    }

    async fn wait_for_scan(state: &Arc<AppState>, scan_id: &str) {
        for _ in 0..100 {
            if state
                .scans
                .lock()
                .unwrap()
                .get(scan_id)
                .is_some_and(|scan| scan.status != "running")
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("scan did not finish");
    }

    async fn mock_eh(responses: Vec<String>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for body in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 8192];
                let _ = stream.read(&mut request).await.unwrap();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        format!("http://{address}")
    }

    async fn mock_auto_lookup(
        gdata_body: String,
        request_count: usize,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..request_count {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 2048];
                loop {
                    let count = stream.read(&mut chunk).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..count]);
                    let Some(header_end) = request
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .map(|pos| pos + 4)
                    else {
                        continue;
                    };
                    let headers =
                        String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length: ")
                                .and_then(|length| length.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= header_end + content_length {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&request).into_owned();
                let (content_type, body) = if request.starts_with("POST ") {
                    ("application/json", gdata_body.clone())
                } else {
                    (
                        "text/html",
                        "<div class='itg'><a href='https://e-hentai.org/g/9/deadbeef00/'><div class='glink'>Candidate</div></a></div>".to_owned(),
                    )
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
                requests.push(request);
            }
            requests
        });
        (format!("http://{address}"), server)
    }

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
    async fn batch_waits_after_each_completed_book_even_when_metadata_fails() {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let mock = tokio::spawn(async move {
            let mut previous_complete = None;
            let mut next_start_delay = None;
            for index in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request_started = std::time::Instant::now();
                if let Some(completed) = previous_complete {
                    next_start_delay = Some(request_started.duration_since(completed));
                }
                let mut request = Vec::new();
                let mut chunk = [0; 2048];
                loop {
                    let count = stream.read(&mut chunk).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..count]);
                    if let Some(end) = request
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .map(|pos| pos + 4)
                    {
                        let header = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length: ")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + length {
                            break;
                        }
                    }
                }
                let body = if index == 0 {
                    r#"{"error":"fictional upstream error"}"#.to_owned()
                } else {
                    let raw = String::from_utf8_lossy(&request);
                    let body_at = raw.find("\r\n\r\n").unwrap() + 4;
                    let input: Value = serde_json::from_str(&raw[body_at..]).unwrap();
                    let item = &input["gidlist"][0];
                    format!(
                        r#"{{"gmetadata":[{{"gid":{},"token":"{}","title":"Book"}}]}}"#,
                        item[0],
                        item[1].as_str().unwrap()
                    )
                };
                if index == 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
                previous_complete = Some(std::time::Instant::now());
            }
            next_start_delay.unwrap()
        });
        let temp = tempfile::tempdir().unwrap();
        let mut state = AppState::open(temp.path().join("data"), Some("secret".into())).unwrap();
        state.eh = EhClient::new(&base, &base).unwrap();
        state.eh_settings.lock().unwrap().interval = 1;
        {
            let conn = state.db.lock().unwrap();
            conn.execute("INSERT INTO roots VALUES('root','root','/root','[]',0)", [])
                .unwrap();
            conn.execute("INSERT INTO entries(id,root_id,relative_path,title,eh_gid,eh_token,eh_domain,eh_bind_source,status,created_at,updated_at) VALUES('one','root','one.zip','One','1','aa','e-hentai.org','manual','active',0,0),('two','root','two.zip','Two','2','bb','e-hentai.org','auto','active',0,0)",[]).unwrap();
        }
        let (status, result) = api(
            router(Arc::new(state)),
            "POST",
            "/api/eh/refresh",
            Some("{}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result["failed"], 1);
        assert_eq!(result["refreshed"], 1);
        assert!(mock.await.unwrap() >= std::time::Duration::from_millis(900));
    }

    #[tokio::test]
    async fn batch_interval_starts_after_the_delayed_book_finishes() {
        let response_started = std::time::Instant::now();
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        let completed = std::time::Instant::now();
        assert!(
            completed.duration_since(response_started) >= std::time::Duration::from_millis(100)
        );
        wait_after_batch_book(std::time::Duration::from_millis(90), true).await;
        let next_book_started = std::time::Instant::now();
        assert!(
            next_book_started.duration_since(completed) >= std::time::Duration::from_millis(80)
        );
        let completed_last = std::time::Instant::now();
        wait_after_batch_book(std::time::Duration::from_millis(90), false).await;
        assert!(
            std::time::Instant::now().duration_since(completed_last)
                < std::time::Duration::from_millis(40)
        );
    }

    #[tokio::test]
    async fn bind_refresh_and_failed_rebind_keep_personal_overrides_consistent() {
        let temp = tempfile::tempdir().unwrap();
        let api_base = mock_eh(vec![
            r#"{"gmetadata":[{"gid":1,"token":"aa","title":"First","title_jpn":"猫","category":"Non-H","tags":["artist:one"]}]}"#.into(),
            r#"{"gmetadata":[{"gid":1,"token":"aa","title":"Updated","title_jpn":"猫の本","category":"Non-H","tags":["artist:two"]}]}"#.into(),
            r#"{"error":"temporarily unavailable"}"#.into(),
            r#"{"gmetadata":[{"gid":2,"error":"gallery unavailable"}]}"#.into(),
        ]).await;
        let mut state = AppState::open(temp.path().join("data"), Some("secret".into())).unwrap();
        state.eh = EhClient::new("https://e-hentai.org", &api_base).unwrap();
        {
            let conn = state.db.lock().unwrap();
            conn.execute("INSERT INTO roots VALUES('root','root','/root','[]',0)", [])
                .unwrap();
            conn.execute("INSERT INTO entries(id,root_id,relative_path,title,custom_title,note,created_at,updated_at) VALUES('entry','root','book.zip','Book','Personal title','Personal note',0,0)", []).unwrap();
            conn.execute("INSERT INTO entry_tags VALUES('entry','local:keep','local'),('entry','artist:one','hidden')", []).unwrap();
        }
        let app = router(Arc::new(state));
        let (status, bound) = api(
            app.clone(),
            "POST",
            "/api/entries/entry/eh-bind",
            Some(r#"{"url":"https://e-hentai.org/g/1/aa/"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bound["ehTitle"], "First");
        assert_eq!(bound["ehTags"], json!(["artist:one", "category:non-h"]));
        assert_eq!(bound["customTitle"], "Personal title");
        assert_eq!(bound["note"], "Personal note");
        assert_eq!(bound["localTags"], json!(["local:keep"]));
        assert_eq!(bound["hiddenTags"], json!(["artist:one"]));

        let (status, refreshed) = api(
            app.clone(),
            "POST",
            "/api/entries/entry/eh-refresh",
            Some("{}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(refreshed["ehTitleJpn"], "猫の本");
        assert_eq!(refreshed["ehTags"], json!(["artist:two", "category:non-h"]));
        assert_eq!(refreshed["hiddenTags"], json!(["artist:one"]));
        assert_eq!(refreshed["localTags"], json!(["local:keep"]));

        let (_, failed_refresh) = api(
            app.clone(),
            "POST",
            "/api/entries/entry/eh-refresh",
            Some("{}"),
        )
        .await;
        assert_eq!(failed_refresh["ehTitleJpn"], "猫の本");
        assert_eq!(
            failed_refresh["ehTags"],
            json!(["artist:two", "category:non-h"])
        );
        assert_eq!(failed_refresh["ehError"], "temporarily unavailable");

        let (status, rebound) = api(
            app,
            "POST",
            "/api/entries/entry/eh-bind",
            Some(r#"{"url":"https://e-hentai.org/g/2/bb/"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{rebound:?}");
        assert_eq!(rebound["ehGid"], "2");
        assert_eq!(rebound["ehTitle"], Value::Null);
        assert_eq!(rebound["ehTitleJpn"], Value::Null);
        assert_eq!(rebound["ehTags"], json!([]));
        assert_eq!(rebound["ehError"], "gallery unavailable");
        assert_eq!(rebound["customTitle"], "Personal title");
        assert_eq!(rebound["note"], "Personal note");
        assert_eq!(rebound["localTags"], json!(["local:keep"]));
        assert_eq!(rebound["hiddenTags"], json!(["artist:one"]));
    }

    #[tokio::test]
    async fn automatic_lookup_falls_through_binds_first_result_and_manual_confirmation_changes_source()
     {
        use tokio::net::TcpListener;
        let temp = tempfile::tempdir().unwrap();
        let library = temp.path().join("library");
        let data = temp.path().join("data");
        std::fs::create_dir_all(&library).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed_server = observed.clone();
        tokio::spawn(async move {
            for _ in 0..9 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buf = [0; 2048];
                loop {
                    let count = stream.read(&mut buf).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buf[..count]);
                    let Some(header_end) = request
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .map(|pos| pos + 4)
                    else {
                        continue;
                    };
                    let headers =
                        String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length: ")
                                .and_then(|n| n.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= header_end + content_length {
                        break;
                    }
                }
                let request_text = String::from_utf8_lossy(&request).into_owned();
                observed_server.lock().unwrap().push(request_text.clone());
                let is_post = request_text.starts_with("POST ");
                let (content_type, body) = if is_post {
                    let body_at = request_text.find("\r\n\r\n").unwrap() + 4;
                    let payload: Value = serde_json::from_str(&request_text[body_at..]).unwrap();
                    let item = &payload["gidlist"][0];
                    let gid = item[0].as_u64().unwrap();
                    let token = item[1].as_str().unwrap();
                    (
                        "application/json",
                        format!(
                            r#"{{"gmetadata":[{{"gid":{gid},"token":"{token}","title":"English {gid}","title_jpn":"日本語 {gid}","category":"Manga","tags":["artist:Test"]}}]}}"#
                        ),
                    )
                } else if request_text.contains("gid%3A123") {
                    ("text/html", "<a href='https://e-hentai.org/g/999/unrelated/'>unrelated</a><div class='itg'><a href='https://e-hentai.org/g/123/aa/'><div class='glink'>First actual result</div></a><a href='https://e-hentai.org/g/124/bb/'><div class='glink'>Second result</div></a></div>".into())
                } else {
                    ("text/html", "<div class='itg'><a href='https://e-hentai.org/g/456/cc/'><div class='glink'>Title result</div></a></div>".into())
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let mut state = AppState::open(data, Some("secret".into())).unwrap();
        state.eh = EhClient::new(&base, &base).unwrap();
        {
            let mut settings = state.eh_settings.lock().unwrap();
            settings.use_thumbnails = true;
            settings.search_gid = true;
            settings.interval = 0;
        }
        {
            let conn = state.db.lock().unwrap();
            conn.execute(
                "INSERT INTO roots VALUES('root','root',?1,'[]',0)",
                [library.to_string_lossy().as_ref()],
            )
            .unwrap();
            conn.execute("INSERT INTO entries(id,root_id,relative_path,title,created_at,updated_at) VALUES('gid','root','missing.zip','[circle] Work [123]',0,0),('title','root','missing2.zip','Plain title',0,0),('preview','root','missing3.zip','Preview',0,0)",[]).unwrap();
        }
        let app = router(Arc::new(state));
        let (status, gid_match) = api(
            app.clone(),
            "POST",
            "/api/entries/gid/eh-lookup",
            Some(r#"{"mode":"auto"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(gid_match["matchedBy"], "gid");
        assert_eq!(gid_match["entry"]["ehGid"], "123");
        assert_eq!(gid_match["entry"]["ehBindSource"], "auto");
        assert_eq!(gid_match["candidates"].as_array().unwrap().len(), 2);
        assert_eq!(gid_match["autoBound"], true);

        let (status, title_match) = api(
            app.clone(),
            "POST",
            "/api/entries/title/eh-lookup",
            Some(r#"{"mode":"auto"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(title_match["matchedBy"], "auto-title");
        assert_eq!(title_match["entry"]["ehGid"], "456");
        assert_eq!(title_match["entry"]["ehBindSource"], "auto");

        let (status, preview) = api(
            app.clone(),
            "POST",
            "/api/entries/preview/eh-lookup",
            Some(r#"{"mode":"auto","autoBind":false}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(preview["candidates"].as_array().unwrap().len(), 1);
        assert_eq!(preview["autoBound"], false);
        assert_eq!(preview["entry"]["ehGid"], Value::Null);

        let (status, manual_same) = api(
            app.clone(),
            "POST",
            "/api/entries/gid/eh-bind",
            Some(r#"{"url":"https://e-hentai.org/g/123/aa/"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(manual_same["ehBindSource"], "manual");
        let (status, manual_pick) = api(
            app.clone(),
            "POST",
            "/api/entries/preview/eh-bind",
            Some(r#"{"url":"https://e-hentai.org/g/456/cc/"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(manual_pick["ehBindSource"], "manual");

        let (status, autos) = api(app.clone(), "GET", "/api/entries?ehBindSource=auto", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(autos["total"], 1);
        assert_eq!(autos["entries"][0]["id"], "title");
        let (status, manuals) = api(app, "GET", "/api/entries?ehBindSource=manual", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(manuals["total"], 2);
        let requests = observed.lock().unwrap();
        assert!(requests.iter().any(|request| request.contains("gid%3A123")));
        assert!(
            requests.iter().all(|request| !request.contains("f_shash")),
            "unavailable covers must fall through to later searches"
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("POST "))
                .count(),
            4
        );
    }

    #[tokio::test]
    async fn automatic_bind_rolls_back_if_old_eh_tags_cannot_be_deleted() {
        let (base, mock) = mock_auto_lookup(r#"{"gmetadata":[]}"#.into(), 1).await;
        let temp = tempfile::tempdir().unwrap();
        let mut state = AppState::open(temp.path().join("data"), Some("secret".into())).unwrap();
        state.eh = EhClient::new(&base, &base).unwrap();
        {
            let conn = state.db.lock().unwrap();
            conn.execute("INSERT INTO roots VALUES('root','root','/root','[]',0)", [])
                .unwrap();
            conn.execute("INSERT INTO entries(id,root_id,relative_path,title,created_at,updated_at) VALUES('entry','root','book.zip','Book',0,0)",[]).unwrap();
            conn.execute(
                "INSERT INTO entry_tags VALUES('entry','artist:old','eh')",
                [],
            )
            .unwrap();
            conn.execute_batch("CREATE TRIGGER refuse_eh_tag_delete BEFORE DELETE ON entry_tags WHEN OLD.entry_id='entry' AND OLD.origin='eh' BEGIN SELECT RAISE(ABORT,'tag delete blocked'); END;").unwrap();
        }
        let state = Arc::new(state);

        let (status, _) = api(
            router(state.clone()),
            "POST",
            "/api/entries/entry/eh-lookup",
            Some(r#"{"mode":"auto"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        let request = mock.await.unwrap();
        assert_eq!(request.len(), 1);
        assert!(request[0].starts_with("GET "));
        let conn = state.db.lock().unwrap();
        let (gid, source, old_tag): (Option<String>, Option<String>, String) = conn
            .query_row(
                "SELECT e.eh_gid,e.eh_bind_source,t.tag FROM entries e JOIN entry_tags t ON t.entry_id=e.id WHERE e.id='entry'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(gid, None);
        assert_eq!(source, None);
        assert_eq!(old_tag, "artist:old");
    }

    #[tokio::test]
    async fn automatic_bound_refresh_reports_metadata_write_failure() {
        let metadata = r#"{"gmetadata":[{"gid":9,"token":"deadbeef00","title":"New title","title_jpn":"新しい","tags":[]}] }"#;
        let (base, mock) = mock_auto_lookup(metadata.into(), 1).await;
        let temp = tempfile::tempdir().unwrap();
        let mut state = AppState::open(temp.path().join("data"), Some("secret".into())).unwrap();
        state.eh = EhClient::new(&base, &base).unwrap();
        {
            let conn = state.db.lock().unwrap();
            conn.execute("INSERT INTO roots VALUES('root','root','/root','[]',0)", [])
                .unwrap();
            conn.execute("INSERT INTO entries(id,root_id,relative_path,title,eh_gid,eh_token,eh_domain,eh_bind_source,eh_title,eh_title_jpn,created_at,updated_at) VALUES('entry','root','book.zip','Book','9','deadbeef00','e-hentai.org','manual','Old title','旧',0,0)",[]).unwrap();
            conn.execute(
                "INSERT INTO entry_tags VALUES('entry','artist:old','eh')",
                [],
            )
            .unwrap();
            conn.execute_batch("CREATE TRIGGER refuse_eh_title_update BEFORE UPDATE OF eh_title ON entries WHEN OLD.id='entry' BEGIN SELECT RAISE(ABORT,'metadata write blocked'); END;").unwrap();
        }
        let state = Arc::new(state);

        let (status, _) = api(
            router(state.clone()),
            "POST",
            "/api/entries/entry/eh-lookup",
            Some(r#"{"mode":"auto"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        let requests = mock.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("POST "));
        assert!(requests[0].contains(r#""gidlist":[[9,"deadbeef00"]]"#));
        let conn = state.db.lock().unwrap();
        let (title, title_jpn, tag): (Option<String>, Option<String>, String) = conn
            .query_row(
                "SELECT e.eh_title,e.eh_title_jpn,t.tag FROM entries e JOIN entry_tags t ON t.entry_id=e.id WHERE e.id='entry'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(title.as_deref(), Some("Old title"));
        assert_eq!(title_jpn.as_deref(), Some("旧"));
        assert_eq!(tag, "artist:old");
    }

    #[tokio::test]
    async fn automatic_bind_keeps_selected_gallery_when_gdata_fails() {
        let body = r#"{"gmetadata":[{"gid":9,"error":"fixture metadata failure"}]}"#;
        let (base, mock) = mock_auto_lookup(body.into(), 2).await;
        let temp = tempfile::tempdir().unwrap();
        let mut state = AppState::open(temp.path().join("data"), Some("secret".into())).unwrap();
        state.eh = EhClient::new(&base, &base).unwrap();
        state
            .db
            .lock()
            .unwrap()
            .execute("INSERT INTO roots VALUES('root','root','/root','[]',0)", [])
            .unwrap();
        state
            .db
            .lock()
            .unwrap()
            .execute("INSERT INTO entries(id,root_id,relative_path,title,created_at,updated_at) VALUES('entry','root','book.zip','Book',0,0)",[])
            .unwrap();
        let state = Arc::new(state);

        let (status, result) = api(
            router(state.clone()),
            "POST",
            "/api/entries/entry/eh-lookup",
            Some(r#"{"mode":"auto"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result["autoBound"], true);
        assert_eq!(result["entry"]["ehGid"], "9");
        assert_eq!(result["entry"]["ehBindSource"], "auto");
        assert_eq!(result["entry"]["ehError"], "fixture metadata failure");
        let requests = mock.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET "));
        assert!(requests[1].starts_with("POST "));
        assert!(requests[1].contains(r#""gidlist":[[9,"deadbeef00"]]"#));
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

    #[test]
    fn entry_response_distinguishes_missing_rows_from_tag_database_errors() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("data"), Some("secret".into())).unwrap();
        let missing = get_entry_response(&state, "missing");
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        state
            .db
            .lock()
            .unwrap()
            .execute("INSERT INTO roots VALUES('root','root','/root','[]',0)", [])
            .unwrap();
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO entries(id,root_id,relative_path,title,created_at,updated_at) VALUES('entry','root','book.zip','Book',0,0)",
                [],
            )
            .unwrap();
        state
            .db
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE entry_tags")
            .unwrap();

        let tag_error = get_entry_response(&state, "entry");
        assert_eq!(tag_error.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn eh_settings_are_write_only_persisted_separately_and_clearable() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        let state = Arc::new(AppState::open(data_dir.clone(), Some("secret".into())).unwrap());
        let app = router(state);
        let (status, initial) = api(app.clone(), "GET", "/api/settings/eh", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            initial,
            json!({"site":"e-hentai.org","credentialsConfigured":false,"sendCookiesToEHentai":false,"language":"","useThumbnails":false,"searchGid":false,"preferOriginalTitle":false,"additionalTags":false,"includeExpunged":false,"interval":4})
        );

        let (status, saved) = api(app.clone(), "PUT", "/api/settings/eh", Some(
            r#"{"site":"exhentai.org","cookieHeader":"session=synthetic-test-value; pref=fixture"}"#
        )).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            saved,
            json!({"site":"exhentai.org","credentialsConfigured":true,"sendCookiesToEHentai":false,"language":"","useThumbnails":false,"searchGid":false,"preferOriginalTitle":false,"additionalTags":false,"includeExpunged":false,"interval":4})
        );
        assert!(!saved.to_string().contains("synthetic-test-value"));
        let (status, readback) = api(app.clone(), "GET", "/api/settings/eh", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            readback,
            json!({"site":"exhentai.org","credentialsConfigured":true,"sendCookiesToEHentai":false,"language":"","useThumbnails":false,"searchGid":false,"preferOriginalTitle":false,"additionalTags":false,"includeExpunged":false,"interval":4})
        );
        let settings_file = std::fs::read_to_string(data_dir.join("eh-settings.json")).unwrap();
        assert!(settings_file.contains("synthetic-test-value"));
        let database = std::fs::read(data_dir.join("henshin.sqlite")).unwrap();
        assert!(
            !database
                .windows(b"synthetic-test-value".len())
                .any(|w| w == b"synthetic-test-value")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(data_dir.join("eh-settings.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        let (status, kept) = api(
            app.clone(),
            "PUT",
            "/api/settings/eh",
            Some(r#"{"site":"e-hentai.org"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            kept,
            json!({"site":"e-hentai.org","credentialsConfigured":true,"sendCookiesToEHentai":false,"language":"","useThumbnails":false,"searchGid":false,"preferOriginalTitle":false,"additionalTags":false,"includeExpunged":false,"interval":4})
        );
        let (status, invalid) = api(
            app.clone(),
            "PUT",
            "/api/settings/eh",
            Some(r#"{"cookieHeader":"session=bad\nvalue"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!invalid.to_string().contains("bad"));
        let (status, cleared) = api(
            app.clone(),
            "PUT",
            "/api/settings/eh",
            Some(r#"{"clearCredentials":true}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            cleared,
            json!({"site":"e-hentai.org","credentialsConfigured":false,"sendCookiesToEHentai":false,"language":"","useThumbnails":false,"searchGid":false,"preferOriginalTitle":false,"additionalTags":false,"includeExpunged":false,"interval":4})
        );
        let (status, options) = api(app.clone(), "PUT", "/api/settings/eh", Some(r#"{"sendCookiesToEHentai":true,"language":"English","useThumbnails":true,"searchGid":true,"preferOriginalTitle":true,"additionalTags":true,"includeExpunged":true,"interval":0}"#)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(options["sendCookiesToEHentai"], true);
        assert_eq!(options["interval"], 0);
        assert_eq!(options["preferOriginalTitle"], true);
        let (status, _) = api(
            app.clone(),
            "PUT",
            "/api/settings/eh",
            Some(r#"{"interval":21}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _missing) = api(
            app,
            "POST",
            "/api/entries/missing/eh-lookup",
            Some(r#"{"site":"exhentai.org","mode":"title","query":"fictional title"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn missing_cover_is_regenerated_from_unchanged_collection_file() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let root = temp.path().join("library");
        fs::create_dir(&root).unwrap();
        let source = root.join("book.zip");
        make_archive(&source);
        let source_before = fs::read(&source).unwrap();
        let metadata = fs::metadata(&source).unwrap();
        let stamp = metadata
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let size = metadata.len();
        let key = format!("entry-{stamp}-{size}.jpg");
        let state = Arc::new(AppState::open(data, Some("secret".into())).unwrap());
        {
            let conn = state.db.lock().unwrap();
            conn.execute(
                "INSERT INTO roots VALUES('root','Library',?1,'[]',1)",
                [root.to_string_lossy().as_ref()],
            )
            .unwrap();
            conn.execute("INSERT INTO entries(id,root_id,relative_path,title,file_size,file_mtime,cover_key,created_at,updated_at) VALUES('entry','root','book.zip','book',?1,?2,?3,1,1)", rusqlite::params![size, stamp, key]).unwrap();
        }
        let response = router(state)
            .oneshot(
                Request::builder()
                    .uri(format!("/api/covers/{key}"))
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/jpeg");
        let jpeg = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(jpeg.starts_with(&[0xff, 0xd8]));
        assert_eq!(fs::read(&source).unwrap(), source_before);
    }

    #[tokio::test]
    async fn queued_cover_miss_reads_same_path_replacement_after_scan_gate() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let root = temp.path().join("library");
        fs::create_dir(&root).unwrap();
        let source = root.join("book.zip");
        make_archive(&source);
        let state = Arc::new(AppState::open(data, Some("secret".into())).unwrap());
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO roots VALUES('root','Library',?1,'[]',1)",
                [root.to_string_lossy().as_ref()],
            )
            .unwrap();
        let initial = crate::scanner::start(state.clone(), "root".into()).unwrap();
        wait_for_scan(&state, &initial.id).await;
        let (entry_id, old_key): (String, String) = state
            .db
            .lock()
            .unwrap()
            .query_row("SELECT id,cover_key FROM entries", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE entries SET custom_title='keep this entry' WHERE id=?1",
                [&entry_id],
            )
            .unwrap();
        fs::remove_file(state.covers_dir.join(&old_key)).unwrap();

        let permit = state.scan_gate.clone().acquire_owned().await.unwrap();
        let replacement_scan = crate::scanner::start(state.clone(), "root".into()).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let app = router(state.clone());
        let requested_key = old_key.clone();
        let request = tokio::spawn(async move {
            app.oneshot(
                Request::builder()
                    .uri(format!("/api/covers/{requested_key}"))
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        make_archive_with_width(&source, 16);
        drop(permit);

        let response = request.await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        wait_for_scan(&state, &replacement_scan.id).await;
        let (new_id, new_key, title): (String, String, String) = state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT id,cover_key,custom_title FROM entries WHERE relative_path='book.zip'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(new_id, entry_id);
        assert_ne!(new_key, old_key);
        assert_eq!(title, "keep this entry");
        assert!(!state.covers_dir.join(&old_key).exists());
        assert!(state.covers_dir.join(new_key).exists());
    }

    #[tokio::test]
    async fn stale_cached_cover_lookup_uses_transient_hash_until_rescan_commits_scan_fields() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let root = temp.path().join("library");
        fs::create_dir(&root).unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        let source = root.join("book.zip");
        make_archive_with_pages(&source, 2, 1);
        let mut state = AppState::open(data, Some("secret".into())).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = requests.clone();
        tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 2048];
                loop {
                    let count = stream.read(&mut buffer).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..count]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                observed
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&request).into_owned());
                let body = "<html><div class='nohits'>No hits found</div></html>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        state.eh = EhClient::new(&base, &base).unwrap();
        state.eh_settings.lock().unwrap().use_thumbnails = true;
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO roots VALUES('root','Library',?1,'[]',1)",
                [canonical_root.to_string_lossy().as_ref()],
            )
            .unwrap();
        let state = Arc::new(state);
        let scan = crate::scanner::start(state.clone(), "root".into()).unwrap();
        wait_for_scan(&state, &scan.id).await;
        let (entry_id, cached): (String, (i64, u64, i64, String, i64)) = state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT id,page_count,file_size,file_mtime,cover_sha1,cover_hash_version FROM entries",
                [],
                |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))),
            )
            .unwrap();

        make_archive_with_pages(&source, 16, 2);
        let new_hash = crate::cover::raw_first_sha1(&source).unwrap();
        let new_size = fs::metadata(&source).unwrap().len();
        let (status, lookup) = api(
            router(state.clone()),
            "POST",
            &format!("/api/entries/{entry_id}/eh-lookup"),
            Some(r#"{"mode":"auto"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(lookup["candidates"], json!([]));
        let requests = requests.lock().unwrap();
        assert!(
            requests[0].contains(&format!("f_shash={new_hash}")),
            "first lookup request did not use current raw hash {new_hash}: {:?}",
            *requests
        );
        assert!(requests[1].contains("f_search=%22book%22"));
        drop(requests);
        let unchanged = state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT page_count,file_size,file_mtime,cover_sha1,cover_hash_version FROM entries WHERE id=?1",
                [&entry_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(unchanged, cached);

        let rescan = crate::scanner::start(state.clone(), "root".into()).unwrap();
        wait_for_scan(&state, &rescan.id).await;
        let refreshed = state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT page_count,file_size,cover_sha1,cover_hash_version FROM entries WHERE id=?1",
                [&entry_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, u64>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)),
            )
            .unwrap();
        assert_eq!(refreshed, (2, new_size, new_hash, 1));
    }

    #[tokio::test]
    async fn explicit_cover_preview_uses_cached_hash_only_when_archive_is_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let offline_root = temp.path().join("offline-library");
        let live_root = temp.path().join("live-library");
        let moved_root = temp.path().join("offline-library-moved");
        fs::create_dir(&offline_root).unwrap();
        fs::create_dir(&live_root).unwrap();
        let offline_root = fs::canonicalize(offline_root).unwrap();
        let live_root = fs::canonicalize(live_root).unwrap();
        let changed_archive = live_root.join("book.zip");
        make_archive_with_width(&changed_archive, 16);
        let current_hash = crate::cover::raw_first_sha1(&changed_archive).unwrap();
        let cached_hash = "a".repeat(40);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = requests.clone();
        tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 1024];
                loop {
                    let count = stream.read(&mut chunk).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..count]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                observed
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&request).into_owned());
                let body = "<div class='itg'>No hits found</div>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let mut state = AppState::open(data, Some("secret".into())).unwrap();
        state.eh =
            EhClient::new(&format!("http://{address}"), &format!("http://{address}")).unwrap();
        {
            let conn = state.db.lock().unwrap();
            conn.execute(
                "INSERT INTO roots VALUES('offline','Offline',?1,'[]',0),('live','Live',?2,'[]',0)",
                params![offline_root.to_string_lossy(), live_root.to_string_lossy()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO entries(id,root_id,relative_path,title,file_size,file_mtime,cover_sha1,cover_hash_version,created_at,updated_at) VALUES('offline-entry','offline','missing.zip','Offline',100,1,?1,1,0,0),('changed-entry','live','book.zip','Changed',1,0,?1,1,0,0)",
                [&cached_hash],
            )
            .unwrap();
        }
        fs::rename(&offline_root, moved_root).unwrap();
        let state = Arc::new(state);

        let (offline_status, offline) = api(
            router(state.clone()),
            "POST",
            "/api/entries/offline-entry/eh-lookup",
            Some(r#"{"mode":"cover"}"#),
        )
        .await;
        assert_eq!(offline_status, StatusCode::OK);
        assert_eq!(offline["candidates"], json!([]));
        let (changed_status, changed) = api(
            router(state),
            "POST",
            "/api/entries/changed-entry/eh-lookup",
            Some(r#"{"mode":"cover"}"#),
        )
        .await;
        assert_eq!(changed_status, StatusCode::OK);
        assert_eq!(changed["candidates"], json!([]));

        let requests = requests.lock().unwrap();
        assert!(requests[0].contains(&format!("f_shash={cached_hash}")));
        assert!(requests[1].contains(&format!("f_shash={current_hash}")));
        assert!(!requests[1].contains(&format!("f_shash={cached_hash}")));
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
            conn.execute("INSERT INTO entry_tags VALUES('a','artist:alice','eh'),('a','language:japanese','local'),('a','female:sole female','eh'),('b','artist:alice','eh'),('b','uploader:MixedCase','eh')", []).unwrap();
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
        let (status, mixed_case_tag) = api(
            app.clone(),
            "GET",
            "/api/entries?includeTags=uploader%3Amixedcase",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(mixed_case_tag["total"], 1);
        assert_eq!(mixed_case_tag["entries"][0]["id"], "b");
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
        assert_eq!(
            value["tags"],
            json!(["artist:alice", "language:japanese", "uploader:MixedCase"])
        );
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
        let (status, preference) = api(
            app.clone(),
            "PUT",
            "/api/settings/eh",
            Some(r#"{"preferOriginalTitle":true}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(preference["preferOriginalTitle"], true);
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
        assert_eq!(value["ehTitle"], "猫 EN");
        assert_eq!(value["ehDisplayTitle"], "猫の本");
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
