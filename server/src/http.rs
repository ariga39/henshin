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
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

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
    match conn.execute("INSERT INTO roots(id,label,server_path,exclusions_json,created_at) VALUES(?1,?2,?3,?4,?5)",params![id,input.label,path.to_string_lossy(),exclusions,now()]){Ok(_)=>(StatusCode::CREATED,Json(json!({"id":id,"label":input.label,"serverPath":path,"exclusions":input.exclusions}))).into_response(),Err(e)=>err(StatusCode::BAD_REQUEST,e.to_string())}
}
async fn list_roots(State(s): State<Arc<AppState>>) -> Response {
    let conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
    match conn.prepare("SELECT id,label,server_path,exclusions_json,created_at FROM roots ORDER BY created_at,id").and_then(|mut st|st.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"label":r.get::<_,String>(1)?,"serverPath":r.get::<_,String>(2)?,"exclusions":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(json!([])),"createdAt":r.get::<_,i64>(4)?}))).and_then(|rows|rows.collect::<rusqlite::Result<Vec<_>>>())){Ok(v)=>Json(json!({"roots":v})).into_response(),Err(e)=>err(StatusCode::INTERNAL_SERVER_ERROR,e.to_string())}
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
    let exclusions = serde_json::to_string(
        &input
            .exclusions
            .unwrap_or_else(|| serde_json::from_str(&old_exclusions).unwrap_or_default()),
    )
    .unwrap_or(old_exclusions);
    match conn.execute("UPDATE roots SET label=?1,exclusions_json=?2 WHERE id=?3",params![label,exclusions,id]){Ok(_)=>Json(json!({"id":id,"label":label,"serverPath":path,"exclusions":serde_json::from_str::<Value>(&exclusions).unwrap_or(json!([]))})).into_response(),Err(e)=>err(StatusCode::INTERNAL_SERVER_ERROR,e.to_string())}
}
async fn delete_root(State(s): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let conn = match s.db.lock() {
        Ok(c) => c,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    };
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
    let mut st=match conn.prepare("SELECT id,root_id,relative_path,status,title,custom_title,note,page_count,file_size,file_mtime,cover_key,cover_sha1,eh_gid,eh_token,eh_domain,eh_title,eh_title_jpn,eh_refreshed_at,eh_error,open_count,last_opened_at,created_at,updated_at FROM entries WHERE status=?1 AND (?2 IS NULL OR root_id=?2) ORDER BY created_at DESC,id ASC LIMIT ?3 OFFSET ?4"){Ok(s)=>s,Err(e)=>return err(StatusCode::INTERNAL_SERVER_ERROR,e.to_string())};
    let rows = st.query_map(params![status, q.root_id, limit, offset], entry_json);
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
    match conn.query_row("SELECT id,root_id,relative_path,status,title,custom_title,note,page_count,file_size,file_mtime,cover_key,cover_sha1,eh_gid,eh_token,eh_domain,eh_title,eh_title_jpn,eh_refreshed_at,eh_error,open_count,last_opened_at,created_at,updated_at FROM entries WHERE id=?1",[id],entry_json){Ok(entry)=>Json(entry).into_response(),Err(rusqlite::Error::QueryReturnedNoRows)=>err(StatusCode::NOT_FOUND,"entry not found"),Err(e)=>err(StatusCode::INTERNAL_SERVER_ERROR,e.to_string())}
}
fn entry_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"rootId":r.get::<_,String>(1)?,"relativePath":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"title":r.get::<_,String>(4)?,"customTitle":r.get::<_,Option<String>>(5)?,"note":r.get::<_,String>(6)?,"pageCount":r.get::<_,i64>(7)?,"fileSize":r.get::<_,Option<i64>>(8)?,"fileMtime":r.get::<_,Option<i64>>(9)?,"coverKey":r.get::<_,Option<String>>(10)?,"coverSha1":r.get::<_,Option<String>>(11)?,"ehGid":r.get::<_,Option<String>>(12)?,"ehToken":r.get::<_,Option<String>>(13)?,"ehDomain":r.get::<_,Option<String>>(14)?,"ehTitle":r.get::<_,Option<String>>(15)?,"ehTitleJpn":r.get::<_,Option<String>>(16)?,"ehRefreshedAt":r.get::<_,Option<i64>>(17)?,"ehError":r.get::<_,Option<String>>(18)?,"openCount":r.get::<_,i64>(19)?,"lastOpenedAt":r.get::<_,Option<i64>>(20)?,"createdAt":r.get::<_,i64>(21)?,"updatedAt":r.get::<_,i64>(22)?}),
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenInput {
    event_id: String,
    opened_at: i64,
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
        if let Err(e)=tx.execute("UPDATE entries SET open_count=open_count+1,last_opened_at=?1,updated_at=?1 WHERE id=?2",params![input.opened_at,id]){return err(StatusCode::INTERNAL_SERVER_ERROR,e.to_string())}
    }
    match tx.query_row(
        "SELECT open_count,last_opened_at FROM entries WHERE id=?1",
        [id],
        |r| Ok(json!({"openCount":r.get::<_,i64>(0)?,"lastOpenedAt":r.get::<_,Option<i64>>(1)?})),
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
    fn open_event_is_idempotent() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::initialize(&c).unwrap();
        c.execute("INSERT INTO roots VALUES('r','r','/r','[]',0)", [])
            .unwrap();
        c.execute("INSERT INTO entries(id,root_id,relative_path,title,created_at,updated_at) VALUES('e','r','a.zip','a',0,0)",[]).unwrap();
        for _ in 0..2 {
            c.execute(
                "INSERT OR IGNORE INTO open_events VALUES('event','e',12)",
                [],
            )
            .unwrap();
        }
        let n = c
            .query_row("SELECT count(*) FROM open_events", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(n, 1);
    }
}
