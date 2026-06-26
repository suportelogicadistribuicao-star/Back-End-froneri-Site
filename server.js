const { execFileSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

const distServerPath = join(__dirname, 'dist', 'server.js');

function buildProject() {
  execFileSync(process.execPath, ['build.mjs'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
}

buildProject();

if (!existsSync(distServerPath)) {
  throw new Error('Build finished, but dist/server.js was not created.');
}

require(distServerPath);