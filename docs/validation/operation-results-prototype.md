# Operation-result lookup prototype evidence

Status: focused prototype pass for commit `8350c34adcaf432461d16034ca6c40b8fa852724`.

## Shipped policy

The isolated `/prototype/v1` API retains operation results for seven days
(`604800000` milliseconds) within their authority epoch. Expiry is derived from
the existing `operation_results.created_at_ms`; no schema migration or reset is
required. The store admits at most 64 retained rows, and each mutation
transaction reclaims at most 64 expired or obsolete-epoch rows before checking
capacity.

An operation-status read validates the authenticated instance and epoch, reads
without writing or retrying, and returns `410 operation_expired` for unknown or
expired results. Same-operation replay is checked before preconditions,
compaction, and capacity, and returns the stored note plus its original
creation-derived expiry. If safe bounded cleanup still leaves the store full,
cleanup commits independently and the mutation returns `503 storage_full503`
without changing the note or inserting the rejected result.

## Executed evidence

The final candidate was tested with Node 24.19.0:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass; contracts, server, and desktop |
| `pnpm test` | Pass; build, 40 Vitest tests in 6 files, and 3/3 Electron tests |

The HTTP boundary cases exercised:

- A real loopback PUT whose response is destroyed after successful HTTP 200
  headers; status lookup recovers the one committed revision and exact stored
  expiry, and a later edit does not replace that original result.
- Unknown, expired, and expired same-ID mutation replay return
  `operation_expired` without changing the note; status lookup leaves the
  expired row present for later mutation-owned compaction.
- Missing authentication reveals neither the live instance nor epoch.
  Authenticated wrong-instance and wrong-epoch status queries are rejected
  before result lookup. A restarted authority rejects status lookup under the
  old epoch.
- Sixty-four real writes fill the shipped cap. The next mutation returns
  `storage_full503` without changing revision 64, while the first operation
  still replays identically at capacity.
- A fixture with 130 obsolete rows reclaims 64 rows and commits
  `storage_full503` on the first attempt (131 rows become 67), then reclaims
  another 64 rows on the next attempt, leaving two obsolete rows plus the live
  result before admitting the same operation ID. The live current-epoch result
  remains replayable throughout.

Exact revision arithmetic, stale-revision conflicts, canonical
`operation_conflict`, and same-operation ordering remain covered by the same
HTTP boundary suite.
