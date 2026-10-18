# Path Mapping Review

Topic: [Storage roots and path mappings](../design/path-mapping.md). Stack: [PR #2](https://github.com/ariga39/henshin/pull/2), branch `design/02-path-mapping`, base `design/01-entry-identity` ([PR #1](https://github.com/ariga39/henshin/pull/1)).

## Scope and Independence

Initial fixed commit: `4ace9e92ed7cd193c364245d5db53444ffdb1807`. Both new sessions receive the identical prompt and [six-criterion protocol](topic-review-brief.md), with prior review/progress files excluded.

- Sol: `gpt-6.1-sol`, new Codex task `01a14cd8-6dd2-7d31-97d8-e122d9e1e706`.
- Flash: `opencode-go/deepseek-v4.1-flash`, new OpenCode Plan session `ses_eb326f80effeUONwCwYdY70TZN` through Herdr, model/provider verified before submission.

## Impact on Earlier Topics

The lifecycle topic now distinguishes device mapping revisions from entry location revisions. Persistence disallows overlapping active server roots across libraries, and indexing prevents old-mapping scans from committing. Reader handoff containment is scoped explicitly below. These are new contracts reviewed in this PR; the earlier topic's PASS does not cover these later edits.

## Initial Findings

### S1 External Reader Traversal Is Outside Henshin's Control

**Medium; accepted.** The initial mapping topic promised no content read outside the boundary while the reader contract permits launching a directory. A reader can follow an excluded child link even without a concurrent filesystem race. Mapping and reader documents now limit containment to Henshin's own reads and the supplied launch target, explicitly excluding subsequent reader traversal. The acceptance cases include a valid directory containing an excluded link.

### F1 Mapping Revision Ownership

**Low; accepted.** Clarified that server mapping revisions are server-owned per root, while each client stores its own per-instance/per-root mapping revision. A change to root B does not invalidate root A's work.

### F2 Concurrent Server Mapping Changes

**Low; accepted.** Server mapping mutations now submit the observed revision and reject stale submissions, rather than silently replacing another client's configuration. The overlap invariant is rechecked at commit, including concurrent changes to other roots. Client windows serialize conditional mapping changes through the main process.

### F3 Portable Versus Device-specific Name Restrictions

**Low; accepted.** Names outside the logical path grammar, such as POSIX names containing backslashes, are excluded from discovery and reported. A name that the portable grammar can encode may still be indexed even when one client cannot represent it.

### F4 Location Example

**Low; accepted as a wording clarification.** The JSON example is explicitly an entry response with sibling ID/revision fields. Only root ID and relative path form the location tuple.

### F5 Mapping States

**Low; accepted.** Defined effective states Absent, Active, and Suspended, with a separate draft that can coexist with them. Root scan enablement and current accessibility are separate. Removal/recreation never reuses revision generations.

### F6 Client Overlap Scope

**Low; accepted.** A client compares its own mappings for the selected server instance, not native paths on the server.

Sol initially returned REVISE for S1. Flash returned PASS with six optional low findings; all were addressed before final verification. Both use all six criteria, and no additional product decision was requested.

## Revision Verification

Sol returned PASS on `82e4241a6502fc6c97085565f89af77e59f2482e`. Flash identified one medium residual inconsistency: the old resolution-results row still grouped drafts with suspended effective mappings, despite the new separate draft model. It is now keyed only on effective state, with an explicit statement and acceptance case that pending drafts cannot block an active mapping.

Flash's two optional handoffs were also clarified: portable-name exclusions are linked from indexing, and conditional mapping changes belong to Phase 1 rather than waiting for Phase 2 metadata editing. Both are existing protection requirements, not new product capabilities.

## Review Gate

In progress. Runtime/native-adapter/NAS behavior remains untested; no implementation-ready platform claim follows from this document review.
