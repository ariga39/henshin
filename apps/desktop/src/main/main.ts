import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { emptyConfig, readConfig, writeConfig, type DesktopConfig } from './config.js';
import { request, serverApiUrl } from './api.js';
import { resolveLocalPath } from './paths.js';
import { launchReader } from './reader.js';

protocol.registerSchemesAsPrivileged([{ scheme: 'henshin-cover', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let config: DesktopConfig;
const persist = async () => writeConfig(app.getPath('userData'), config);
const createWindow = () => {
  const window = new BrowserWindow({ width: 1240, height: 820, minWidth: 850, minHeight: 600, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  void window.loadFile(path.join(__dirname, 'index.html'));
};

app.whenReady().then(async () => {
  try { config = await readConfig(app.getPath('userData')); }
  catch (error) {
    config = emptyConfig();
    await dialog.showMessageBox({ type: 'error', title: 'Henshin configuration could not be read', message: (error as Error).message, detail: 'The app will open with empty settings. Save the connection and local settings to replace the damaged configuration.' });
  }
  protocol.handle('henshin-cover', async (requestUrl) => {
    const key = new URL(requestUrl.url).hostname;
    if (!key || key.includes('/') || key.includes('\\') || key.includes('..')) return new Response('Invalid cover key', { status: 400 });
    if (!config.connection.url || !config.connection.token) return new Response('Not configured', { status: 401 });
    try {
      const coverUrl = serverApiUrl(config.connection.url, `/api/covers/${encodeURIComponent(key)}`);
      const response = await fetch(coverUrl, { headers: { Authorization: `Bearer ${config.connection.token}` } });
      return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'image/jpeg' } });
    } catch { return new Response('Could not reach the Henshin server', { status: 503 }); }
  });
  ipcMain.handle('config:get', () => ({ connection: { url: config.connection.url, tokenConfigured: !!config.connection.token }, mappings: config.mappings, readers: config.readers }));
  ipcMain.handle('config:save', async (_event, value: DesktopConfig) => { config = { ...value, connection: { url: value.connection.url.trim(), token: value.connection.token || config.connection.token }, mappings: value.mappings, readers: value.readers }; await persist(); return { connection: { url: config.connection.url, tokenConfigured: !!config.connection.token }, mappings: config.mappings, readers: config.readers }; });
  ipcMain.handle('api:request', async (_event, endpoint: string, method = 'GET', body?: unknown) => request(config.connection, endpoint, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  ipcMain.handle('dialog:directory', async () => (await dialog.showOpenDialog({ properties: ['openDirectory'] })).filePaths[0] ?? null);
  ipcMain.handle('dialog:executable', async () => (await dialog.showOpenDialog({ properties: ['openFile'] })).filePaths[0] ?? null);
  ipcMain.handle('root:map', async (_event, rootId: string, folder: string) => { config.mappings[rootId] = folder; await persist(); return config.mappings; });
  ipcMain.handle('reader:save', async (_event, readers) => { config.readers = readers; await persist(); return config.readers; });
  ipcMain.handle('entry:open', async (_event, entry) => {
    const reader = config.readers.find(candidate => candidate.id === entry.readerId) ?? config.readers.find(candidate => candidate.isDefault);
    if (!reader) throw new Error('Add or select a reader in Settings first.');
    const file = await resolveLocalPath(config.mappings, entry.rootId, entry.relativePath);
    await launchReader(reader, file, filePath => shell.openPath(filePath));
    try {
      const stats = await request<{ openCount: number; lastOpenedAt: number }>(config.connection, `/api/entries/${encodeURIComponent(entry.id)}/open`, { method: 'POST', body: JSON.stringify({ eventId: randomUUID(), openedAt: Math.floor(Date.now() / 1000) }) });
      return { stats };
    } catch (error) { return { warning: `Reader opened, but the server did not record this open: ${(error as Error).message}` }; }
  });
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
