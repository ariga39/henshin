import { contextBridge, ipcRenderer } from 'electron';
import type { ReaderProfile } from '../main/config.js';

type ConfigView = {
  connection: { url: string; tokenConfigured: boolean };
  mappings: Record<string, string>;
  readers: ReaderProfile[];
};
type ConfigInput = {
  connection: { url: string; token?: string; tokenConfigured?: boolean };
  mappings: Record<string, string>;
  readers: ReaderProfile[];
};
type EntryToOpen = {
  id: string;
  rootId: string;
  relativePath: string;
  readerId: string;
};
type ReaderOpenResult = {
  stats?: { openCount: number; lastOpenedAt: number | null };
  warning?: string;
};

contextBridge.exposeInMainWorld('henshin', {
  getConfig: (): Promise<ConfigView> => ipcRenderer.invoke('config:get'),
  saveConfig: (config: ConfigInput): Promise<ConfigView> =>
    ipcRenderer.invoke('config:save', config),
  request: <T>(endpoint: string, method?: string, body?: unknown): Promise<T> =>
    ipcRenderer.invoke('api:request', endpoint, method, body),
  chooseDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:directory'),
  chooseExecutable: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:executable'),
  mapRoot: (rootId: string, folder: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke('root:map', rootId, folder),
  saveReaders: (readers: ReaderProfile[]): Promise<ReaderProfile[]> =>
    ipcRenderer.invoke('reader:save', readers),
  openEntry: (entry: EntryToOpen): Promise<ReaderOpenResult> =>
    ipcRenderer.invoke('entry:open', entry),
});
