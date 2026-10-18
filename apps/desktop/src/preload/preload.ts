import { contextBridge, ipcRenderer } from "electron"
import { IpcChannels } from "@henshin/contracts/channels"

/**
 * Narrow preload surface. It exposes only the enumerated prototype operations,
 * never `ipcRenderer`, a generic fetch, or any URL/path/credential capability.
 */
contextBridge.exposeInMainWorld("henshinPrototype", {
  handshake: () => ipcRenderer.invoke(IpcChannels.handshake, {}),
  getNote: (noteId: string) => ipcRenderer.invoke(IpcChannels.getNote, { note_id: noteId }),
  editNote: (input: {
    readonly note_id: string
    readonly text: string
    readonly expected_revision: string
    readonly operation_id: string
  }) => ipcRenderer.invoke(IpcChannels.editNote, input)
})
