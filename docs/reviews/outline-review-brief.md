# Outline Review Brief

## Baseline and Scope

Review commit `f0acdd43115696202226311769ff237acad10ec0` in this repository. Read `README.md`, `CONTEXT.md`, `AGENTS.md`, `docs/design.md`, and all 13 documents under `docs/design/` at that commit. This is a review of a design outline, not an implementation or a diff against a parent commit.

Perform an independent, read-only review. Do not modify files, install packages, change configuration, commit, or delegate. Do not read another reviewer's findings. Return your review in the conversation in English.

## User Requirements

- A personal E-Hentai / ExHentai collection manager: indexing, thumbnails, metadata and tags, metadata refresh, search, and open counts.
- No built-in viewer. Launch an external reader on the client device.
- Cross-platform desktop clients using Electron, React, and TypeScript, connecting to an independently deployable local or remote server.
- Storage and server deployment are independent. The user's files are on a NAS; each device accesses the same files using its own mount or share path. Root mapping is sufficient; content downloads, forwarding, and replication are not required.
- Synchronize EH metadata and shared library information and records across devices. EH favorites synchronization is not requested.
- Effect is preferred for backend and frontend application logic. Exact versions, adapters, and the HTTP stack remain design proposals. SQLite is the current database proposal.
- Documentation is in English and organized by topic. This is an outline to refine before implementation; not every open design question must already be resolved.

## Identical Review Dimensions

Apply all six dimensions. These criteria are the same for every reviewer.

1. **Requirements and scope**: Does the outline preserve the user requirements and distinguish confirmed decisions from assumptions? Identify unrequested commitments or missing core capabilities.
2. **Domain and document consistency**: Are file identity, gallery bindings, paths, local overrides, and open events consistent across the glossary and topic documents? Identify contradictory ownership or lifecycle rules.
3. **Technical feasibility and boundaries**: Are Electron, React, Effect, the independent server, SQLite, and NAS integration coherent? Check runtime ownership, API and IPC contracts, workers, and package assumptions.
4. **Data integrity and failure behavior**: Evaluate moves, replacement, duplicates, failed scans, concurrency, retry, cancellation, disconnection, authentication, and backup/restore. Use concrete failure scenarios rather than hypothetical checklists.
5. **Complexity and sequencing**: Are dependencies and implementation phases sensible? Identify premature abstractions, unnecessary infrastructure, or important prerequisites postponed until after dependent work.
6. **Readiness and verification**: Can the outline guide the next detailed-design step? Are acceptance criteria meaningful? Distinguish gaps that must be resolved now from acknowledged questions appropriate for later topic refinement.

## Evidence and Output

- Report at most eight material findings, ordered by severity. For each, provide severity (high/medium/low), dimension, exact file and line reference, the conflicting rule or evidence, a concrete consequence, and the smallest useful correction.
- Do not report missing implementation code as a defect. Do not report a listed open question solely because it is unresolved. A listed question is a finding only if an existing commitment contradicts it or depends on an unresolved choice in an unsafe order.
- Do not invent features or require a generic enterprise architecture. Do not claim framework capabilities or instability without evidence; label uncertainty and use primary documentation if needed.
- Add a short coverage table for all six dimensions, indicating findings or no material finding.
- Separately list up to three product decisions for the user, if genuinely necessary. Do not silently decide them.
- End with the recommended order for the next detailed-design topics and any limits of your review.

The primary agent will evaluate both reviews against the source documents, resolve disagreements, and revise the outline. Reviewers do not edit the outline themselves.
