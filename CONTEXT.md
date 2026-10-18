# Henshin Library Domain

Henshin manages collection files and EH gallery information through desktop clients connected to a local or remote server, with reading handled by an external reader on the client device. File storage and server deployment are independent; the current use case has devices directly accessing the same files on a NAS.

## Language

**Library**: A collection of library entries and their source files managed by one server and organized across one or more storage roots. Multiple clients can access the same library.

**Storage Root**: A logical root directory containing collection files, such as a shared comics directory on a NAS, belonging to one library. Its identity is independent of server deployment and device mount paths.

**Path Mapping**: The access path for a storage root on a particular device. Devices can access the same files through different network paths or mount points.

**Library Entry**: An independently managed edition of content, with its own metadata associations and open history. Language editions and revisions are not treated as the same entry merely because their titles are similar.
_Avoid_: Using "EH Gallery" to refer to a library entry.

**Library File**: An archive or image directory containing collected content, potentially located on shared storage such as a NAS. Access from multiple devices does not imply a separate copy on each device.

**Replacement Candidate**: Newly observed content at an entry's location whose relationship to the indexed edition has not yet been resolved. It is not automatically the same edition or a new accepted entry.

**Detached Entry**: A retained library entry that no longer owns a current file location. Its metadata and open history still describe the previous edition.

**File Status**: The combination of an entry's identity state and the server's last observation of its file availability. It does not describe whether another device can currently access the file.

**EH Gallery**: A gallery published on E-Hentai/ExHentai and its site metadata. An EH gallery can be associated with multiple library entries, and a library entry may have no gallery match yet.

**Gallery Binding**: A confirmed association between a library entry and a specific EH gallery. A candidate search result is not a binding.

**Source Metadata**: Titles, namespaced tags, categories, upload information, and other descriptions retrieved from EH. It describes the online gallery and does not establish that a library file has the same page count, completeness, or edition.

**Local Override**: A user's custom title, tags, or other descriptive changes to a library entry. These changes are distinct from source metadata.

**Namespaced Tag**: A tag identified by its namespace and original text. A Chinese translation is a display and search alias, not a change to the tag's identity.

**Metadata Sync**: Updating source metadata for a bound EH gallery. It does not download content or automatically replace an older library file with a newer edition.

**Cross-device Sync**: Making consistent library information and personal records available across clients. Each client's path mappings are configured independently; sharing library information does not require copying content files.

**Open Event**: A record that a user handed a library entry to an external reader through Henshin and the operating system accepted the launch or open request. It does not establish actual reading, reading duration, or completion.

**Open Count**: The number of open events accumulated under a consistent counting policy.
_Avoid_: Read count, completion count.

**Display Cache (Client Cache)**: Bounded, evictable thumbnails and metadata retained for client display and eligible disconnected operations. It excludes the launch/event journal, saved drafts, and unresolved command attempts; clearing it never deletes those records or collection files. Direct NAS access does not require a downloaded content cache.

## Identity and Concurrency Terms

These terms summarize the owning contracts; they do not create additional state or counters.

**Identity State**: Accepted, replacement-pending, or detached status governing an entry's claim and Open eligibility; separate from whether a device can reach the file. See [entry lifecycle](docs/design/entry-identity.md).

**Availability Observation**: A device's time-stamped result of checking file access; the server's observation is not proof of client access. See [path mappings](docs/design/path-mapping.md).

**Staged Discovery**: A persisted observed candidate awaiting analysis/reconciliation or explicit allocation, not yet an accepted library entry. See [indexing](docs/design/file-indexing.md).

**Review Hold**: A persisted restriction preventing a staged target's automatic allocation/relocation until explicit release or resolution under current evidence. It is not a NAS file lock. See [indexing](docs/design/file-indexing.md).

**Fingerprint Profile**: A versioned definition of the bytes/names and serialization hashed for exact representation comparison. Different profiles are not comparable evidence. See [indexing](docs/design/file-indexing.md).

**Comparison Key**: A device-native filesystem comparison value used to detect equivalent or colliding paths, distinct from the original path and search normalization. See [path mappings](docs/design/path-mapping.md).

**Server Instance ID**: The persisted namespace for a sole authority and its records, preserved by migration/restore and changed for an independent clone; not an authentication credential. See [consistency](docs/design/synchronization.md).

**Authority Epoch**: A fresh unpredictable token for each server process start, used to reject stale command/view contexts without changing the instance namespace; not a restored counter. See [consistency](docs/design/synchronization.md).

**Device ID**: A random desktop-installation identity shared by its windows/connections and used for diagnostic event provenance, not authorization. See [consistency](docs/design/synchronization.md).

**Decision Revision (Entry Revision)**: The single per-entry edit fence advanced by identity decisions, binding changes and personal overrides; both names denote the same counter. See [persistence](docs/design/data-model.md).

**Location Revision and Content Version**: Separate per-entry versions for claim changes and accepted-representation changes. Exact-equality observation refresh may retain content version. See [entry lifecycle](docs/design/entry-identity.md).

**Library Change Revision**: A coarse signal that visible membership/order/projections changed, compared only within the current epoch; not an entry edit precondition. See [search](docs/design/search.md).

**Configuration Revisions and Generations**: Mapping/policy/profile/device-label edits have their own owner-specific revisions; scan/credential/request generations fence obsolete work. They are not aliases of the entry decision revision. See [persistence](docs/design/data-model.md) and [task contracts](docs/design/api-and-tasks.md).
