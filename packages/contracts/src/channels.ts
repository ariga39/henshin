/**
 * IPC channel names, kept in a dependency-free module so the Electron preload
 * can import them without pulling the HTTP client graph.
 */
export const IpcChannels = {
  handshake: "henshin-prototype:handshake",
  getNote: "henshin-prototype:get-note",
  editNote: "henshin-prototype:edit-note",
  saveDraft: "henshin-prototype:save-draft",
  loadDraft: "henshin-prototype:load-draft",
  discardDraft: "henshin-prototype:discard-draft"
} as const
