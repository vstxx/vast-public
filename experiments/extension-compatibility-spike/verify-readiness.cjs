const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (name) => JSON.parse(readFileSync(join(__dirname, 'results', `${name}.json`), 'utf8'));
const report = (result, from) => result.reports.find((entry) => entry.from === from)?.data;
const running = (result) => result.serviceWorker.snapshots.find((snapshot) => snapshot.label === 'after-load')?.workers.length;

const baselineWrapper = read('ece-polyfill-wrapper');
const patchedWrapper = read('ece-patched-polyfill-wrapper');
assert.equal(report(baselineWrapper, 'polyfill-wrapper').before.chromePermissionsOnAdded, 'object');
assert.equal(report(baselineWrapper, 'polyfill-wrapper').after.browserPermissionsOnAdded, 'undefined');
assert.equal(report(patchedWrapper, 'polyfill-wrapper').after.browserPermissionsOnAdded, 'object');
assert.equal(report(patchedWrapper, 'polyfill-wrapper').after.browserOnCommitted, 'object');

const proton = read('ece-patched-protonpass');
const keepassxc = read('ece-patched-keepassxc');
const bitwarden = read('ece-patched-bitwarden');
for (const result of [proton, keepassxc, bitwarden]) {
  assert.equal(result.completed, true);
  assert.equal(running(result), 1);
  assert.equal(result.page.https.loaded, true);
  assert.ok(result.page.https.executedExtensionScripts.length > 0);
}
assert.ok(!proton.serviceWorker.console.some((entry) => entry.message.includes('onAdded')));
assert.ok(!keepassxc.serviceWorker.console.some((entry) => entry.level === 3 && entry.message.includes('onCommitted')));

const permissions = read('ece-patched-permissions-grant');
assert.deepEqual(report(permissions, 'permissions-onAdded')?.permissions, ['bookmarks']);
assert.deepEqual(report(permissions, 'permissions-onRemoved')?.permissions, ['bookmarks']);

const late = read('ece-mv2-vast-webrequest-late');
assert.ok(late.mainWebRequest.registeredAfterFirstBeacon);
assert.ok(late.mainWebRequest.beforeRequest >= 3);
assert.ok(late.mainWebRequest.extensionCountAfterRegistration.beforeRequest >
  late.mainWebRequest.extensionCountBeforeRegistration.beforeRequest);
const policy = read('ece-mv2-policy-late');
const server = policy.reports.filter((entry) => entry.from === 'server-beacon').map((entry) => entry.data);
assert.ok(server.some((entry) => entry.url === '/beacon?deny'));
assert.ok(server.some((entry) => entry.url === '/beacon?redirect'));
assert.ok(server.some((entry) => entry.url === '/beacon?allowed' && entry.header === null));
assert.ok(policy.mainWebRequest.seenUrls.every((url) => !url.includes('/beacon?')));

for (const name of ['stock-mv3-lifecycle-70s', 'ece-mv3-lifecycle-70s']) {
  const result = read(name);
  assert.equal(result.completed, true);
  assert.equal(result.reports.some((entry) => entry.from === 'alarms-onAlarm'), false);
  assert.equal(result.reports.some((entry) => entry.from === 'runtime-onInstalled'), false);
}

const alarm = read('stock-mv3-alarm-consumption');
assert.equal(alarm.completed, true);
assert.ok(alarm.reports.some((entry) => entry.from === 'sw' &&
  entry.data.functional.alarmsGetAll?.result?.some((item) => item.name === 'probe')));
assert.deepEqual(alarm.lifecycle.alarmsAt130s, []);
assert.equal(alarm.reports.some((entry) => entry.from === 'alarms-onAlarm'), false);

for (const mode of ['stock', 'ece']) {
  const first = read(`${mode}-mv3-restart-first`);
  const second = read(`${mode}-mv3-restart-second`);
  assert.equal(first.completed, true);
  assert.equal(second.completed, true);
  assert.equal(first.profile, second.profile);
  assert.equal(first.extension.id, second.extension.id);
  assert.equal(running(first), 1);
  assert.equal(running(second), 1);
  assert.ok(first.reports.some((entry) => entry.from === 'sw-install'));
  assert.equal(second.reports.some((entry) => entry.from === 'sw-install'), false);
  assert.equal(second.reports.some((entry) => entry.from === 'runtime-onStartup'), false);
  assert.equal(first.reports.some((entry) => entry.from === 'runtime-onInstalled'), false);
}

console.log('Readiness evidence verified: wrapper repair and permission events work in the harness; native lifecycle and deterministic webRequest composition remain blocked.');
