import { spawn as nodeSpawn } from 'node:child_process';
import type { ReaderProfile } from './config.js';

export async function launchReader(reader: ReaderProfile, file: string, openPath: (file: string) => Promise<string>, spawnProcess = nodeSpawn): Promise<void> {
  if (reader.mode === 'system') {
    const error = await openPath(file);
    if (error) throw new Error(`Could not open the file with the system default app: ${error}`);
    return;
  }
  if (!reader.executable) throw new Error('Choose an executable for this reader in Settings.');
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(reader.executable!, [...reader.args, file], { detached: true, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
