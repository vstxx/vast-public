const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const results = join(__dirname, 'results');
function read(name) { return JSON.parse(readFileSync(join(results, `${name}.json`), 'utf8')); }
function run(name) { return JSON.parse(readFileSync(join(results, `${name}.run.json`), 'utf8')); }
function report(result, from) { return result.reports.filter((entry) => entry.from === from); }
function latestReport(result, from) { return report(result, from).at(-1)?.data; }
function workerCount(result, label) { return result.serviceWorker.snapshots.find((snapshot) => snapshot.label === label)?.workers.length; }

const zero = read('stock-zero');
assert.equal(zero.completed, true);
assert.equal(zero.extension, null);
assert.equal(zero.page.https.loaded, true);

const stockMv3 = read('stock-mv3');
const eceMv3 = read('ece-mv3-vast-webrequest');
for (const result of [stockMv3, eceMv3]) {
  assert.equal(result.completed, true);
  assert.equal(latestReport(result, 'cs-port-result')?.ack, true);
  assert.equal(latestReport(result, 'cs-dynamic-main')?.ok, true);
  assert.equal(result.page.local.scriptingMarker, '1');
  assert.equal(result.page.local.externalMessage.response.external, true);
  assert.equal(latestReport(result, 'cs-war-fetch')?.status, 200);
  assert.equal(result.popup.enumerated, true);
  assert.equal(latestReport(result, 'sw-events-late')?.onAlarm, false);
  assert.equal(latestReport(result, 'sw-events-late')?.onInstalled, false);
}
assert.equal(workerCount(stockMv3, 'after-35s-idle'), 0);
assert.equal(workerCount(stockMv3, 'after-wake-navigation'), 1);
assert.equal(latestReport(stockMv3, 'sw-events-late').webNavigationSeen, false);
assert.equal(latestReport(eceMv3, 'sw-events-late').webNavigationSeen, true);
assert.equal(latestReport(eceMv3, 'sw-events-late').tabsOnUpdatedSeen, true);
assert.equal(latestReport(eceMv3, 'sw')?.functional.actionBadgeRoundTrip.result, '7');
assert.equal(latestReport(eceMv3, 'sw')?.functional.permissionsContains.result, true);
assert.equal(latestReport(eceMv3, 'sw')?.functional.cookiesSetGet.ok, true);

const stockMv2 = read('stock-mv2-webrequest');
const eceMv2 = read('ece-mv2-webrequest');
const eceMv2WithMain = read('ece-mv2-vast-webrequest');
assert.ok(latestReport(stockMv2, 'mv2-webrequest').beforeRequest > 0);
assert.ok(latestReport(eceMv2, 'mv2-webrequest').beforeRequest > 0);
assert.equal(latestReport(eceMv2WithMain, 'mv2-webrequest').beforeRequest, 0);
assert.ok(eceMv2WithMain.mainWebRequest.beforeRequest > 0);

for (const name of ['stock-bitwarden', 'ece-bitwarden', 'stock-protonpass', 'ece-protonpass', 'stock-keepassxc', 'ece-keepassxc']) {
  const result = read(name);
  assert.equal(result.completed, true, name);
  assert.equal(result.page.https.loaded, true, name);
  assert.ok(result.page.https.executedExtensionScripts?.length || name.startsWith('stock-'), name);
}
assert.equal(workerCount(read('stock-bitwarden'), 'after-load'), 0);
assert.equal(workerCount(read('ece-bitwarden'), 'after-load'), 1);
assert.equal(workerCount(read('ece-protonpass'), 'after-load'), 0);
assert.ok(read('ece-protonpass').serviceWorker.console.some((entry) => entry.message.includes('onAdded')));
assert.ok(read('ece-keepassxc').serviceWorker.console.some((entry) => entry.message.includes('onCommitted')));

for (const name of ['cws-stock-zero', 'cws-stock-mv2', 'cws-stock-mv3', 'cws-ece-mv3']) {
  assert.equal(run(name).code, 0xc0000005, name);
  assert.equal(read(name).cws.rejectClicked, true, name);
  assert.equal(read(name).completed, false, name);
}

console.log('Compatibility evidence verified: stock/ECE matrix, real extensions, network conflict, and 4 isolated CWS crashes.');
