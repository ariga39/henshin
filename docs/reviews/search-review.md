# Search Review

Topic: [Search semantics and filtering](../design/search.md). Stack: [PR #5](https://github.com/ariga39/henshin/pull/5), branch `design/05-search`, base `design/04-eh-metadata` ([PR #4](https://github.com/ariga39/henshin/pull/4)).

## Scope and Evidence

Initial fixed commit: `36017b5f749c2c7b453966b2e2e333e77614c6f4`. Both fresh reviewers used identical prompts and the [six-criterion protocol](topic-review-brief.md), excluding prior outcomes/progress.

- Sol: `gpt-6.1-sol`, Codex task `01a14d0a-527d-7323-beaa-2a7ef8bf9803`.
- Flash: `opencode-go/deepseek-v4.1-flash`, OpenCode Plan session `ses_eb2f52a7dffeEA3DorSPvOhE6j` through Herdr; model/provider verified before submission.
- Official SQLite scalar-function and FTS5 documentation inspected on 2026-10-18. No runtime queries or benchmarks executed.

## Earlier-contract Impact

Persistence records immutable date added and the per-library search change revision. External reading keeps occurrence time as the last-opened statistic. Delivery now explicitly measures the literal-substring baseline and allows an accelerator only with equivalent semantics. These contracts were reviewed in this topic's PR.

## Findings and Gate

Both initial reviews returned PASS without material findings. Flash suggested five non-blocking clarifications: change-revision ownership/advancement, empty-string versus null ordering, a combined-filter fixture, explicit cursor sort direction, and consistent delivery wording. All were applied.

Both reviewers verified final design revision `393e29fa017c825f259e64025a5eeeed030ffe51` and returned PASS with no remaining material finding or regression across the six dimensions. Flash's remaining optional notes concern schema naming (search change revision and library change revision denote the same signal) and restore semantics; these remain explicit persistence/synchronization handoffs, not new search decisions. The topic gate is complete.

Local links, English prose, code fences, heading spacing, topic indexing, and whitespace passed. Review-record updates do not alter the verified design revision. Library scale, normalization fixtures, concrete cursor encoding, and measured performance remain implementation gates.
