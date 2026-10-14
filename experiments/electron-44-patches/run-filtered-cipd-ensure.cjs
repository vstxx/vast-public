#!/usr/bin/env node
// A local gclient CIPD adapter. It filters only the twelve verified updater
// test fixtures and preserves the unfiltered ensure input for inspection.
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { copyFileSync, mkdirSync } = require('node:fs');
const { resolve, join } = require('node:path');

const args = process.argv.slice(2);
const rootIndex = args.indexOf('-root');
const fileIndex = args.indexOf('-ensure-file');
const expectedRoot = process.env.VAST_CIPD_EXPECTED_ROOT;
const auditRoot = process.env.VAST_CIPD_AUDIT_DIR;
const cipdExe = process.env.VAST_CIPD_EXE;
if (args[0] !== 'ensure' || rootIndex < 0 || fileIndex < 0 ||
    !args[rootIndex + 1] || !args[fileIndex + 1] ||
    !expectedRoot || !auditRoot || !cipdExe ||
    resolve(args[rootIndex + 1]).toLowerCase() !== resolve(expectedRoot).toLowerCase()) {
  throw new Error('Unexpected CIPD command or checkout root; refusing to filter');
}

const runDir = join(resolve(auditRoot), randomUUID());
mkdirSync(runDir, { recursive: true });
const original = join(runDir, 'gclient.ensure');
const filtered = join(runDir, 'filtered.ensure');
copyFileSync(args[fileIndex + 1], original);
const filter = spawnSync(process.execPath, [join(__dirname, 'filter-testonly-updater-cipd.cjs'), original, filtered], {
  stdio: 'inherit', windowsHide: true
});
if (filter.error || filter.status !== 0) {
  throw filter.error || new Error(`CIPD filter failed with exit ${filter.status}; input retained at ${original}`);
}
args[fileIndex + 1] = filtered;
process.stdout.write(`CIPD input: ${original}\nCIPD filtered: ${filtered}\n`);
const ensured = spawnSync(resolve(cipdExe), args, { stdio: 'inherit', windowsHide: true });
if (ensured.error) throw ensured.error;
process.exitCode = ensured.status ?? 1;
