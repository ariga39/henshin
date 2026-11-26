import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPackage } from '@electron/asar';
import { build } from 'electron-builder';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, '../..');
const pkg = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
if (!['darwin', 'win', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
  throw new Error(`Unsupported native desktop packaging target: ${platform}-${arch}`);
}
if (platform !== 'darwin' && arch !== 'x64') throw new Error(`Unsupported native desktop target: ${platform}-${arch}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: appDir, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

run(process.execPath, ['build.mjs']);
await build({ projectDir: appDir });

const ext = platform === 'linux' ? 'AppImage' : 'zip';
const artifactPlatform = platform === 'darwin' ? 'darwin' : platform === 'win' ? 'windows' : 'linux';
const artifact = path.join(repoRoot, 'dist/release', `Henshin-${pkg.version}-${artifactPlatform}-${arch}.${ext}`);
const checksum = createHash('sha256').update(await readFile(artifact)).digest('hex');
await writeFile(`${artifact}.sha256`, `${checksum}  ${path.basename(artifact)}\n`);
const checksumLine = (await readFile(`${artifact}.sha256`, 'utf8')).trim();
const [recordedChecksum, recordedArchive] = checksumLine.split(/\s+/, 2);
if (recordedChecksum !== checksum || recordedArchive !== path.basename(artifact)) {
  throw new Error('Desktop archive checksum sidecar does not match the archive');
}

const unpack = await mkdtemp(path.join(tmpdir(), 'henshin-desktop-smoke-'));
const userData = path.join(unpack, 'synthetic-user-data');
await import('node:fs/promises').then(fs => fs.mkdir(userData, { recursive: true }));
try {
  let appPath;
  let signingStatus;
  if (platform === 'darwin') {
    run('ditto', ['-x', '-k', artifact, unpack]);
    appPath = path.join(unpack, 'Henshin.app');
    signingStatus = reportMacSigning(appPath);
  } else if (platform === 'win') {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${artifact}' -DestinationPath '${unpack}' -Force`]);
    appPath = await findNamedFile(unpack, 'Henshin.exe');
    if (!appPath) throw new Error('Windows archive did not contain Henshin.exe');
    signingStatus = reportWindowsSigning(appPath);
  } else {
    run(artifact, ['--appimage-extract'], { cwd: unpack });
    await import('node:fs/promises').then(fs => fs.rename(path.join(unpack, 'squashfs-root'), path.join(unpack, 'appimage-root')));
    appPath = artifact;
    signingStatus = inspectAppImageSigning(artifact);
  }
  await writeFile(`${artifact}.signing-status.txt`, `${signingStatus}\n`);

  const bundledServer = await findServerFiles(unpack);
  if (bundledServer.length) throw new Error(`Desktop artifact contains a server binary: ${bundledServer.join(', ')}`);
  const asarFiles = await findAsarFiles(unpack);
  const bundledInAsar = asarFiles.flatMap(file => listPackage(file).filter(name => ['henshin-server', 'henshin-server.exe'].includes(path.posix.basename(name))));
  if (bundledInAsar.length) throw new Error(`Desktop app.asar contains a server binary: ${bundledInAsar.join(', ')}`);
  const executable = platform === 'darwin' ? path.join(appPath, 'Contents/MacOS/Henshin') : appPath;
  await smoke(executable, userData, unpack, platform);
  process.stdout.write(`Desktop artifact: ${artifact}\nChecksum: ${artifact}.sha256\nNative runtime smoke: passed (${platform}-${arch})\n`);
} finally {
  await rm(unpack, { recursive: true, force: true });
}

async function findServerFiles(dir) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name === 'henshin-server' || entry.name === 'henshin-server.exe') found.push(target);
    }
  }
  await walk(dir);
  return found;
}

async function findNamedFile(dir, fileName) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === fileName) return target;
    if (entry.isDirectory()) {
      const found = await findNamedFile(target, fileName);
      if (found) return found;
    }
  }
}

async function findAsarFiles(dir) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name === 'app.asar') found.push(target);
    }
  }
  await walk(dir);
  return found;
}

async function smoke(executable, userDataDir, cwd, targetPlatform) {
  const args = ['--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`];
  const command = targetPlatform === 'linux' && !process.env.DISPLAY ? 'xvfb-run' : executable;
  const commandArgs = command === 'xvfb-run' ? ['-a', executable, ...args] : args;
  const child = spawn(command, commandArgs, {
    cwd,
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
    stdio: 'ignore',
  });
  let startupError;
  child.once('error', error => { startupError = error; });
  await new Promise(resolve => setTimeout(resolve, 5000));
  try {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`Packaged Electron app exited during startup with status ${child.exitCode}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref();
    });
  }
}

function reportMacSigning(appPath) {
  const result = spawnSync('codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
  const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0 && /Signature=adhoc/i.test(details)) {
    const status = 'macOS code signing status: ad hoc; extracted Henshin.app passed codesign --verify --deep --strict. Not Developer ID signed or notarized.';
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
    process.stdout.write(`Signing status: ad hoc (codesign inspection and strict verification)\n`);
    return status;
  } else {
    throw new Error(`Expected an ad hoc signed macOS app bundle; codesign inspection reported: ${details.trim() || `exit ${result.status}`}`);
  }
}

function reportWindowsSigning(executable) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$signature = Get-AuthenticodeSignature -LiteralPath '${executable}'; if ($signature.SignerCertificate) { "$($signature.Status): $($signature.SignerCertificate.Subject)" } else { "$($signature.Status): no signer certificate" }`], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Authenticode inspection failed: ${result.stderr}`);
  const status = `Windows Authenticode status: ${result.stdout.trim()} (inspected with Get-AuthenticodeSignature).`;
  process.stdout.write(`Signing status: ${status}\n`);
  return status;
}

function inspectAppImageSigning(artifact) {
  const result = spawnSync(artifact, ['--appimage-signature'], { encoding: 'utf8', env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' } });
  if (result.status === 0 && result.stdout.trim()) {
    const status = `AppImage signing status: embedded signature metadata present (${result.stdout.trim()}); no signing identity is configured by this build.`;
    process.stdout.write(`Signing status: ${status}\n`);
    return status;
  }
  if (result.status !== 0 && /no signature|not signed|no embedded signature/i.test(`${result.stdout}\n${result.stderr}`)) {
    const status = 'AppImage signing status: unsigned (AppImage runtime reports no embedded signature).';
    process.stdout.write(`Signing status: ${status}\n`);
    return status;
  }
  throw new Error(`Could not inspect AppImage signature metadata: ${result.stderr || result.stdout || `exit ${result.status}`}`);
}
