use rusqlite::{Connection, OpenFlags, params};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

pub fn create(data_dir: &Path, output: &Path) -> io::Result<()> {
    let data_dir = fs::canonicalize(data_dir)?;
    let database = data_dir.join("henshin.sqlite");
    if !fs::metadata(&database)?.is_file() {
        return Err(invalid("henshin.sqlite is not a regular file"));
    }
    let name = output
        .file_name()
        .ok_or_else(|| invalid("output must name a file"))?;
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let canonical_parent = fs::canonicalize(parent)?;
    let destination = canonical_parent.join(name);
    let destination_text = destination
        .to_str()
        .ok_or_else(|| invalid("backup output path must be valid UTF-8"))?;
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "backup output already exists",
        ));
    }
    for suffix in ["", "-wal", "-shm"] {
        if destination == PathBuf::from(format!("{}{}", database.display(), suffix)) {
            return Err(invalid(
                "backup output cannot replace the live database or its sidecars",
            ));
        }
    }

    let connection = Connection::open(&database).map_err(sql_error)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(sql_error)?;
    let mut roots = connection
        .prepare("SELECT server_path FROM roots")
        .map_err(sql_error)?;
    let rows = roots
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sql_error)?;
    for row in rows {
        let path = PathBuf::from(row.map_err(sql_error)?);
        let root = fs::canonicalize(&path).unwrap_or(path);
        if destination.starts_with(root) {
            return Err(invalid(
                "backup output cannot be inside a configured collection root",
            ));
        }
    }
    let covers_dir = resolve_path(&data_dir.join("covers"))?;
    if destination.starts_with(covers_dir) {
        return Err(invalid("backup output cannot be inside the cover cache"));
    }
    drop(roots);

    // Reserve the destination atomically without overwriting existing output.
    let reservation = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)?;
    drop(reservation);
    let result = connection
        .execute("VACUUM INTO ?1", params![destination_text])
        .map_err(sql_error);
    if let Err(error) = result {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }
    Ok(())
}

pub fn restore(data_dir: &Path, input: &Path) -> io::Result<()> {
    let input_location = resolve_entry_path(input)?;
    let input = fs::canonicalize(input)?;
    if !fs::metadata(&input)?.is_file() {
        return Err(invalid("backup input is not a regular file"));
    }
    let roots = collection_roots(&input)?;
    let requested_data_dir = resolve_path(data_dir)?;
    let covers_dir = resolve_path(&requested_data_dir.join("covers"))?;
    if input.starts_with(&covers_dir) || input_location.starts_with(&covers_dir) {
        return Err(invalid("restore input cannot be inside the cover cache"));
    }
    for root in roots {
        if requested_data_dir.starts_with(&root) || root.starts_with(&requested_data_dir) {
            return Err(invalid(
                "restore data directory cannot overlap a collection root recorded in the backup",
            ));
        }
    }

    fs::create_dir_all(data_dir)?;
    let data_dir = fs::canonicalize(data_dir)?;
    let lock = crate::app::acquire_data_dir_lock(&data_dir).map_err(|error| {
        if error.kind() == io::ErrorKind::WouldBlock {
            invalid("henshin-server or another administrative command is using this data directory; stop it before restoring")
        } else {
            error
        }
    })?;
    let database = data_dir.join("henshin.sqlite");
    if input == database {
        return Err(invalid("backup input cannot be the live database"));
    }

    let stage = data_dir.join(format!(".restore-{}.sqlite", uuid::Uuid::new_v4()));
    fs::copy(&input, &stage)?;
    let validation = validate_backup(&stage).and_then(|()| initialize_database(&stage));
    if let Err(error) = validation {
        remove_staged(&stage);
        return Err(error);
    }

    if database.exists() {
        // A damaged current database must not prevent recovery; the old set is
        // moved intact after a best-effort checkpoint.
        if let Ok(connection) = Connection::open(&database) {
            if let Err(error) = connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
                tracing::warn!(%error, "could not checkpoint existing database before restore");
            }
            drop(connection);
        }
    }

    let has_old_files = [
        &database,
        &sidecar(&database, "-wal"),
        &sidecar(&database, "-shm"),
    ]
    .iter()
    .any(|path| fs::symlink_metadata(path).is_ok());
    if has_old_files {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let archive = data_dir.join(format!(
            "pre-restore-{stamp}-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        fs::create_dir(&archive)?;
        for old in [
            &database,
            &sidecar(&database, "-wal"),
            &sidecar(&database, "-shm"),
        ] {
            if fs::symlink_metadata(old).is_ok() {
                let name = old
                    .file_name()
                    .ok_or_else(|| invalid("invalid database path"))?;
                fs::rename(old, archive.join(name))?;
            }
        }
    }
    fs::rename(&stage, &database).map_err(|error| {
        remove_staged(&stage);
        error
    })?;
    clear_covers(&data_dir.join("covers"))?;
    drop(lock);
    Ok(())
}

fn resolve_entry_path(path: &Path) -> io::Result<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| invalid("path must name a file"))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    Ok(fs::canonicalize(parent)?.join(name))
}

