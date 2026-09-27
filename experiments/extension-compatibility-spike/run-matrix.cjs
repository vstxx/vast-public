const { spawn } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');

const root = resolve(__dirname, '..', '..');
const electron = process.env.VAST_SPIKE_ELECTRON || join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!existsSync(electron)) throw new Error(`Electron executable missing: ${electron}`);
const harness = join(__dirname, 'harness-main.cjs');
const resultsRoot = join(__dirname, 'results');
mkdirSync(resultsRoot, { recursive: true });
rmSync(join(resultsRoot, 'summary.json'), { force: true });
const batchId = randomUUID();

const scenarios = [
  { name: 'stock-zero', mode: 'stock', extension: 'none' },
  { name: 'stock-mv3', mode: 'stock', extension: 'mv3' },
  { name: 'stock-mv2-webrequest', mode: 'stock', extension: 'mv2' },
  { name: 'ece-mv3', mode: 'ece', extension: 'mv3' },
  { name: 'ece-production-mv3', mode: 'ece', productionEce: true, extension: 'mv3', grantPermissions: true },
  { name: 'ece-mv3-vast-webrequest', mode: 'ece', extension: 'mv3', mainWebRequest: true },
  { name: 'ece-mv2-webrequest', mode: 'ece', extension: 'mv2' },
  { name: 'ece-mv2-vast-webrequest', mode: 'ece', extension: 'mv2', mainWebRequest: true },
  { name: 'ece-mv2-vast-webrequest-late', mode: 'ece', extension: 'mv2', mainWebRequest: true, mainWebRequestLate: true },
  { name: 'ece-mv2-policy-late', mode: 'ece', extension: 'mv2', mainWebRequest: true, mainWebRequestLate: true, policyProbe: true },
  { name: 'stock-polyfill-wrapper', mode: 'stock', extension: 'polyfill' },
  { name: 'ece-polyfill-wrapper', mode: 'ece', extension: 'polyfill' },
  { name: 'ece-patched-polyfill-wrapper', mode: 'ece', extension: 'polyfill' },
  { name: 'ece-patched-protonpass', mode: 'ece', extension: 'protonpass', timeout: 120000 },
  { name: 'ece-patched-keepassxc', mode: 'ece', extension: 'keepassxc', timeout: 120000 },
  { name: 'ece-patched-bitwarden', mode: 'ece', extension: 'bitwarden', timeout: 120000 },
  { name: 'ece-patched-permissions-grant', mode: 'ece', extension: 'mv3', grantPermissions: true },
  { name: 'stock-mv3-lifecycle-70s', mode: 'stock', extension: 'mv3', lifecycleLong: true, timeout: 105000 },
  { name: 'ece-mv3-lifecycle-70s', mode: 'ece', extension: 'mv3', lifecycleLong: true, timeout: 105000 },
  { name: 'stock-mv3-lifecycle-130s', mode: 'stock', extension: 'mv3', lifecycleDeep: true, timeout: 170000 },
  { name: 'ece-mv3-lifecycle-130s', mode: 'ece', extension: 'mv3', lifecycleDeep: true, timeout: 170000 },
  { name: 'stock-mv3-install-events', mode: 'stock', extension: 'mv3', lifecycleOnly: true },
  { name: 'ece-mv3-install-events', mode: 'ece', extension: 'mv3', lifecycleOnly: true },
  { name: 'stock-mv3-alarm-consumption', mode: 'stock', extension: 'mv3', lifecycleDeep: true, timeout: 170000 },
  { name: 'stock-mv3-alarm-awake', mode: 'stock', extension: 'mv3', lifecycleKeepAlive: true, timeout: 105000 },
  { name: 'stock-mv3-restart', mode: 'stock', extension: 'mv3', lifecycleOnly: true, restartPair: true },
  { name: 'stock-mv3-update', mode: 'stock', extension: 'mv3', lifecycleOnly: true, lifecycleUpdate: true, restartPair: true },
  { name: 'ece-mv3-restart', mode: 'ece', extension: 'mv3', lifecycleOnly: true, restartPair: true },
  // The second process intentionally waits 70 seconds before inspecting the
  // persisted alarm. Leave enough outer-process headroom for slow Windows
  // profile startup and external-disk I/O; the harness has its own watchdog.
  { name: 'stock-mv3-alarm-persist', mode: 'stock', extension: 'mv3', lifecyclePersist: true, restartPair: true, timeout: 180000 },
  { name: 'patch-matrix-app-only', mode: 'stock', extension: 'none', mainWebRequest: true, patchMatrix: true },
  { name: 'patch-matrix-neither', mode: 'stock', extension: 'none', patchMatrix: true },
  { name: 'patch-matrix-extension-only', mode: 'stock', extension: 'mv2', patchMatrix: true },
  { name: 'patch-matrix-both', mode: 'stock', extension: 'mv2', mainWebRequest: true, patchMatrix: true },
  { name: 'patch-matrix-both-late', mode: 'stock', extension: 'mv2', mainWebRequest: true, mainWebRequestLate: true, patchMatrix: true },
  { name: 'patch-matrix-expanded', mode: 'stock', extension: 'mv2', mainWebRequest: true, patchMatrix: true, expandedNetwork: true, timeout: 140000 },
  { name: 'multi-baseline', mode: 'ece', productionEce: true, multiExtension: true, extensions: [], timeout: 120000 },
  { name: 'multi-bitwarden', mode: 'ece', productionEce: true, multiExtension: true, extensions: ['bitwarden'], timeout: 140000 },
  { name: 'multi-protonpass', mode: 'ece', productionEce: true, multiExtension: true, extensions: ['protonpass'], timeout: 140000 },
  { name: 'multi-bitwarden-protonpass', mode: 'ece', productionEce: true, multiExtension: true, extensions: ['bitwarden', 'protonpass'], timeout: 160000 },
  { name: 'multi-bitwarden-adblocker', mode: 'ece', productionEce: true, multiExtension: true, extensions: ['bitwarden', 'adblocker'], mainWebRequest: true, timeout: 160000 },
  { name: 'multi-protonpass-adblocker', mode: 'ece', productionEce: true, multiExtension: true, extensions: ['protonpass', 'adblocker'], mainWebRequest: true, timeout: 160000 },
  { name: 'multi-all-production-targets', mode: 'ece', productionEce: true, multiExtension: true, extensions: ['bitwarden', 'protonpass', 'adblocker'], mainWebRequest: true, timeout: 170000 },
  { name: 'multi-ordinary-probes', mode: 'ece', productionEce: true, multiExtension: true, extensions: ['ordinary-a', 'ordinary-b'], mainWebRequest: true, grantPermissions: true, timeout: 160000 },
  ...['bitwarden', 'protonpass', 'keepassxc'].flatMap((extension) => [
    { name: `stock-${extension}`, mode: 'stock', extension },
    { name: `ece-${extension}`, mode: 'ece', extension },
    { name: `ece-${extension}-vast-webrequest`, mode: 'ece', extension, mainWebRequest: true }
  ])
];
const selectedNames = process.argv[2] || process.env.VAST_SPIKE_SCENARIOS;
const selected = selectedNames
  ? new Set(selectedNames.split(',').map((value) => value.trim()))
  : null;
