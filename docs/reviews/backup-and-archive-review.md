# Backup and Archival Recovery Review

Scope: [backup and archival recovery](../design/backup-and-archive.md), all linked owning topics and changed contracts. Initial head `744f93c4840e044f44e3fd2cd5f80e8b9cb247fd`, base `0604ddb`. [PR #19](https://github.com/ariga39/henshin/pull/19) follows PR #18 in GitHub Stack #17. The user confirmed during review that Henshin backs up application data while external NAS tools protect original collection files; both reviewers received that clarification.

## Independent Reports and Adjudication

Fresh Codex `gpt-6.1-sol` session `henshin-backup-sol` and fresh OpenCode Go `deepseek-v4.1-flash` session `ses_eb174d137ffeiKQjwI7p3AvmZY` received identical fixed-head prompts and the [six-criterion protocol](topic-review-brief.md). Model/provider identities were verified. Review was read-only, excluded earlier outcomes, and independent until initial reports were complete.

Sol initially returned PASS with an optional restore fixture: newer cover files may remain when an older database is restored and numeric content versions later recur. DeepSeek initially returned REVISE for two contract gaps: backup policy had a write route but no read route for a fresh destination, and the asserted shared configuration generation had no defined persistence mechanism. It also requested clearer maintenance ownership, secret-exclusion coverage, backup/export distinction and a single owning recovery procedure.

| Concern | Adjudication and correction |
| --- | --- |
| Settings cannot be read before first artifact | Added authenticated GET /settings/backups for destination IDs, per-destination revision, policy/validation state and results; no native paths or secrets |
| Undefined configuration-generation fence | All restorable application configuration is snapshot-backed; configuration.json derives from that same SQLite snapshot and cannot override it. Host service-manager/environment/TLS setup is explicitly external |
| Persistence and maintenance handoffs | Named destination/artifact catalogs, durable reservation and policy serialization; offline maintenance shares the exclusion lock and owns stopped-desktop writes. Recovery procedure has one owning topic |
| Restore and reused cover keys | Explicit pre-restore server derived-cache invalidation, client epoch thumbnail eviction/manifest freshness and desktop display-cache discard; no reuse of discarded-timeline bytes solely by numeric key equality |
| Missing acceptance details | Added credential-content sentinels, settings-before-artifacts, configuration projection mismatch, cache rollback and wall-clock-retention cases |
| Confirmed scope and privacy | App-data-only backup now confirmed; external original-file backup retained; complete private bundle downloads are explicitly distinct from redacted metadata exports |

The primary also made retention use destination/store catalog publication order instead of timestamps, so a clock rollback cannot nominate a newer recovery point for deletion merely by file dates. Catalog loss remains non-pruning until explicit reconciliation. Long-term archive bundles never enter automatic rotation.

## Verification

Both reviewers returned PASS on `a30488af520b89fbe8862373cde45404f474eeeb` after identical correction/regression probes. Final editorial cleanup aligned the store-ownership overview with its stopped-maintenance exception, moved the unchanged backup-policy write contract into the API table, and normalized settings-revision wording. Both then verified that fixed delta and returned PASS at final design head `271cb983099ed31a22745a9603911d1e71523073`, with no remaining material finding.

All 43 Markdown files passed links/heading-anchor, English prose, fences, heading-spacing, topic-index and whitespace checks. The final record-only commit does not change the reviewed design. No application/NAS/backup/restore runtime test has run, no live backup policy has been configured, and no collection or real backup was modified. Native adapters, permissions, bundle publication, secret exclusion, retention failure injection and actual restore drills remain implementation gates.
