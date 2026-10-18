# File Indexing Review

Topic: [File indexing and thumbnails](../design/file-indexing.md). Stack: [PR #3](https://github.com/ariga39/henshin/pull/3), branch `design/03-file-indexing`, base `design/02-path-mapping` ([PR #2](https://github.com/ariga39/henshin/pull/2)).

## Scope and Reviewers

Initial fixed commit: `73ae0d83627607da28a4a1abc524132469f39c11`. Both fresh sessions use the same [six-criterion protocol](topic-review-brief.md), prompt, primary topic, and directly linked contracts. Prior outcomes/progress are excluded, and the overview is treated as an index rather than a request to recursively review unrelated topics.

- Sol: `gpt-6.1-sol`, new Codex task `01a14ceb-0d01-7a21-b456-c1d8d6ae9bce`.
- Flash: `opencode-go/deepseek-v4.1-flash`, new OpenCode Plan session `ses_eb314521affej5p3pL0B1AG1kR`, launched through Herdr and verified before submission.

## Earlier-contract Impact

Entry lifecycle now allows explicit detachment of confirmed-missing claims without deleting records, preventing retired claims from indefinitely blocking new discovery. It also clarifies uncertain lightweight changes and delegates the complete acceptance analysis profile to indexing. Persistence records durable staging/observation responsibilities; delivery adds format, fingerprint, and resource-limit prerequisites. Earlier reviews do not cover these later edits.

## Findings and Disposition

### S1 Move During Enumeration Can Become a Copy

**Medium; accepted.** An indexed source may be observed before it moves into a directory enumerated later. Before copy/new-entry allocation, recheck matching sources and the target. Disappeared/changed/uncheckable sources keep the target staged and trigger refreshed reconciliation. An acceptance case covers this window without claiming a filesystem snapshot.

### F1 Lightweight Changes and Pending Replacement

**Medium; concern accepted, remedy adjusted.** A timestamp-only touch could block Open when no old full fingerprint exists. The revision explicitly describes the uncertainty and its recovery: an existing baseline triggers targeted automatic verification; exact equality clears pending. Without a baseline, complete fast analysis requires explicit same-edition confirmation or new-entry classification. Baseline acquisition remains opt-in.

The suggested alternative of clearing uncertainty from fast analysis alone is not adopted: unchanged page count/cover cannot establish unchanged bytes. This would weaken the earlier known-change Open rule and risk silently transferring records to replacement content. The conservative default, including its timestamp-touch cost, is now explicit in both topics and acceptance cases for reviewer verification.

### F2 Mixed Unsupported Pages and Acceptance Profile

**Medium; accepted.** Mixed supported/known-unsupported pages now produce `unsupported-pages` and remain staged/pending; diagnostic counts cannot become an accepted local page count. A complete supported manifest is the acceptance analysis profile, with cover success/failure and optional full fingerprints tracked separately. The lifecycle wording links to this profile instead of implying full decoding of every page. A 20-JPEG/1-GIF fixture specifies the expected result.

### F3 Archive Name Equality

**Low; accepted.** Duplicate member names use exact decoded code-point equality without case/Unicode folding. Decoders must preserve distinct identities or report unsupported ambiguity.

### F4 Backslash Archive Members

**Low; accepted with a narrower rule.** Backslashes are permitted in opaque decoder member identifiers. Safety validation considers both separator styles for traversal/absolute names, but names are not converted into native output paths. Source-file path restrictions remain separate.

### F5 Manual Relocation Holds

**Low; accepted.** Defined a persisted, version-conditional review hold on staged targets, with explicit release/import/relocation and a conflict if allocation already won. Added cross-root and occupied-target acceptance coverage.

The optional cache-lifecycle comment is addressed with bounded LRU eviction and inactive-task temporary cleanup; cache references do not guarantee file presence. Scan generation terminology is unified across enumeration and reconciliation. Both initial verdicts were REVISE: Sol reported one medium finding; Flash reported two medium and three low findings.

## Review Gate

Awaiting verification of the revised fixed commit, including the rationale for F1. No runtime, NAS, decoder, or performance tests have run. Representative collection size remains an input for measurements rather than an assumed throughput target.
