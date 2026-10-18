# Persistence Review

Topic: [Persistence schemas and transactions](../design/data-model.md). Stack: [PR #10](https://github.com/ariga39/henshin/pull/10), branch `design/10-persistence`, base `design/09-user-interface` ([PR #9](https://github.com/ariga39/henshin/pull/9)).

## Scope and Evidence

Initial fixed commit: `1775408906a6261bd78e938c1c4982219d365474`. Fresh reviewers used identical prompts and the [six-criterion protocol](topic-review-brief.md), excluding prior outcomes/progress and their diffs.

- Sol: `gpt-6.1-sol`, Codex task `01a14d3e-d72e-75c3-8064-9cee5b35312e`.
- Flash: `opencode-go/deepseek-v4.1-flash`, OpenCode Plan session `ses_eb2c095f4ffemdzrF0ouwr1OP5` through Herdr; model/provider verified before submission.
- Official SQLite WAL and online-backup documentation inspected on 2026-10-18; no executable schema or database test was run.

## Findings and Resolution

Sol initially returned PASS. Flash returned REVISE for missing Stop-scanning decision fences, standalone confirmed-missing detachment, and durable lightweight per-page observations. The revision adds dedicated conditional transactions and evidence records, preserving prior identity/indexing requirements. Hold release, alias publication, credential-version activation, non-reserving last-known location, and instance-wide sharing were also clarified.

Both reviewers verified final design revision `ba6b0503e876fd5de99d8d935b5fc74323f6c17c` and returned PASS with no material findings/regressions across all six dimensions. Flash's remaining optional note asks future schema/code edits to keep revision increments explicit; the transaction rows already name decision/policy/library increments for Stop scanning and decision/location/library increments for detachment. The topic gate is complete.

## Contract Impact and Validation

This topic implements prior behavior in logical tables and atomic operations without changing identity ownership, NAS access, event semantics, or scope. It distinguishes authoritative data from projections, the local journal from server history, and private backup from metadata export. Exact adapter/DDL/layout choices remain implementation gates constrained by this schema contract.

Local links, English prose, code fences, heading spacing, topic indexing, and whitespace passed. Record-only updates do not alter the reviewed design. Runtime SQLite behavior, migrations, NAS comparisons, backup/restore, crash recovery, and performance remain untested.
