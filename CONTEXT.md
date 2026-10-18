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

**Client Cache**: Thumbnails or metadata retained by a client to display the library. Direct NAS access does not require a downloaded content cache; clearing the cache does not delete library files.
