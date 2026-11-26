# Henshin

Henshin is a personal desktop application for managing a household comic collection on a trusted home LAN. The collection remains in user-managed storage such as a NAS, and each device opens files through its own local or mounted path. Collection files are read-only to Henshin; reading uses an external reader.

## Design

The product design and core constraints are in [docs/design.md](docs/design.md).

## Build and run the server

The standalone Rust service is built separately from the desktop. From the repository root:

```sh
cd server
cargo build --release
./target/release/henshin-server serve \
  --data-dir /path/to/henshin-data \
  --listen 0.0.0.0:4317
```

The data directory holds the SQLite database, cover cache, lock, server ID, and bearer token. Keep it separate from collection directories. On first start, the server creates and prints a token; keep it private. Use `--listen 127.0.0.1:4317` when the server is only used from the same machine.

## Run the desktop app

From the repository root, use Node.js 24.19.0 or newer and pnpm 11 to install, build, and launch the desktop client.

```sh
pnpm install --frozen-lockfile
pnpm --filter @henshin/desktop build
pnpm --filter @henshin/desktop start
```

In Settings, enter the running server’s HTTP address and bearer token. Map a library root to its folder on this device and select a local reader to open books.

## Backup and restore

Use the server CLI to back up the application database while the server is running or stopped:

```sh
henshin-server backup --data-dir /path/to/henshin-data --out /path/to/archive.sqlite
```

The output must not already exist or be inside a configured collection root. Restore only while the server is stopped:

```sh
henshin-server restore --data-dir /path/to/henshin-data --in /path/to/archive.sqlite
```

Restore validates the backup before changing the data directory. It moves the previous database and any SQLite WAL/SHM sidecars into a `pre-restore-*` folder, then clears the derived cover cache.

The backup contains `henshin.sqlite`: configured roots, indexed entries, E-Hentai metadata and tags, personal titles, notes and tag overrides, and open history. It does not contain original comic files (use NAS backup tools), server secrets such as the bearer token or ExHentai credentials, each desktop's `desktop-config.json`, or the regenerable cover cache. Missing covers are recreated when requested or during a root scan.
