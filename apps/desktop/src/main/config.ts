import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ReaderProfile = { id: string; name: string; mode: 'executable' | 'system'; executable?: string; args: string[]; isDefault: boolean };
export type DesktopConfig = { connection: { url: string; token: string }; mappings: Record<string, string>; readers: ReaderProfile[] };
export const emptyConfig = (): DesktopConfig => ({ connection: { url: '', token: '' }, mappings: {}, readers: [] });

export function connectionForSave(
  current: DesktopConfig['connection'],
  next: DesktopConfig['connection'],
): DesktopConfig['connection'] {
  const url = next.url.trim();
  let sameOrigin = false;
  try {
    sameOrigin = new URL(current.url).origin === new URL(url).origin;
  } catch {
    sameOrigin = false;
  }

  return {
    url,
    token: next.token || (sameOrigin ? current.token : ''),
  };
}

export async function readConfig(userData: string): Promise<DesktopConfig> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(userData, 'desktop-config.json'), 'utf8'));
    if (!value || typeof value !== 'object') throw new Error('desktop-config.json must contain an object');
    const v = value as Partial<DesktopConfig>;
    if (!v.connection || typeof v.connection.url !== 'string' || typeof v.connection.token !== 'string' || !v.mappings || typeof v.mappings !== 'object' || !Array.isArray(v.readers)) throw new Error('desktop-config.json has an invalid shape');
    return { connection: { ...v.connection }, mappings: { ...v.mappings }, readers: v.readers };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
    throw new Error(`Could not read desktop-config.json: ${(error as Error).message}`);
  }
}

export async function writeConfig(userData: string, config: DesktopConfig): Promise<void> {
  await mkdir(userData, { recursive: true });
  const target = path.join(userData, 'desktop-config.json');
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(temporary, 0o600);
  await rename(temporary, target);
  if (process.platform !== 'win32') await chmod(target, 0o600);
}
