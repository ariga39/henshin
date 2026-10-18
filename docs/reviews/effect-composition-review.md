# Effect Composition Review

Topic: [Effect application composition](../design/application-logic.md). Stack: [PR #12](https://github.com/ariga39/henshin/pull/12), branch `design/12-effect-composition`, base `design/11-api-and-tasks` ([PR #11](https://github.com/ariga39/henshin/pull/11)).

## Scope and Reviewer Provenance

Initial design commit: `2fddbae074e2b8b84fc3411aa33c26e2f647d33d`. Reviews follow identical prompts and the [six-criterion protocol](topic-review-brief.md).

- Sol: `gpt-6.1-sol`, fresh Codex task `01a14d56-fad7-7080-8e87-24a55deae7ca`.
- The first Flash session `ses_eb2a86a8cffeQ2AJUZfaej7q4r` read the prohibited progress file. Its PASS is discarded as gate evidence, despite no material finding.
- Replacement Flash: fresh `opencode-go/deepseek-v4.1-flash` Plan session `ses_eb2a1ba77ffePI6kU9fEDpspbM` through Herdr, model/provider verified. It independently reviewed full revision `0a7d00e` with the same prompt sent to Sol, using fixed blobs and restricted design diffs; no prior outcomes/progress were read.

## Findings and Resolution

The clean Flash review returned REVISE: saved drafts lacked a main/IPC/UI recovery seam, and post-restart command reconciliation required durable operation-attempt records. Sol found no material issue at that revision. The correction gives main a recovery store, defines draft IPC/UI and conditional local revisions, persists safe command intent before dispatch, and reconciles rather than automatically replaying pre-restart commands. Explicit Disconnect pauses network work while retaining recovery data.

Both reviewers verified final design revision `b4a9262d0b9aa7f6841f41d3befb464259a4a5c3` and returned PASS with no material findings/regressions across all six dimensions. The clean review closes all findings. Optional naming/summary alignment belongs to the subsequent architecture/delivery consolidation; RecoveryStore denotes the existing main-owned recovery capability, not a new domain entity. The topic gate is complete.

## Earlier-contract Impact and Validation

Persistence adds durable command attempts and draft revisions; API/IPC exposes recovery operations; UI provides namespace-scoped recovery. Local replacement covers and EH previews retain distinct policies. Both verifications included these changes.

Local links, English prose, code fences, heading spacing, topic indexing, and whitespace passed. Record-only updates do not change the verified design. No compiled Effect prototype or runtime test occurred. A fresh Effect-site fetch failed TLS/reachability; existing references were retained without claiming current package/API validation. Package pinning and native integration remain explicit implementation gates.
