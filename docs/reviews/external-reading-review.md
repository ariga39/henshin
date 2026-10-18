# External Reading Review

Topic: [External readers and open history](../design/external-reading.md). Stack: [PR #6](https://github.com/ariga39/henshin/pull/6), branch `design/06-external-reading`, base `design/05-search` ([PR #5](https://github.com/ariga39/henshin/pull/5)).

## Scope and Evidence

Initial fixed commit: `371dbcef4779e147b5061698b6ebdc6aea95289a`. Fresh reviewers received identical prompts and the [six-criterion protocol](topic-review-brief.md), excluding prior outcomes/progress.

- Sol: `gpt-6.1-sol`, Codex task `01a14d13-d61f-7272-a794-9d9b44475eac`.
- Flash: `opencode-go/deepseek-v4.1-flash`, OpenCode Plan session `ses_eb2eb9b9affeic2G3U3Bn6f88z` through Herdr; model/provider verified before submission.
- Official Node child-process and Electron shell documentation inspected on 2026-10-18. No reader integration or NAS/platform execution occurred.

## Findings and Resolution

Sol initially returned PASS. Flash returned REVISE for an ambiguous action-ID uniqueness scope: per-entry wording could conflict with instance-wide event deduplication. The revised text requires random UUID action/event IDs across devices and entries, with instance/entry context used for attribution rather than uniqueness partitioning.

Other accepted clarifications cover mapping revision terminology, device-ID ownership, client-local SQLite persistence, first-image versus cover selection, and explicit delivery gates. Queue-full behavior remains a labeled first-release default: one counted Open contract, without silent fallback to untracked launch. This is not a new confirmed user requirement or a restriction on external file access.

Both reviewers verified final design revision `2fba5b427bd2e1ebfd4f994f77ac6046a566c914` and returned PASS with no material findings or regressions across all six dimensions. Flash's optional wording notes about installation identity versus queue namespace and storage-retention versus delivery policy will be resolved in the immediately following synchronization topic, which owns those distinctions. They do not block this topic gate.

## Earlier-contract Impact and Validation

Persistence now owns the desktop journal separately from the server database and uses the same event uniqueness scope. Delivery records platform handoff, shutdown-survival, and crash-injection gates. These changes were included in both verifications.

Local links, English prose, code fences, heading spacing, topic indexing, and whitespace passed. Review-record updates do not alter the verified design revision. Named-reader compatibility and platform adapters remain untested implementation prerequisites.