fn collection_roots(input: &Path) -> io::Result<Vec<PathBuf>> {
    let connection =
        Connection::open_with_flags(input, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(sql_error)?;
    let mut statement = connection
        .prepare("SELECT server_path FROM roots")
        .map_err(sql_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sql_error)?;
    rows.map(|row| resolve_path(Path::new(&row.map_err(sql_error)?)))
        .collect()
}

fn resolve_path(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::Prefix(prefix) => resolved.push(prefix.as_os_str()),
            std::path::Component::RootDir => resolved.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                resolved.pop();
                if let Ok(canonical) = fs::canonicalize(&resolved) {
                    resolved = canonical;
                }
            }
            std::path::Component::Normal(name) => {
                resolved.push(name);
                if let Ok(canonical) = fs::canonicalize(&resolved) {
                    resolved = canonical;
                }
            }
        }
    }
    Ok(resolved)
}

fn initialize_database(path: &Path) -> io::Result<()> {
    let connection = Connection::open(path).map_err(sql_error)?;
    crate::db::initialize(&connection).map_err(sql_error)?;
    drop(connection);
    remove_staged_sidecars(path);
    Ok(())
}

fn clear_covers(covers: &Path) -> io::Result<()> {
    match fs::symlink_metadata(covers) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            remove_symlink_or_file(covers)?;
            fs::create_dir(covers)?;
        }
        Ok(_) => {
            for item in fs::read_dir(covers)? {
                let path = item?.path();
                let metadata = fs::symlink_metadata(&path)?;
                if metadata.is_dir() && !metadata.file_type().is_symlink() {
                    fs::remove_dir_all(path)?;
                } else if metadata.file_type().is_symlink() {
                    remove_symlink_or_file(&path)?;
                } else {
                    fs::remove_file(path)?;
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs::create_dir(covers)?,
        Err(error) => return Err(error),
    }
    Ok(())
}

fn remove_symlink_or_file(path: &Path) -> io::Result<()> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(directory_error) => fs::remove_file(path).or(Err(directory_error)),
    }
}

fn validate_backup(path: &Path) -> io::Result<()> {
    let connection = Connection::open(path).map_err(sql_error)?;
    let mut check = connection
        .prepare("PRAGMA integrity_check")
        .map_err(sql_error)?;
    let rows = check
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sql_error)?;
    let results = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql_error)?;
    if results.as_slice() != ["ok"] {
        return Err(invalid("backup failed SQLite integrity_check"));
    }
    for projection in [
        "SELECT id,label,server_path,exclusions_json,created_at FROM roots LIMIT 0",
        "SELECT id,root_id,relative_path,status,title,custom_title,note,page_count,file_size,file_mtime,cover_key,cover_sha1,eh_gid,eh_token,eh_domain,eh_title,eh_title_jpn,eh_refreshed_at,eh_error,open_count,last_opened_at,created_at,updated_at FROM entries LIMIT 0",
        "SELECT entry_id,tag,origin FROM entry_tags LIMIT 0",
        "SELECT id,entry_id,opened_at FROM open_events LIMIT 0",
    ] {
        connection.prepare(projection).map_err(sql_error)?;
    }
    drop(check);
    drop(connection);
    remove_staged_sidecars(path);
    Ok(())
}

