/**
 * IPC channel names, kept in a dependency-free module so the Electron preload
 * can import them without pulling the HTTP client graph.
 */
export const IpcChannels = {
  rootPreview: "henshin:root-preview",
  rootList: "henshin:root-list",
  rootSave: "henshin:root-save",
  rootCommand: "henshin:root-command",
  readerProfileList: "henshin:reader-profile-list",
  readerSelectExecutable: "henshin:reader-select-executable",
  readerProfileSave: "henshin:reader-profile-save",
  librarySearch: "henshin:library-search",
  taskList: "henshin:task-list",
  reviewCandidates: "henshin:review-candidates",
  reviewCommand: "henshin:review-command",
  handshake: "henshin-prototype:handshake",
  connect: "henshin-prototype:connect",
  disconnect: "henshin-prototype:disconnect",
  connectionStatus: "henshin-prototype:connection-status",
  getNote: "henshin-prototype:get-note",
  editNote: "henshin-prototype:edit-note",
  saveDraft: "henshin-prototype:save-draft",
  loadDraft: "henshin-prototype:load-draft",
  discardDraft: "henshin-prototype:discard-draft",
  listCommandAttempts: "henshin-prototype:list-command-attempts",
  reconcileCommand: "henshin-prototype:reconcile-command",
  dismissCommand: "henshin-prototype:dismiss-command"
} as const
