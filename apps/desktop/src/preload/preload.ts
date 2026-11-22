import { contextBridge, ipcRenderer } from "electron"
import { IpcChannels } from "@henshin/contracts/channels"

/**
 * Narrow preload surface. It exposes only the enumerated desktop operations,
 * never `ipcRenderer`, a generic fetch, or credentials.
 */
contextBridge.exposeInMainWorld("henshinRootPreview", {
  preview: (path: string) => ipcRenderer.invoke(IpcChannels.rootPreview, { path })
})

if (new URLSearchParams(window.location.search).get("mode") === "prototype") {
  contextBridge.exposeInMainWorld("henshinPrototype", {
    handshake: () => ipcRenderer.invoke(IpcChannels.handshake, {}),
    getNote: (noteId: string) => ipcRenderer.invoke(IpcChannels.getNote, { note_id: noteId }),
    editNote: (input: {
      readonly note_id: string
      readonly text: string
      readonly expected_revision: string
      readonly operation_id: string
    }) => ipcRenderer.invoke(IpcChannels.editNote, input),
    saveDraft: (input: {
      readonly note_id: string
      readonly form_id: string
      readonly text: string
      readonly expected_local_revision: string
      readonly base_server_revision: string
      readonly base_epoch: string
    }) => ipcRenderer.invoke(IpcChannels.saveDraft, input),
    loadDraft: (input: { readonly note_id: string; readonly form_id: string }) =>
      ipcRenderer.invoke(IpcChannels.loadDraft, input),
    discardDraft: (input: {
      readonly note_id: string
      readonly form_id: string
      readonly expected_local_revision: string
    }) => ipcRenderer.invoke(IpcChannels.discardDraft, input),
    listCommandAttempts: () => ipcRenderer.invoke(IpcChannels.listCommandAttempts, {}),
    reconcileCommand: (operationId: string) =>
      ipcRenderer.invoke(IpcChannels.reconcileCommand, { operation_id: operationId }),
    dismissCommand: (operationId: string) =>
      ipcRenderer.invoke(IpcChannels.dismissCommand, { operation_id: operationId })
  })
}
