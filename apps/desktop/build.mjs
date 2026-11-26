import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true }),
  build({ entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true }),
  build({ entryPoints: ['src/renderer/index.tsx'], outfile: 'dist/renderer.js', bundle: true, platform: 'browser', format: 'iife', sourcemap: true }),
  build({ entryPoints: ['src/main/config.test.ts', 'src/main/paths.test.ts', 'src/main/reader.test.ts', 'src/main/api.test.ts', 'src/main/externalLinks.test.ts', 'src/renderer/libraryState.test.ts'], outdir: 'dist/tests', bundle: true, platform: 'node', format: 'esm', entryNames: '[name]', external: ['electron'], sourcemap: true }),
]);
await cp('src/renderer/index.html', 'dist/index.html');
await cp('src/renderer/style.css', 'dist/style.css');
