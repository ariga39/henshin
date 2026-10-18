# Detailed Topic Review Protocol

Each topic receives a new Codex session using `gpt-6.1-sol` and a new OpenCode session using `opencode-go/deepseek-v4.1-flash`. Both receive the same prompt, fixed commit, scope, requirements, and criteria. Neither reads the other's findings before completing its independent review. Follow-up verification may use that topic's sessions; the next topic starts fresh sessions.

## Reviewer Instructions

Review the commit and primary topic named in the task prompt using `git show`, not a changing working tree. Read `AGENTS.md`, `CONTEXT.md`, `docs/design.md`, the primary topic, and every design document the primary topic links to. Inspect the topic commit's changes for cross-document contradictions. Do not read review outcomes or other reviewer conversations. Remain read-only: no edits, commits, installs, configuration changes, or delegation. Respond in English.

## Requirements and Stage

Henshin is an Electron/React/TypeScript desktop collection manager with Effect application logic and an independent proposed Node/Effect/SQLite server. File storage is independent of server placement: both client and server access the user's NAS through their own root mappings. Reading launches an external reader locally. There is no built-in reader, content downloading, forwarding, replication, automatic mounting, or file organization. Shared metadata and open records live on one authoritative server. Documentation is in English and split by topic.

This is detailed design, not application implementation. Proposed defaults are allowed when clearly labeled and consistent with user requirements. Assess whether the named topic's decisions are coherent and sufficient for later topics to build on. Mechanisms explicitly handed to a later owning topic are not defects unless the handoff contradicts a rule, hides an unresolved decision belonging to the current topic, or permits unsafe implementation before the dependency is resolved. Do not demand every database column, endpoint, UI widget, or framework prototype in every topic.

## Identical Criteria

1. **Requirements and scope**: Preserve confirmed requirements, distinguish defaults, avoid unjustified features and restrictions.
2. **Domain and consistency**: Check identity, ownership, lifecycle, terminology, and contracts with linked topics.
3. **Feasibility and boundaries**: Check client/server, filesystem, process, and API boundaries; distinguish guarantees from observations and unverified assumptions.
4. **Integrity and failures**: Test concrete concurrency, retry, cancellation, stale-state, partial-failure, disconnection, and recovery scenarios.
5. **Complexity and sequencing**: Prefer simple mechanisms justified by the scenario; flag missing prerequisites and avoid speculative architecture.
6. **Acceptance and readiness**: Check whether meaningful scenarios establish the topic's stated rules and whether dependent topics have explicit handoffs.

## Output

Report material actionable findings ordered by high/medium/low severity. Each needs an exact file/line reference at the reviewed commit, the violated requirement or contradictory rule, a realistic failure scenario, and the smallest useful correction. Separate optional suggestions from blockers; do not invent findings to fill a quota. Include a six-dimension coverage table, unresolved product decisions only if necessary, and review limits.

End with `PASS` when there is no unresolved material finding within the topic scope, otherwise `REVISE`. This is a design-review verdict, not a claim of tested runtime behavior.

## Iteration and Stack Policy

The primary agent evaluates every finding against the source and records accepted changes or evidence-based disagreement. Both reviewers verify the revised fixed commit, including changed rules and affected contracts, until neither has an unresolved material finding. A rejected finding is not automatically closed: the reviewer receives the rationale for verification. Do not begin drafting the next topic before this gate passes.

Each topic has its own branch and PR. The first targets `main`; later PRs target the preceding topic branch. Later discoveries may amend earlier rules in the discovering topic's PR, with an explicit impact note and review of the affected earlier contracts. Do not rewrite historical review results as if they covered later changes. No automatic merge into `main` is implied.
