import { contextBridge, ipcRenderer } from "electron"
import type {
  ReaderProfileSaveIpcRequest,
  ReaderProfileTestIpcRequest,
  ReaderProfileTestTargetSelectIpcRequest,
  ReleaseHeldDiscoveryIpcRequest,
  RootCommandIpcRequest,
  RootPreviewRequest,
  RootRegistrationRequest
} from "@henshin/contracts"
import { IpcChannels } from "@henshin/contracts/channels"

contextBridge.exposeInMainWorld("henshinRootPreview", {
  preview: (input: RootPreviewRequest) =>
    ipcRenderer.invoke(IpcChannels.rootPreview, input),
  list: () => ipcRenderer.invoke(IpcChannels.rootList, {}),
  save: (input: RootRegistrationRequest) => ipcRenderer.invoke(IpcChannels.rootSave, input),
  command: (input: RootCommandIpcRequest) => ipcRenderer.invoke(IpcChannels.rootCommand, input)
})

contextBridge.exposeInMainWorld("henshinScanReview", {
  listTasks: () => ipcRenderer.invoke(IpcChannels.taskList, {}),
  candidates: () => ipcRenderer.invoke(IpcChannels.reviewCandidates, {}),
  command: (input: ReleaseHeldDiscoveryIpcRequest) => ipcRenderer.invoke(IpcChannels.reviewCommand, input)
})

contextBridge.exposeInMainWorld("henshinReaderProfiles", {
  list: () => ipcRenderer.invoke(IpcChannels.readerProfileList, {}),
  selectExecutable: () => ipcRenderer.invoke(IpcChannels.readerSelectExecutable, {}),
  save: (input: ReaderProfileSaveIpcRequest) => ipcRenderer.invoke(IpcChannels.readerProfileSave, input),
  selectTestTarget: (input: ReaderProfileTestTargetSelectIpcRequest) =>
    ipcRenderer.invoke(IpcChannels.readerProfileTestTargetSelect, input),
  test: (input: ReaderProfileTestIpcRequest) => ipcRenderer.invoke(IpcChannels.readerProfileTest, input)
})

contextBridge.exposeInMainWorld("henshinLibrary", {
  search: (input: { readonly page_size?: number; readonly cursor?: string }) =>
    ipcRenderer.invoke(IpcChannels.librarySearch, input)
})

if (new URLSearchParams(window.location.search).get("mode") === "prototype") {
  contextBridge.exposeInMainWorld("henshinPrototype", {
    handshake: () => ipcRenderer.invoke(IpcChannels.handshake, {}),
    connect: () => ipcRenderer.invoke(IpcChannels.connect, {}),
    disconnect: () => ipcRenderer.invoke(IpcChannels.disconnect, {}),
    connectionStatus: () => ipcRenderer.invoke(IpcChannels.connectionStatus, {}),
    onOpenJournalChanged: (listener: () => void) => {
      const handler = () => listener()
      ipcRenderer.on(IpcChannels.openJournalChanged, handler)
      return () => ipcRenderer.removeListener(IpcChannels.openJournalChanged, handler)
    },
    listOpenJournal: () => ipcRenderer.invoke(IpcChannels.listOpenJournal, {}),
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
