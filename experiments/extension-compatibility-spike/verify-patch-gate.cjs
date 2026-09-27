const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const baseline = process.argv.includes('--baseline');
const read = (name) => JSON.parse(readFileSync(join(__dirname, 'results', `${name}.json`), 'utf8'));
const required = [
  'patch-matrix-app-only', 'patch-matrix-extension-only',
  'patch-matrix-both', 'patch-matrix-both-late',
  'stock-mv3-install-events', 'stock-mv3-restart-first',
  'stock-mv3-restart-second', 'stock-mv3-update-first',
  'stock-mv3-update-second', 'stock-mv3-alarm-awake',
  'stock-mv3-alarm-persist-first', 'stock-mv3-alarm-persist-second'
];
const summary = read('summary');
const expectedBinary = baseline
  ? resolve(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe')
  : resolve(process.env.VAST_SPIKE_ELECTRON || '');
if (!baseline) assert.ok(process.env.VAST_SPIKE_ELECTRON, 'Set VAST_SPIKE_ELECTRON to the custom build');
assert.equal(resolve(summary.electronBinary), expectedBinary);
for (const name of required) {
  const run = read(`${name}.run`);
  assert.equal(run.batchId, summary.batchId, `${name} is from a different run`);
  assert.equal(resolve(run.electronBinary), expectedBinary);
  assert.equal(run.code, 0, `${name} did not exit cleanly`);
  assert.equal(run.completed, true);
  assert.equal(read(name).versions.electron, '44.3.0');
}
const app = read('patch-matrix-app-only');
const extension = read('patch-matrix-extension-only');
const both = read('patch-matrix-both');
const bothLate = read('patch-matrix-both-late');
const hit = (result, name, websocket = false) => result.patchMatrix.serverHits.filter((entry) => entry.url === `/matrix?case=${name}` && Boolean(entry.websocket) === websocket);
const response = (result, name) => result.patchMatrix.responses.find((entry) => entry.testCase === name)?.response;
const extensionReport = (result) => result.reports.filter((entry) => entry.from === 'mv2-webrequest').at(-1)?.data;
const eventCount = (result, from, predicate = () => true) => result.reports.filter((entry) => entry.from === from && predicate(entry)).length;

for (const result of [app, extension, both, bothLate]) {
  assert.equal(result.completed, true);
  assert.equal(result.errors.length, 0);
  assert.equal(hit(result, 'allow').length, 1);
  assert.equal(response(result, 'allow').ok, true);
}
assert.equal(hit(app, 'vast-deny').length, 0);
assert.equal(hit(app, 'vast-target').length, 2);
assert.equal(hit(app, 'headers')[0].headers.vast, 'authoritative');
assert.deepEqual(response(app, 'headers').headers, { vast: 'authoritative', extension: null });
assert.equal(hit(app, 'vast-deny', true).length, 0);
assert.equal(hit(extension, 'extension-cancel').length, 0);
assert.equal(hit(extension, 'extension-target').length, 2);
assert.equal(hit(extension, 'headers')[0].headers.extension, 'present');
assert.deepEqual(response(extension, 'headers').headers, { vast: null, extension: 'present' });
assert.equal(hit(extension, 'extension-cancel', true).length, 0);
assert.ok(extensionReport(extension).urls.some((url) => url.includes('/matrix?case=allow')));

if (baseline) {
  assert.equal(hit(both, 'vast-deny').length, 0);
  assert.equal(hit(both, 'extension-cancel').length, 1);
  assert.equal(hit(both, 'extension-redirect').length, 1);
  assert.equal(hit(both, 'vast-target').length, 2);
  assert.equal(hit(both, 'headers')[0].headers.extension, null);
  assert.deepEqual(response(both, 'headers').headers, { vast: 'authoritative', extension: null });
  assert.equal(hit(both, 'extension-cancel', true).length, 1);
  assert.equal(extensionReport(both).beforeRequest, 0);
  assert.equal(hit(bothLate, 'vast-deny').length, 1);
  assert.equal(hit(bothLate, 'extension-target').length, 2);
  assert.equal(hit(bothLate, 'headers')[0].headers.vast, null);
  assert.equal(hit(bothLate, 'headers')[0].headers.extension, 'present');
  assert.deepEqual(response(bothLate, 'headers').headers, { vast: null, extension: 'present' });
  assert.equal(hit(bothLate, 'vast-deny', true).length, 0);
  const install = read('stock-mv3-install-events');
  assert.deepEqual(install.reports.find((entry) => entry.from === 'sw-listeners')?.data, { alarm: true, installed: true, startup: true });
  const restartFirst = read('stock-mv3-restart-first');
  const restartSecond = read('stock-mv3-restart-second');
  const alarmAwake = read('stock-mv3-alarm-awake');
  const updateFirst = read('stock-mv3-update-first');
  const updateSecond = read('stock-mv3-update-second');
  const persistFirst = read('stock-mv3-alarm-persist-first');
  const persistSecond = read('stock-mv3-alarm-persist-second');
  assert.equal(eventCount(install, 'runtime-onInstalled'), 0);
  assert.equal(eventCount(install, 'storage-onChanged'), 0);
  assert.equal(eventCount(restartSecond, 'runtime-onStartup'), 0);
  assert.equal(eventCount(updateSecond, 'runtime-onInstalled'), 0);
  assert.equal(updateFirst.extension.id, updateSecond.extension.id);
  assert.equal(updateSecond.extension.version, '2.0.0');
  assert.equal(eventCount(alarmAwake, 'alarms-onAlarm'), 0);
  assert.equal(eventCount(persistSecond, 'alarms-onAlarm', (entry) => entry.data.name === 'persist-probe'), 0);
  assert.equal(restartFirst.profile, restartSecond.profile);
  assert.equal(persistFirst.profile, persistSecond.profile);
  console.log('Stock Electron 44.3.0 baseline confirmed: webRequest routes are exclusive; alarm and runtime lifecycle events are absent.');
  process.exit(0);
}

assert.equal(hit(both, 'vast-deny').length, 0);
assert.equal(response(extension, 'auth-extension').body, 'auth:extension');
const neither = read('patch-matrix-neither');
const neitherRun = read('patch-matrix-neither.run');
assert.equal(neitherRun.batchId, summary.batchId);
assert.equal(neitherRun.code, 0);
assert.equal(neither.completed, true);
assert.equal(neither.errors.length, 0);
assert.equal(hit(neither, 'allow').length, 1);
assert.equal(hit(neither, 'allow', true).length, 1);
assert.equal(hit(both, 'extension-cancel').length, 0);
assert.equal(hit(both, 'extension-redirect-denied').length, 0);
assert.equal(hit(both, 'vast-target').length, 2);
assert.equal(hit(both, 'extension-target').length, 1);
assert.equal(hit(both, 'headers').length, 1);
assert.equal(hit(both, 'headers')[0].headers.vast, 'authoritative');
assert.equal(hit(both, 'headers')[0].headers.extension, 'present');
assert.deepEqual(response(both, 'headers').headers, { vast: 'authoritative', extension: 'present' });
assert.ok(response(both, 'extension-redirect-denied').error);
assert.equal(response(both, 'auth-extension').body, 'auth:extension');
assert.equal(response(both, 'auth-vast').body, 'auth:vast');
assert.notEqual(response(both, 'auth-vast-cancel').body, 'auth:extension');
assert.equal(hit(both, 'vast-deny', true).length, 0);
assert.equal(hit(both, 'extension-cancel', true).length, 0);
assert.equal(hit(both, 'allow', true).length, 1);
assert.ok(extensionReport(both).urls.some((url) => url.includes('/matrix?case=allow')));
assert.equal(extensionReport(both).completedUrls.filter((url) => url.includes('/matrix?case=allow')).length, 1);
assert.equal(extensionReport(both).errorUrls.filter((url) => url.includes('/matrix?case=extension-cancel')).length, 1);
assert.equal(extensionReport(both).urls.filter((url) => url.includes('/matrix?case=vast-deny')).length, 0);
assert.ok(extensionReport(both).urls.some((url) => url.includes('ws://') && url.includes('/matrix?case=allow')));
assert.ok(both.mainWebRequest.seenUrls.some((url) => url.includes('/matrix?case=allow')));
assert.equal(hit(bothLate, 'vast-deny').length, 0);
assert.equal(hit(bothLate, 'extension-cancel').length, 0);
assert.equal(hit(bothLate, 'extension-redirect-denied').length, 0);
assert.equal(hit(bothLate, 'vast-target').length, 2);
assert.equal(hit(bothLate, 'headers')[0].headers.vast, 'authoritative');
assert.equal(hit(bothLate, 'headers')[0].headers.extension, 'present');
assert.deepEqual(response(bothLate, 'headers').headers, { vast: 'authoritative', extension: 'present' });
assert.ok(response(bothLate, 'extension-redirect-denied').error);
assert.equal(response(bothLate, 'auth-extension').body, 'auth:extension');
assert.equal(response(bothLate, 'auth-vast').body, 'auth:vast');
assert.notEqual(response(bothLate, 'auth-vast-cancel').body, 'auth:extension');
assert.equal(hit(bothLate, 'vast-deny', true).length, 0);
assert.equal(hit(bothLate, 'extension-cancel', true).length, 0);
const install = read('stock-mv3-install-events');
assert.deepEqual(install.reports.find((entry) => entry.from === 'sw-listeners')?.data, { alarm: true, installed: true, startup: true });
const restartFirst = read('stock-mv3-restart-first');
const restartSecond = read('stock-mv3-restart-second');
const alarmAwake = read('stock-mv3-alarm-awake');
const updateFirst = read('stock-mv3-update-first');
const updateSecond = read('stock-mv3-update-second');
const persistFirst = read('stock-mv3-alarm-persist-first');
const persistSecond = read('stock-mv3-alarm-persist-second');
assert.equal(eventCount(install, 'runtime-onInstalled', (entry) => entry.data?.reason === 'install'), 1);
assert.ok(eventCount(install, 'storage-onChanged', (entry) => entry.data?.newValue === 'sw') >= 1);
assert.equal(eventCount(restartFirst, 'runtime-onInstalled', (entry) => entry.data?.reason === 'install'), 1);
assert.equal(eventCount(restartSecond, 'runtime-onStartup'), 1);
assert.equal(eventCount(restartSecond, 'runtime-onInstalled'), 0);
assert.equal(updateFirst.extension.id, updateSecond.extension.id);
assert.equal(updateSecond.extension.version, '2.0.0');
assert.equal(eventCount(updateSecond, 'runtime-onInstalled', (entry) => entry.data?.reason === 'update' && entry.data?.previousVersion === '1.0.0'), 1);
assert.equal(eventCount(updateSecond, 'runtime-onStartup'), 0);
assert.equal(eventCount(alarmAwake, 'alarms-onAlarm', (entry) => entry.data.name === 'probe'), 1);
assert.equal(eventCount(persistSecond, 'alarms-onAlarm', (entry) => entry.data.name === 'persist-probe'), 1);
assert.equal(restartFirst.profile, restartSecond.profile);
assert.equal(persistFirst.profile, persistSecond.profile);
console.log('Network patch gate passed for HTTP and WebSocket baseline cases.');
