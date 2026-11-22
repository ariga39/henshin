import { contextBridge, ipcRenderer } from "electron"
import { IpcChannels } from "@henshin/contracts/channels"

contextBridge.exposeInMainWorld("henshinRootPreview", {
  preview: (path: string) => ipcRenderer.invoke(IpcChannels.rootPreview, { path }),
  list: () => ipcRenderer.invoke(IpcChannels.rootList, {}),
  save: (input: {
    readonly operation_id: string
    readonly instance_id: string
    readonly epoch: string
    readonly label: string
    readonly path: string
    readonly preview_identity: {
      readonly canonical_server_path: string
      readonly device: string
      readonly inode: string
    }
  }) => ipcRenderer.invoke(IpcChannels.rootSave, input)
})

if (new URLSearchParams(window.location.search).get("mode") === "prototype") {
  contextBridge.exposeInMainWorld("henshinPrototype", {
    handshake: () => ipcRenderer.invoke(IpcChannels.handshake, {}),
    connect: () => ipcRenderer.invoke(IpcChannels.connect, {}),
    disconnect: () => ipcRenderer.invoke(IpcChannels.disconnect, {}),
    connectionStatus: () => ipcRenderer.invoke(IpcChannels.connectionStatus, {}),
    getNote: (noteId: string) => ipcRenderer.invoke(IpcChannels.getNote, { note_id: noteId }),
    editNote: (input: {
      readonly note_id: string
      readonly text: string
      readonly expected_revision: string
      readonly base_epoch: string
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