if (process.env.VAST_SPIKE_SKIP_CWS !== '1') {
  scenarios.push(
    { name: 'cws-stock-zero', mode: 'stock', extension: 'none', cws: true, timeout: 35000 },
    { name: 'cws-stock-mv3', mode: 'stock', extension: 'mv3', cws: true, timeout: 35000 },
    { name: 'cws-stock-mv2', mode: 'stock', extension: 'mv2', cws: true, timeout: 35000 },
    { name: 'cws-ece-mv3', mode: 'ece', extension: 'mv3', cws: true, timeout: 35000 }
  );
  for (const scenario of scenarios) if (scenario.cws && process.env.VAST_SPIKE_CWS_URL) scenario.cwsUrl = process.env.VAST_SPIKE_CWS_URL;
}

function runScenario(scenario, reusedProfile) {
  return new Promise((resolveRun) => {
    const token = `${scenario.name}-${randomUUID()}`;
    const profile = reusedProfile || join(tmpdir(), scenario.multiExtension ? `ve-${randomUUID()}` : `vast-extension-spike-${token}`);
    const resultPath = join(resultsRoot, `${scenario.name}.json`);
    const stdoutPath = join(resultsRoot, `${scenario.name}.log`);
    rmSync(resultPath, { force: true });
    rmSync(join(resultsRoot, `${scenario.name}.run.json`), { force: true });
    const args = [harness, `--scenario=${Buffer.from(JSON.stringify(scenario)).toString('base64')}`, `--profile=${profile}`, `--result=${resultPath}`];
    const childEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, args, { cwd: __dirname, windowsHide: true, env: childEnv });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill(), scenario.timeout || 80000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(stdoutPath, output);
      let result = null;
      if (existsSync(resultPath)) {
        try { result = JSON.parse(readFileSync(resultPath, 'utf8')); } catch {}
      }
      const run = { scenario: scenario.name, code, signal, result, log: stdoutPath, profile };
      writeFileSync(join(resultsRoot, `${scenario.name}.run.json`), JSON.stringify({ scenario: scenario.name, batchId, electronBinary: electron, code, signal, completed: result?.completed === true, crashDumps: result?.crashDumps || null }, null, 2));
      resolveRun(run);
    });
  });
}

(async () => {
  const summary = { generatedAt: new Date().toISOString(), batchId, electronBinary: electron, ece: '4.9.0', runs: [] };
  for (const scenario of scenarios.filter((item) => !selected || selected.has(item.name))) {
    if (scenario.restartPair) {
      const profile = join(tmpdir(), `vast-extension-spike-${scenario.name}-${randomUUID()}`);
      for (const phase of ['first', 'second']) {
        const runScenarioName = { ...scenario, name: `${scenario.name}-${phase}`, restartGroup: scenario.name, restartPhase: phase, restartPair: false };
        process.stdout.write(`[spike] ${runScenarioName.name} ... `);
        const run = await runScenario(runScenarioName, profile);
        summary.runs.push(run);
        console.log(`exit=${run.code} signal=${run.signal || '-'} result=${run.result ? 'yes' : 'no'}`);
      }
      continue;
    }
    process.stdout.write(`[spike] ${scenario.name} ... `);
    const run = await runScenario(scenario);
    summary.runs.push(run);
    console.log(`exit=${run.code} signal=${run.signal || '-'} result=${run.result ? 'yes' : 'no'}`);
  }
  writeFileSync(join(resultsRoot, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`[spike] wrote ${join(resultsRoot, 'summary.json')}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
