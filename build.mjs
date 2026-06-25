import * as esbuild from 'esbuild';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

function collectTsFiles(dir, result = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, result);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      result.push(full.replace(/\\/g, '/'));
    }
  }
  return result;
}

const entryPoints = ['server.ts', ...collectTsFiles('src')];

await esbuild.build({
  entryPoints,
  bundle: false,
  platform: 'node',
  target: 'node18',
  outdir: 'dist',
  outbase: '.',
  format: 'cjs',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});
