import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const executableArgument = process.argv.find(value => value.startsWith('--executable='));
if (!executableArgument) throw new Error('Pass --executable=<absolute browser path>.');
const executable = resolve(executableArgument.slice('--executable='.length));
await stat(executable);

const screenshotArgument = process.argv.find(value => value.startsWith('--screenshot='));
const screenshotPath = screenshotArgument ?
    resolve(screenshotArgument.slice('--screenshot='.length)) : null;
const projectionScreenshotArgument =
    process.argv.find(value => value.startsWith('--projection-screenshot='));
const projectionScreenshotPath = projectionScreenshotArgument ?
    resolve(projectionScreenshotArgument.slice('--projection-screenshot='.length)) :
    null;
const keepProfile = process.argv.includes('--keep-profile');
const browserLogs = process.argv.includes('--browser-logs');
const backupArgument =
    process.argv.find(value => value.startsWith('--backup-fixture='));
const backupFixture = backupArgument ?
    resolve(backupArgument.slice('--backup-fixture='.length)) : null;
if (backupFixture) await stat(backupFixture);
const tempRoot = resolve(tmpdir());
const profile = await mkdtemp(join(tempRoot, 'VastWebUISmoke-'));
const ntpProfile = await mkdtemp(join(tempRoot, 'VastNtpSmoke-'));
const migrationFixture = await mkdtemp(join(tempRoot, 'VastMigrationFixture-'));
const migrationDataRoot = await mkdtemp(join(tempRoot, 'VastMigrationData-'));
const migrationTransactionParent =
    await mkdtemp(join(tempRoot, 'VastMigrationTransaction-'));
const migrationFixtureData = join(migrationDataRoot, 'vast-data.json');
const migrationFixtureDataText = JSON.stringify({
  schemaVersion: 5,
  activeWorkspaceId: 'workspace-fixture',
  workspaces: [
    {
      id: 'workspace-fixture',
      name: 'Fixture',
      icon: 'home',
      color: '#123456',
      order: 0,
      isPrivate: false,
    },
    {
      id: 'workspace-secondary',
      name: 'Secondary',
      icon: 'briefcase',
      color: '#abcdef',
      order: 1,
      isPrivate: true,
    },
  ],
  tabGroups: [],
  tabs: [{}, {}, {}],
  bookmarks: [{}, {}, {}, {}],
  bookmarkFolders: [],
  history: [{}],
  downloads: [],
  notes: [{}, {}],
  readingList: [],
  quickLinks: [],
  settings: {theme: 'dark', layoutMode: 'horizontal'},
});
await writeFile(migrationFixtureData, migrationFixtureDataText);
await writeFile(
    join(migrationDataRoot, 'password-vault.json'),
    '{"schemaVersion":1,"records":[]}');
await writeFile(join(migrationDataRoot, 'Cookies'), 'must not migrate');
await writeFile(
    join(migrationFixture, 'data-root.json'),
    JSON.stringify({customDataRoot: migrationDataRoot, updatedAt: Date.now()}));

const sleep = milliseconds =>
    new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

class FatalWaitError extends Error {}

async function waitFor(check, description, timeoutMilliseconds = 120_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (error instanceof FatalWaitError) throw error;
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(
      `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
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
          'error', () => reject(new Error('DevTools WebSocket connection failed.')),
          {once: true});
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  send(method, params = {}, timeoutMilliseconds = 300_000) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools command timed out: ${method}`));
      }, timeoutMilliseconds);
      this.pending.set(id, {resolve: resolvePromise, reject, timer});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

const browserArguments = [
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  backupFixture ?
      `--vast-backup-fixture=${backupFixture}` :
      `--vast-migration-fixture=${migrationFixture}`,
  `--vast-migration-transaction-parent=${migrationTransactionParent}`,
  '--vast-enable-migration-fixture-commit',
  'data:text/html,<title>Vast%20WebUI%20Launcher</title>',
];
if (browserLogs) browserArguments.unshift('--enable-logging=stderr');

