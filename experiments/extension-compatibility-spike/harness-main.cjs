const { app, BrowserWindow, session, crashReporter } = require('electron');
const http = require('node:http');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const scenario = JSON.parse(Buffer.from(arg('scenario'), 'base64').toString('utf8'));
const profile = resolve(arg('profile'));
const resultPath = resolve(arg('result'));
const crashDumps = join(profile, 'CrashDumps');
const fixtureRoot = join(__dirname, 'fixtures');
const runtimeRoot = join(profile, 'fixture');
const referenceRoot = resolve(__dirname, '..', '..', 'extension-reference');
let allowedTlsPort = null;
const result = {
  scenario,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  profile,
  crashDumps,
  reports: [],
  serviceWorker: { registrations: [], status: [], console: [], snapshots: [] },
  rendererConsole: [],
  devtoolsContexts: [],
  extension: null,
  extensions: [],
  multiExtension: { isolation: [], postReloadIsolation: [], crossMessages: [], reloads: [], resourceSamples: [] },
  page: {},
  popup: {},
  mainWebRequest: { enabled: Boolean(scenario.mainWebRequest), beforeRequest: 0, beforeSendHeaders: 0, headersReceived: 0, seenUrls: [] },
  lifecycle: {},
  patchMatrix: { serverHits: [], responses: [], authEvents: [], corsHits: [], proxyHits: [], resourceSamples: [] },
  errors: [],
  completed: false
};

