import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = await readFile(path.join(root, 'server/Cargo.toml'), 'utf8');
const version = manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!version) throw new Error('Could not read server version from Cargo.toml');

const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
if (!['darwin', 'linux', 'windows'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
  throw new Error(`Unsupported native packaging target: ${platform}-${arch}`);
}
if (platform === 'windows' && arch !== 'x64') throw new Error(`Unsupported Windows packaging target: ${arch}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

run('cargo', ['build', '--release', '--locked'], { cwd: path.join(root, 'server') });

const binaryName = platform === 'windows' ? 'henshin-server.exe' : 'henshin-server';
const binary = path.join(root, 'server/target/release', binaryName);
const readme = path.join(root, 'README.md');
const releaseDir = path.join(root, 'dist/release');
await mkdir(releaseDir, { recursive: true });
const base = `henshin-server-${version}-${platform}-${arch}`;
const archive = path.join(releaseDir, `${base}.${platform === 'windows' ? 'zip' : 'tar.gz'}`);
const staging = await mkdtemp(path.join(tmpdir(), 'henshin-server-package-'));
try {
  await copyFile(binary, path.join(staging, binaryName));
  await copyFile(readme, path.join(staging, 'README.md'));
  if (platform === 'windows') {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -LiteralPath '${path.join(staging, binaryName)}','${path.join(staging, 'README.md')}' -DestinationPath '${archive}' -Force`]);
  } else {
    run('tar', ['-czf', archive, '-C', staging, binaryName, 'README.md']);
  }

  const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${checksum}  ${path.basename(archive)}\n`);

  const extracted = await mkdtemp(path.join(tmpdir(), 'henshin-server-smoke-'));
  try {
    if (platform === 'windows') {
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${extracted}' -Force`]);
    } else {
      run('tar', ['-xzf', archive, '-C', extracted]);
    }
    const extractedBinary = path.join(extracted, binaryName);
    await smoke(extractedBinary, extracted);
    if (platform === 'darwin') checkMacLinkage(extractedBinary);
    process.stdout.write(`Server artifact: ${archive}\nChecksum: ${archive}.sha256\nNative runtime smoke: passed (${platform}-${arch})\n`);
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function smoke(executable, cwd) {
  run(executable, ['--help'], { cwd });
  const port = 43000 + Math.floor(Math.random() * 15000);
  const dataDir = path.join(cwd, 'synthetic-data');
  const { spawn } = await import('node:child_process');
  const proc = spawn(executable, ['serve', '--data-dir', dataDir, '--listen', `127.0.0.1:${port}`, '--token', 'synthetic-ci-token'], {
    cwd,
    env: { ...process.env, RUST_LOG: 'error' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const deadline = Date.now() + 15000;
    let response;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`Extracted server exited early: ${stderr}`);
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          headers: { authorization: 'Bearer synthetic-ci-token' },
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!response?.ok) throw new Error(`Extracted server failed its health smoke: ${stderr}`);
    const health = await response.json();
    if (typeof health.serverId !== 'string' || !health.serverId || typeof health.version !== 'string') {
      throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
    }
  } finally {
    proc.kill('SIGTERM');
    await new Promise(resolve => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', resolve);
      setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3000).unref();
    });
  }
}

function checkMacLinkage(executable) {
  const result = spawnSync('otool', ['-L', executable], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`otool failed: ${result.stderr}`);
  const unexpected = result.stdout.split('\n').filter(line => /\(compatibility version/.test(line) && !/^\s*\/usr\/lib\//.test(line) && !/^\s*\/System\/Library\//.test(line));
  if (unexpected.length) throw new Error(`Unexpected non-system macOS linkage:\n${unexpected.join('\n')}`);
  process.stdout.write('macOS dynamic linkage: system libraries only\n');
}
