const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const electron = process.env.VAST_SPIKE_ELECTRON;
if (!electron || !existsSync(electron)) {
  console.error('Set VAST_SPIKE_ELECTRON to the built patched electron.exe');
  process.exit(2);
}

const spike = resolve(__dirname, '..', 'extension-compatibility-spike');
const scenarios = [
  'patch-matrix-app-only',
  'patch-matrix-neither',
  'patch-matrix-extension-only',
  'patch-matrix-both',
  'patch-matrix-both-late',
  'stock-mv3-install-events',
  'stock-mv3-restart',
  'stock-mv3-update',
  'stock-mv3-alarm-awake',
  'stock-mv3-alarm-persist'
];
const env = {
  ...process.env,
  VAST_SPIKE_ELECTRON: resolve(electron),
  VAST_SPIKE_SKIP_CWS: '1'
};

for (const [script, args] of [
  ['run-matrix.cjs', [scenarios.join(',')]],
  ['verify-patch-gate.cjs', []]
]) {
  const result = spawnSync(process.execPath, [join(spike, script), ...args], {
    cwd: spike,
    env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
