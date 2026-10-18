# Henshin Product and Technical Design

Henshin organizes a NAS collection into a searchable library with updatable metadata. Desktop clients connect to a local or remote server and open NAS files directly through their own path mappings. The server maintains the index, EH information, and open history.

## Design Status

The design is split by topic so each area can be discussed and refined independently. The detailed behavioral baseline remains distinct from executable implementation and runtime validation. Confirmed requirements and proposed defaults are distinguished in the product scope; empirical choices and acceptance evidence are tracked by the delivery gates.

The confirmed desktop stack is Electron + React + TypeScript. Effect is preferred for frontend and server application logic; the proposed backend combines Node.js, Effect's HTTP stack, and SQLite. Specific package versions and adapters remain subject to integration validation. NAS storage is independent of server deployment, and each device resolves the same files through its own root mappings. There is no built-in reader or content-transfer requirement.

## Topic Documents

| Topic | Document | Owns |
| --- | --- | --- |
| Product | [Product scope and scenarios](design/product-scope.md) | Requirements, defaults, release boundaries, representative scenarios |
| Architecture | [Architecture and deployment](design/architecture.md) | Component and process responsibilities, technologies, deployment |
| Application logic | [Application logic with Effect](design/application-logic.md) | Services, runtimes, frontend integration, errors, resource lifetimes |
| Entry lifecycle | [Entry identity and file lifecycle](design/entry-identity.md) | Identity retention, replacement decisions, relocation evidence, copies, retained history |
| File locations | [Storage roots and path mappings](design/path-mapping.md) | Logical locations, per-device mappings, path resolution |
| Indexing | [File indexing and thumbnails](design/file-indexing.md) | Entry discovery, change detection, relocation, covers |
| Persistence | [Data model and persistence](design/data-model.md) | Identity, relationships, lifecycle constraints, server/client-local storage, journal transactions, migrations and retention |
| EH integration | [EH metadata, bindings, and local overrides](design/eh-metadata.md) | Matching, bindings, updates, overrides, translations |
| Search | [Search, filtering, and result ordering](design/search.md) | Query semantics, tag selection, filters, sorting, pagination, language support, index correctness |
| Reading | [External readers and open history](design/external-reading.md) | Reader profiles, identity-checked launch, accepted-handoff counting, local durability, crash recovery and event ownership |
| Consistency | [Cross-device consistency and instance lifecycle](design/synchronization.md) | Concurrent edits, reconnects, event delivery, authority epochs, migration, cloning, restore |
| UI | [User interface and journeys](design/user-interface.md) | Screens, navigation, setup, actions, visible states |
| Contracts and execution | [API contracts and background tasks](design/api-and-tasks.md) | Requests and responses, task transitions, retries, notifications |
| Delivery | [Delivery and validation](design/delivery-and-validation.md) | Implementation phases, acceptance criteria, platform checks |

[The domain glossary](../CONTEXT.md) defines shared terminology. Topic documents describe behavior and implementation choices without duplicating those definitions.

## Refinement Order

1. Establish product scenarios and resolve indexing, path, and entry-identity rules together, including replacement at an unchanged path and preservation of the previous edition's records.
2. Detail metadata precedence, search behavior, reader integration, and cross-device consistency.
3. Develop UI journeys against those rules, using concrete normal and failure scenarios.
4. Define schemas, API contracts, and task state transitions; run focused investigations for uncertain platform or library behavior.
5. Update implementation phases and acceptance cases with the resulting decisions and evidence.

Keep each rule in its owning topic and link to it from dependent topics. Update related documents when a decision changes their contract. Do not silently promote a proposed default or open question into a confirmed requirement.

## Reference Projects

| Source | Relevant behavior | Henshin's approach |
| --- | --- | --- |
| [exhentai-manga-manager](https://github.com/SchneeHertz/exhentai-manga-manager) | Directory indexing, tag management, external readers, desktop interaction | Borrow feature organization while separating the server from local reader launch |
| [LANraragi](https://github.com/Difegue/LANraragi) | Server-side archiving, metadata plugins, client API | Borrow background-processing responsibilities; implement only EH as a source initially |
| [LANraragi EH plugin](https://github.com/Difegue/LANraragi/blob/dev/lib/LANraragi/Plugin/Metadata/EHentai.pm) | URL, gallery ID, image-hash, and title search workflows | Require candidate confirmation rather than binding an ambiguous match to the first result |
| [HappyPanda X settings](https://happypandax.github.io/settings.html) | Client/server settings, metadata queues, external reader configuration | Configure readers on each client device; the linked documentation describes an older version |
| [Komga scanning and metadata processing](https://komga.org/docs/guides/scan-analysis-refresh/) | Separation of scanning, analysis, and metadata refresh | Schedule file-change processing separately from EH updates |

Reference projects inform product behavior and workflows. They do not imply direct code reuse or adoption of their runtime dependencies.
