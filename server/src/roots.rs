use rusqlite::Connection;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn validate(
    path: &str,
    data_dir: &Path,
    conn: &Connection,
    except: Option<&str>,
) -> Result<PathBuf, String> {
    let root = fs::canonicalize(path).map_err(|_| "root directory is unavailable".to_string())?;
    if !root.is_dir() || fs::read_dir(&root).is_err() {
        return Err("root must be a readable directory".into());
    }
    if overlaps(&root, data_dir) {
        return Err("root overlaps the application data directory".into());
    }
    let mut stmt = conn
        .prepare("SELECT id, server_path FROM roots")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, path) = row.map_err(|e| e.to_string())?;
        if except == Some(id.as_str()) {
            continue;
        }
        let other = PathBuf::from(path);
        if overlaps(&root, &other) {
            return Err("root overlaps another configured root".into());
        }
    }
    Ok(root)
}

pub fn validate_snapshot(
    path: &str,
    data_dir: &Path,
    existing_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let root = fs::canonicalize(path).map_err(|_| "root directory is unavailable".to_string())?;
    if !root.is_dir() || fs::read_dir(&root).is_err() {
        return Err("root must be a readable directory".into());
    }
    if overlaps(&root, data_dir) {
        return Err("root overlaps the application data directory".into());
    }
    if existing_roots.iter().any(|other| overlaps(&root, other)) {
        return Err("root overlaps another configured root".into());
    }
    Ok(root)
}

fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_data_directory_overlap_in_both_directions_and_root_nesting() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        fs::create_dir(&data).unwrap();
        let data = fs::canonicalize(data).unwrap();
        let parent = temp.path().join("library");
        fs::create_dir(&parent).unwrap();
        let parent = fs::canonicalize(parent).unwrap();
        let nested = parent.join("nested");
        fs::create_dir(&nested).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::initialize(&conn).unwrap();
        assert!(validate(data.to_str().unwrap(), &data, &conn, None).is_err());
        assert!(validate(temp.path().to_str().unwrap(), &data, &conn, None).is_err());
        conn.execute(
            "INSERT INTO roots VALUES('r','r',?1,'[]',0)",
            [parent.to_string_lossy().as_ref()],
        )
        .unwrap();
        assert!(validate(nested.to_str().unwrap(), &data, &conn, None).is_err());
    }
}