async function launchBrowser(profilePath = profile) {
  const portFile = join(profilePath, 'DevToolsActivePort');
  await rm(portFile, {force: true});
  const process = spawn(executable, [
    `--user-data-dir=${profilePath}`,
    ...browserArguments,
  ], {
    stdio: browserLogs ? 'inherit' : 'ignore',
    windowsHide: true,
  });
  const port = await waitFor(async () => {
    if (process.exitCode !== null) {
      throw new FatalWaitError(`browser exited with code ${process.exitCode}`);
    }
    try {
      const [portLine] = (await readFile(portFile, 'utf8')).split(/\r?\n/);
      return Number.parseInt(portLine, 10) || false;
    } catch {
      return false;
    }
  }, 'DevToolsActivePort');
  return {process, port};
}

async function connectVastPage(port, process) {
  const createUrl =
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent('chrome://vast/')}`;
  await waitFor(async () => {
    if (process.exitCode !== null) {
      throw new FatalWaitError(`browser exited with code ${process.exitCode}`);
    }
    const createResponse = await fetch(createUrl, {method: 'PUT'});
    return createResponse.ok ? true : false;
  }, 'chrome://vast target creation');
  const target = await waitFor(async () => {
    const targets =
        await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find(
        value => value.type === 'page' && value.url === 'chrome://vast/');
  }, 'chrome://vast target');
  const connection = new CdpConnection(target.webSocketDebuggerUrl);
  await connection.connect();
  await connection.send('Page.enable');
  await connection.send('Runtime.enable');
  return {connection, target};
}

async function verifyVastNewTab(port, process) {
  const createUrl =
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent('chrome://newtab/')}`;
  const createdTarget = await waitFor(async () => {
    if (process.exitCode !== null) {
      throw new FatalWaitError(`browser exited with code ${process.exitCode}`);
    }
    const response = await fetch(createUrl, {method: 'PUT'});
    return response.ok ? response.json() : false;
  }, 'chrome://newtab target creation');
  return waitFor(async () => {
    const targets =
        await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(value => value.id === createdTarget.id);
    if (!target || target.title !== 'Vast' ||
        (target.url !== 'chrome://newtab/' && target.url !== 'chrome://vast/')) {
      return false;
    }
    return {id: target.id, title: target.title, url: target.url};
  }, 'Vast title behind chrome://newtab', 120_000);
}

async function closeBrowser(process, activeConnection) {
  await activeConnection?.send('Browser.close').catch(() => {});
  await waitFor(() => process?.exitCode !== null, 'browser shutdown', 10_000)
      .catch(() => process?.kill());
  activeConnection?.close();
}

