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

For a saved root, choose `Preview books`, confirm the checked `Hold new
discoveries for review` mode, and select `Start manual scan`. The desktop polls
the durable task and staged discoveries, showing progress, readiness or analysis
errors, and the held state. Reopening the desktop reloads the task and staged
results; this flow never accepts a book into Library.

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
