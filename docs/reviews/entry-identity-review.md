# Entry Identity Review

Topic: [Entry identity and file lifecycle](../design/entry-identity.md). Stack: [PR #1](https://github.com/ariga39/henshin/pull/1), branch `design/01-entry-identity`, base `main`.

## Scope and Independence

Both reviewers use the [topic protocol](topic-review-brief.md), the same six criteria, primary topic, linked design contracts, and fixed initial commit `d40a66e7426484bf7f5f49762be6f52f31a30a7f`. The scope clarification excludes every other file under `docs/reviews` so overview links cannot import earlier conclusions.

- Sol: new Codex task `01a14cca-edde-7712-b06f-416c8afb0a43`, model `gpt-6.1-sol`.
- Flash: new OpenCode Plan session `ses_eb3313936ffez79PbzQ8WfqlR1` through Herdr, verified as `opencode-go/deepseek-v4.1-flash` before submission.
- An initial Flash attempt followed a link into the earlier outline review. It was stopped and discarded; the replacement session starts without that history. The discarded attempt contributes no review findings.

No runtime, NAS, framework integration, or platform behavior is established by these reviews. The draft's acceptance cases remain specifications.

## Initial Findings

### S1 Contradictory Merge Scope

**Medium; accepted.** At the initial commit, `docs/design/data-model.md:25` still asked the user whether to merge duplicate entries and their history, while the new lifecycle topic excludes merging in the first release. The persistence document now states that duplicate detection only flags candidates; copies remain separate and no history transfer occurs.

### F1 Event Observation Versions

**Reported medium; accepted as a field clarification.** Reading and identity required observed location/content versions but the abbreviated Open event row omitted them. The row now names both. The reported consequence that entry ownership could not be protected without versions was overstated: never retargeting by path is an independent rule. The versions remain necessary to identify stale observations.

### F2 Recovery After Original Content Returns

**Medium; accepted.** The initial evidence table kept identity for exact equality but did not explicitly clear a pending replacement. Comparable complete evidence of the accepted representation now clears the candidate and restores Accepted atomically, without changing content version. Conditional revisions reject a stale resolution screen. Missing files, failed scans, and size/mtime matches cannot clear pending state. An acceptance case covers recovery and stale decisions.

### F3 Atomicity Wording

**Low; accepted.** Clarified that external file changes and database transactions cannot be atomic with each other.

### F4 Revision Fields in Responsibility Table

**Low; accepted.** The entry and candidate rows now name the revisions already required by the resolution protocol. This does not choose a database schema.

### F5 File Status Terminology

**Low; accepted.** The glossary and lifecycle define file status as identity state plus last server availability observation. Persistence names both axes; search/UI must not flatten them or treat them as client access evidence.

The optional EH handoff was added to clarify that local analysis changes do not overwrite source metadata. Both initial reviewers returned REVISE. Sol found one medium issue; Flash found two medium and three low issues. All six actionable findings received corrections or clarifications.

## Review Gate

Both reviewers returned PASS on `7dc45f9f00dd21ff605dd5ff9b93be5b9926e34b`, with no unresolved material finding. Flash additionally noted two non-blocking wording ambiguities: "decision revision" instead of the existing entry revision, and "automatic" potentially qualifying the merge prohibition. Both were corrected in `b2a936237c85999ba1b3c96ca85e71e6d8cdd994`; both reviewers then inspected the exact two-phrase diff and returned PASS with no remaining findings. The optional similarity-deduplication comment adds no feature: exact-copy flagging and later similarity detection remain distinct.

Both passes covered requirements/scope, domain/consistency, feasibility/boundaries, integrity/failures, complexity/sequencing, and acceptance/readiness. Local links, English prose, code fences, heading spacing, topic indexing, and whitespace passed across 23 Markdown documents. The topic gate is complete; path mappings may proceed. Later edits to the review record do not change the verified design revision.
