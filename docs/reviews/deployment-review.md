# Deployment, Authentication, and Packaging Review

Topic: [Architecture](../design/architecture.md). Stack: [PR #13](https://github.com/ariga39/henshin/pull/13), branch `design/13-deployment`, base `design/12-effect-composition` ([PR #12](https://github.com/ariga39/henshin/pull/12)).

## Scope and Provenance

Initial design revision: `2119c4d4024a385daca8d3c78947ad21f2f8240d`. Both fresh sessions received the same scope and [six-criterion protocol](topic-review-brief.md), with fixed-source review, restricted design diffs, and no access to review outcomes.

- Sol: `gpt-6.1-sol`, Codex task `01a14d6e-74dd-79d3-865a-aa73ae4ebed4`.
- Flash: `opencode-go/deepseek-v4.1-flash`, OpenCode session `ses_eb290a8a0ffeMnUT8fSsnZHBtJ` through Herdr; actual model/provider verified.

## Findings and Resolution

Sol initially returned PASS. Flash requested changes because restoring a pre-rotation snapshot could reactivate the old owner-token verifier, and the deployment acceptance gates needed an explicit mandatory handoff to Delivery. It also suggested clarifying independent-access initialization for a managed library, removing the undefined auth revision, and scoping the desktop lock to its data directory.

Revision `df21b25` adopted those corrections: supported restore/migration/clone and pre-upgrade rollback clear copied verifiers before activation, independent access requires a fresh locally initialized token, and managed mode uses only its transient bootstrap credential. Sol passed the revision. Flash verified the earlier items resolved but found that an active EH secret reference could similarly revive a protected old version still present outside the database.

Final design revision `14f578708ec0230431442f702c979a190a7c5730` also clears active EH secret references, blocks credential-dependent work until explicit re-entry/reattachment into a new immutable version/generation, and prevents recovered tasks/results from reactivating old references. Both reviewers returned PASS across all six dimensions with no unresolved material finding. Flash's optional nullable-reference wording suggestion is a clarity follow-up for delivery consolidation; the cleared/unconfigured state is already required.

## Earlier-contract Impact and Validation

Persistence now distinguishes optional owner authentication and protected credential references from restored active authority. Consistency applies the reset to authority migration, clone, restore, and rollback. Delivery carries mandatory security and deployment evidence before the affected capability ships. Application logic aligns its existing main-owned RecoveryStore terminology.

Local Markdown links, English prose, code fences, heading spacing, topic indexing, and whitespace passed. Record-only updates do not alter the verified design. No runtime, secret-store, TLS/proxy, signing, native ABI, installer, NAS, or restore test has run. Official Electron security/safeStorage documentation was inspected; concrete APIs and supported builds remain implementation gates.
