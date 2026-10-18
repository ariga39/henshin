# Adversarial Design Review Protocol

This is a falsification exercise, distinct from the earlier six-dimension consistency review. Attempt to construct a concrete counterexample to a stated guarantee across the whole design. Do not grade documentation quality, repeat stylistic suggestions, or assume a previous verdict. Both reviewers receive the same fixed head, scope, protocol, and attack surface.

## Scope and Constraints

Read the task's fixed-head AGENTS.md, README.md, CONTEXT.md, docs/design.md, and all 14 docs/design/*.md using fixed Git blobs. Inspect only path-restricted design/glossary/README diffs if needed. This protocol is the only readable file under docs/reviews; exclude historical findings, progress, other reviewer conversations, and their diffs. Work independently, read-only, without delegation, installs, network probes, or edits.

Henshin is a single-user Electron/React desktop with Effect application logic and an independent Node/Effect/SQLite authority. Client and server use separate mappings to the same externally managed NAS. It indexes metadata/covers and opens a local external reader; it does not forward collection content, mount shares, extract for reading, or embed a viewer. Shared metadata and accepted-handoff history belong to the server. Explicitly labeled defaults remain design decisions, and native/package/upstream behavior remains subject to documented implementation gates.

This is a design-level exercise, not an executed exploit or proof of implementation security. Do not claim that an unavailable runtime, untested adapter, or deferred optional feature is itself a defect.

## Method: Invariants, Attack Trees, and Failure Sequences

First identify the highest-impact guarantees and their authoritative rules. Model enough state to track instance/epoch, entry/claim/content/candidate versions, mappings/policy generations, operations/events, tasks, profile selection, and durable versus transient records. Do not invent counters or mechanisms the design does not require.

Try to defeat these guarantees using interacting failures, not just isolated invalid input:

| Attack family | Example pressure to explore | Invariants to challenge |
| --- | --- | --- |
| Authority and input abuse | Hostile metadata/archive names/redirects, malformed IPC, a compromised renderer exercising allowed capabilities, wrong namespace or credential context | Native access and process launch remain inside the main-owned boundary; no arbitrary credential forwarding, source writes, or cross-namespace attribution |
| State-machine interleavings | Two clients, stale reads, response reordering, lost replies, cancellation versus commit/dispatch, restart at a durable boundary | One claim owner; stale authority cannot publish; no automatic duplicate launch; one event identity has one authoritative effect |
| Evidence substitution | File move/replacement during scanning, timestamp changes, missing baselines, incompatible fingerprints, client/server path collisions, evicted old covers | Observations never become stronger proof than defined; replacement data cannot inherit old identity/cover keys; uncertain candidates remain unresolved |
| Resource and recovery exhaustion | Disk full at each journal/database/artifact boundary, bounded queues/caches, hanging readers/workers, slow consumers, long offline periods | Pending history is not silently discarded; work is bounded or fails visibly; recovery does not automatically replay ambiguous side effects or damage accepted data |
| Operator and lifecycle mistakes | Incorrect remount, changing credentials during tasks, same endpoint with a different instance, restore of old state, migration/clone/rollback, independently owned service reuse | Retained identity and authentication authority follow the defined lifecycle; recovery cannot revive revoked credentials or silently retarget queues; ownership controls shutdown |

The attacker may control untrusted source data/network responses, send malformed unauthenticated requests, or control renderer inputs at the documented renderer/main boundary. A separate actor may change NAS files while Henshin reads them. An authorized operator can make configuration mistakes. Local administrator compromise, arbitrary editing of Henshin's protected database/binaries, or stolen full owner credentials cannot be used to prove a guarantee the product never claims against that actor.

Prefer short traces that cross two boundaries or combine two plausible failures. Follow the actual specified guards. A scenario is not a finding if it works only because the implementer ignores an explicit rule. If a design gate must settle a choice before the affected feature exists, classify the dependency rather than assuming the unsafe choice ships.

## Evidence Required for a Finding

For each supported counterexample provide:

1. The exact invariant and its head file/line references.
2. Initial state, actors/capabilities, and relevant revision/identity values.
3. A numbered event sequence, including commit/dispatch/crash boundaries and the resulting durable state.
4. The forbidden observable result, why it matters, and which documented checks were considered but fail to prevent it.
5. The smallest coherent correction and a specific regression/fault-injection scenario that would distinguish the correction from the current rule.

A genuinely missing boundary rule can be a finding when the allowed flow lacks the authority/context necessary to decide safely. Explain that concrete ambiguity; a generic demand for more fields, limits, states, or details is insufficient. Use severity based on demonstrated impact and preconditions, not guessed numerical exploitability. Clearly separate a confirmed textual contradiction, a permitted counterexample, and a question needing implementation evidence.

## Outcome Categories and Anti-false-positive Rules

Assign each explored trace one category:

- **Supported design counterexample:** the documented rules permit a violation or two governing rules require incompatible behavior.
- **Defeated by a documented guard:** cite the guard and the step where the attempted attack fails.
- **Accepted limitation or scope exclusion:** the behavior is explicitly disclosed and does not contradict another promise; explain the remaining operational consequence.
- **Requires empirical evidence:** depends on native/platform/adapter behavior already gated or not yet known; identify the smallest experiment, without labeling it an executed failure.

Known limitations must not be relabeled as novel defects: no full-byte proof on every Open, no filesystem snapshot across external reader launch, no exact knowledge of an ambiguous crash outcome, no automatic reconstruction of acknowledged post-backup history, partial disconnected caches, and no global detection of all copied authorities. A separate contradictory promise can still make a limitation material, but cite that promise.

Do not invent required batch workflows, extra services, generic fallback adapters, or stronger security guarantees as a way to manufacture findings. Do not infer safety solely from stable IDs, terminology, framework choice, or a previous review. A failed attempt is useful evidence; no finding quota is required.

## Report

Respond in English. Lead with supported counterexamples ordered by impact; use the evidence structure above. Include a compact coverage table for all five attack families, and describe the strongest defeated attacks, accepted limitations, and necessary experiments without repeating every sentence of the design.

End with **COUNTEREXAMPLE FOUND** if any material supported design counterexample remains, or **NO SUPPORTED COUNTEREXAMPLE FOUND** otherwise. The latter means the explored traces did not defeat the fixed design, not that the design or future implementation is proven secure or complete.

The primary agent independently verifies findings against the fixed sources. Corrections receive reviewer verification before closure, with the attack trace retained as an acceptance case. If a claim is rejected, record the specific guard or scope rule rather than silently dropping it. Preserve independent initial reports before sharing adjudication evidence.
