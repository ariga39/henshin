import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export function relativePathParts(
  relativePath: string,
  platform = process.platform,
): string[] {
  const windows = platform === 'win32';
  if (
    !relativePath ||
    relativePath.includes('\0') ||
    path.posix.isAbsolute(relativePath) ||
    (windows &&
      (relativePath.includes('\\') || path.win32.isAbsolute(relativePath)))
  ) {
    throw new Error('The server returned an unsafe relative file path.');
  }

  const pieces = relativePath.split('/');
  if (
    pieces.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        (windows && /^[a-zA-Z]:/.test(part)),
    )
  ) {
    throw new Error('The server returned an unsafe relative file path.');
  }
  return pieces;
}

export async function resolveLocalPath(mappings: Record<string, string>, rootId: string, relativePath: string): Promise<string> {
  const root = mappings[rootId];
  if (!root) throw new Error('This server root has no local folder mapping. Configure it in Settings.');
  const pieces = relativePathParts(relativePath);
  const resolvedRoot = await realpath(root);
  const candidate = await realpath(path.join(resolvedRoot, ...pieces));
  const rel = path.relative(resolvedRoot, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    if (rel === '') { /* the mapped root itself is not a valid book */ }
    else throw new Error('The selected file resolves outside the mapped folder.');
  }
  if (!rel) throw new Error('The selected file is not inside the mapped folder.');
  if (!(await stat(candidate)).isFile()) throw new Error('The mapped path is not a file.');
  return candidate;
}
