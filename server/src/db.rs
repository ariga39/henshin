use rusqlite::{Connection, functions::FunctionFlags};
use unicode_normalization::UnicodeNormalization;

pub fn normalize_text(value: &str) -> String {
    value.nfkc().collect::<String>().to_lowercase()
}

pub fn initialize(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.create_scalar_function(
        "norm_text",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            Ok(ctx
                .get::<Option<String>>(0)?
                .map_or_else(String::new, |value| normalize_text(&value)))
        },
    )?;
    conn.create_scalar_function(
        "path_basename",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            Ok(ctx
                .get::<Option<String>>(0)?
                .and_then(|value| value.rsplit('/').next().map(str::to_owned))
                .unwrap_or_default())
        },
    )?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS roots (id TEXT PRIMARY KEY, label TEXT NOT NULL, server_path TEXT NOT NULL UNIQUE, exclusions_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE, relative_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','missing')), title TEXT NOT NULL, custom_title TEXT, note TEXT NOT NULL DEFAULT '', page_count INTEGER NOT NULL DEFAULT 0, file_size INTEGER, file_mtime INTEGER, cover_key TEXT, cover_sha1 TEXT, eh_gid TEXT, eh_token TEXT, eh_domain TEXT, eh_title TEXT, eh_title_jpn TEXT, eh_refreshed_at INTEGER, eh_error TEXT, open_count INTEGER NOT NULL DEFAULT 0, last_opened_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(root_id, relative_path));
        CREATE TABLE IF NOT EXISTS entry_tags (entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, tag TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('eh','local','hidden')), PRIMARY KEY(entry_id,tag,origin));
        CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag,origin,entry_id);
        CREATE TABLE IF NOT EXISTS open_events (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, opened_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_open_events_entry ON open_events(entry_id,opened_at DESC);")
}
