import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/server.js',
  format: 'cjs',
  minify: false,
  sourcemap: false,
  external: [
    'fsevents', // módulo nativo Mac-only, não existe no Linux
  ],
  logLevel: 'info',
});