let browser;
let ntpBrowser;
let connection;
let target;
let productRootRecoveredAfterRestart = false;
let workspaceSelectionPersistedAfterRestart = false;
let selectedWorkspaceId;
let expectedWorkspaceCount = 0;
let newTabRoute;
try {
  let launched = await launchBrowser(ntpProfile);
  ntpBrowser = launched.process;
  newTabRoute = await verifyVastNewTab(launched.port, ntpBrowser);

  launched = await launchBrowser();
  browser = launched.process;
  let page = await connectVastPage(launched.port, browser);
  connection = page.connection;
  target = page.target;

  let lastPageState;
  const pageState = await waitFor(async () => {
    const evaluation = await connection.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `({
        ready: document.documentElement.dataset.vastReady,
        href: location.href,
        title: document.title,
        bodyText: document.body?.innerText.slice(0, 300),
        runtime: document.querySelector('#runtime-architecture')?.textContent,
        product: document.querySelector('#product-version')?.textContent,
        proof: document.querySelector('#runtime-proof')?.textContent,
        migrationState: document.documentElement.dataset.migrationPreview,
        migrationSummary: document.querySelector('#migration-summary')?.textContent,
        migrationDetails: document.querySelector('#migration-details')?.textContent,
        migrationTransaction: document.documentElement.dataset.migrationTransaction,
        productDataState: document.documentElement.dataset.productData,
        productDataStatus: document.querySelector('#product-data-status')?.textContent,
        migrationControlsVisible: !document.querySelector('#migration-controls')?.hidden,
        hasRuntimeCard: Boolean(document.querySelector('[data-testid="runtime-card"]')),
        hasMigrationCard: Boolean(document.querySelector('[data-testid="migration-card"]')),
        hasHome: Boolean(document.querySelector('[data-testid="vast-home"]')),
        hasSearch: Boolean(document.querySelector('[data-testid="vast-search"]')),
        searchAction: document.querySelector('#search-form')?.action,
        workspaceCount: document.querySelector('#workspace-count')?.textContent,
        workspaceItems: document.querySelectorAll('[data-workspace-id]').length,
      })`,
    });
    lastPageState = evaluation;
    return evaluation.result?.value?.ready === 'true' ? evaluation.result.value : false;
  }, 'Vast WebUI readiness', 300_000).catch(async error => {
    const moduleProbe = await connection.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `import('./app.js').then(
        () => ({ok: true}),
        moduleError => ({ok: false, error: moduleError.stack || String(moduleError)}))`,
    });
    throw new Error(
        `${error.message}; last state: ${JSON.stringify(lastPageState)}; module: ${JSON.stringify(moduleProbe)}`);
  });

  const expected = {
    title: 'Vast',
    runtime: 'Upstream Chromium //chrome',
    product: 'Vast 2.0.0-dev',
    proof: 'Electron runtime absent',
    migrationState: 'compatible',
    migrationSummary: 'Schema 5 fixture ready',
    migrationTransaction: 'ready',
    productDataState: 'not-selected',
    migrationControlsVisible: true,
    hasRuntimeCard: true,
    hasMigrationCard: true,
    hasHome: true,
    hasSearch: true,
    searchAction: 'https://www.google.com/search',
    workspaceCount: '0',
    workspaceItems: 1,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (pageState[key] !== value) {
      throw new Error(`Unexpected Vast WebUI ${key}: ${JSON.stringify(pageState[key])}`);
    }
  }
  if (backupFixture) {
    if (!pageState.migrationDetails?.includes('archive file(s) verified;') ||
        !pageState.migrationDetails.includes('Vast product file(s) selected.')) {
      throw new Error(
          `Backup preview lacks aggregate verification: ${JSON.stringify(pageState.migrationDetails)}`);
    }
  } else if (!pageState.migrationDetails?.includes(
      '2 workspace(s), 3 tab(s), 4 bookmark(s), 2 note(s), and 1 history item(s).')) {
    throw new Error(
        `Unexpected Vast migration preview: ${JSON.stringify(pageState.migrationDetails)}`);
  }
  if (!pageState.migrationDetails.includes(
      'Password vault detected but excluded from preview.')) {
    throw new Error('Migration preview did not explicitly exclude the password vault.');
  }
  const workspaceCountMatch =
      pageState.migrationDetails.match(/(\d+) workspace\(s\)/);
  expectedWorkspaceCount = Number.parseInt(workspaceCountMatch?.[1] || '', 10);
  if (!Number.isSafeInteger(expectedWorkspaceCount) ||
      expectedWorkspaceCount < 1) {
    throw new Error(
        `Migration preview lacks a valid workspace count: ${JSON.stringify(pageState.migrationDetails)}`);
  }

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
  const committedTransaction = await waitFor(async () => {
    const evaluation = await connection.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `({
        state: document.documentElement.dataset.migrationTransaction,
        result: document.querySelector('#migration-result')?.textContent,
        rollbackVisible: !document.querySelector('#migration-rollback')?.hidden,
      })`,
    });
    const value = evaluation.result?.value;
    if (!value?.state || value.state === 'working') return false;
    return value.state === 'committed' && !value.rollbackVisible ? false : value;
  }, 'fixture migration commit', 300_000);
  if (committedTransaction.state !== 'committed') {
    throw new Error(
        `Fixture migration did not commit: ${JSON.stringify(committedTransaction)}`);
  }
  if (!committedTransaction.result?.includes(
      'The Electron source was not modified.')) {
    throw new Error(
        `Unexpected migration result: ${JSON.stringify(committedTransaction)}`);
  }
  if (!committedTransaction.rollbackVisible) {
    throw new Error('Rollback confirmation was not exposed after commit.');
  }

  const recoveredProductData = await waitFor(async () => {
    const evaluation = await connection.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `({
        state: document.documentElement.dataset.productData,
        status: document.querySelector('#product-data-status')?.textContent,
        workspaceCount: document.querySelector('#workspace-count')?.textContent,
        workspaceItems: document.querySelectorAll('[data-workspace-id]').length,
        activeWorkspace: document.querySelector('#active-workspace-name')?.textContent,
        activeWorkspaceIds: [...document.querySelectorAll('[data-workspace-active="true"]')]
            .map(element => element.dataset.workspaceId),
      })`,
    });
    return evaluation.result?.value?.state === 'recovered' ?
        evaluation.result.value : false;
  }, 'profile-local product-root activation', 300_000);
  if (!recoveredProductData.status?.includes(
      `Vast 2 data recovered: schema 5, ${expectedWorkspaceCount} workspace(s), dark theme.`)) {
    throw new Error(
        `Unexpected recovered product data: ${JSON.stringify(recoveredProductData)}`);
  }
  if (recoveredProductData.workspaceCount !== String(expectedWorkspaceCount) ||
      recoveredProductData.workspaceItems !== expectedWorkspaceCount ||
      !recoveredProductData.activeWorkspace ||
      recoveredProductData.activeWorkspaceIds.length !== 1 ||
      (!backupFixture &&
       recoveredProductData.activeWorkspaceIds[0] !== 'workspace-fixture')) {
    throw new Error(
        `Workspace projection did not render safely: ${JSON.stringify(recoveredProductData)}`);
  }

  const migratedDestination =
      join(migrationTransactionParent, 'migrated-vast-data');
  const productRootSelection =
      join(profile, 'Default', 'VastProductData', 'root-selection.json');
  const selectedRoot = JSON.parse(await readFile(productRootSelection, 'utf8'));
  if (selectedRoot.state !== 'active' ||
      resolve(selectedRoot.dataRoot) !== resolve(migratedDestination)) {
    throw new Error(
        `Unexpected profile-local product-root selection: ${JSON.stringify(selectedRoot)}`);
  }
  if (!backupFixture &&
      (await readFile(join(migratedDestination, 'vast-data.json'), 'utf8')) !==
          migrationFixtureDataText) {
    throw new Error('Committed fixture data does not match the copied source.');
  }
  await stat(join(migratedDestination, 'password-vault.json'));
  if (await stat(join(migratedDestination, 'Cookies')).then(() => true, () => false)) {
    throw new Error('Electron cookie storage crossed the migration boundary.');
  }
  const transactionDirectoryName =
      (await readdir(migrationTransactionParent))
          .find(name => name.startsWith('.vast-migration-'));
  if (!transactionDirectoryName) {
    throw new Error('Native migration transaction directory was not created.');
  }
  const transactionDirectory =
      join(migrationTransactionParent, transactionDirectoryName);
  const committedJournal = JSON.parse(
      await readFile(join(transactionDirectory, 'migration-journal.json'), 'utf8'));
  if (committedJournal.state !== 'committed' ||
      !Array.isArray(committedJournal.files) ||
      committedJournal.files.length === 0 ||
      (!backupFixture && committedJournal.files.length !== 2) ||
      committedJournal.files.some(file =>
        /(^|\/)(Cookies|Local State|Preferences|Sessions)(\/|$)/i.test(file.path))) {
    throw new Error(
        `Unexpected committed migration journal: ${JSON.stringify(committedJournal)}`);
  }

  await closeBrowser(browser, connection);
  browser = undefined;
  connection = undefined;
  launched = await launchBrowser();
  browser = launched.process;
  page = await connectVastPage(launched.port, browser);
  connection = page.connection;
  target = page.target;

  const restartedProductData = await waitFor(async () => {
    const evaluation = await connection.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `({
        ready: document.documentElement.dataset.vastReady,
        productData: document.documentElement.dataset.productData,
        transaction: document.documentElement.dataset.migrationTransaction,
        status: document.querySelector('#product-data-status')?.textContent,
        runHidden: document.querySelector('#migration-run')?.hidden,
        rollbackVisible: !document.querySelector('#migration-rollback')?.hidden,
        workspaceCount: document.querySelector('#workspace-count')?.textContent,
        workspaceItems: document.querySelectorAll('[data-workspace-id]').length,
        activeWorkspaceIds: [...document.querySelectorAll('[data-workspace-active="true"]')]
            .map(element => element.dataset.workspaceId),
      })`,
    });
    return evaluation.result?.value?.ready === 'true' ?
        evaluation.result.value : false;
  }, 'product-root recovery after browser restart', 300_000);
  if (restartedProductData.productData !== 'recovered' ||
      restartedProductData.transaction !== 'recovered' ||
      restartedProductData.runHidden !== true ||
      restartedProductData.rollbackVisible !== true ||
      restartedProductData.workspaceCount !== String(expectedWorkspaceCount) ||
      restartedProductData.workspaceItems !== expectedWorkspaceCount ||
      restartedProductData.activeWorkspaceIds.length !== 1 ||
      !restartedProductData.status?.includes(
          `Vast 2 data recovered: schema 5, ${expectedWorkspaceCount} workspace(s), dark theme.`)) {
    throw new Error(
        `Product root did not recover safely after restart: ${JSON.stringify(restartedProductData)}`);
  }
  productRootRecoveredAfterRestart = true;

  const migratedDataBeforeWorkspaceSelection =
      await readFile(join(migratedDestination, 'vast-data.json'));
  const workspaceSelectionTarget = await connection.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const target = [...document.querySelectorAll('button[data-workspace-id]')]
          .find(element => element.dataset.workspaceActive === 'false');
      if (!target) return null;
      const result = {
        id: target.dataset.workspaceId,
        label: target.getAttribute('aria-label'),
      };
      target.click();
      return result;
    })()`,
  });
  const selectionTarget = workspaceSelectionTarget.result?.value;
  if (!selectionTarget?.id) {
    throw new Error('No inactive workspace was available for selection.');
  }
  selectedWorkspaceId = selectionTarget.id;

  const selectedWorkspace = await waitFor(async () => {
    const evaluation = await connection.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `({
        state: document.documentElement.dataset.workspaceSelection,
        activeWorkspaceId: document.documentElement.dataset.activeWorkspaceId,
        activeWorkspace: document.querySelector('#active-workspace-name')?.textContent,
        activeWorkspaceIds: [...document.querySelectorAll('[data-workspace-active="true"]')]
            .map(element => element.dataset.workspaceId),
      })`,
    });
    const value = evaluation.result?.value;
    return value?.state === 'selected' ? value : false;
  }, 'profile-local workspace selection');
  if (selectedWorkspace.activeWorkspaceId !== selectedWorkspaceId ||
      selectedWorkspace.activeWorkspaceIds.length !== 1 ||
      selectedWorkspace.activeWorkspaceIds[0] !== selectedWorkspaceId) {
    throw new Error(
        `Workspace selection was not reflected in WebUI: ${JSON.stringify(selectedWorkspace)}`);
  }

  const workspaceSelectionPath =
      join(profile, 'Default', 'VastProductData', 'workspace-selection.json');
  const workspaceSelection =
      JSON.parse(await readFile(workspaceSelectionPath, 'utf8'));
  if (workspaceSelection.formatVersion !== 1 ||
      workspaceSelection.workspaceId !== selectedWorkspaceId ||
      resolve(workspaceSelection.journalPath) !== resolve(selectedRoot.journalPath)) {
    throw new Error(
        `Unexpected workspace selection envelope: ${JSON.stringify(workspaceSelection)}`);
  }

  await closeBrowser(browser, connection);
  browser = undefined;
  connection = undefined;
  launched = await launchBrowser();
  browser = launched.process;
  page = await connectVastPage(launched.port, browser);
  connection = page.connection;
  target = page.target;

  const restartedWorkspaceSelection = await waitFor(async () => {
    const evaluation = await connection.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `({
        ready: document.documentElement.dataset.vastReady,
        productData: document.documentElement.dataset.productData,
        activeWorkspaceId: document.documentElement.dataset.activeWorkspaceId,
        activeWorkspaceIds: [...document.querySelectorAll('[data-workspace-active="true"]')]
            .map(element => element.dataset.workspaceId),
      })`,
    });
    return evaluation.result?.value?.ready === 'true' ?
        evaluation.result.value : false;
  }, 'workspace selection recovery after browser restart', 300_000);
  if (restartedWorkspaceSelection.productData !== 'recovered' ||
      restartedWorkspaceSelection.activeWorkspaceId !== selectedWorkspaceId ||
      restartedWorkspaceSelection.activeWorkspaceIds.length !== 1 ||
      restartedWorkspaceSelection.activeWorkspaceIds[0] !==
          selectedWorkspaceId) {
    throw new Error(
        `Workspace selection did not survive restart: ${JSON.stringify(restartedWorkspaceSelection)}`);
  }
  const migratedDataAfterWorkspaceSelection =
      await readFile(join(migratedDestination, 'vast-data.json'));
  if (!migratedDataAfterWorkspaceSelection.equals(
          migratedDataBeforeWorkspaceSelection)) {
    throw new Error('Workspace selection modified imported vast-data.json.');
  }
  workspaceSelectionPersistedAfterRestart = true;

  if (projectionScreenshotPath) {
    const projectionScreenshot = await connection.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(
        projectionScreenshotPath,
        Buffer.from(projectionScreenshot.data, 'base64'));
  }

  await connection.send('Runtime.evaluate', {
    expression: `(() => {
      const confirmation = document.querySelector('#rollback-confirm');
      const button = document.querySelector('#migration-rollback');
      confirmation.checked = true;
      confirmation.dispatchEvent(new Event('change'));
      if (button.disabled) throw new Error('Rollback button stayed disabled.');
      button.click();
    })()`,
  });
  const rolledBackTransaction = await waitFor(async () => {
    const evaluation = await connection.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `({
        state: document.documentElement.dataset.migrationTransaction,
        result: document.querySelector('#migration-result')?.textContent,
      })`,
    });
    return evaluation.result?.value?.state === 'rolled-back' ?
        evaluation.result.value : false;
  }, 'fixture migration rollback', 300_000);
  if (!rolledBackTransaction.result?.includes('Source unchanged.')) {
    throw new Error(
        `Unexpected rollback result: ${JSON.stringify(rolledBackTransaction)}`);
  }
  const clearedWorkspaceProjection = await waitFor(async () => {
    const evaluation = await connection.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `({
        productData: document.documentElement.dataset.productData,
        workspaceCount: document.querySelector('#workspace-count')?.textContent,
        workspaceItems: document.querySelectorAll('[data-workspace-id]').length,
        activeWorkspace: document.querySelector('#active-workspace-name')?.textContent,
      })`,
    });
    return evaluation.result?.value?.productData === 'not-selected' ?
        evaluation.result.value : false;
  }, 'workspace projection clear after rollback');
  if (clearedWorkspaceProjection.workspaceCount !== '0' ||
      clearedWorkspaceProjection.workspaceItems !== 1 ||
      clearedWorkspaceProjection.activeWorkspace !== 'Vast') {
    throw new Error(
        `Workspace projection remained after rollback: ${JSON.stringify(clearedWorkspaceProjection)}`);
  }
  if (await stat(migratedDestination).then(() => true, () => false)) {
    throw new Error('Committed destination still exists after rollback.');
  }
  if (await stat(productRootSelection).then(() => true, () => false)) {
    throw new Error('Product-root selection still exists after rollback.');
  }
  await stat(join(transactionDirectory, 'rolled-back-data', 'vast-data.json'));
  const rolledBackJournal = JSON.parse(
      await readFile(join(transactionDirectory, 'migration-journal.json'), 'utf8'));
  if (rolledBackJournal.state !== 'rolled-back') {
    throw new Error(
        `Migration journal did not record rollback: ${JSON.stringify(rolledBackJournal)}`);
  }

  let invalidMigrationRejected = false;
  let invalidDataRootRejected = false;
  if (!backupFixture) {
    await writeFile(migrationFixtureData, '{"schemaVersion":');
    const invalidEvaluation = await connection.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const mojo = await import('./vast.mojom-webui.js');
        const handler = new mojo.PageHandlerRemote();
        mojo.PageHandlerFactory.getRemote().createPageHandler(
            handler.$.bindNewPipeAndPassReceiver());
        return (await handler.getMigrationPreview()).preview;
      })()`,
    });
    const invalidPreview = invalidEvaluation.result?.value;
    if (!invalidPreview?.available || invalidPreview.compatible ||
        invalidPreview.error !== 'Vast data file is not valid JSON.') {
      throw new Error(
          `Invalid migration fixture was not rejected: ${JSON.stringify(invalidPreview)}`);
    }
    invalidMigrationRejected = true;

    await writeFile(migrationFixtureData, migrationFixtureDataText);
    await writeFile(
        join(migrationFixture, 'data-root.json'),
        '{"customDataRoot":"relative-profile"}');
    const invalidDataRootEvaluation = await connection.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const mojo = await import('./vast.mojom-webui.js');
        const handler = new mojo.PageHandlerRemote();
        mojo.PageHandlerFactory.getRemote().createPageHandler(
            handler.$.bindNewPipeAndPassReceiver());
        return (await handler.getMigrationPreview()).preview;
      })()`,
    });
    const invalidDataRootPreview = invalidDataRootEvaluation.result?.value;
    if (invalidDataRootPreview?.available ||
        invalidDataRootPreview?.compatible ||
        invalidDataRootPreview?.error !==
            'data-root.json must contain an absolute customDataRoot.') {
      throw new Error(
          `Invalid data-root fixture was not rejected: ${JSON.stringify(invalidDataRootPreview)}`);
    }
    invalidDataRootRejected = true;
  }

  if (screenshotPath) {
    const screenshot = await connection.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  }

  console.log(JSON.stringify({
    schemaVersion: 1,
    url: target.url,
    ...pageState,
    backupFixtureAudited: Boolean(backupFixture),
    invalidMigrationRejected,
    invalidDataRootRejected,
    migrationTransactionCommitted: true,
    migrationTransactionRolledBack: true,
    productRootActivatedAndCleared: true,
    productRootRecoveredAfterRestart,
    workspaceSelectionPersistedAfterRestart,
    selectedWorkspaceId,
    newTabRouteVerified: Boolean(newTabRoute),
    newTabRoute,
    workspaceProjectionRenderedAfterRestart: true,
    projectionScreenshot: projectionScreenshotPath,
    screenshot: screenshotPath,
  }));

  await closeBrowser(browser, connection);
  browser = undefined;
  connection = undefined;
} finally {
  connection?.close();
  if (browser?.exitCode === null) {
    browser.kill();
    await waitFor(() => browser.exitCode !== null, 'browser cleanup', 10_000)
        .catch(() => {});
  }
  if (ntpBrowser?.exitCode === null) {
    ntpBrowser.kill();
    await waitFor(
        () => ntpBrowser.exitCode !== null, 'NTP browser cleanup', 10_000)
        .catch(() => {});
  }
  if (!keepProfile && profile.startsWith(`${tempRoot}\\`)) {
    await rm(profile, {recursive: true, force: true, maxRetries: 20, retryDelay: 250});
  }
  if (ntpProfile.startsWith(`${tempRoot}\\`)) {
    await rm(ntpProfile, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
  if (migrationFixture.startsWith(`${tempRoot}\\`)) {
    await rm(migrationFixture, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
  if (migrationDataRoot.startsWith(`${tempRoot}\\`)) {
    await rm(migrationDataRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
  if (migrationTransactionParent.startsWith(`${tempRoot}\\`)) {
    await rm(migrationTransactionParent, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
}
