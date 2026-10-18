# Adversarial Whole-design Review

This round uses the [invariant and failure-sequence protocol](adversarial-review-brief.md), replacing the earlier six-criterion rubric. Scope is the 14 design topics, overview, glossary, README and repository instructions at fixed head `eaf6afd6db79bfc7374ac125acbd0c78475cdef0`. The follow-up is [PR #16](https://github.com/ariga39/henshin/pull/16), stacked on [PR #15](https://github.com/ariga39/henshin/pull/15). This is a design exercise, not an executed exploit or runtime validation.

## Independent Initial Reports

Both fresh OpenCode sessions received the same scope, protocol, fixed head and attacker capabilities. Model/provider identities were verified before submission. Historical review outcomes and the other reviewer report were excluded. The summaries below preserve the initial outcomes separately from primary adjudication and subsequent verification.

| Reviewer | Fresh session | Initial result |
| --- | --- | --- |
| OpenCode Go `deepseek-v4.1-flash` | `ses_eb1aefd6affe7KegtUVm0cP3Po` | NO SUPPORTED COUNTEREXAMPLE FOUND; explored all five attack families |
| OpenCode Go `step-5-preview` | `ses_eb1aee8fcffeEwZWZZHTPBk5Se` | COUNTEREXAMPLE FOUND; proposed F1 (acceptance-profile precedence) and F2 (cross-window Open coordination) |

Flash's strongest defeated traces were cross-namespace attribution through a compromised renderer, concurrent replacement resolution, publication after an authority restart, replacement bytes acquiring old identity/cover keys, ambiguous launch replay, and incorrect-remount identity rebinding. It identified native behavior as gated empirical work and did not treat known observation/recovery limits as defects.

Step initially argued that an unsupported GIF added to an accepted image directory could leave the supported-page fingerprint unchanged and incorrectly clear pending state. Its initial cross-window trace also incorrectly placed a durable accepted event before describing the action as unresolved. The primary challenged both traces against the fixed sources before sharing adjudication for verification. Step withdrew F1 as a supported counterexample, and corrected F2 to the genuinely active, pre-terminal interval. Its amended initial verdict rested solely on F2, classified low severity; it identified no credential, wrong-file, or data-loss consequence.

## Adjudication and Corrections

### F1: Unsupported Page Versus Equal Fingerprint

At the initial head, `file-indexing.md:46` explicitly requires unsupported-page and other failed-profile candidates to remain pending. `entry-identity.md:76` also requires a complete, stable observation for exact restoration. An image-directory digest covers the supported-page set (`file-indexing.md:73`), so adding a recognized unsupported GIF can leave that digest unchanged; however, ignoring the mandatory acceptance-profile failure is not a permitted execution. The original exploit claim is defeated by that guard.

There was still useful ambiguity between enumeration completeness and acceptance-profile completeness. The correction explicitly requires successful stable acceptance analysis for exact restoration and automatic relocation. Equality under a failed profile remains diagnostic evidence. The regression scenario is: accepted image directory with an exact baseline, add a recognized unsupported GIF, remain pending with Open blocked; remove it and complete stable successful analysis, then exact equality restores Accepted with the same content version. This is a precedence clarification, not a newly confirmed bypass.

### F2: Concurrent Opens From Two Local Windows

Initial fixed-head rules: `user-interface.md:78` promises disabled repeated launch controls across local windows; `external-reading.md:29,34` coalesces by action ID. `api-and-tasks.md:85` only reads status by an already-known action ID. The journal key is instance/action (`data-model.md:96`), and `synchronization.md:48` names shared connection/event coordination without a concrete per-entry Open admission rule.

1. Windows W1 and W2 use the same instance I and entry E, with accepted state and valid mapping/profile revisions. Neither sees an active launch initially.
2. W1 submits A1. Main prepares or dispatches it; its outcome is still unresolved. No terminal accepted event/result is assumed.
3. W2 still has enabled controls and submits a different A2. Action-ID deduplication does not identify A2 as A1, and W2 cannot query the unknown A1 by entry.
4. Without per-entry admission, both requests can pass the identity/path/profile checks and dispatch. If both are OS-accepted, two immutable events result.

This violates the promised cross-window in-flight coalescing. The count still honestly represents two accepted handoffs; the issue is an avoidable concurrent second launch, not incorrect event deduplication or fabricated reading history. Two deliberate Opens after a terminal result are legitimate and do not demonstrate this finding.

The correction makes main atomically reserve a transient `(instance_id, entry_id)` active slot before asynchronous work, shared across local windows and connection profiles. A competing request follows the existing action ID/status, without another intent or dispatch and without changing the first action's captured context. IPC exposes entry-based active status and launch-state hints; delayed UI hints cannot bypass admission.

The slot ends on terminal outcome publication, independently of reader lifetime, event upload, or renderer acknowledgment. Window teardown does not release active work; pre-intent failure/cancellation still publishes a terminal result. Accepted-but-not-durable events retain the explicit warning and persistence-only retry. Restart leaves diagnostic unknown intents, never replayable launches or permanent active locks. A new explicit Open is possible after the uncertainty is shown. Separate installations remain independent.

Acceptance cases cover distinct concurrent IDs, multiple windows/profiles, stale UI, originating-window teardown, pending uploads, crash/unknown recovery, and subsequent deliberate Opens. The fixes span reading, IPC, Effect ownership, persistence, synchronization and UI; the existing journal key and event-deduplication contract remain unchanged.

## Attack-family Coverage and Remaining Evidence

| Family | Representative traces | Adjudicated outcome |
| --- | --- | --- |
| Authority and input abuse | Malformed IPC, wrong namespace, hostile URL/redirect/archive names, cursor/SQL input | Defeated by explicit main-owned allowlists, context validation, source policy and parameterized-query rules |
| State-machine interleavings | Concurrent replacement decisions, stale epochs/results, cancellation versus commit, launch/crash boundaries, cross-window actions | F2 required explicit admission/status coordination; other explored traces defeated by revision/epoch/generation checks and journal rules |
| Evidence substitution | Replacement/move, stale digests, unsupported pages, client collisions, old-cover eviction | F1 exploit withdrawn under the failed-profile guard; precedence clarified; accepted observation limits retained |
| Resource and recovery exhaustion | Full journal/database/artifact storage, pending queues, slow SSE, wedged decoder, ambiguous launch | Required visible failure, bounded work and no replay remain; actual native termination and fault injection need implementation evidence |
| Operator and lifecycle mistakes | Incorrect remount, credential change, same URL/new instance, restore/clone/migration/rollback | Explicit namespace/epoch/reset and remount rules defeat explored traces; sample verification and copied-authority detection retain disclosed limits |

No full-byte proof on every Open, no filesystem snapshot through reader launch, unknown crash outcomes, lost acknowledged post-backup history, partial offline caches, and incomplete global copied-authority detection remain accepted limitations. These were not relabeled as defects. G3/G5 still require native containment/handoff experiments; disk-full and crash-boundary injection, decoder termination, and the other [delivery gates](../design/delivery-and-validation.md) remain unexecuted.

## Correction Verification

Both reviewers received the same corrected trace, adjudication and regression probes under the adversarial protocol at fixed design revision `5628734c1a7a7ecea422336a0326b07a14f6f7cd`.

Step returned NO SUPPORTED COUNTEREXAMPLE FOUND. Its seven checks covered same-entry/different-profile admission, stale hints, pre-intent failure/cancellation, window teardown, accepted-event persistence failure, crash/unknown recovery, and subsequent deliberate Open. It also verified both GIF add/remove traces and relocation/profile precedence. Its concluding reference to two initially supported findings does not supersede its earlier withdrawal of F1: the supported correction remains F2, with F1 a clarification.

Step suggested optional repetition of two existing rules: checkAccess is non-launching while Open reserves admission (`api-and-tasks.md:82`), and post-acceptance persistence failure publishes a warning with an in-memory event and persistence-only retry (`external-reading.md:37,62`). Neither supplies a contradictory rule or supported failing trace; those explicit guards remain sufficient, without another mechanism or design change.

DeepSeek also returned NO SUPPORTED COUNTEREXAMPLE FOUND at the same head. It verified all seven admission/recovery traces, both GIF traces, automatic relocation, unchanged event deduplication, and G5 acceptance-case ownership. It noted that the brief evidence table and service-summary table do not repeat every qualification; their owning precedence/admission paragraphs explicitly govern those summaries, so these are not remaining behavioral gaps. Same-entry/different-profile coalescing intentionally follows the first active request without changing its profile.

The primary accepts both final verdicts for the explored design traces. Safety depends on implementing the specified atomic admission boundary, not merely on calling Electron main single-threaded. No runtime, native reader, NAS, packaging, or fault-injection test was performed. Markdown links and heading anchors, English prose, fences, heading spacing, topic indexing and whitespace checks passed for all 39 Markdown files. The final record-only commit does not change the reviewed design.
