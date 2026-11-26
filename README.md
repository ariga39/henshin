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

## Current status

The Rust service is implemented under `server/`. The desktop implementation is not present in this baseline; its workspace dependency setup remains.

For desktop workspace work, Node.js 24.19.0 or newer and pnpm 11 are required. Install the locked workspace dependencies with:

```sh
pnpm install --frozen-lockfile
```
