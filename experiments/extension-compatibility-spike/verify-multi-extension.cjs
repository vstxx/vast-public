const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const names = [
  'multi-baseline',
  'multi-bitwarden',
  'multi-protonpass',
  'multi-bitwarden-protonpass',
  'multi-bitwarden-adblocker',
  'multi-protonpass-adblocker',
  'multi-all-production-targets',
  'multi-ordinary-probes'
];
const root = join(__dirname, 'results');
const read = (name) => JSON.parse(readFileSync(join(root, `${name}.json`), 'utf8'));
const expectedBinary = resolve(process.env.VAST_SPIKE_ELECTRON || '');
assert.ok(process.env.VAST_SPIKE_ELECTRON, 'Set VAST_SPIKE_ELECTRON to the patched Electron binary.');

const totals = {};
for (const name of names) {
  const result = read(name);
  const run = read(`${name}.run`);
  assert.equal(resolve(run.electronBinary), expectedBinary, `${name}: wrong Electron binary`);
  assert.equal(run.code, 0, `${name}: non-zero exit`);
  assert.equal(run.completed, true, `${name}: incomplete run`);
  assert.equal(result.completed, true, `${name}: result incomplete`);
  assert.equal(result.errors.length, 0, `${name}: process errors`);
  assert.equal(result.crashDumpFiles.some((entry) => entry.toLowerCase().endsWith('.dmp')), false, `${name}: crash dump`);
  assert.equal(new Set(result.extensions.map((entry) => entry.id)).size, result.extensions.length, `${name}: duplicate extension IDs`);

  for (const isolated of result.multiExtension.isolation) {
    const expected = result.extensions.find((entry) => entry.name === isolated.name);
    assert.ok(expected, `${name}: missing extension metadata for ${isolated.name}`);
    assert.equal(isolated.runtimeId, expected.id, `${name}: runtime ID confusion for ${isolated.name}`);
    assert.equal(isolated.token, `${isolated.name}:${expected.id}`, `${name}: storage leakage for ${isolated.name}`);
  }
  for (const message of result.multiExtension.crossMessages) {
    assert.equal(message.response, null, `${name}: cross-extension response leaked ${message.sender} -> ${message.target}`);
    if (message.lastError) assert.match(message.lastError, /receiving end|does not exist|not allowed|not permitted/i, `${name}: unexpected cross-extension error`);
    if (message.error) assert.match(message.error, /receiving end|does not exist|not allowed|not permitted/i, `${name}: unexpected cross-extension rejection`);
  }
  assert.equal(result.reports.some((entry) => entry.from === 'cross-extension-received'), false, `${name}: a cross-extension probe reached another worker`);
  for (const reload of result.multiExtension.reloads) {
    const expected = result.extensions.find((entry) => entry.name === reload.name);
    assert.equal(reload.id, expected.id, `${name}: extension identity changed during reload`);
  }
  for (const restored of result.multiExtension.postReloadIsolation) {
    const expected = result.extensions.find((entry) => entry.name === restored.name);
    assert.equal(restored.runtimeId, expected.id, `${name}: runtime ID changed after reload`);
    assert.equal(restored.token, `${restored.name}:${expected.id}`, `${name}: storage did not survive reload`);
  }

  const samples = result.multiExtension.resourceSamples;
  assert.equal(samples.map((sample) => sample.label).join(','), 'loaded,after-popup-tab-cycles,after-reloads,after-idle', `${name}: resource samples missing`);
  const totalWorkingSet = (sample) => sample.processes.reduce((sum, process) => sum + process.workingSetSize, 0);
  const loadedMemory = totalWorkingSet(samples[0]);
  const idleMemory = totalWorkingSet(samples.at(-1));
  // This bounded smoke catches runaway growth while allowing Chromium caches
  // and real extension bundles to retain their normal first-use working set.
  assert.ok(idleMemory - loadedMemory < 350 * 1024, `${name}: working set grew by more than 350 MiB`);
  totals[name] = { loadedKiB: loadedMemory, idleKiB: idleMemory, deltaKiB: idleMemory - loadedMemory, processCount: samples.at(-1).processes.length };
}

const ordinary = read('multi-ordinary-probes');
assert.equal(ordinary.extensions.length, 2);
assert.equal(ordinary.serviceWorker.snapshots.find((entry) => entry.label === 'multi-after-load').workers.length, 2);
assert.equal(ordinary.serviceWorker.snapshots.find((entry) => entry.label === 'multi-after-reloads').workers.length, 2);

console.log(JSON.stringify({ ok: true, totals }, null, 2));
