use crate::{app::AppState, cover};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use walkdir::WalkDir;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanState {
    pub id: String,
    pub root_id: String,
    pub status: String,
    pub found: usize,
    pub indexed: usize,
    pub errors: Vec<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

pub fn start(state: Arc<AppState>, root_id: String) -> Result<ScanState, String> {
    let (root, excludes) = {
        let conn = state.db.lock().map_err(|_| "database lock poisoned")?;
        conn.query_row(
            "SELECT server_path, exclusions_json FROM roots WHERE id=?1",
            [&root_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("root not found")?
    };
    let mut scans = state.scans.lock().map_err(|_| "scan state lock poisoned")?;
    if scans
        .values()
        .any(|s| s.root_id == root_id && s.status == "running")
    {
        return Err("scan already running".into());
    }
    scans.retain(|_, scan| scan.root_id != root_id);
    let now = unix_now();
    let scan = ScanState {
        id: uuid::Uuid::new_v4().to_string(),
        root_id: root_id.clone(),
        status: "running".into(),
        found: 0,
        indexed: 0,
        errors: vec![],
        started_at: now,
        finished_at: None,
    };
    scans.insert(scan.id.clone(), scan.clone());
    drop(scans);
    let scan_id = scan.id.clone();
    tokio::task::spawn_blocking(move || {
        let result = run(&state, &root_id, Path::new(&root), &excludes);
        if let Ok(mut scans) = state.scans.lock() {
            if let Some(s) = scans.get_mut(&scan_id) {
                match result {
                    Ok((found, indexed, errors)) => {
                        s.found = found;
                        s.indexed = indexed;
                        s.errors = errors;
                        s.status = "completed".into();
                    }
                    Err(error) => {
                        s.errors.push(error);
                        s.status = "failed".into();
                    }
                }
                s.finished_at = Some(unix_now());
            }
        }
    });
    Ok(scan)
}

fn run(
    state: &AppState,
    root_id: &str,
    root: &Path,
    exclusions: &str,
) -> Result<(usize, usize, Vec<String>), String> {
    let _permit = state
        .scan_gate
        .blocking_acquire()
        .map_err(|_| "scan gate closed")?;
    if !root.is_dir() || fs::read_dir(root).is_err() {
        return Err("root directory is unavailable".into());
    }
    let excludes: HashSet<String> =
        serde_json::from_str(exclusions).map_err(|_| "invalid root exclusions")?;
    let mut archives = Vec::new();
    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            !(entry.depth() > 0
                && entry.file_type().is_dir()
                && excludes.contains(&entry.file_name().to_string_lossy().into_owned()))
        });
    for item in walker {
        let item = item.map_err(|e| format!("root traversal failed: {e}"))?;
        if item.file_type().is_file()
            && item
                .path()
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("zip"))
        {
            archives.push(item.into_path());
        }
    }
    archives.sort();
    let mut seen = HashSet::new();
    let mut errors = Vec::new();
    let mut indexed = 0;
    for path in &archives {
        let relative = relative_path(root, path)?;
        seen.insert(relative.clone());
        match process_one(state, root_id, path, &relative) {
            Ok(changed) => {
                if changed {
                    indexed += 1
                }
            }
            Err(e) => errors.push(format!("archive skipped: {e}")),
        }
    }
    let conn = state.db.lock().map_err(|_| "database lock poisoned")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut stmt = tx
        .prepare("SELECT relative_path,cover_key FROM entries WHERE root_id=?1 AND status='active'")
        .map_err(|e| e.to_string())?;
    let existing = stmt
        .query_map([root_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (relative, cover_key) in existing {
        if !seen.contains(&relative) {
            tx.execute("UPDATE entries SET status='missing',updated_at=?1 WHERE root_id=?2 AND relative_path=?3",params![unix_now(),root_id,relative]).map_err(|e|e.to_string())?;
            if let Some(key) = cover_key {
                let _ = fs::remove_file(state.covers_dir.join(key));
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok((archives.len(), indexed, errors))
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|e| e.to_string())?
        .components()
        .map(|component| match component {
            std::path::Component::Normal(name) => name
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| "archive path is not UTF-8".to_string()),
            _ => Err("archive path contains an unexpected component".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join("/"))
}

fn process_one(
    state: &AppState,
    root_id: &str,
    path: &Path,
    relative: &str,
) -> Result<bool, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let size = metadata.len();
    let modified = metadata
        .modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let title = PathBuf::from(relative)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("archive filename is not UTF-8")?
        .to_owned();
    let (id, old_cover, skip) = {
        let conn = state.db.lock().map_err(|_| "database lock poisoned")?;
        let old=conn.query_row("SELECT id,cover_key,status,file_size,file_mtime FROM entries WHERE root_id=?1 AND relative_path=?2",params![root_id,relative],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<u64>>(3)?,r.get::<_,Option<i64>>(4)?))).optional().map_err(|e|e.to_string())?;
        if let Some((id, key, status, old_size, old_time)) = old {
            let intact = key
                .as_ref()
                .is_some_and(|k| state.covers_dir.join(k).is_file());
            (
                id,
                key,
                status == "active"
                    && old_size == Some(size)
                    && old_time == Some(modified)
                    && intact,
            )
        } else {
            (uuid::Uuid::new_v4().to_string(), None, false)
        }
    };
    if skip {
        return Ok(false);
    }
    let cover = cover::extract(path, &state.covers_dir, &id, modified, size)?;
    let now = unix_now();
    let conn = state.db.lock().map_err(|_| "database lock poisoned")?;
    conn.execute("INSERT INTO entries(id,root_id,relative_path,status,title,page_count,file_size,file_mtime,cover_key,cover_sha1,created_at,updated_at) VALUES(?1,?2,?3,'active',?4,?5,?6,?7,?8,?9,?10,?10) ON CONFLICT(root_id,relative_path) DO UPDATE SET status='active',title=excluded.title,page_count=excluded.page_count,file_size=excluded.file_size,file_mtime=excluded.file_mtime,cover_key=excluded.cover_key,cover_sha1=excluded.cover_sha1,updated_at=excluded.updated_at",params![id,root_id,relative,title,cover.pages as i64,size,modified,cover.key,cover.sha1,now]).map_err(|e|e.to_string())?;
    drop(conn);
    if let Some(old) = old_cover {
        if old != cover.key {
            let _ = fs::remove_file(state.covers_dir.join(old));
        }
    }
    Ok(true)
}

pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    use sha1::Digest;
    use std::io::{Read, Write};
    use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

    fn archive(path: &Path, pages: &[(&str, [u8; 3])]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        for (name, color) in pages {
            let image = image::DynamicImage::ImageRgb8(ImageBuffer::from_pixel(2, 2, Rgb(*color)));
            let mut bytes = Vec::new();
            image
                .write_to(
                    &mut std::io::Cursor::new(&mut bytes),
                    image::ImageFormat::Png,
                )
                .unwrap();
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn replacement_missing_and_reappearance_preserve_identity_and_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let root = temp.path().join("library");
        fs::create_dir(&root).unwrap();
        let book = root.join("book.zip");
        archive(&book, &[("10.png", [0, 0, 255]), ("2.png", [255, 0, 0])]);
        let state = AppState::open(data, None).unwrap();
        let conn = state.db.lock().unwrap();
        conn.execute(
            "INSERT INTO roots VALUES('root','root',?1,'[]',0)",
            [root.to_string_lossy().as_ref()],
        )
        .unwrap();
        drop(conn);
        assert!(process_one(&state, "root", &book, "book.zip").unwrap());
        let conn = state.db.lock().unwrap();
        let (id, key, hash, pages): (String, String, String, i64) = conn
            .query_row(
                "SELECT id,cover_key,cover_sha1,page_count FROM entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(pages, 2);
        let mut z = ZipArchive::new(fs::File::open(&book).unwrap()).unwrap();
        let mut raw = Vec::new();
        z.by_name("2.png").unwrap().read_to_end(&mut raw).unwrap();
        assert_eq!(hash, hex::encode(sha1::Sha1::digest(&raw)));
        conn.execute("UPDATE entries SET custom_title='kept',note='kept',eh_gid='g',eh_token='t',eh_domain='e-hentai.org',open_count=7,last_opened_at=9 WHERE id=?1",[&id]).unwrap();
        conn.execute(
            "INSERT INTO entry_tags VALUES(?1,'artist:kept','local')",
            [&id],
        )
        .unwrap();
        drop(conn);
        std::thread::sleep(std::time::Duration::from_millis(1100));
        archive(
            &book,
            &[
                ("1.png", [0, 255, 0]),
                ("2.png", [0, 0, 0]),
                ("3.png", [50, 50, 50]),
            ],
        );
        assert!(process_one(&state, "root", &book, "book.zip").unwrap());
        {
            let c = state.db.lock().unwrap();
            let (new_id, new_key, pages, title, note, gid, count, last_opened): (
                String, String, i64, String, String, String, i64, i64,
            ) = c
                .query_row(
                    "SELECT id,cover_key,page_count,custom_title,note,eh_gid,open_count,last_opened_at FROM entries",
                    [],
                    |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)),
                )
                .unwrap();
            assert_eq!(new_id, id);
            assert_ne!(new_key, key);
            assert_eq!(pages, 3);
            assert_eq!(
                (title.as_str(), note.as_str(), gid.as_str(), count),
                ("kept", "kept", "g", 7)
            );
            assert_eq!(last_opened, 9);
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM entry_tags WHERE entry_id=?1",
                    [&id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
        }
        fs::remove_file(&book).unwrap();
        assert!(run(&state, "root", &root, "[]").is_ok());
        assert_eq!(
            state
                .db
                .lock()
                .unwrap()
                .query_row("SELECT status FROM entries", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "missing"
        );
        archive(&book, &[("1.png", [1, 2, 3])]);
        assert!(run(&state, "root", &root, "[]").is_ok());
        assert_eq!(
            state
                .db
                .lock()
                .unwrap()
                .query_row("SELECT status FROM entries", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "active"
        );
        fs::remove_dir_all(&root).unwrap();
        assert!(run(&state, "root", &root, "[]").is_err());
        assert_eq!(
            state
                .db
                .lock()
                .unwrap()
                .query_row("SELECT status FROM entries", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "active"
        );
    }

    #[test]
    fn exclusions_are_applied_before_walking() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let root = temp.path().join("library");
        fs::create_dir_all(root.join("skip")).unwrap();
        archive(&root.join("skip/a.zip"), &[("1.png", [1, 2, 3])]);
        let state = AppState::open(data, None).unwrap();
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO roots VALUES('root','root',?1,'[\"skip\"]',0)",
                [root.to_string_lossy().as_ref()],
            )
            .unwrap();
        let (found, indexed, _) = run(&state, "root", &root, "[\"skip\"]").unwrap();
        assert_eq!((found, indexed), (0, 0));
    }
}
