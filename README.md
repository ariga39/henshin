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

## Build and install the macOS desktop development package

On an Apple Silicon Mac with Node.js 24.19.0 and the repository's pinned pnpm,
run these commands from the checkout.

```sh
pnpm install --frozen-lockfile
pnpm --filter @henshin/desktop package:mac
```

Extract the tarball from `dist/desktop/`, move `Henshin.app` to your
Applications folder, and launch it. The app includes its managed server.
Choose a collection directory, confirm the preview, and start a scan to
populate Library. The development build uses an ad hoc signature. Public
distribution requires Developer ID signing and notarization.

## Build the standalone server archive

The repository build produces a platform-specific archive under
`dist/standalone/`. Build-time pnpm stages the locked production dependencies;
the unpacked archive requires only the documented Node.js prerequisite and does
not require pnpm or a repository checkout at runtime.

```sh
CI=true fnm exec --using=24.19.0 node apps/server/distribution.mjs
```

The archive includes the server, persistence, manifest, and thumbnail workers,
the host-native Sharp/libvips codec, and third-party redistribution notices. It
is not a release upload or a cross-platform support claim. The archive README
records the exact platform exercised and the remaining limits; a separate
archive is required for each advertised host architecture.

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
with any recognized non-default database requires explicit `--database`
selection and is never silently paired with a new empty `server.sqlite`
library.

Each data directory has one independent owner credential bound to the selected
database. Reuse that explicit database path on subsequent starts. To operate
a second independent library, initialize it in a separate data directory.

To rotate a lost or compromised owner token, stop the service and run the same
initialization command with `--rotate-owner` in place of `--initialize-owner`.
Save the replacement token and restart the service. Each independent client
needs the new token to reconnect.

Register a server backup destination through the stopped local administration
command. The destination must be an existing directory outside the active
database directory and every saved collection root:

```sh
node apps/server/dist/server.mjs backup-destination register \
  --data-dir "$PWD/.henshin-server-data" \
  --name primary --path "/mnt/backup/henshin"
node apps/server/dist/server.mjs backup-destination list \
  --data-dir "$PWD/.henshin-server-data"
```

The list command reports the persisted destination ID and native identity. A
remount is reported as `needs-reconfirmation`; replacing a destination keeps
its ID and requires an explicit confirmation:

```sh
node apps/server/dist/server.mjs backup-destination replace \
  --data-dir "$PWD/.henshin-server-data" \
  --id <destination-id> --path "/mnt/backup/new" --confirm
```

Create a verified application archive at the registered destination. The
command snapshots server state only; collection files and authentication
secrets remain outside the bundle:

```sh
node apps/server/dist/server.mjs backup create \
  --data-dir "$PWD/.henshin-server-data" \
  --destination-id <destination-id> \
  --label "pre-upgrade archive"
```

Run an isolated restore drill while the service is stopped. The drill records
its result against the exact artifact and manifest digest; it never replaces
the live database or writes collection files:

```sh
node apps/server/dist/server.mjs backup drill \
  --data-dir "$PWD/.henshin-server-data" \
  --artifact-id <artifact-id>
node apps/server/dist/server.mjs backup drill list \
  --data-dir "$PWD/.henshin-server-data"
```

### Restore an existing server authority

Stop the service and all other writers before restoring. List the completed
recovery points, then preview the selected artifact; the preview shows its
snapshot time, instance/library identity, and estimated lost revision interval:

```sh
node apps/server/dist/server.mjs backup restore list \
  --data-dir "$PWD/.henshin-server-data"
node apps/server/dist/server.mjs backup restore preview \
  --data-dir "$PWD/.henshin-server-data" \
  --artifact-id <artifact-id>
```

Apply only after reviewing that output. The command requires `--confirm`,
checks the existing target's instance and library identity, preserves a
rollback copy, and prints a new `owner_token` on success. Save that token in a
protected location; the pre-restore token is no longer valid:

```sh
node apps/server/dist/server.mjs backup restore apply \
  --data-dir "$PWD/.henshin-server-data" \
  --artifact-id <artifact-id> --confirm
```

If replacement is interrupted, do not delete the restore marker, its private
recovery companion, rollback copy, or selected archive. Restart the service, or
rerun a stopped restore command; startup and maintenance recovery inspect the
atomically written marker (and its recovery companion if needed), then recover
the previous target when installation did not finish. If both marker copies
are unreadable, keep the target, rollback copy, staging directory, and archive
intact and stop for the explicit restore recovery procedure; the server never
guesses which database to replace. Inspect the result with
`backup restore list` or `backup restore preview`. After a successful replacement,
restart the service with the newly printed token and verify the recovered
instance/history before resuming work. If the process stopped after installing
the replacement but before printing a new token, startup keeps the restored
service offline. Run `--rotate-owner` and save the printed token, then restart
the service and reconnect clients. Restore preflight checks
credential writability before the database replacement.

Restored roots and destinations remain unverified, and scans, EH work, backup
publication, and rotation remain suspended until their current paths and
policy are checked. Run reconciliation only while the service is stopped:

```sh
node apps/server/dist/server.mjs backup restore reconcile \
  --data-dir "$PWD/.henshin-server-data"
```

Resume normal work only after it reports `"status":"normal"`. A running
service, a mismatched readable authority, a damaged archive, or a changed
destination blocks replacement without overwriting the selected archive or
collection files. Empty-target disaster recovery and independent cloning use
separate operator workflows.

The rollback copy is intentionally retained through verification and
reconciliation. After the recovered service and its mappings are verified, an
operator may remove only the matching `.henshin-rollback-*.sqlite` file and its
`-wal`/`-shm` sidecars from the data directory; never remove an archive or a
collection file as rollback cleanup.
