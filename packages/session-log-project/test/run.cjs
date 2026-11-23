const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (!process.env.DSH_NODE_EXECUTABLE || !process.env.DSH_INSTALL_DIR) throw new Error('Run tests from a DSH desktop session with its installed runtime.');
const files = fs.readdirSync(__dirname).filter(name => name.endsWith('.test.mjs')).map(name => path.join(__dirname, name));
const child = spawn(process.env.DSH_NODE_EXECUTABLE, ['--test', '--test-isolation=none', '--require', path.join(__dirname, 'installed-runtime.cjs'), ...files], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
