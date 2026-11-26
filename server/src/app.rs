use crate::{db, scanner};
use rusqlite::Connection;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;

pub struct AppState {
    pub data_dir: PathBuf,
    pub covers_dir: PathBuf,
    pub token: String,
    pub server_id: String,
    pub db: Mutex<Connection>,
    pub scans: Mutex<HashMap<String, scanner::ScanState>>,
    pub scan_gate: Arc<Semaphore>,
    _lock: fs::File,
}

impl AppState {
    pub fn open(
        data_dir: PathBuf,
        supplied_token: Option<String>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        fs::create_dir_all(&data_dir)?;
        let data_dir = fs::canonicalize(data_dir)?;
        let lock_path = data_dir.join("server.lock");
        let lock = fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(lock_path)?;
        lock.try_lock()?;
        let covers_dir = data_dir.join("covers");
        fs::create_dir_all(&covers_dir)?;
        let token_path = data_dir.join("token");
        let token = if let Some(token) = supplied_token {
            if token.is_empty() {
                return Err("token must not be empty".into());
            }
            if token_path.exists() && fs::read_to_string(&token_path)?.trim_end() != token {
                return Err("configured token differs from persisted token".into());
            }
            if !token_path.exists() {
                write_private(&token_path, token.as_bytes())?;
            }
            token
        } else if token_path.exists() {
            fs::read_to_string(&token_path)?.trim_end().to_owned()
        } else {
            let token =
                uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().simple().to_string();
            write_private(&token_path, token.as_bytes())?;
            println!("Generated bearer token: {token}");
            token
        };
        let server_id_path = data_dir.join("server-id");
        let server_id = if server_id_path.exists() {
            fs::read_to_string(server_id_path)?.trim().to_owned()
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            fs::write(server_id_path, &id)?;
            id
        };
        let connection = Connection::open(data_dir.join("henshin.sqlite"))?;
        db::initialize(&connection)?;
        Ok(Self {
            data_dir,
            covers_dir,
            token,
            server_id,
            db: Mutex::new(connection),
            scans: Mutex::new(HashMap::new()),
            scan_gate: Arc::new(Semaphore::new(1)),
            _lock: lock,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_directory_lock_is_exclusive_for_the_process_lifetime() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data");
        let first = AppState::open(path.clone(), Some("secret".into())).unwrap();
        assert!(AppState::open(path.clone(), Some("secret".into())).is_err());
        drop(first);
        assert!(AppState::open(path, Some("secret".into())).is_ok());
    }
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?
        .write_all(bytes)
}
#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?
        .write_all(bytes)
}
