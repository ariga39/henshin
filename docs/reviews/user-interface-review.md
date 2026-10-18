# User Interface Review

Topic: [UI journeys and interaction](../design/user-interface.md). Stack: [PR #9](https://github.com/ariga39/henshin/pull/9), branch `design/09-user-interface`, base `design/08-product-scope` ([PR #8](https://github.com/ariga39/henshin/pull/8)).

## Scope and Evidence

Initial fixed commit: `0e73018711854e1df491220de14b6e3a3494902d`. Both fresh reviewers used identical prompts and the [six-criterion protocol](topic-review-brief.md), excluding prior outcomes/progress and their diffs.

- Sol: `gpt-6.1-sol`, Codex task `01a14d30-5fc2-7fb1-b643-1f2760973a6c`.
- Flash: `opencode-go/deepseek-v4.1-flash`, OpenCode Plan session `ses_eb2cf082affe8DixaJkFZ7sHnO` through Herdr; model/provider verified before submission.

## Findings and Resolution

Both initial verdicts were REVISE for the missing staged-discovery/relocation journey. Sol identified the target-allocation race; Flash also identified the first-scan boundary/exclusion preview handoff. The revision adds preview, held discoveries, relocation/import/release actions, incomplete-scan warnings, and existing-entry conflict recovery. Device-label editing and namespace-scoped diagnostics were also clarified.

Both verified final design revision `b8bd34980a9951f5fcc2c74e75bc91da3d3790e0` and returned PASS with no material findings/regressions across all six dimensions. Flash's optional implementation clarifications concern displaying plausible candidates even after a complete scan, showing loose/unassigned images, and exact root revision field names; the owning indexing rules remain binding, and schemas/wireframes must preserve them. No rule waives those earlier requirements. The topic gate is complete.

## Earlier-contract Impact

Indexing now persists an optional pre-scan Hold new discoveries mode and creates new candidates with holds before automatic allocation/relocation. This makes the UI reservation opportunity reliable for cross-root moves. Existing claims still receive normal observations; normal scans retain their policy; releasing a hold requires fresh validation. Both reviewers explicitly checked this change against identity, mapping, reading, and search contracts. Topic 3's historical review is not retroactively rewritten.

## Validation Limits

Local links, English prose, code fences, heading spacing, topic indexing, and whitespace passed. Review-record updates do not change the verified design. No rendered wireframes, usability/accessibility tests, runtime crash tests, or virtualization benchmarks have been executed.
