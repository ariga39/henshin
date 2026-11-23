import { contextBridge, ipcRenderer } from "electron"
import type {
  LocalMappingActivateIpcRequest,
  LocalMappingListIpcRequest,
  LocalMappingPreviewIpcRequest,
  OpenBookIpcRequest,
  OpenBookStatusIpcRequest,
  ReaderProfileSaveIpcRequest,
  ReaderProfileTestIpcRequest,
  ReaderProfileTestTargetSelectIpcRequest,
  ReleaseHeldDiscoveryIpcRequest,
  ReviewCandidateIpcRequest,
  RootCommandIpcRequest,
  RootPreviewRequest,
  RootRegistrationRequest,
  RecoverOpenJournalIpcRequest,
  LibrarySearchIpcRequest,
  LibraryNoteIpcRequest
} from "@henshin/contracts"
import { IpcChannels } from "@henshin/contracts/channels"

contextBridge.exposeInMainWorld("henshinRootPreview", {
  preview: (input: RootPreviewRequest) =>
    ipcRenderer.invoke(IpcChannels.rootPreview, input),
  list: () => ipcRenderer.invoke(IpcChannels.rootList, {}),
  save: (input: RootRegistrationRequest) => ipcRenderer.invoke(IpcChannels.rootSave, input),
  command: (input: RootCommandIpcRequest) => ipcRenderer.invoke(IpcChannels.rootCommand, input)
})

contextBridge.exposeInMainWorld("henshinLocalMapping", {
  preview: (input: LocalMappingPreviewIpcRequest) =>
    ipcRenderer.invoke(IpcChannels.localMappingPreview, input),
  list: (input: LocalMappingListIpcRequest) =>
    ipcRenderer.invoke(IpcChannels.localMappingList, input),
  activate: (input: LocalMappingActivateIpcRequest) =>
    ipcRenderer.invoke(IpcChannels.localMappingActivate, input)
})

contextBridge.exposeInMainWorld("henshinScanReview", {
  listTasks: () => ipcRenderer.invoke(IpcChannels.taskList, {}),
  candidates: () => ipcRenderer.invoke(IpcChannels.reviewCandidates, {}),
  command: (input: ReviewCandidateIpcRequest) => ipcRenderer.invoke(IpcChannels.reviewCommand, input)
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
  search: (input: LibrarySearchIpcRequest) =>
    ipcRenderer.invoke(IpcChannels.librarySearch, input),
  entry: (input: { readonly entry_id: string }) =>
    ipcRenderer.invoke(IpcChannels.libraryEntry, input),
  note: (input: LibraryNoteIpcRequest) =>
    ipcRenderer.invoke(IpcChannels.libraryNote, input),
  open: (input: OpenBookIpcRequest) => ipcRenderer.invoke(IpcChannels.openBook, input),
  status: (input: OpenBookStatusIpcRequest) => ipcRenderer.invoke(IpcChannels.openBookStatus, input),
  onOpenStateChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on(IpcChannels.openStateChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.openStateChanged, handler)
  },
  getThumbnail: (key: string) => ipcRenderer.invoke(IpcChannels.thumbnailGet, { key })
})

contextBridge.exposeInMainWorld("henshinConnection", {
  connect: () => ipcRenderer.invoke(IpcChannels.connect, {}),
  disconnect: () => ipcRenderer.invoke(IpcChannels.disconnect, {}),
  connectionStatus: () => ipcRenderer.invoke(IpcChannels.connectionStatus, {})
})

contextBridge.exposeInMainWorld("henshinOpenJournal", {
  onChanged: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on(IpcChannels.openJournalChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.openJournalChanged, handler)
  },
  list: () => ipcRenderer.invoke(IpcChannels.listOpenJournal, {}),
  recover: (input: RecoverOpenJournalIpcRequest) =>
    ipcRenderer.invoke(IpcChannels.recoverOpenJournal, input)
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
