use crate::{app::AppState, roots, scanner};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

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
        .route("/api/entries/{id}", get(get_entry))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryQuery {
    root_id: Option<String>,
    status: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
}
async fn list_entries(State(s): State<Arc<AppState>>, Query(q): Query<EntryQuery>) -> Response {
    if q.status
        .as_deref()
        .is_some_and(|x| x != "active" && x != "missing")
    {
        return err(StatusCode::BAD_REQUEST, "invalid status");
    }
    let status = q.status.unwrap_or_else(|| "active".into());
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let offset = q.offset.unwrap_or(0);
    let conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
    let sql = format!(
        "SELECT {ENTRY_COLUMNS} FROM entries \
         WHERE status=?1 AND (?2 IS NULL OR root_id=?2) \
         ORDER BY created_at DESC,id ASC LIMIT ?3 OFFSET ?4"
    );
    let mut st = match conn.prepare(&sql) {
        Ok(statement) => statement,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let rows = st.query_map(params![status, q.root_id, limit, offset], entry_from_row);
    match rows.and_then(|r| r.collect::<rusqlite::Result<Vec<_>>>()) {
        Ok(entries) => {
            Json(json!({"entries":entries,"limit":limit,"offset":offset})).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
async fn get_entry(State(s): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
    let sql = format!("SELECT {ENTRY_COLUMNS} FROM entries WHERE id=?1");
    match conn.query_row(&sql, [id], entry_from_row) {
        Ok(entry) => Json(entry).into_response(),
        Err(rusqlite::Error::QueryReturnedNoRows) => err(StatusCode::NOT_FOUND, "entry not found"),
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
}
