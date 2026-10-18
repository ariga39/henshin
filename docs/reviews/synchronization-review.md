# Synchronization Review

Topic: [Cross-device consistency and instance lifecycle](../design/synchronization.md). Stack: [PR #7](https://github.com/ariga39/henshin/pull/7), branch `design/07-synchronization`, base `design/06-external-reading` ([PR #6](https://github.com/ariga39/henshin/pull/6)).

## Scope and Evidence

Initial fixed commit: `b2561554f200d4f8275e31539edca3652e0acdd4`. Both fresh reviewers used identical prompts and the [six-criterion protocol](topic-review-brief.md), excluding prior review outcomes/progress and their diffs.

- Sol: `gpt-6.1-sol`, Codex task `01a14d1c-c03a-7c30-bea1-26e10b9a15b2`.
- Flash: `opencode-go/deepseek-v4.1-flash`, OpenCode Plan session `ses_eb2e29d6dffe2rHnb7j5yEHuHn` through Herdr; model/provider verified before submission.

## Findings and Gate

Both initial verdicts were PASS. Flash identified non-blocking ownership/clarity gaps in device-label registration, observable authority overlap, revision naming, and the overview index. The revision assigns persistence/API owners, limits overlap checks to fresh authenticated configured endpoints, distinguishes delayed responses, and aligns the index and field wording.

Both reviewers verified final design revision `174af0a2a8a98d4de7b7ca8ba5487720da2d8031` and returned PASS with no material findings or regressions across all six dimensions. Flash's residual optional wording note uses "per-library" descriptively for the explicitly named library change revision; it denotes no second field. Device-registry uniqueness and clone/restore schema details remain with the upcoming persistence topic, as explicitly handed off. The topic gate is complete.

## Earlier-contract Impact and Validation

Search cursors now include the authority epoch. Persistence separates installation identity from instance-scoped journals, standardizes library change revision, and records device-label responsibilities. API responsibilities include epoch handshake and device-label operations. These changes were reviewed together; earlier review records do not claim to cover them.

Local links, English prose, code fences, heading spacing, topic indexing, and whitespace passed. Review-record updates do not alter the verified design revision. No live reconnect, concurrency, backup/restore, or crash tests have run; concrete protocol/schema and runtime validation remain implementation gates.
