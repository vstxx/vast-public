const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const resultsRoot = join(__dirname, 'results');
const read = (name) => JSON.parse(readFileSync(join(resultsRoot, `${name}.json`), 'utf8'));
const result = read('patch-matrix-expanded');
const run = read('patch-matrix-expanded.run');
const expectedBinary = resolve(process.env.VAST_SPIKE_ELECTRON || '');
assert.ok(process.env.VAST_SPIKE_ELECTRON, 'Set VAST_SPIKE_ELECTRON to the patched Electron binary.');
assert.equal(resolve(run.electronBinary), expectedBinary);
assert.equal(run.code, 0);
assert.equal(run.completed, true);
assert.equal(result.versions.electron, '44.3.0');
assert.equal(result.completed, true);
assert.equal(result.errors.length, 0);
assert.equal(result.crashDumpFiles.some((name) => name.toLowerCase().endsWith('.dmp')), false);

const response = (name) => result.patchMatrix.responses.find((entry) => entry.testCase === name)?.response;
const hits = (name) => result.patchMatrix.serverHits.filter((entry) => entry.url.includes(`case=${name}`));
const extensionReport = result.reports.filter((entry) => entry.from === 'mv2-webrequest').at(-1)?.data;

// The existing authority rules must remain true in the expanded workload.
assert.equal(hits('vast-deny').length, 0);
assert.equal(hits('extension-cancel').length, 0);
assert.equal(hits('extension-redirect-denied').length, 0);
assert.equal(hits('headers').length, 1);
assert.equal(hits('headers')[0].headers.vast, 'authoritative');
assert.equal(hits('headers')[0].headers.extension, 'present');
assert.equal(hits('headers')[0].headers.second, 'observed');
assert.equal(response('headers').headers.vast, 'authoritative');
assert.equal(response('headers').headers.extension, 'present');

// A throwing listener does not crash the process or erase Vast's final policy.
assert.equal(response('extension-throws').ok, true);
assert.equal(hits('extension-throws')[0].headers.vast, 'authoritative');
assert.equal(response('auth-extension-async').body, 'auth:extension');
assert.deepEqual(response('auth-extension-timeout'), { boundedTimeout: true });

for (const status of [301, 302, 307, 308]) {
  assert.equal(response(`redirect-${status}`).ok, true);
  assert.ok(response(`redirect-${status}`).url.includes(`case=redirect-${status}`));
}
assert.deepEqual(response('tls'), { ok: true, status: 200, body: 'tls-ok' });
assert.deepEqual(response('cors-preflight'), { ok: true, status: 200, body: 'cors-ok' });
assert.deepEqual(result.patchMatrix.corsHits.map((entry) => entry.method), ['OPTIONS', 'GET']);
assert.equal(result.patchMatrix.corsHits[0].requestedMethod, 'GET');
assert.match(result.patchMatrix.corsHits[0].requestedHeaders, /x-preflight-probe/i);

assert.deepEqual(response('concurrent-volume'), { total: 96, passed: 96 });
assert.equal(hits('volume').length, 96);
assert.equal(response('unload-during-request').ok, true);
assert.equal(response('after-extension-reload').ok, true);
assert.ok(extensionReport.beforeRequest > 0);
assert.ok(extensionReport.secondObserver > 0);
assert.ok(extensionReport.beforeRequest >= extensionReport.secondObserver - 1);

assert.deepEqual(response('authenticated-proxy'), {
  ok: true,
  status: 200,
  body: 'proxy-ok',
  header: 'authenticated'
});
assert.equal(result.patchMatrix.proxyHits.some((entry) => entry.authorized === false), true);
assert.equal(result.patchMatrix.proxyHits.some((entry) => entry.authorized === true), true);
assert.equal(result.patchMatrix.resourceSamples.length, 2);

console.log('Expanded production network matrix passed: redirects, TLS, CORS, proxy auth, listener failure/timeout, concurrency and unload/reload.');
