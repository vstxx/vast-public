import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const executableArgument = process.argv.find((value) => value.startsWith('--executable='));
if (!executableArgument) throw new Error('Pass --executable=<absolute browser path>.');
const executable = resolve(executableArgument.slice('--executable='.length));
await stat(executable);

const keepProfile = process.argv.includes('--keep-profile');
const tempRoot = resolve(tmpdir());
const profile = await mkdtemp(join(tempRoot, 'VastNativeCapabilities-'));
const downloadDirectory = join(profile, 'SmokeDownloads');
await mkdir(downloadDirectory);
const result = {
  schemaVersion: 1,
  executable: basename(executable),
  devTools: false,
  multiTab: false,
  cookiesPersisted: false,
  serviceWorker: false,
  popup: false,
  download: false,
  permissionsApi: false,
};

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function waitFor(check, description, timeoutMilliseconds = 120_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener('open', resolvePromise, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('DevTools WebSocket connection failed.')), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve: resolvePending, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
      else resolvePending(message.result);
    });
    this.socket.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('DevTools WebSocket closed before a response arrived.'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMilliseconds = 30_000) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools command timed out: ${method}`));
      }, timeoutMilliseconds);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url, 'http://127.0.0.1');
  if (requestUrl.pathname === '/sw.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
      'Cache-Control': 'no-store',
    });
    response.end(`
      self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
      self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
      self.addEventListener('message', (event) => {
        if (event.data === 'vast-ping') event.ports[0].postMessage('vast-service-worker-ok');
      });
      self.addEventListener('fetch', (event) => {
        if (new URL(event.request.url).pathname === '/sw-check') {
          event.respondWith(new Response('vast-service-worker-ok'));
        }
      });
    `);
    return;
  }
  if (requestUrl.pathname === '/download') {
    response.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Disposition': 'attachment; filename="vast-smoke-download.txt"',
    });
    response.end('vast-download-ok');
    return;
  }
  if (requestUrl.pathname === '/popup') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<title>Vast Popup Smoke</title><h1>popup</h1>');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end('<title>Vast Capability Smoke</title><h1>Vast Capability Smoke</h1>');
});

await new Promise((resolvePromise, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolvePromise);
});
const origin = `http://127.0.0.1:${server.address().port}`;

async function launchBrowser() {
  const portFile = join(profile, 'DevToolsActivePort');
  await rm(portFile, { force: true });
  const child = spawn(executable, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    `${origin}/`,
  ], { stdio: 'ignore', windowsHide: true });
  const port = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`browser exited with code ${child.exitCode}`);
    try {
      const [portLine] = (await readFile(portFile, 'utf8')).split(/\r?\n/);
      return Number.parseInt(portLine, 10) || false;
    } catch {
      return false;
    }
  }, 'DevToolsActivePort');
  return { child, port };
}

async function stopBrowser(child, connection) {
  try {
    await connection?.send('Browser.close');
  } catch {
    connection?.close();
  }
  try {
    await waitFor(() => child.exitCode !== null, 'browser shutdown', 10_000);
  } catch {
    child.kill();
    await waitFor(() => child.exitCode !== null, 'forced browser shutdown', 10_000);
  }
  connection?.close();
}