mkdirSync(profile, { recursive: true });
mkdirSync(crashDumps, { recursive: true });
app.setPath('userData', profile);
app.setPath('crashDumps', crashDumps);
crashReporter.start({ uploadToServer: false, compress: false });
app.on('certificate-error', (event, _contents, url, _error, _certificate, callback) => {
  try {
    const parsed = new URL(url);
    if (scenario.expandedNetwork && parsed.hostname === '127.0.0.1' && parsed.port === String(allowedTlsPort)) {
      event.preventDefault(); callback(true); return;
    }
  } catch {}
  callback(false);
});

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const errorText = (error) => String(error && (error.stack || error.message) || error).slice(0, 2000);
function stage(name) { result.stage = name; result.stages ??= []; result.stages.push({ name, at: Date.now() }); save(); }
async function limited(promise, label, timeout = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function save() {
  mkdirSync(resolve(resultPath, '..'), { recursive: true });
  result.crashDumpFiles = existsSync(crashDumps) ? readdirSync(crashDumps) : [];
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
}
function recordError(stage, error) { result.errors.push({ stage, error: errorText(error) }); save(); }
function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}: ${values.join(', ')}`);
}

function startServer() {
  return new Promise((resolveServer) => {
    const portPath = join(profile, 'probe-port');
    const server = http.createServer((request, response) => {
      if (request.url.startsWith('/report')) {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          try { result.reports.push(JSON.parse(body)); } catch (error) { recordError('parse-report', error); }
          response.writeHead(204, { 'access-control-allow-origin': '*' }); response.end(); save();
        });
        return;
      }
      if (request.url === '/phase') {
        response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
        response.end(scenario.lifecyclePersist ? scenario.restartPhase : 'none'); return;
      }
      if (request.url.startsWith('/beacon')) {
        if (scenario.policyProbe) result.reports.push({ from: 'server-beacon', data: { url: request.url, header: request.headers['x-vast-probe'] || null } });
        response.writeHead(200, { 'access-control-allow-origin': '*' }); response.end('beacon'); save(); return;
      }
      if (request.url.startsWith('/matrix?')) {
        result.patchMatrix.serverHits.push({ url: request.url, method: request.method, headers: { vast: request.headers['x-vast-probe'] || null, extension: request.headers['x-extension-probe'] || null, second: request.headers['x-extension-second'] || null } });
        const testCase = new URL(request.url, 'http://127.0.0.1').searchParams.get('case');
        if (testCase === 'delayed') {
          setTimeout(() => { response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); response.end('delayed-ok'); save(); }, 500);
          return;
        }
        if (request.url.includes('case=auth-')) {
          const authCase = testCase;
          const expectedUser = authCase === 'auth-extension'
            || authCase === 'auth-extension-async' ? 'extension'
            : authCase === 'auth-vast' ? 'vast' : null;
          const basic = request.headers.authorization || '';
          const user = basic.startsWith('Basic ') ? Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':')[0] : '';
          if (!expectedUser || user !== expectedUser) {
            response.writeHead(401, { 'www-authenticate': `Basic realm="vast-compat-${authCase}"`, 'access-control-allow-origin': '*' });
            response.end('auth-required'); save(); return;
          }
          response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
          response.end(`auth:${user}`); save(); return;
        }
        response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'x-origin-probe': 'server' });
        response.end('matrix-ok'); save(); return;
      }
      if (request.url.startsWith('/redirect?')) {
        const parsed = new URL(request.url, 'http://127.0.0.1');
        const status = Number(parsed.searchParams.get('status'));
        response.writeHead([301, 302, 307, 308].includes(status) ? status : 302, { location: `/matrix?case=redirect-${status}` });
        response.end(); return;
      }
      if (request.url === '/frame') {
        response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" });
        response.end('<!doctype html><html><body>frame</body></html>'); return;
      }
      const connectSrc = scenario.expandedNetwork
        ? "connect-src 'self' http://127.0.0.1:* https://127.0.0.1:* ws://127.0.0.1:* http://vast-proxy.invalid"
        : "connect-src 'self'";
      response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': `default-src 'self'; script-src 'self'; ${connectSrc}` });
      response.end('<!doctype html><html><head><title>Vast extension probe</title></head><body><input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password"><iframe src="/frame"></iframe></body></html>');
    });
    server.on('upgrade', (request, socket) => {
      result.patchMatrix.serverHits.push({ url: request.url, websocket: true, headers: { vast: request.headers['x-vast-probe'] || null, extension: request.headers['x-extension-probe'] || null } });
      const key = request.headers['sec-websocket-key'];
      if (!key) { socket.destroy(); return; }
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      save();
    });
    const requestedPort = scenario.restartGroup && existsSync(portPath) ? Number(readFileSync(portPath, 'utf8')) : 0;
    server.listen(requestedPort, '127.0.0.1', () => {
      if (scenario.restartGroup) writeFileSync(portPath, String(server.address().port));
      resolveServer(server);
    });
  });
}

function generateCertificate() {
  const tlsRoot = join(profile, 'tls');
  mkdirSync(tlsRoot, { recursive: true });
  execFileSync('python', [join(__dirname, 'generate-localhost-certificate.py'), tlsRoot], { stdio: 'pipe' });
  return { key: readFileSync(join(tlsRoot, 'localhost-key.pem')), cert: readFileSync(join(tlsRoot, 'localhost-cert.pem')) };
}

function startTlsServer(httpOrigin) {
  return new Promise((resolveServer) => {
    const server = https.createServer(generateCertificate(), (request, response) => {
      result.patchMatrix.serverHits.push({ url: request.url, method: request.method, tls: true, headers: { vast: request.headers['x-vast-probe'] || null, extension: request.headers['x-extension-probe'] || null } });
      if (request.url === '/cors' && request.method === 'OPTIONS') {
        result.patchMatrix.corsHits.push({ method: request.method, requestedMethod: request.headers['access-control-request-method'] || null, requestedHeaders: request.headers['access-control-request-headers'] || null });
        response.writeHead(204, {
          'access-control-allow-origin': httpOrigin,
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'x-preflight-probe'
        });
        response.end(); save(); return;
      }
      if (request.url === '/cors') {
        result.patchMatrix.corsHits.push({ method: request.method, customHeader: request.headers['x-preflight-probe'] || null });
        response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': httpOrigin });
        response.end('cors-ok'); save(); return;
      }
      response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      response.end('tls-ok'); save();
    });
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

function startProxyServer() {
  return new Promise((resolveServer) => {
    const server = http.createServer((request, response) => {
      const authorization = request.headers['proxy-authorization'] || '';
      result.patchMatrix.proxyHits.push({ url: request.url, authorized: authorization.startsWith('Basic ') });
      if (authorization !== `Basic ${Buffer.from('proxy:pass').toString('base64')}`) {
        response.writeHead(407, { 'proxy-authenticate': 'Basic realm="vast-compat-proxy"', 'access-control-allow-origin': '*' });
        response.end('proxy-auth-required'); save(); return;
      }
      response.writeHead(200, { 'content-type': 'text/plain', 'x-proxy-probe': 'authenticated', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-proxy-probe' });
      response.end('proxy-ok'); save();
    });
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

function copyTemplated(source, destination, port) {
  cpSync(source, destination, { recursive: true });
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.(?:js|json|html)$/.test(name)) {
        const value = readFileSync(path, 'utf8');
        writeFileSync(path, value.replaceAll('__PORT__', String(port)));
      }
    }
  };
  visit(destination);
  return destination;
}

function extensionSpec(port) {
  if (scenario.extension === 'none') return null;
  if (scenario.extension === 'mv3') {
    const path = scenario.restartGroup && existsSync(runtimeRoot)
      ? runtimeRoot : copyTemplated(join(fixtureRoot, 'mv3-probe'), runtimeRoot, port);
    if (scenario.lifecycleUpdate && scenario.restartPhase === 'second') {
      const manifestPath = join(path, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
      manifest.version = '2.0.0';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
    return { path, popup: 'popup.html', options: 'popup.html' };
  }
  if (scenario.extension === 'mv2') return { path: copyTemplated(join(fixtureRoot, 'mv2-webrequest'), runtimeRoot, port) };
  if (scenario.extension === 'polyfill') {
    copyTemplated(join(fixtureRoot, 'polyfill-probe'), runtimeRoot, port);
    cpSync(join(referenceRoot, 'keepassxc', 'common', 'browser-polyfill.min.js'), join(runtimeRoot, 'browser-polyfill.min.js'));
    return { path: runtimeRoot };
  }
  const specs = {
    bitwarden: { popup: 'popup/index.html' },
    protonpass: { popup: 'popup.html', options: 'settings.html' },
    keepassxc: { popup: 'popups/popup.html', options: 'options/options.html' }
  };
  return { path: join(referenceRoot, scenario.extension), ...specs[scenario.extension] };
}

function snapshotWorkers(browserSession, label) {
  try {
    const workers = Object.values(browserSession.serviceWorkers.getAllRunning()).map((worker) => ({
      scope: worker.scope,
      scriptUrl: worker.scriptUrl,
      runningStatus: worker.runningStatus,
      versionId: worker.versionId
    }));
    result.serviceWorker.snapshots.push({ label, workers });
  } catch (error) { recordError(`workers:${label}`, error); }
  save();
}

async function enumerateExtensionPage(contents) {
  return contents.executeJavaScript(`(async () => {
    const names = ['runtime','storage','alarms','tabs','scripting','webNavigation','webRequest','contextMenus','notifications','cookies','idle','offscreen','privacy','sidePanel','commands','i18n','action','permissions','windows'];
    const apis = Object.fromEntries(names.map((name) => [name, typeof chrome === 'undefined' || chrome[name] === undefined ? 'missing' : typeof chrome[name]]));
    let storage = null, storageError = null;
    try { storage = await chrome.storage.local.get(null); } catch (error) { storageError = String(error && error.message || error); }
    return { title: document.title, url: location.href, runtimeId: typeof chrome === 'undefined' ? null : chrome.runtime?.id || null, apis, storageKeys: storage ? Object.keys(storage).slice(0, 30) : [], storageError };
  })()`, true);
}

async function main() {
  stage('main-start');
  const server = await startServer();
  stage('server-started');
  const port = server.address().port;
  let tlsServer = null;
  let proxyServer = null;
  if (scenario.expandedNetwork) {
    tlsServer = await startTlsServer(`http://127.0.0.1:${port}`);
    allowedTlsPort = tlsServer.address().port;
    proxyServer = await startProxyServer();
    result.patchMatrix.tlsPort = allowedTlsPort;
    result.patchMatrix.proxyPort = proxyServer.address().port;
    stage('expanded-servers-started');
  }
  const browserSession = session.fromPartition(`persist:${scenario.restartGroup || scenario.name}`);
  if (scenario.expandedNetwork) {
    browserSession.setCertificateVerifyProc((request, callback) => {
      callback(request.hostname === '127.0.0.1' ? 0 : -3);
    });
  }
  stage('session-created');

  browserSession.serviceWorkers.on('registration-completed', (_event, details) => { result.serviceWorker.registrations.push(details); save(); });
  browserSession.serviceWorkers.on('running-status-changed', (details) => { result.serviceWorker.status.push(details); save(); });
  browserSession.serviceWorkers.on('console-message', (_event, details) => { result.serviceWorker.console.push(details); save(); });

  let compatibility = null;
  if (scenario.mode === 'ece') {
    stage('ece-init');
    const eceModule = scenario.productionEce
      ? join(resolve(__dirname, '..', '..'), 'node_modules', 'electron-chrome-extensions')
      : 'electron-chrome-extensions';
    const { ElectronChromeExtensions } = require(eceModule);
    const permissionGrants = new Map();
    compatibility = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: browserSession,
      getGrantedPermissions: (extension) => permissionGrants.get(extension.id) || { permissions: [], origins: [] },
      requestPermissions: async (extension, request) => {
        if (!scenario.grantPermissions) return false;
        const optionalPermissions = new Set(extension.manifest.optional_permissions || []);
        const optionalOrigins = new Set(extension.manifest.optional_host_permissions || []);
        if (!(request.permissions || []).every((permission) => optionalPermissions.has(permission))) return false;
        if (!(request.origins || []).every((origin) => optionalOrigins.has(origin))) return false;
        const current = permissionGrants.get(extension.id) || { permissions: [], origins: [] };
        permissionGrants.set(extension.id, {
          permissions: [...new Set([...current.permissions, ...(request.permissions || [])])],
          origins: [...new Set([...current.origins, ...(request.origins || [])])]
        });
        return true;
      },
      removePermissions: async (extension, request) => {
        const current = permissionGrants.get(extension.id) || { permissions: [], origins: [] };
        permissionGrants.set(extension.id, {
          permissions: current.permissions.filter((permission) => !(request.permissions || []).includes(permission)),
          origins: current.origins.filter((origin) => !(request.origins || []).includes(origin))
        });
        return true;
      },
      createTab: async (details) => {
        const child = new BrowserWindow({ show: false, webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
        compatibility.addTab(child.webContents, child);
        if (scenario.multiExtension) await child.loadURL('about:blank');
        else if (details.url) await child.loadURL(details.url);
        return [child.webContents, child];
      },
      createWindow: async () => new BrowserWindow({ show: false, webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
    });
  }

  function registerMainWebRequest() {
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      result.mainWebRequest.beforeRequest++;
      if (result.mainWebRequest.seenUrls.length < 100) result.mainWebRequest.seenUrls.push(details.url);
      if (scenario.patchMatrix && details.url.includes('/matrix?case=vast-deny')) callback({ cancel: true });
      else if (scenario.patchMatrix && details.url.includes('/matrix?case=vast-redirect')) callback({ redirectURL: details.url.replace('vast-redirect', 'vast-target') });
      else if (scenario.patchMatrix && details.url.includes('/matrix?case=redirect-collision')) callback({ redirectURL: details.url.replace('redirect-collision', 'vast-target') });
      else if (scenario.policyProbe && details.url.includes('/beacon?deny')) callback({ cancel: true });
      else if (scenario.policyProbe && details.url.includes('/beacon?redirect')) callback({ redirectURL: `http://127.0.0.1:${port}/beacon?target` });
      else callback({});
    });
    browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
      result.mainWebRequest.beforeSendHeaders++;
      const requestHeaders = { ...details.requestHeaders };
      if (scenario.policyProbe || scenario.patchMatrix) requestHeaders['X-Vast-Probe'] = 'authoritative';
      callback({ requestHeaders });
    });
    browserSession.webRequest.onHeadersReceived((details, callback) => {
      result.mainWebRequest.headersReceived++;
      if (scenario.patchMatrix && details.url.includes('/matrix?case=')) {
        callback({ responseHeaders: { ...details.responseHeaders, 'X-Vast-Response': ['authoritative'] } });
      } else callback({ responseHeaders: details.responseHeaders });
    });
  }
  if (scenario.mainWebRequest && !scenario.mainWebRequestLate) registerMainWebRequest();

  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  if (scenario.patchMatrix && scenario.mainWebRequest) {
    win.webContents.on('login', (event, details, authInfo, callback) => {
      result.patchMatrix.authEvents.push({
        url: details?.url || null,
        challenger: authInfo?.host || null,
        realm: authInfo?.realm || null
      });
      save();
      if (authInfo?.isProxy) {
        event.preventDefault(); callback('proxy', 'pass');
      } else if (details.url.includes('case=auth-vast-cancel')) {
        event.preventDefault(); callback();
      } else if (details.url.includes('case=auth-vast')) {
        event.preventDefault(); callback('vast', 'pass');
      }
    });
  }
  stage('window-created');
  compatibility?.addTab(win.webContents, win);
  win.webContents.on('console-message', (event, level, message, lineNumber, sourceId) => {
    const value = event && typeof event === 'object' && 'message' in event
      ? { level: event.level, message: event.message, lineNumber: event.lineNumber, sourceId: event.sourceId }
      : { level, message, lineNumber, sourceId };
    result.rendererConsole.push(value); save();
  });
  win.webContents.on('render-process-gone', (_event, details) => { result.errors.push({ stage: 'render-process-gone', details }); save(); });
  // A cold custom Electron start can spend several seconds initializing the
  // profile and extension services on slower disks. This navigation is only
  // harness setup, so do not confuse startup I/O latency with a lifecycle
  // compatibility failure.
  await limited(win.loadURL('about:blank'), 'about:blank', 30000);
  stage('blank-loaded');
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.executionContextCreated') {
      const context = params.context;
      result.devtoolsContexts.push({ id: context.id, origin: context.origin, name: context.name, auxData: context.auxData }); save();
    }
  });
  await limited(win.webContents.debugger.sendCommand('Runtime.enable'), 'Runtime.enable');
  await limited(win.webContents.debugger.sendCommand('Profiler.enable'), 'Profiler.enable');
  await limited(win.webContents.debugger.sendCommand('Profiler.startPreciseCoverage', { callCount: true, detailed: false }), 'Profiler.startPreciseCoverage');
  stage('debugger-enabled');

  if (scenario.multiExtension) {
    const popupPaths = { bitwarden: 'popup/index.html', protonpass: 'popup.html', adblocker: 'popup.html', 'ordinary-a': 'popup.html', 'ordinary-b': 'popup.html' };
    const extensionPaths = {
      bitwarden: join(referenceRoot, 'bitwarden'),
      protonpass: join(referenceRoot, 'protonpass'),
      adblocker: resolve(__dirname, '..', '..', 'resources', 'first-party-extensions', 'adblocker-for-vast')
    };
    const loaded = [];
    for (const name of scenario.extensions || []) {
      let path = extensionPaths[name];
      if (!path && (name === 'ordinary-a' || name === 'ordinary-b')) {
        path = copyTemplated(join(fixtureRoot, 'mv3-probe'), join(profile, name), port);
        const manifestPath = join(path, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
        manifest.name = `Vast ordinary extension ${name.slice(-1).toUpperCase()}`;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }
      if (!path) throw new Error(`Unknown multi-extension fixture: ${name}`);
      const extension = await browserSession.extensions.loadExtension(path, { allowFileAccess: false });
      const item = { name, path, popup: popupPaths[name], extension };
      loaded.push(item);
      result.extensions.push({ name, id: extension.id, version: extension.version, manifestVersion: extension.manifest.manifest_version });
    }
    assertUnique(result.extensions.map((extension) => extension.id), 'extension runtime IDs');
    await sleep(4000);
    snapshotWorkers(browserSession, 'multi-after-load');
    await limited(win.loadURL(`http://127.0.0.1:${port}/page`), 'multi-page');
    await sleep(3500);

    const sampleResources = async (label) => {
      result.multiExtension.resourceSamples.push({
        label,
        at: Date.now(),
        browserMemory: await process.getProcessMemoryInfo(),
        processes: app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, cpu: metric.cpu.percentCPUUsage, workingSetSize: metric.memory.workingSetSize }))
      });
      save();
    };
    await sampleResources('loaded');

    const openExtensionSurface = async (item, operation) => {
      const surface = new BrowserWindow({ show: false, webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
      compatibility?.addTab(surface.webContents, surface);
      try {
        await limited(surface.loadURL('about:blank'), `${item.name}-surface-blank`, 10000);
        surface.webContents.debugger.attach('1.3');
        await limited(surface.webContents.debugger.sendCommand('Page.enable'), `${item.name}-surface-page-enable`, 5000);
        await limited(surface.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
          const api = globalThis.chrome;
          if (!api?.runtime) return;
          Object.defineProperty(globalThis, '__vastCompatibilityNative', {
            value: { runtime: api.runtime, storageLocal: api.storage?.local, permissions: api.permissions },
            configurable: false,
            enumerable: false,
            writable: false
          });
        })()` }), `${item.name}-surface-init-script`, 5000);
        await limited(surface.loadURL(`chrome-extension://${item.extension.id}/${item.popup}`), `${item.name}-surface`, 20000);
        await sleep(500);
        return await limited(operation(surface.webContents), `${item.name}-surface-operation`, 8000);
      } finally {
        if (!surface.isDestroyed()) surface.destroy();
      }
    };

    for (const item of loaded) {
      const token = `${item.name}:${item.extension.id}`;
      const isolation = await openExtensionSurface(item, (contents) => contents.executeJavaScript(`(async () => {
        const native = globalThis.__vastCompatibilityNative;
        await native.storageLocal.set({ vastProductionIsolationToken: ${JSON.stringify(token)} });
        const stored = await native.storageLocal.get('vastProductionIsolationToken');
        const permissions = native.permissions?.getAll ? await native.permissions.getAll() : null;
        return { runtimeId: native.runtime.id, token: stored.vastProductionIsolationToken, permissions };
      })()`, true));
      result.multiExtension.isolation.push({ name: item.name, ...isolation });
    }

    for (const sender of loaded) {
      for (const target of loaded) {
        if (sender === target) continue;
        const probe = await openExtensionSurface(sender, (contents) => contents.executeJavaScript(`(async () => {
          const runtime = globalThis.__vastCompatibilityNative.runtime;
          try {
            const response = await runtime.sendMessage(${JSON.stringify(target.extension.id)}, { vastProductionIsolationProbe: true });
            return { response: response === undefined ? null : response, lastError: runtime.lastError?.message || null };
          } catch (error) {
            return { response: null, error: String(error?.message || error) };
          }
        })()`, true));
        result.multiExtension.crossMessages.push({ sender: sender.name, target: target.name, ...probe });
      }
    }

    for (let index = 0; index < 8; index++) {
      const item = loaded[index % Math.max(loaded.length, 1)];
      if (item) await openExtensionSurface(item, (contents) => contents.executeJavaScript(`({ id: globalThis.__vastCompatibilityNative.runtime.id, title: document.title })`, true));
      const tab = new BrowserWindow({ show: false, webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
      compatibility?.addTab(tab.webContents, tab);
      await limited(tab.loadURL(`http://127.0.0.1:${port}/page?cycle=${index}`), `multi-tab-${index}`, 10000);
      tab.destroy();
    }
    await sampleResources('after-popup-tab-cycles');

    if (typeof browserSession.extensions.reloadExtension !== 'function') {
      throw new Error('Patched Electron native reloadExtension API is unavailable');
    }
    for (const item of loaded) {
      for (let cycle = 0; cycle < 2; cycle++) {
        browserSession.extensions.reloadExtension(item.extension.id);
        await sleep(1000);
        const reloadedExtension = browserSession.extensions.getExtension(item.extension.id);
        if (!reloadedExtension) throw new Error(`Extension ${item.name} disappeared during native reload`);
        item.extension = reloadedExtension;
        result.multiExtension.reloads.push({ name: item.name, cycle, id: item.extension.id });
      }
      const restored = await openExtensionSurface(item, (contents) => contents.executeJavaScript(`(async () => {
        const value = await globalThis.__vastCompatibilityNative.storageLocal.get('vastProductionIsolationToken');
        return { runtimeId: globalThis.__vastCompatibilityNative.runtime.id, token: value.vastProductionIsolationToken || null };
      })()`, true));
      result.multiExtension.postReloadIsolation.push({ name: item.name, ...restored });
    }
    await sleep(4000);
    snapshotWorkers(browserSession, 'multi-after-reloads');
    await sampleResources('after-reloads');
    await sleep(5000);
    await sampleResources('after-idle');
    result.completed = true;
    save();
    server.close();
    app.exit(0);
    return;
  }

  const spec = extensionSpec(port);
  let loadedExtension = null;
  if (spec) {
    stage('extension-loading');
    try {
      const extension = await browserSession.extensions.loadExtension(spec.path, { allowFileAccess: false });
      loadedExtension = extension;
      result.extension = { id: extension.id, name: extension.name, version: extension.version, path: extension.path, manifestVersion: extension.manifest.manifest_version, background: extension.manifest.background };
    } catch (error) { recordError('load-extension', error); }
  }
  stage('extension-loaded');

  await sleep(2500);
  snapshotWorkers(browserSession, 'after-load');
  if (scenario.lifecycleOnly) {
    await sleep(3500);
    result.completed = true; save(); server.close(); app.exit(0); return;
  }

  if (scenario.lifecyclePersist && result.extension) {
    await sleep(scenario.restartPhase === 'first' ? 3500 : 70000);
    snapshotWorkers(browserSession, `persist-${scenario.restartPhase}`);
    result.completed = true; save(); server.close(); app.exit(0); return;
  }

  if (scenario.lifecycleKeepAlive && result.extension) {
    await limited(win.loadURL(`chrome-extension://${result.extension.id}/popup.html`), 'keepalive-popup');
    result.lifecycle.keepalive = await win.webContents.executeJavaScript(`(() => {
      globalThis.lifecyclePort = chrome.runtime.connect({ name: 'lifecycle-keepalive' });
      globalThis.lifecycleTimer = setInterval(() => globalThis.lifecyclePort.postMessage({ ping: Date.now() }), 5000);
      return true;
    })()`, true).catch(errorText);
    await sleep(70000);
    snapshotWorkers(browserSession, 'after-70s-keepalive');
    result.lifecycle.alarmsAt70s = await win.webContents.executeJavaScript(`chrome.alarms.getAll().then(alarms => alarms.map(alarm => alarm.name))`, true).catch(errorText);
    result.completed = true; save(); server.close(); app.exit(0); return;
  }

  if (scenario.patchMatrix) {
    const localUrl = `http://127.0.0.1:${port}/page`;
    await limited(win.loadURL(localUrl), 'matrix-page');
    await sleep(1500);
    if (scenario.mainWebRequest && scenario.mainWebRequestLate) registerMainWebRequest();
    const matrixCases = ['allow', 'vast-deny', 'extension-cancel', 'vast-redirect', 'extension-redirect', 'extension-redirect-denied', 'redirect-collision', 'headers', 'auth-extension', 'auth-vast', 'auth-vast-cancel'];
    if (scenario.expandedNetwork) matrixCases.push('extension-throws', 'auth-extension-async');
    for (const testCase of matrixCases) {
      const response = await limited(win.webContents.executeJavaScript(`fetch(${JSON.stringify(`http://127.0.0.1:${port}/matrix?case=${testCase}`)}).then(async r => ({ ok: r.ok, url: r.url, status: r.status, body: await r.text(), headers: { vast: r.headers.get('x-vast-response'), extension: r.headers.get('x-extension-response') } })).catch(e => ({ error: String(e) }))`, true), `matrix-${testCase}`, 8000);
      result.patchMatrix.responses.push({ testCase, response });
    }
    if (scenario.expandedNetwork) {
      const timeoutResponse = await limited(win.webContents.executeJavaScript(`Promise.race([
        fetch(${JSON.stringify(`http://127.0.0.1:${port}/matrix?case=auth-extension-timeout`)}).then(async r => ({ status: r.status, body: await r.text() })).catch(error => ({ error: String(error) })),
        new Promise(resolve => setTimeout(() => resolve({ boundedTimeout: true }), 2500))
      ])`, true), 'matrix-auth-timeout', 4000);
      result.patchMatrix.responses.push({ testCase: 'auth-extension-timeout', response: timeoutResponse });

      for (const status of [301, 302, 307, 308]) {
        const response = await limited(win.webContents.executeJavaScript(`fetch(${JSON.stringify(`http://127.0.0.1:${port}/redirect?status=${status}`)}).then(r => ({ ok: r.ok, status: r.status, url: r.url })).catch(error => ({ error: String(error) }))`, true), `redirect-${status}`, 8000);
        result.patchMatrix.responses.push({ testCase: `redirect-${status}`, response });
      }

      const tlsUrl = `https://127.0.0.1:${allowedTlsPort}`;
      const tlsResponse = await limited(win.webContents.executeJavaScript(`fetch(${JSON.stringify(`${tlsUrl}/tls`)}).then(async r => ({ ok: r.ok, status: r.status, body: await r.text() })).catch(error => ({ error: String(error) }))`, true), 'tls-request', 10000);
      result.patchMatrix.responses.push({ testCase: 'tls', response: tlsResponse });
      const corsResponse = await limited(win.webContents.executeJavaScript(`fetch(${JSON.stringify(`${tlsUrl}/cors`)}, { headers: { 'X-Preflight-Probe': 'present' } }).then(async r => ({ ok: r.ok, status: r.status, body: await r.text() })).catch(error => ({ error: String(error) }))`, true), 'cors-preflight', 10000);
      result.patchMatrix.responses.push({ testCase: 'cors-preflight', response: corsResponse });

      result.patchMatrix.resourceSamples.push({ label: 'before-volume', memory: await process.getProcessMemoryInfo(), metrics: app.getAppMetrics().map((metric) => ({ type: metric.type, cpu: metric.cpu.percentCPUUsage, workingSetSize: metric.memory.workingSetSize })) });
      const volumeResponse = await limited(win.webContents.executeJavaScript(`Promise.all(Array.from({ length: 96 }, (_, index) => fetch(${JSON.stringify(`http://127.0.0.1:${port}/matrix?case=volume`)} + '&n=' + index).then(r => r.ok))).then(values => ({ total: values.length, passed: values.filter(Boolean).length })).catch(error => ({ error: String(error) }))`, true), 'concurrent-volume', 20000);
      result.patchMatrix.responses.push({ testCase: 'concurrent-volume', response: volumeResponse });
      result.patchMatrix.resourceSamples.push({ label: 'after-volume', memory: await process.getProcessMemoryInfo(), metrics: app.getAppMetrics().map((metric) => ({ type: metric.type, cpu: metric.cpu.percentCPUUsage, workingSetSize: metric.memory.workingSetSize })) });

      if (loadedExtension && spec) {
        const delayed = win.webContents.executeJavaScript(`fetch(${JSON.stringify(`http://127.0.0.1:${port}/matrix?case=delayed`)}).then(async r => ({ ok: r.ok, body: await r.text() })).catch(error => ({ error: String(error) }))`, true);
        await sleep(75);
        browserSession.extensions.removeExtension(loadedExtension.id);
        result.patchMatrix.responses.push({ testCase: 'unload-during-request', response: await limited(delayed, 'unload-during-request', 5000) });
        loadedExtension = await browserSession.extensions.loadExtension(spec.path, { allowFileAccess: false });
        await sleep(1000);
        const afterReload = await limited(win.webContents.executeJavaScript(`fetch(${JSON.stringify(`http://127.0.0.1:${port}/matrix?case=after-reload`)}).then(async r => ({ ok: r.ok, body: await r.text() })).catch(error => ({ error: String(error) }))`, true), 'after-extension-reload', 8000);
        result.patchMatrix.responses.push({ testCase: 'after-extension-reload', response: afterReload });
      }

      await browserSession.setProxy({ proxyRules: `http=127.0.0.1:${proxyServer.address().port}`, proxyBypassRules: '127.0.0.1;localhost' });
      const proxyResponse = await limited(win.webContents.executeJavaScript(`fetch('http://vast-proxy.invalid/resource').then(async r => ({ ok: r.ok, status: r.status, body: await r.text(), header: r.headers.get('x-proxy-probe') })).catch(error => ({ error: String(error) }))`, true), 'authenticated-proxy', 10000);
      result.patchMatrix.responses.push({ testCase: 'authenticated-proxy', response: proxyResponse });
      await browserSession.setProxy({ mode: 'direct' });
    }
    for (const testCase of ['allow', 'vast-deny', 'extension-cancel']) {
      const response = await limited(win.webContents.executeJavaScript(`new Promise(resolve => { const socket = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${port}/matrix?case=${testCase}`)}); socket.onopen = () => { socket.close(); resolve('open'); }; socket.onerror = () => resolve('error'); setTimeout(() => resolve('timeout'), 3000); })`, true), `matrix-ws-${testCase}`, 5000);
      result.patchMatrix.responses.push({ testCase: `ws-${testCase}`, response });
    }
    await sleep(1100);
    result.completed = true; save(); server.close(); tlsServer?.close(); proxyServer?.close(); app.exit(0); return;
  }

  if (scenario.cws) {
    result.cws = { startedAt: Date.now(), url: scenario.cwsUrl || 'https://chromewebstore.google.com/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm' };
    save();
    await limited(win.loadURL(result.cws.url), 'cws-navigation', 25000);
    result.cws.didFinishLoad = true;
    await sleep(8000);
    result.cws.finalUrl = win.webContents.getURL();
    result.cws.title = win.webContents.getTitle();
    if (result.cws.finalUrl.startsWith('https://consent.google.com/')) {
      result.cws.consentButtons = await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].map(button => ({ text: button.innerText.trim().slice(0, 100), type: button.type, name: button.name })).slice(0, 30)`, true).catch(errorText);
      result.cws.rejectClicked = await win.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('button')].find(item => item.innerText.trim().startsWith('Odrzu')); if (!button) return false; button.click(); return true; })()`, true).catch(errorText);
      save();
      if (result.cws.rejectClicked === true) await sleep(12000);
      result.cws.afterConsentUrl = win.webContents.getURL();
      result.cws.afterConsentTitle = win.webContents.getTitle();
    }
    result.cws.survived = true;
    result.completed = true; save(); server.close(); app.exit(0); return;
  }

  const localUrl = `http://127.0.0.1:${port}/page`;
  stage('local-loading');
  await limited(win.loadURL(localUrl), 'local-navigation');
  stage('local-loaded');
  await sleep(4500);
  result.page.local = {
    url: win.webContents.getURL(),
    isolatedMarker: await win.webContents.executeJavaScript('document.documentElement.getAttribute("data-probe-cs")', true).catch(errorText),
    mainWorldMarker: await win.webContents.executeJavaScript('document.documentElement.getAttribute("data-probe-main")', true).catch(errorText),
    scriptingMarker: await win.webContents.executeJavaScript('document.documentElement.getAttribute("data-probe-scripting")', true).catch(errorText)
  };
  if (scenario.extension === 'mv3' && result.extension) {
    result.page.local.externalMessage = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) { resolve({ available: false }); return; }
      chrome.runtime.sendMessage(${JSON.stringify(result.extension.id)}, { probe: true }, (response) => resolve({ available: true, response, lastError: chrome.runtime.lastError?.message || null }));
      setTimeout(() => resolve({ timeout: true }), 3000);
    })`, true).catch(errorText);
  }
  try { await limited(win.webContents.executeJavaScript(`fetch('http://127.0.0.1:${port}/beacon').then(r => r.text())`, true), 'beacon-fetch', 5000); }
  catch (error) { recordError('beacon-fetch', error); }
  if (scenario.mainWebRequest && scenario.mainWebRequestLate) {
    await sleep(1100);
    result.mainWebRequest.extensionCountBeforeRegistration = result.reports.filter((entry) => entry.from === 'mv2-webrequest').at(-1)?.data;
    result.mainWebRequest.registeredAfterFirstBeacon = true;
    registerMainWebRequest();
    const probes = scenario.policyProbe ? ['deny', 'redirect', 'allowed'] : ['after=0', 'after=1', 'after=2'];
    result.mainWebRequest.probeResponses = [];
    for (const probe of probes) {
      const response = await limited(win.webContents.executeJavaScript(`fetch('http://127.0.0.1:${port}/beacon?${probe}').then(r => ({ ok: r.ok, url: r.url })).catch(error => ({ error: String(error) }))`, true), 'post-listener-beacon', 5000);
      result.mainWebRequest.probeResponses.push(response);
    }
    await sleep(1100);
    result.mainWebRequest.extensionCountAfterRegistration = result.reports.filter((entry) => entry.from === 'mv2-webrequest').at(-1)?.data;
  }
  await limited(win.loadURL(`${localUrl}?second=1`), 'local-second-navigation');
  await sleep(2500);
  snapshotWorkers(browserSession, 'after-navigation-events');

  try {
    await limited(win.loadURL('https://example.com/'), 'https-example-navigation', 12000);
    await sleep(5000);
    result.page.https = { loaded: true, url: win.webContents.getURL(), title: await win.webContents.getTitle() };
    try {
      const coverage = await limited(win.webContents.debugger.sendCommand('Profiler.takePreciseCoverage'), 'Profiler.takePreciseCoverage');
      result.page.https.executedExtensionScripts = coverage.result.filter((script) => script.url.startsWith('chrome-extension://')).map((script) => ({ url: script.url, executedFunctions: script.functions.filter((fn) => fn.ranges.some((range) => range.count > 0)).length }));
    } catch (error) { recordError('https-coverage', error); }
  } catch (error) { result.page.https = { loaded: false, error: errorText(error) }; }

  if (result.extension && spec?.popup) {
    try {
      await limited(win.loadURL(`chrome-extension://${result.extension.id}/${spec.popup}`), 'popup-navigation');
      await sleep(5000);
      result.popup = { navigated: true, finalUrl: win.webContents.getURL(), title: win.webContents.getTitle() };
      result.popup.dom = await win.webContents.executeJavaScript(`({ text: document.body?.innerText?.slice(0, 1500) || '', buttons: [...document.querySelectorAll('button')].map(button => button.innerText.trim()).filter(Boolean).slice(0, 20), inputs: [...document.querySelectorAll('input')].map(input => input.type).slice(0, 20) })`, true).catch(errorText);
      try { Object.assign(result.popup, await enumerateExtensionPage(win.webContents)); result.popup.enumerated = true; }
      catch (error) { result.popup.enumerated = false; result.popup.enumerationError = errorText(error); }
    } catch (error) { result.popup = { loaded: false, error: errorText(error) }; }
  }
  if (result.extension && spec?.options) {
    try {
      await limited(win.loadURL(`chrome-extension://${result.extension.id}/${spec.options}`), 'options-navigation');
      await sleep(1000);
      result.options = { loaded: true, title: await win.webContents.getTitle() };
    } catch (error) { result.options = { loaded: false, error: errorText(error) }; }
  }

  await sleep(2500);
  snapshotWorkers(browserSession, 'before-idle');
  if (scenario.extension === 'mv3' && !scenario.mainWebRequest) {
    await sleep(35000);
    snapshotWorkers(browserSession, 'after-35s-idle');
    await limited(win.loadURL(`${localUrl}?wake=1`), 'wake-navigation');
    await sleep(4000);
    snapshotWorkers(browserSession, 'after-wake-navigation');
    result.lifecycle.reawakenedContentScript = await win.webContents.executeJavaScript('document.documentElement.getAttribute("data-probe-cs")', true).catch(errorText);
  }

  if (scenario.lifecycleLong || scenario.lifecycleDeep) {
    const elapsed = Date.now() - result.stages.find((item) => item.name === 'extension-loaded').at;
    await sleep(Math.max(0, (scenario.lifecycleDeep ? 130000 : 70000) - elapsed));
    snapshotWorkers(browserSession, scenario.lifecycleDeep ? 'after-130s-lifecycle' : 'after-70s-lifecycle');
    if (scenario.lifecycleDeep && result.extension) {
      await limited(win.loadURL(`chrome-extension://${result.extension.id}/popup.html`), 'lifecycle-popup');
      result.lifecycle.alarmsAt130s = await win.webContents.executeJavaScript(`chrome.alarms.getAll().then(alarms => alarms.map(alarm => ({ name: alarm.name, scheduledTime: alarm.scheduledTime })))`, true).catch(errorText);
      await sleep(3000);
      save();
    }
  }

  result.completed = true;
  save();
  server.close();
  app.exit(0);
}

app.on('child-process-gone', (_event, details) => { result.errors.push({ stage: 'child-process-gone', details }); save(); });
app.on('render-process-gone', (_event, contents, details) => { result.errors.push({ stage: 'app-render-process-gone', webContentsId: contents.id, details }); save(); });
app.whenReady().then(main).catch((error) => { recordError('fatal', error); app.exit(1); });
setTimeout(() => { recordError('watchdog', new Error('scenario exceeded 175 seconds')); app.exit(2); }, 175000);
