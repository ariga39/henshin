# Henshin

Henshin is a cross-platform desktop application for managing E-Hentai / ExHentai collections, with independently deployable clients and a server. It provides file indexing, cover thumbnails, EH metadata, search, and open history. Reading takes place in an external reader on the client device.

File storage and server deployment are independent. The current target scenario stores files on a NAS, with each device accessing the same files through its own network path or mount point. The server can run on the user's computer or another machine on the local network.

## Documentation

English is the working language for repository documentation.

- [Design overview and topic index](docs/design.md): navigation and refinement order for separate design topics with behavioral contracts and explicit implementation gates.
- [Domain glossary](CONTEXT.md): shared definitions for libraries, entries, storage roots, path mappings, EH galleries, and open history.

## Current status

The full product is in the design phase; the first-release client and server do
not exist yet. The design distinguishes confirmed choices from proposed
defaults, and package versions, framework integration, packaging, native
dependencies, and NAS access still require validation.

This repository also contains one focused, isolated runtime/persistence
prototype. It is not a runnable product client or server, does not implement the
first-release schema or API, and does not claim any gate complete.

## Runtime persistence prototype

The prototype lives in `apps/server`, `apps/desktop`, and `packages/contracts`.
It performs a synthetic conditional edit through a real Electron renderer →
preload → Electron main typed HTTP client → independent Effect HTTP server →
`node:sqlite` worker, persists committed state across restart, and returns a
tagged revision conflict without writing. The synthetic operation is isolated
under `/prototype/v1` and is not a production API. Executed evidence and the
list of pending gate cases are in
[docs/validation/g1-g2-runtime-persistence-prototype.md](docs/validation/g1-g2-runtime-persistence-prototype.md).

### Requirements

- Node.js `>= 24.19.0` (tested: 24.19.0; Electron 44.9.0 bundles Node 24.22.0).
  Node 22's `node:sqlite` adapter truncates `TEXT` at U+0000, so it is not
  supported for this prototype.
- pnpm 11.

### Reproducible commands

```sh
pnpm install --frozen-lockfile   # locked install; allowBuilds covers electron and esbuild
pnpm typecheck   # contracts, server, desktop
pnpm build       # server and desktop bundles
pnpm test:http   # HTTP-boundary tests against the built independent server
pnpm test:e2e    # real Electron integration test (Playwright)
pnpm test        # build + all tests
```

### Run the prototype locally

```sh
pnpm build
pnpm --filter @henshin/desktop start   # launches Electron and its owned server child
```

The desktop spawns the independent server with the bundled Electron Node runtime
and passes the bearer token over a private stdin channel. Starting the server
standalone requires writing one JSON bootstrap line
(`{"bearerToken":"...","dbPath":"..."}`) to its stdin; it reports readiness on
stdout.
