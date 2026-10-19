# G1/G2 Runtime Persistence Prototype Evidence

Status: **Prototype pass** for the executed cases below. This is not a gate
completion: every other G1/G2 case remains **Not run** and is listed at the end.
The prototype is a synthetic, isolated slice, not a product client or server.

## Source under test

- Tested code: `5dd562d01784a66c3cb00a9e9ca52eef384fa765` — `pnpm typecheck`,
  `pnpm build`, `pnpm test:http` (13/13), and `pnpm test:e2e` (1/1) all pass on
  this revision.
- Prototype base commit: `ec2cc9a` (first frozen install/typecheck/test pass).
- Primary acceptance reran the full suite after the bootstrap-error redaction
  change in the tested revision. The earlier `abb3ce4` run covered 12 HTTP tests;
  this run also covers the malformed-bootstrap child-process regression.

## Scope and fixtures

- One synthetic operation: a single note with a monotonic revision, edited
  through a real renderer → preload → Electron main → independent Effect HTTP
  server → SQLite worker round trip, plus a tagged revision conflict.
- The API is isolated under `/prototype/v1` with the `henshin-prototype` id; it
  is not a production surface.
- Synthetic data only. No NAS, EH, reader, or collection access occurs.
- Auth is required even on loopback: a random 256-bit bearer token is generated
  by main and passed to the server over its private stdin channel. It never
  appears in argv, the environment, or logs.

## Environment

- macOS 26.7.1 (build 25G241), arm64.
- Primary verification runtime: Node 24.19.0 (the command-PATH `node`).
- Desktop/server runtime: Electron 44.9.0, which bundles Node 24.22.0.
- Separate evidence runtime: Node 22.23.2.
- effect 4.0.5, @effect/platform-node 4.0.5, typescript 5.9.3, vitest 5.0.5,
  @playwright/test 1.64.1, react/react-dom 19.3.1.
- SQLite driver: built-in `node:sqlite` (`DatabaseSync`) on a dedicated
  `node:worker_threads` worker in the server process.
- Version evidence: `pnpm-lock.yaml`. Effect 4.0.5 was selected as the current
  stable v4 release after confirming the `beta` tag points at a superseded
  pre-release (`4.0.0-beta.107`).

## Driver selection experiment

`node:sqlite` was executed directly (open, DDL, insert, select, close) in each
runtime that must run the server:

| Runtime | Transaction | Embedded U+0000 round trip |
| --- | --- | --- |
| Node 24.19.0 (primary) | Pass | Pass (`a\u0000b` length 3, equal) |
| Electron 44.9.0 / Node 24.22.0 | Pass | Pass |
| Node 22.23.2 (separate) | Pass | **Fail** (TEXT truncated at U+0000) |

Because the pinned runtimes (Node >= 24.19.0 and Electron's Node 24.22.0)
preserve NUL exactly, no native rebuild adapter was needed and public text was
not narrowed. Node 22 is unsupported: `package.json` `engines.node` is
`>=24.19.0`.

`BigInt` binding and `StatementSync.setReadBigInts(true)` were verified to read
and write `9223372036854775807` exactly.

## Executed commands and outcomes

All commands were run on the primary Node 24.19.0 runtime unless noted.

| Command | Result |
| --- | --- |
| `pnpm install` | Pass (locked install, explicit `allowBuilds` for electron/esbuild) |
| `pnpm typecheck` | Pass (contracts, server, desktop) |
| `pnpm build` | Pass (server `dist/server.mjs` + `dist/worker.mjs`; desktop main/preload/renderer) |
| `pnpm test:http` | Pass, 13/13 (12 real HTTP cases plus the malformed-bootstrap child-process regression) |
| `pnpm test:e2e` | Pass, 1/1 (real Electron via Playwright `_electron`) |

No leaked Electron or owned server child processes remained after the suites.

## Cases exercised

- Malformed bootstrap input containing a sentinel credential exits within the
  test deadline with a fixed redacted diagnostic and without echoing the input.
- Renderer Effect operation through the typed preload/main client reaches the
  independent server and a SQLite worker transaction; a tagged
  `revision_conflict` round-trips to the UI without private details.
- Committed state is durable: the note revision and text are observed after the
  desktop is closed and relaunched against the same database file.
- Namespace and authority epoch: the instance id is stable across restart; the
  epoch changes, and both are asserted to be real UUIDs.
- Stale revision: a second edit from the same captured revision returns
  `revision_conflict` with the current revision and performs no write.
- Stale epoch: a mutation carrying a wrong epoch is rejected with
  `epoch_changed` before any write.
- Command deduplication: an identical same-epoch retry returns the stored result
  before preconditions are re-evaluated; the same operation id with a different
  payload returns `operation_conflict`. Canonical identity is derived inside the
  worker from validated fields.
- Authentication: missing and invalid bearer tokens return
  `authentication_required` without disclosing the live instance or epoch.
- Input bounds: non-canonical and out-of-range revisions and over-long text are
  rejected at the HTTP boundary (400).
- JSON body ceiling: a body over the 1 MiB limit is rejected with 413 at HTTP
  parsing for **both** a declared `Content-Length` and a chunked
  (`Transfer-Encoding: chunked`, no `Content-Length`) body, with no write. A
  within-limit chunked body is still accepted (200). A malformed chunked JSON
  body is rejected with 400.
- Text fidelity: a maximum-length text of 1024 U+0001 control characters (whose
  JSON escaping expands well past the old 4096-byte internal bound) is accepted
  and round-trips; a maximum-length text of 1024 U+0000 characters round-trips
  exactly on the pinned runtime.
- Exact revision arithmetic: starting from `9007199254740992` (2^53), the note
  increments to `9007199254740993`, reads back exactly, and a stale edit reports
  `current_revision = 9007199254740993` — beyond `Number.MAX_SAFE_INTEGER`.

## Pending G1/G2 cases (Not run)

- G1 case 2: React remount/unmount, window switching, late responses and epoch
  change leaving one subscription and no duplicate command; draft
  save/reload/reapply/discard across namespace switches and restart.
- G1 case 3: native reader adapter plus journal (pre-dispatch cancellation,
  accepted handoff after teardown, no automatic relaunch, event retry).
- G1 case 4: durable task scheduling, cancellation/restart, stale-generation
  rejection, busy/full database behavior.
- G1 case 5: resource counters and crash fixtures for sockets, bodies, workers,
  Blob URLs, and temp files.
- G1 remainder: lost-reply reconciliation and explicit Disconnect.
- G2 remainder: executable DDL for the full authoritative schema,
  pagination/cursor limits and stale-cursor restart, live-refresh fixtures,
  published API/IPC schema snapshot, SQLite backup/rollback, measured
  busy/checkpoint deadlines and finite journal/cache limits, separate Electron
  and standalone-Node native builds, and packaging.

## Limitations

- Single macOS/arm64 host; no cross-platform or packaged-ABI validation.
- Prototype-only schema and API; not the first-release persistence contract.
- The desktop spawns the server via `ELECTRON_RUN_AS_NODE`, not a packaged
  standalone runtime or installer.
- The prototype's chunked-body handling buffers unmeasured bodies in memory up
  to the 1 MiB bound; it does not implement streaming upload.
