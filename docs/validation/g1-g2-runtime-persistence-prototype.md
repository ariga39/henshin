# G1/G2 Runtime Persistence Prototype Evidence

Status: **Prototype pass** for the executed cases below. This is not a gate
completion: every other G1/G2 case remains **Not run** and is listed at the end.
The prototype is a synthetic, isolated slice, not a product client or server.

## Source under test

- Tested code: `8d2d7bdda2a8942f022bb15e0091976255f5cbba`.
- Primary acceptance independently ran `pnpm typecheck` and `pnpm test` on that
  revision: 27 Vitest tests and three real Electron tests passed. Note editing
  and draft/server actions are disabled during current-note loading; the
  namespace fixture waits for visible note readiness before editing.
- Subsequent stack integration changes only this evidence document and ancestry.

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
| `pnpm test` | Pass, 27 Vitest tests plus 3/3 real Electron e2e tests |

### Durable draft precursor checks

The full suite above includes three real draft-worker tests, two deterministic
renderer load/edit race tests, and the Electron draft restart and namespace
cases. They cover the narrow synthetic-note draft slice only and do not
replace the full G1 case 2 gate.

The executed lifecycle suite awaited cleanup of its owned child processes and
temporary database directories; no fixture process was left running by the
suite.

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

### Durable draft precursor cases exercised

- The real desktop SQLite worker accepts 64 distinct namespace/note/form keys.
  Discarding one key creates a retained tombstone, so a 65th key returns the
  explicit `full` result; the discarded key and all existing drafts remain
  unchanged by the rejected save.
- A save for a missing key with expected local revision `7` returns a local
  conflict at revision `0` and does not create the key.
- A saved draft discarded at local revision `1` returns absent with revision
  `2` after worker restart; recreating it with expected revision `2` succeeds
  at revision `3`.
- An explicit current-note load and an explicit saved-draft load are held behind
  deterministic deferred responses. Text typed after each request starts is
  retained; the completion may refresh authoritative metadata but cannot replace
  the edited form text.
- The namespace Electron case uses separate launches against two server
  databases with one shared desktop database. A draft from the first verified
  instance is absent from the second and present again when the first is
  relaunched.

## Runtime lifecycle precursor (executed)

This is a bounded G1 case 5 / G6 precursor, not completion of the full resource
gate or resource framework.

- Eight concurrent calls are pending when a real worker thread exits; all settle
  with the worker-death error, and later admission fails closed.
- A real worker call times out and an interrupted call is removed from pending.
  A barrier fixture confirms 64 calls reached pending before the 65th is
  rejected; after interruption, a new call is admitted. A worker that ignores
  close is terminated within the configured shutdown deadline.
- The production child supervisor is exercised with a real built server for
  normal stop, failed SQLite readiness, a never-ready child killed at the
  readiness deadline, and a missing executable. Spawn errors settle without an
  unhandled child-process error.
- Closing the production child's private stdin control channel makes the owned
  child exit, while a separately started server remains reachable. This models
  parent loss at the documented control-channel boundary.
- A standalone real-process bootstrap test supplies a sentinel in malformed
  input and observes a bounded nonzero exit, a safe diagnostic, and no sentinel
  or token echo in stderr.

## Pending G1/G2 cases (Not run)

- G1 case 2 remainder: React remount/unmount, live window/profile switching,
  namespace/epoch late-response guards, subscription ownership, duplicate-command
  prevention, and full deliberate reapplication/reconciliation. The bounded
  saved-draft and input-race cases above are executed; they do not complete this gate.
- G1 case 3: native reader adapter plus journal (pre-dispatch cancellation,
  accepted handoff after teardown, no automatic relaunch, event retry).
- G1 case 4: durable task scheduling, cancellation/restart, stale-generation
  rejection, busy/full database behavior.
- G1 case 5 remainder: resource counters and crash fixtures for sockets, bodies,
  Blob URLs, and the broader temporary-resource surface. This revision only
  executes the bounded worker/server-child precursor above.
- G1 remainder: lost-reply reconciliation and explicit Disconnect.
- G2 remainder: executable DDL for the full authoritative schema,
  pagination/cursor limits and stale-cursor restart, live-refresh fixtures,
  published API/IPC schema snapshot, SQLite backup/rollback, measured
  busy/checkpoint deadlines and finite journal/cache limits, separate Electron
  and standalone-Node native builds, and packaging.

## Limitations

- Single macOS/arm64 host; no cross-platform or packaged-ABI validation.
- Multi-window races are emulated by stale IPC calls from one real window; no
  multi-window harness exists in this prototype.
- Namespace changes use separate launches and verified server instances; actual
  connection-profile switching is not implemented here.
- The draft capacity is exactly 64 retained keys, tombstones count toward that
  limit, and this prototype has no compaction.
- Prototype-only schema and API; not the first-release persistence contract.
- The desktop spawns the server via `ELECTRON_RUN_AS_NODE`, not a packaged
  standalone runtime or installer.
- Parent loss is tested by closing the private stdin control channel through the
  production supervisor seam; no Electron `SIGKILL` crash fixture or packaged
  desktop process-tree assertion was executed.
- Full resource counters, renderer crash behavior, sockets/body/Blob URL
  accounting, NAS/EH/reader resources, and the remaining G1/G6 gates remain
  untested.
- The prototype's chunked-body handling buffers unmeasured bodies in memory up
  to the 1 MiB bound; it does not implement streaming upload.