fn remove_staged(path: &Path) {
    let _ = fs::remove_file(path);
    remove_staged_sidecars(path);
}

fn remove_staged_sidecars(path: &Path) {
    for suffix in ["-wal", "-shm"] {
        let _ = fs::remove_file(sidecar(path, suffix));
    }
}

fn sidecar(database: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{}", database.display(), suffix))
}

fn sql_error(error: rusqlite::Error) -> io::Error {
    io::Error::other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::AppState;

    fn add_entry(conn: &Connection, title: &str) {
        conn.execute(
            "INSERT INTO roots VALUES('root','Library','/library','[]',1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO entries(id,root_id,relative_path,title,created_at,updated_at) VALUES('entry','root','book.zip',?1,1,1)", [title]).unwrap();
        conn.execute(
            "INSERT INTO entry_tags VALUES('entry','artist:test','eh')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO open_events VALUES('event','entry',2)", [])
            .unwrap();
    }

    #[test]
    fn backup_works_while_server_holds_lock_and_refuses_existing_or_collection_outputs() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let library = temp.path().join("library");
        fs::create_dir(&library).unwrap();
        let state = AppState::open(data.clone(), Some("secret".into())).unwrap();
        add_entry(&state.db.lock().unwrap(), "current");
        // This insert remains in the WAL while AppState owns the connection.
        state
            .db
            .lock()
            .unwrap()
            .execute("UPDATE entries SET title='wal value' WHERE id='entry'", [])
            .unwrap();
        let output = temp.path().join("snapshot.sqlite");
        create(&data, &output).unwrap();
        let snapshot = Connection::open(&output).unwrap();
        let title: String = snapshot
            .query_row("SELECT title FROM entries WHERE id='entry'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "wal value");

        let existing = temp.path().join("existing.sqlite");
        fs::write(&existing, b"keep me").unwrap();
        assert_eq!(
            create(&data, &existing).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(existing).unwrap(), b"keep me");
        let cached_backup = state.covers_dir.join("requested.sqlite");
        assert!(create(&data, &cached_backup).is_err());
        assert!(!cached_backup.exists());

        state
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE roots SET server_path=?1",
                [library.to_string_lossy().as_ref()],
            )
            .unwrap();
        let inside = library.join("snapshot.sqlite");
        assert!(create(&data, &inside).is_err());
        assert!(!inside.exists());
        let nested = library.join("nested");
        fs::create_dir(&nested).unwrap();
        assert!(create(&data, &nested.join("snapshot.sqlite")).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let alias = temp.path().join("library-alias");
            symlink(&library, &alias).unwrap();
            assert!(create(&data, &alias.join("snapshot.sqlite")).is_err());
        }
        assert!(create(&data, &data.join("henshin.sqlite")).is_err());
        drop(state);
    }

    #[test]
    fn failed_restore_preserves_live_database_and_cache_and_live_restore_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let state = AppState::open(data.clone(), Some("secret".into())).unwrap();
        add_entry(&state.db.lock().unwrap(), "keep");
        fs::write(data.join("covers/old.jpg"), b"cover").unwrap();
        let bad = temp.path().join("broken.sqlite");
        fs::write(&bad, b"not sqlite").unwrap();
        assert!(restore(&data, &bad).is_err());
        let other = temp.path().join("other.sqlite");
        Connection::open(&other).unwrap();
        assert!(restore(&data, &other).is_err());
        assert_eq!(
            state
                .db
                .lock()
                .unwrap()
                .query_row("SELECT title FROM entries WHERE id='entry'", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "keep"
        );
        assert_eq!(fs::read(data.join("covers/old.jpg")).unwrap(), b"cover");
        let valid = temp.path().join("valid.sqlite");
        create(&data, &valid).unwrap();
        assert!(
            restore(&data, &valid)
                .unwrap_err()
                .to_string()
                .contains("stop it before restoring")
        );
        drop(state);
    }

    #[test]
    fn restore_installs_validated_copy_and_archives_old_database_files() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let state = AppState::open(source.clone(), Some("secret".into())).unwrap();
        add_entry(&state.db.lock().unwrap(), "restored");
        state.db.lock().unwrap().execute("UPDATE entries SET custom_title='personal',note='note',open_count=3,last_opened_at=2 WHERE id='entry'", []).unwrap();
        let backup = temp.path().join("archive.sqlite");
        create(&source, &backup).unwrap();
        drop(state);

        let target = temp.path().join("target");
        let old = AppState::open(target.clone(), Some("target-secret".into())).unwrap();
        add_entry(&old.db.lock().unwrap(), "old");
        fs::write(target.join("covers/old.jpg"), b"old cover").unwrap();
        drop(old);
        fs::write(target.join("henshin.sqlite"), b"damaged live database").unwrap();
        fs::write(target.join("henshin.sqlite-wal"), b"stale wal").unwrap();
        fs::write(target.join("henshin.sqlite-shm"), b"stale shm").unwrap();
        let original = fs::read(&backup).unwrap();
        restore(&target, &backup).unwrap();

        let db = Connection::open(target.join("henshin.sqlite")).unwrap();
        assert_eq!(
            db.query_row("SELECT title FROM entries WHERE id='entry'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
            "restored"
        );
        assert_eq!(
            db.query_row(
                "SELECT custom_title FROM entries WHERE id='entry'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "personal"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM open_events", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM entry_tags WHERE origin='eh'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        drop(db);
        assert!(!target.join("covers/old.jpg").exists());
        assert_eq!(fs::read(target.join("token")).unwrap(), b"target-secret");
        assert!(!target.join("henshin.sqlite-wal").exists());
        assert!(!target.join("henshin.sqlite-shm").exists());
        assert_eq!(fs::read(&backup).unwrap(), original);
        let archived = fs::read_dir(&target)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("pre-restore-")
            })
            .unwrap();
        assert!(archived.join("henshin.sqlite").exists());
        assert_eq!(
            fs::read(archived.join("henshin.sqlite")).unwrap(),
            b"damaged live database"
        );
        for suffix in ["-wal", "-shm"] {
            if archived.join(format!("henshin.sqlite{suffix}")).exists() {
                assert!(!target.join(format!("henshin.sqlite{suffix}")).exists());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn restore_removes_a_covers_symlink_without_touching_its_collection_sentinel() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let state = AppState::open(source.clone(), Some("source-secret".into())).unwrap();
        let archive = temp.path().join("archive.sqlite");
        create(&source, &archive).unwrap();
        drop(state);
        for suffix in ["-wal", "-shm"] {
            assert!(!sidecar(&archive, suffix).exists());
        }

        let collection = temp.path().join("collection");
        fs::create_dir(&collection).unwrap();
        let sentinel = collection.join("preserve.txt");
        fs::write(&sentinel, b"collection sentinel").unwrap();
        let target = temp.path().join("target");
        fs::create_dir(&target).unwrap();
        symlink(&collection, target.join("covers")).unwrap();

        restore(&target, &archive).unwrap();
        assert_eq!(fs::read(&sentinel).unwrap(), b"collection sentinel");
        assert!(
            !fs::symlink_metadata(target.join("covers"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(target.join("covers").is_dir());
        for suffix in ["-wal", "-shm"] {
            assert!(!sidecar(&archive, suffix).exists());
        }
    }

    #[test]
    fn restore_rejects_a_data_dir_inside_an_input_collection_root_before_creating_it() {
        let temp = tempfile::tempdir().unwrap();
        let library = temp.path().join("collection");
        fs::create_dir(&library).unwrap();
        let sentinel = library.join("preserve.txt");
        fs::write(&sentinel, b"collection sentinel").unwrap();
        let source = temp.path().join("source");
        let state = AppState::open(source.clone(), Some("source-secret".into())).unwrap();
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO roots VALUES('root','Library',?1,'[]',1)",
                [library.to_string_lossy().as_ref()],
            )
            .unwrap();
        let archive = temp.path().join("archive.sqlite");
        create(&source, &archive).unwrap();
        drop(state);
        let data_dir = library.join("not-created/nested");

        assert!(restore(&data_dir, &archive).is_err());
        assert!(!library.join("not-created").exists());
        assert_eq!(fs::read(&sentinel).unwrap(), b"collection sentinel");
        assert!(!library.join("server.lock").exists());
        for suffix in ["-wal", "-shm"] {
            assert!(!sidecar(&archive, suffix).exists());
        }
    }

    #[test]
    fn restore_rejects_an_input_in_covers_without_removing_the_backup_or_live_data() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let state = AppState::open(data.clone(), Some("target-secret".into())).unwrap();
        add_entry(&state.db.lock().unwrap(), "keep");
        fs::write(state.covers_dir.join("sentinel.jpg"), b"cache sentinel").unwrap();
        let source = temp.path().join("source");
        let source_state = AppState::open(source.clone(), Some("source-secret".into())).unwrap();
        add_entry(&source_state.db.lock().unwrap(), "restored");
        let archive = temp.path().join("archive.sqlite");
        create(&source, &archive).unwrap();
        let cached_input = state.covers_dir.join("input.sqlite");
        fs::copy(&archive, &cached_input).unwrap();
        let archive_before = fs::read(&cached_input).unwrap();

        assert!(restore(&data, &cached_input).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let cached_link = state.covers_dir.join("archive-link.sqlite");
            symlink(&archive, &cached_link).unwrap();
            assert!(restore(&data, &cached_link).is_err());
            assert!(cached_link.exists());
        }
        assert_eq!(fs::read(&cached_input).unwrap(), archive_before);
        assert_eq!(
            state
                .db
                .lock()
                .unwrap()
                .query_row("SELECT title FROM entries WHERE id='entry'", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "keep"
        );
        assert_eq!(
            fs::read(state.covers_dir.join("sentinel.jpg")).unwrap(),
            b"cache sentinel"
        );
        drop(source_state);
        drop(state);
    }

    #[test]
    fn restore_rejects_roots_overlapping_data_dir_and_preserves_both_sides() {
        for root_is_inside_data in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let data = if root_is_inside_data {
                temp.path().join("data")
            } else {
                temp.path().join("collection/data")
            };
            let target = AppState::open(data.clone(), Some("target-secret".into())).unwrap();
            add_entry(&target.db.lock().unwrap(), "keep");
            let root = if root_is_inside_data {
                target.covers_dir.join("collection")
            } else {
                temp.path().join("collection")
            };
            fs::create_dir_all(&root).unwrap();
            let sentinel = root.join("preserve.txt");
            fs::write(&sentinel, b"collection sentinel").unwrap();

            let source = temp.path().join("source");
            let source_state =
                AppState::open(source.clone(), Some("source-secret".into())).unwrap();
            source_state
                .db
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO roots VALUES('root','Library',?1,'[]',1)",
                    [root.to_string_lossy().as_ref()],
                )
                .unwrap();
            let archive = temp.path().join("archive.sqlite");
            create(&source, &archive).unwrap();
            let archive_before = fs::read(&archive).unwrap();

            assert!(restore(&data, &archive).is_err());
            assert_eq!(fs::read(&archive).unwrap(), archive_before);
            assert_eq!(fs::read(&sentinel).unwrap(), b"collection sentinel");
            assert_eq!(
                target
                    .db
                    .lock()
                    .unwrap()
                    .query_row("SELECT title FROM entries WHERE id='entry'", [], |row| {
                        row.get::<_, String>(0)
                    })
                    .unwrap(),
                "keep"
            );
            drop(source_state);
            drop(target);
        }
    }

    #[cfg(unix)]
    #[test]
    fn backup_rejects_non_utf8_output_without_reserving_a_file() {
        use std::os::unix::ffi::OsStringExt;

        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let _state = AppState::open(data.clone(), Some("secret".into())).unwrap();
        let output = temp.path().join(std::ffi::OsString::from_vec(
            b"archive-\xff.sqlite".to_vec(),
        ));

        assert!(create(&data, &output).is_err());
        assert!(!output.exists());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }
}
