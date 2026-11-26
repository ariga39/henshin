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
        CREATE INDEX IF NOT EXISTS idx_open_events_entry ON open_events(entry_id,opened_at DESC);")?;
    let has_hash_version = {
        let mut statement = conn.prepare("PRAGMA table_info(entries)")?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
        columns
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "cover_hash_version")
    };
    if !has_hash_version {
        conn.execute(
            "ALTER TABLE entries ADD COLUMN cover_hash_version INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    let has_bind_source = {
        let mut statement = conn.prepare("PRAGMA table_info(entries)")?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
        columns
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "eh_bind_source")
    };
    if !has_bind_source {
        let tx = conn.unchecked_transaction()?;
        tx.execute("ALTER TABLE entries ADD COLUMN eh_bind_source TEXT CHECK(eh_bind_source IN ('auto','manual'))", [])?;
        tx.execute(
            "UPDATE entries SET eh_bind_source='manual' WHERE eh_gid IS NOT NULL",
            [],
        )?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE entries (id TEXT PRIMARY KEY, eh_gid TEXT, cover_hash_version INTEGER NOT NULL DEFAULT 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries(id,eh_gid) VALUES('bound','123'),('unbound',NULL)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn eh_bind_source_migration_marks_existing_bindings_manual() {
        let conn = legacy_connection();
        initialize(&conn).unwrap();
        let sources = conn
            .prepare("SELECT id,eh_bind_source FROM entries ORDER BY id")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            sources,
            vec![
                ("bound".into(), Some("manual".into())),
                ("unbound".into(), None)
            ]
        );
    }

    #[test]
    fn eh_bind_source_migration_rolls_back_column_if_legacy_update_fails() {
        let conn = legacy_connection();
        conn.execute_batch(
            "CREATE TRIGGER reject_legacy_bind_update BEFORE UPDATE ON entries WHEN OLD.eh_gid IS NOT NULL BEGIN SELECT RAISE(ABORT,'migration update rejected'); END;",
        )
        .unwrap();

        assert!(initialize(&conn).is_err());

        let has_bind_source: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('entries') WHERE name='eh_bind_source')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!has_bind_source);
        let gid: String = conn
            .query_row("SELECT eh_gid FROM entries WHERE id='bound'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(gid, "123");
    }
}
