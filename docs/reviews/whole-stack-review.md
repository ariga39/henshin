# Whole-stack Review and Follow-up

Scope: all 14 design topics plus README, overview, glossary and repository instructions, reviewed cumulatively from `ced51ae` to `0c3ff03`. Corrections are in [PR #15](https://github.com/ariga39/henshin/pull/15), based on [PR #14](https://github.com/ariga39/henshin/pull/14). Historical topic verdicts continue to describe their original fixed revisions.

## Reviewer Provenance and Initial Results

| Reviewer | Fresh session | Initial outcome |
| --- | --- | --- |
| Codex `gpt-6-astra` | `01a14e1e-f901-78d0-95b7-4b9912c6187c` | PASS; optional clarification of historical-cover regeneration and first-image targets |
| OpenCode Go `deepseek-v4.1-flash` | `ses_eb1c1fdcbffe7ZUCXlRNATdVRf` | PASS with low-severity documentation findings and optional suggestions |
| OpenCode Go `step-5-preview` | `ses_eb1c1e64bffeJIBH210ukQqKPn` | REVISE; after primary-source challenge, retained the revision example as a material low-severity contradiction and downgraded/withdrew the initial medium findings |

The two OpenCode sessions received identical whole-stack prompts and all reviewers used the [six-criterion rubric](topic-review-brief.md). Both OpenCode model/provider identities were verified before submission. Prior review outcomes were excluded from independent review. A PASS did not mean the identified inconsistencies should remain unfixed.

Step's initial report called mass timestamp-driven pending state a deadlock and described a possible renderer-path bypass. Source verification established existing per-entry recovery, optional batch fingerprint acquisition, and the explicit prohibition on renderer-supplied executable paths. Step withdrew those claims and corrected an invalid line reference. The remaining UI and handle-issuance wording was still useful to clarify. An epoch is an opaque fresh token, not a decimal revision counter.

## Applied Corrections

| Concern | Correction and affected contracts |
| --- | --- |
| Wire example versus revision type | Mapping example now uses a decimal string; aligns with API and persistence |
| Entry/decision revision naming | Uses decision revision consistently in the cited lifecycle/persistence rules; glossary explicitly identifies the alias as one counter |
| Cache and concurrency vocabulary | Glossary names the display cache and excludes journals/drafts/attempts; links concise identity, epoch, generation and version definitions to their owners |
| Detached default visibility | Lifecycle now agrees with search: current claims remain visible regardless of server availability; detached entries need an explicit view/filter |
| Offline local mismatch | UI explicitly blocks Open pending server reconciliation, preserves cached records and offers access/connection recovery |
| Phase 1 basic list | Uses the existing search route/default ordering/cursors and Phase 1 protocol checks; richer query/filter evidence stays in Phase 2 |
| Handoffs and stale wording | Links lifecycle handoffs and removes the obsolete current-outline reference from Effect guidance |
| Reader boundary | Main native picker issues the executable handle; save rejects renderer paths/fabricated handles; first-image mode is directory-only, with acceptance cases |
| Historical cover eviction | Regeneration needs eligible accepted-version source data; unavailable old bytes retain a placeholder and candidate bytes cannot acquire an old key |
| Remaining scope clarifications | Names GET /library for revision checks; personal tag edits remain per-entry; a clone retains its library ID inside a fresh instance namespace |

The changes preserve optional fingerprint acquisition and individual replacement decisions. They do not add batch replacement confirmation, automatic extraction, a server filesystem browser, or a second search API.

## Deferred Optional Implementation Choices

A speculative Effect fallback adapter and physical table consolidation remain decisions for measured G1/G2 prototypes. Naming an untested replacement or changing physical storage now would not resolve a demonstrated defect. Remote-native path configuration already belongs to authenticated owner setup; this follow-up adds no browsing capability. These are optional design/implementation choices, not unresolved correctness findings.

## Verification

Both OpenCode reviewers verified final design revision `634ff57eb9e2b52dd4db4464ad88bafae69164ba` and returned PASS with no remaining material finding or regression. The first follow-up identified the existing-profile target-retention round-trip and an insufficiently scoped cover acceptance row; both were corrected, along with residual version naming, Phase 1 gate-table traceability and directory-only target summaries. New acceptance rows cover these boundaries.

Step mentioned that an executable target may remain stored but unused when a profile changes to association mode; it explicitly classified this as inert configuration, not a functional/security/integrity finding. No extra state-cleanup mechanism was added.

Local links and heading anchors, English prose, code fences, heading spacing, topic indexing and whitespace checks passed. The record-only commit does not alter the reviewed design. No runtime or platform validation occurred.
