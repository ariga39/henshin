# API, IPC, and Tasks Review

Topic: [HTTP, Electron IPC, and background tasks](../design/api-and-tasks.md). Stack: [PR #11](https://github.com/ariga39/henshin/pull/11), branch `design/11-api-and-tasks`, base `design/10-persistence` ([PR #10](https://github.com/ariga39/henshin/pull/10)).

## Scope and Evidence

Initial fixed commit: `7d6e573e00e34634dd1e4533a1474b3963dfd4ad`. Fresh reviewers received identical prompts and the [six-criterion protocol](topic-review-brief.md), excluding prior outcomes/progress and their diffs.

- Sol: `gpt-6.1-sol`, Codex task `01a14d4a-f4c1-74b2-9b70-f1e696aa6829`.
- Flash: `opencode-go/deepseek-v4.1-flash`, OpenCode Plan session `ses_eb2b4741bffe5x9eDjH5Ln3C7X` through Herdr; model/provider verified before submission.

## Findings and Resolution

Sol returned REVISE because forced reanalysis during an active scan could be rejected despite indexing's promised follow-up. Flash returned REVISE because moving authenticated HTTP into main left thumbnail bytes without an explicit bridge. The revision requires a durable compatible follow-up task, adds bounded authenticated thumbnail IPC and Blob URL cleanup, classifies stale cursors, and clarifies root/settings/device operations.

Both verified final design revision `c7bec1d38c740792d2a30c4a4dfec1cc5a99ee82` and returned PASS with no material findings/regressions across all six dimensions. Optional follow-ups belong to the next owners: align UI's non-exhaustive main-process responsibility wording, distinguish local replacement covers from policy-bound remote EH previews, and configure CSP for bounded Blob images in deployment. The topic gate is complete.

## Earlier-contract Impact and Validation

Application logic and architecture now consistently assign authenticated HTTP clients, credentials, and bounded thumbnail delivery to Electron main. Renderer Effect workflows call allowed preload operations. Both reviewers checked those amendments; historical reviews are not retroactively expanded.

Local links, English prose, code fences, heading spacing, topic indexing, and whitespace passed. Record-only changes do not alter the verified design. No HTTP/IPC implementation, generated protocol schema, runtime task tests, or platform integration was executed.
