# Henshin

Henshin is a personal desktop application for managing a household comic collection on a trusted home LAN. The collection remains in user-managed storage such as a NAS, and each device opens files through its own local or mounted path. Collection files are read-only to Henshin; reading uses an external reader.

## Design

The product design and core constraints are in [docs/design.md](docs/design.md).

## Build and run the server

The standalone Rust service is built separately from the desktop. From the repository root:

```sh
cd server
cargo build --release --locked
./target/release/henshin-server serve \
  --data-dir /path/to/henshin-data \
  --listen 0.0.0.0:4317
```

The data directory holds the SQLite database, cover cache, lock, server ID, and bearer token. Keep it separate from collection directories. On first start, the server creates and prints a token; keep it private. Use `--listen 127.0.0.1:4317` when the server is only used from the same machine.

## Build standalone packages

Package the server and desktop separately on each target's native operating system and architecture. The package commands keep the manifest versions unchanged and write archives and SHA256 sidecars under `dist/release/`.

```sh
node scripts/package-server.mjs
pnpm install --frozen-lockfile
pnpm --filter @henshin/desktop package
```

The server archive contains `henshin-server` (or `henshin-server.exe`) and this README. The desktop archive contains the Electron app and bundled desktop files; it does not contain `henshin-server`. Both package commands extract their result to a temporary directory and smoke-test the extracted runtime. The server smoke checks `--help` and authenticated `/api/health`; the desktop smoke launches the packaged app with a temporary user-data directory. The macOS server package also checks dynamic linkage. Desktop packaging inspects the extracted macOS code signature or Windows Authenticode signature, then writes the observed status to a `.signing-status.txt` sidecar beside the archive and checksum. macOS packages are ad hoc signed, not Developer ID signed or notarized. Linux AppImages are reported unsigned when their embedded signature metadata is absent.

Verify an archive checksum beside the archive:

```sh
# macOS
shasum -a 256 -c henshin-server-0.1.0-darwin-arm64.tar.gz.sha256

# Linux
sha256sum -c henshin-server-0.1.0-linux-x64.tar.gz.sha256

# Windows PowerShell (use the matching archive and sidecar names)
$archive = '.\henshin-server-0.1.0-windows-x64.zip'
$expected = ((Get-Content "$archive.sha256" -Raw).Trim() -split '\s+')[0]
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'SHA256 mismatch' }
```

The CI workflow builds and smoke-tests native packages for these configured targets:

| Target | Server archive | Desktop archive |
| --- | --- | --- |
| macOS arm64 | `henshin-server-<version>-darwin-arm64.tar.gz` | `Henshin-<version>-darwin-arm64.zip` |
| Linux x64 | `henshin-server-<version>-linux-x64.tar.gz` | `Henshin-<version>-linux-x64.AppImage` |
| Windows x64 | `henshin-server-<version>-windows-x64.zip` | `Henshin-<version>-windows-x64.zip` |

A target is verified when its native CI package and extracted-runtime smoke pass. Signing is reported per produced desktop archive from platform inspection; no release signing or publishing is configured. Linux arm64 is not a verified target.

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

Restore validates the backup before changing the data directory. With the server stopped, it archives the previous database and any existing SQLite WAL/SHM sidecars intact in a `pre-restore-*` folder, then clears the derived cover cache. Keep those archived files together when recovering the previous database.

The backup contains `henshin.sqlite`: configured roots, indexed entries, E-Hentai metadata and tags, personal titles, notes and tag overrides, and open history. It does not contain original comic files (use NAS backup tools), server secrets such as the bearer token or ExHentai credentials, each desktop's `desktop-config.json`, or the regenerable cover cache. Missing covers are recreated when requested or during a root scan.
