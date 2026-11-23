# Henshin

Henshin is a cross-platform desktop application for managing E-Hentai / ExHentai collections, with independently deployable clients and a server. It provides file indexing, cover thumbnails, EH metadata, search, and open history. Reading takes place in an external reader on the client device.

File storage and server deployment are independent. The current target scenario stores files on a NAS, with each device accessing the same files through its own network path or mount point. The server can run on the user's computer or another machine on the local network.

## Documentation

English is the working language for repository documentation.

- [Design overview and topic index](docs/design.md): navigation and refinement order for separate design topics with behavioral contracts and explicit implementation gates.
- [Domain glossary](CONTEXT.md): shared definitions for libraries, entries, storage roots, path mappings, EH galleries, and open history.

## Current status

Henshin is in early development. On startup, the desktop connects to its
managed local server. Enter a collection directory to see a read-only sample
of its contents, confirm it with a label, and see saved server roots restored
on the next launch. Scanning and indexing are separate actions.

The separately isolated source-manifest precursor has current executed evidence
in [docs/validation/source-manifests-prototype.md](docs/validation/source-manifests-prototype.md).
The bounded native source-boundary precursor is recorded in
[docs/validation/native-source-boundaries-prototype.md](docs/validation/native-source-boundaries-prototype.md);
it is not a G3 completion claim.

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

### Run the managed product preview locally

```sh
pnpm build
pnpm --filter @henshin/desktop start   # launches Electron and its owned server child
```

The normal launch opens the server collection preview. Enter an absolute
directory path on the managed server to see an empty, complete, or bounded
partial sample. An unavailable path is reported with a retry action. The
submitted path remains attached to displayed results while a new path is being
edited. Saving is enabled only after the current path has its own successful
preview; the server rechecks the preview identity and source/output separation
before durable registration. Saved labels and paths are listed on startup.

For a saved root, choose `Preview books`, edit the `Hold new discoveries for
review` checkbox, and select the single `Start manual scan` action. Unchecked
normal scans accept only complete, current verified discoveries; checked scans
stage discoveries for review and never accept them. The desktop polls the
durable task and staged discoveries, showing progress, readiness or analysis
errors, and the held state. Normal scans wait for the submitted task to reach a
terminal state before refreshing accepted results and surface terminal errors
in Library. Reopening the desktop reloads the task and staged results.

### Run the synthetic prototype explicitly

```sh
HENSHIN_PROTOTYPE_MODE=1 pnpm --filter @henshin/desktop start
```

This explicit mode opens the synthetic note editor and its local draft and
command-recovery flow. Its tests remain in
`apps/desktop/e2e/prototype.spec.ts`; the normal product preview flow is tested
separately.

The desktop spawns the independent server with the bundled Electron Node runtime
and passes the bearer token over a private stdin channel. Starting the server
standalone requires writing one JSON bootstrap line
(`{"bearerToken":"...","dbPath":"..."}`) to its stdin; it reports readiness on
stdout.

### Run the independent foreground service

Independent mode is a foreground Node process and does not depend on Electron.
Create its data directory, initialize its owner credential once, then start it
on a configured loopback port:

```sh
mkdir -p .henshin-server-data
CI=true fnm exec --using=24 pnpm --filter @henshin/server build
CI=true fnm exec --using=24 pnpm --filter @henshin/server start \
  --data-dir "$PWD/.henshin-server-data" --initialize-owner
# Save the owner_token printed by the initialization command locally.
CI=true fnm exec --using=24 pnpm --filter @henshin/server start \
  --data-dir "$PWD/.henshin-server-data" --port 4317
```

The service binds `127.0.0.1:4317` and requires the saved token as a bearer
credential on every API request. Only a verifier is persisted in the restricted
server authentication state; the token is not accepted through process
arguments, environment variables, or logs. Restarting the foreground process
keeps the database instance ID and creates a new authority epoch.

To reuse a database created by managed desktop mode, select its existing file
explicitly on both commands, for example
`--database "$PWD/.henshin-server-data/managed-library.db"`. A data directory
containing a non-default database is not silently paired with a new empty
`server.sqlite` library.