let first;
let firstConnection;
let second;
let secondConnection;
try {
  first = await launchBrowser();
  const version = await (await fetch(`http://127.0.0.1:${first.port}/json/version`)).json();
  if (!version.Browser || /Electron/i.test(version.Browser)) throw new Error(`Unexpected runtime identity: ${version.Browser}`);
  result.devTools = true;

  const firstTarget = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${first.port}/json/list`)).json();
    return targets.find((target) => target.type === 'page' && target.url === `${origin}/`);
  }, 'local capability tab');
  firstConnection = new CdpConnection(firstTarget.webSocketDebuggerUrl);
  await firstConnection.connect();
  await firstConnection.send('Page.enable');
  await firstConnection.send('Runtime.enable');
  await waitFor(async () => {
    const readiness = await firstConnection.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `({ readyState: document.readyState, href: location.href })`,
    });
    return readiness.result?.value?.readyState === 'complete'
      && readiness.result.value.href === `${origin}/`;
  }, 'capability page readiness');
  await firstConnection.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory });

  const capabilityEvaluation = await firstConnection.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    expression: `(async () => {
      document.cookie = 'vastSmoke=persisted; SameSite=Lax; path=/; max-age=3600';
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const messageChannel = new MessageChannel();
      const serviceWorkerText = await new Promise((resolve) => {
        messageChannel.port1.onmessage = (event) => resolve(event.data);
        registration.active.postMessage('vast-ping', [messageChannel.port2]);
      });
      const permission = await navigator.permissions.query({ name: 'geolocation' });
      window.open('/popup', '_blank');
      const anchor = document.createElement('a');
      anchor.href = '/download';
      anchor.download = 'vast-smoke-download.txt';
      document.body.appendChild(anchor);
      anchor.click();
      return {
        cookie: document.cookie,
        serviceWorkerText,
        serviceWorkerState: registration.active?.state,
        permissionState: permission.state,
      };
    })()`,
  });
  if (!capabilityEvaluation.result?.value) {
    const details = capabilityEvaluation.exceptionDetails?.exception?.description
      || capabilityEvaluation.exceptionDetails?.text
      || JSON.stringify(capabilityEvaluation);
    throw new Error(`Capability page evaluation failed: ${details}`);
  }
  const capabilities = capabilityEvaluation.result.value;
  result.serviceWorker = capabilities.serviceWorkerText === 'vast-service-worker-ok' && capabilities.serviceWorkerState === 'activated';
  result.permissionsApi = ['granted', 'denied', 'prompt'].includes(capabilities.permissionState);
  if (typeof capabilities.cookie !== 'string') {
    throw new Error(`Capability page did not return a cookie string: ${JSON.stringify(capabilities)}`);
  }
  if (!capabilities.cookie.includes('vastSmoke=persisted')) throw new Error('Cookie was not set in the first run.');

  const targets = await waitFor(async () => {
    const values = await (await fetch(`http://127.0.0.1:${first.port}/json/list`)).json();
    return values.some((target) => target.type === 'page' && target.url === `${origin}/popup`) ? values : false;
  }, 'popup tab');
  result.popup = true;
  result.multiTab = targets.filter((target) => target.type === 'page').length >= 2;

  const downloaded = join(downloadDirectory, 'vast-smoke-download.txt');
  await waitFor(async () => {
    try {
      return (await readFile(downloaded, 'utf8')) === 'vast-download-ok';
    } catch {
      return false;
    }
  }, 'download completion');
  result.download = true;

  await stopBrowser(first.child, firstConnection);
  firstConnection = null;

  second = await launchBrowser();
  const secondTarget = await waitFor(async () => {
    const targetsAfterRestart = await (await fetch(`http://127.0.0.1:${second.port}/json/list`)).json();
    return targetsAfterRestart.find((target) => target.type === 'page' && target.url === `${origin}/`);
  }, 'restart capability tab');
  secondConnection = new CdpConnection(secondTarget.webSocketDebuggerUrl);
  await secondConnection.connect();
  await secondConnection.send('Runtime.enable');
  await waitFor(async () => {
    const readyState = await secondConnection.send('Runtime.evaluate', {
      returnByValue: true,
      expression: 'document.readyState',
    });
    return readyState.result?.value === 'complete';
  }, 'restart page readiness');
  const cookieEvaluation = await secondConnection.send('Runtime.evaluate', {
    returnByValue: true,
    expression: 'document.cookie',
  });
  if (typeof cookieEvaluation.result?.value !== 'string') {
    const details = cookieEvaluation.exceptionDetails?.exception?.description
      || cookieEvaluation.exceptionDetails?.text
      || JSON.stringify(cookieEvaluation);
    throw new Error(`Restart cookie evaluation failed: ${details}`);
  }
  result.cookiesPersisted = cookieEvaluation.result.value.includes('vastSmoke=persisted');
  await stopBrowser(second.child, secondConnection);
  secondConnection = null;

  const failed = Object.entries(result).filter(([key, value]) => key !== 'schemaVersion' && key !== 'executable' && value !== true);
  if (failed.length) throw new Error(`Capability checks failed: ${failed.map(([key]) => key).join(', ')}`);
  console.log(JSON.stringify(result));
} finally {
  firstConnection?.close();
  secondConnection?.close();
  for (const browser of [first, second]) {
    if (!browser?.child || browser.child.exitCode !== null) continue;
    browser.child.kill();
    await waitFor(() => browser.child.exitCode !== null, 'browser cleanup', 10_000).catch(() => {});
  }
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!keepProfile && profile.startsWith(`${tempRoot}\\`)) {
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}
