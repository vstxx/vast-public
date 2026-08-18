import {spawn} from 'node:child_process';
import {readFile, rm, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';

const argument = name => {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
};
const portArgument = argument('port');
const executableArgument = argument('executable');
const profileArgument = argument('profile');
const fixtureArgument = argument('fixture');
const transactionArgument = argument('transaction-parent');
let port = Number.parseInt(portArgument || '', 10);
let browserProcess;

const sleep = milliseconds =>
    new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

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
  throw new Error(
      `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

if (executableArgument) {
  if (!profileArgument || !fixtureArgument || !transactionArgument) {
    throw new Error(
        'Spawn mode requires --profile, --fixture, and --transaction-parent.');
  }
  const executable = resolve(executableArgument);
  const profile = resolve(profileArgument);
  const fixture = resolve(fixtureArgument);
  const transactionParent = resolve(transactionArgument);
  await Promise.all([
    stat(executable),
    stat(profile),
    stat(fixture),
    stat(transactionParent),
  ]);
  const portFile = join(profile, 'DevToolsActivePort');
  await rm(portFile, {force: true});
  browserProcess = spawn(executable, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    `--vast-migration-fixture=${fixture}`,
    `--vast-migration-transaction-parent=${transactionParent}`,
    '--vast-enable-migration-fixture-commit',
    'data:text/html,<title>Vast%20Fixture%20Preparation</title>',
  ], {stdio: 'ignore', windowsHide: true});
  port = await waitFor(async () => {
    if (browserProcess.exitCode !== null) {
      throw new Error(`Browser exited with code ${browserProcess.exitCode}.`);
    }
    try {
      const [line] = (await readFile(portFile, 'utf8')).split(/\r?\n/);
      return Number.parseInt(line, 10) || false;
    } catch {
      return false;
    }
  }, 'spawned browser DevTools port');
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('Pass --port=<DevTools port> or complete spawn arguments.');
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
      this.socket.addEventListener('open', resolvePromise, {once: true});
      this.socket.addEventListener(
          'error', () => reject(new Error('DevTools connection failed.')),
          {once: true});
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools command timed out: ${method}`));
      }, 120_000);
      this.pending.set(id, {resolve: resolvePromise, reject, timer});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

const createUrl =
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent('chrome://vast/')}`;
const target = await waitFor(async () => {
  const response = await fetch(createUrl, {method: 'PUT'});
  return response.ok ? response.json() : false;
}, 'chrome://vast target creation');

const connection = new CdpConnection(target.webSocketDebuggerUrl);
try {
  await connection.connect();
  await connection.send('Page.enable');
  await connection.send('Runtime.enable');
  await waitFor(async () => {
    const evaluation = await connection.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `({
        ready: document.documentElement.dataset.vastReady,
        preview: document.documentElement.dataset.migrationPreview,
        controls: !document.querySelector('#migration-controls')?.hidden,
      })`,
    });
    const value = evaluation.result?.value;
    return value?.ready === 'true' && value.preview === 'compatible' &&
        value.controls;
  }, 'Vast fixture controls');

  await connection.send('Runtime.evaluate', {
    expression: `(() => {
      const confirmation = document.querySelector('#migration-confirm');
      const button = document.querySelector('#migration-run');
      confirmation.checked = true;
      confirmation.dispatchEvent(new Event('change'));
      if (button.disabled) throw new Error('Migration button stayed disabled.');
      button.click();
    })()`,
  });

  const result = await waitFor(async () => {
    const evaluation = await connection.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `({
        transaction: document.documentElement.dataset.migrationTransaction,
        productData: document.documentElement.dataset.productData,
        activeWorkspaceId: document.documentElement.dataset.activeWorkspaceId,
      })`,
    });
    const value = evaluation.result?.value;
    return value?.transaction === 'committed' &&
        value.productData === 'recovered' ? value : false;
  }, 'fixture commit and product-data recovery');
  console.log(JSON.stringify(result));
  if (browserProcess) {
    await connection.send('Browser.close').catch(() => {});
    await waitFor(
        () => browserProcess.exitCode !== null,
        'spawned browser shutdown',
        10_000).catch(() => browserProcess.kill());
  }
} finally {
  connection.close();
  if (browserProcess?.exitCode === null) browserProcess.kill();
}
