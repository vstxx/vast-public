// Probe service worker — enumerates chrome.* surface and functional behavior.
const PORT = __PORT__;
const sendLifecycle = (from, data) => fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from, data }) }).catch(() => {});
self.addEventListener('install', (event) => { event.waitUntil(sendLifecycle('sw-install', { at: Date.now() })); });
self.addEventListener('activate', (event) => { event.waitUntil(sendLifecycle('sw-activate', { at: Date.now() })); });
const fired = { onInstalled: false, onStartup: false, onAlarm: false, permissionsOnAdded: false, permissionsOnRemoved: false, onMessageFromCs: false, onPortFromCs: false, webRequestSeen: false, webNavigationSeen: false, tabsOnUpdatedSeen: false };
const earlyApis = {
  webNavigation: typeof chrome.webNavigation,
  onCommitted: typeof chrome.webNavigation?.onCommitted,
  permissions: typeof chrome.permissions,
  permissionsOnAdded: typeof chrome.permissions?.onAdded,
  browser: typeof globalThis.browser,
  browserRuntime: typeof globalThis.browser?.runtime,
  browserTabs: typeof globalThis.browser?.tabs,
  browserWebNavigation: typeof globalThis.browser?.webNavigation,
  browserPermissions: typeof globalThis.browser?.permissions,
  contextMenus: typeof chrome.contextMenus,
  tabsGetCurrent: typeof chrome.tabs?.getCurrent
};
fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from: 'sw-early-apis', data: earlyApis }) }).catch(() => {});

function apis() {
  const names = ['runtime','storage','alarms','tabs','scripting','webNavigation','webRequest','contextMenus','notifications','cookies','idle','offscreen','privacy','sidePanel','commands','i18n','action','permissions','windows','downloads','declarativeNetRequest','pageAction','browserAction','devtools','proxy','fileBrowserHandler'];
  const out = {};
  for (const n of names) {
    const v = (typeof chrome !== 'undefined') ? chrome[n] : undefined;
    out[n] = v === undefined ? 'missing' : typeof v;
  }
  out.runtimeId = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) ? chrome.runtime.id.slice(0, 4) + '…' : String((typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id));
  return out;
}

async function probe(name, fn) {
  try { const r = await fn(); return { ok: true, result: r === undefined ? null : r }; }
  catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 300) }; }
}

async function functional() {
  const out = {};
  out.getManifest = await probe('getManifest', async () => { const m = chrome.runtime.getManifest(); return { name: m.name, version: m.version }; });
  out.getPlatformInfo = await probe('platform', () => chrome.runtime.getPlatformInfo());
  out.i18n = await probe('i18n', async () => chrome.i18n.getMessage('probeName'));
  out.storageLocalSetGet = await probe('storage.local', async () => { await chrome.storage.local.set({ probe: 'sw' }); return (await chrome.storage.local.get('probe')).probe; });
  out.storageManaged = chrome.storage.managed ? await probe('storage.managed', () => chrome.storage.managed.get({})) : 'missing';
  out.storageSession = chrome.storage.session ? await probe('storage.session', async () => { await chrome.storage.session.set({ s: 1 }); return (await chrome.storage.session.get('s')).s; }) : 'missing';
  out.storageQuotaUnlimited = await probe('unlimited', async () => { await chrome.storage.local.set({ big: 'x'.repeat(6 * 1024 * 1024) }); await chrome.storage.local.remove('big'); return '6MB-ok'; });
  out.alarmsCreate = await probe('alarms.create', () => chrome.alarms.create('probe', { when: Date.now() + 500 }));
  out.alarmPersistencePhase = await probe('phase', () => fetch(`http://127.0.0.1:${PORT}/phase`).then(response => response.text()));
  if (out.alarmPersistencePhase.ok && out.alarmPersistencePhase.result === 'first') {
    out.persistAlarmCreate = await probe('persist-alarm', () => chrome.alarms.create('persist-probe', { when: Date.now() + 45000 }));
  }
  out.alarmsGetAll = await probe('alarms.getAll', () => chrome.alarms.getAll());
  out.tabsQuery = await probe('tabs.query', async () => { const t = await chrome.tabs.query({}); return { count: t.length, first: t[0] ? { id: typeof t[0].id, url: t[0].url, title: t[0].title } : null }; });
  out.tabsEventAdd = await probe('tabs.events', async () => { chrome.tabs.onUpdated.addListener(() => { fired.tabsOnUpdatedSeen = true; }); chrome.tabs.onCreated.addListener(() => {}); chrome.tabs.onRemoved.addListener(() => {}); chrome.tabs.onActivated.addListener(() => {}); return 'added'; });
  out.scriptingExecute = await probe('scripting.executeScript', async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    if (!tabs.length) return 'no-tab';
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: () => { document.documentElement.setAttribute('data-probe-scripting', '1'); return true; } });
    return res && res.result;
  });
  out.scriptingInsertCss = await probe('scripting.insertCSS', async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    if (!tabs.length) return 'no-tab';
    await chrome.scripting.insertCSS({ target: { tabId: tabs[0].id }, css: '/*probe*/' });
    await chrome.scripting.removeCSS({ target: { tabId: tabs[0].id }, css: '/*probe*/' });
    return 'ok';
  });
  out.webNavigationAdd = await probe('webNavigation', async () => { chrome.webNavigation.onBeforeNavigate.addListener((d) => { if (d.url.includes('/page')) fired.webNavigationSeen = true; }); chrome.webNavigation.onCommitted.addListener(() => {}); return 'added'; });
  out.webRequestAdd = await probe('webRequest', async () => {
    chrome.webRequest.onBeforeRequest.addListener((d) => { if (d.url.includes('/beacon')) { fired.webRequestSeen = true; } }, { urls: ['http://127.0.0.1/*'] });
    chrome.webRequest.onHeadersReceived.addListener(() => {}, { urls: ['http://127.0.0.1/*'] }, []);
    return 'added';
  });
  out.webRequestAuthRequired = chrome.webRequest.onAuthRequired ? await probe('webRequest.onAuthRequired', async () => { chrome.webRequest.onAuthRequired.addListener(() => {}, { urls: ['<all_urls>'] }, ['asyncBlocking']); return 'asyncBlocking-added'; }) : 'missing';
  out.contextMenusCreate = await probe('contextMenus.create', () => new Promise((resolve, reject) => { try { const id = chrome.contextMenus.create({ id: 'probe', title: 'Probe', contexts: ['all'] }, () => { if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(String(id)); }); if (id === undefined && chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); } catch (e) { reject(e); } }));
  out.contextMenusOnClicked = await probe('contextMenus.onClicked', async () => { chrome.contextMenus.onClicked.addListener(() => {}); return 'added'; });
  out.notificationsCreate = await probe('notifications.create', () => new Promise((resolve, reject) => { try { chrome.notifications.create({ type: 'basic', title: 'probe', message: 'probe' }, (id) => { if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(String(id)); }); } catch (e) { reject(e); } }));
  out.idleQuery = chrome.idle ? await probe('idle.queryState', () => chrome.idle.queryState(30)) : 'missing';
  out.cookiesGet = await probe('cookies.get', () => chrome.cookies.get({ url: 'http://127.0.0.1/' }));
  out.cookiesSetGet = await probe('cookies.set', () => chrome.cookies.set({ url: 'http://127.0.0.1/', name: 'probe', value: '1' }));
  out.offscreenCreate = chrome.offscreen ? await probe('offscreen.createDocument', async () => {
    if (await chrome.offscreen.hasDocument?.()) await chrome.offscreen.closeDocument();
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'probe' });
    await chrome.offscreen.closeDocument();
    return 'create+close-ok';
  }) : 'missing';
  out.privacy = chrome.privacy ? {
    webrtc: chrome.privacy.webrtc ? await probe('privacy.webrtc', () => chrome.privacy.webrtc.IPHandlingPolicy.get({})) : 'missing',
    services: chrome.privacy.services ? await probe('privacy.services', () => chrome.privacy.services.autofillCreditCardEnabled?.get({}) ?? 'no-key') : 'missing'
  } : 'missing';
  out.sidePanel = chrome.sidePanel ? await probe('sidePanel.setPanelBehavior', () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })) : 'missing';
  out.commandsGetAll = chrome.commands ? await probe('commands.getAll', () => chrome.commands.getAll()) : 'missing';
  out.onMessageExternal = chrome.runtime.onMessageExternal ? await probe('onMessageExternal.addListener', async () => { chrome.runtime.onMessageExternal.addListener(() => {}); return 'added'; }) : 'missing';
  out.actionTitle = chrome.action?.getTitle ? await probe('action.getTitle', async () => { await chrome.action.setTitle({ title: 'Probe title' }); return await chrome.action.getTitle({}); }) : 'missing';
  out.actionBadgeRoundTrip = chrome.action?.getBadgeText ? await probe('action.getBadgeText', async () => { await chrome.action.setBadgeText({ text: '7' }); return await chrome.action.getBadgeText({}); }) : 'missing';
  out.permissionsContains = chrome.permissions?.contains ? await probe('permissions.contains', () => chrome.permissions.contains({ permissions: ['storage'] })) : 'missing';
  out.permissionsContainsRequiredOriginSubset = chrome.permissions?.contains ? await probe('permissions.contains required origin subset', () => chrome.permissions.contains({ origins: ['http://127.0.0.1/proton/*'] })) : 'missing';
  // Chrome treats a request for an already granted required host as a
  // successful no-op. This is used by real extensions before requesting any
  // genuinely optional permissions.
  out.permissionsRequestRequiredOrigin = await probe('permissions.request required origin', () => chrome.permissions.request({ origins: ['http://127.0.0.1/proton/*'] }));
  out.permissionsRequest = await probe('permissions.request', () => chrome.permissions.request({ permissions: ['bookmarks'] }));
  out.permissionsRemove = await probe('permissions.remove', () => chrome.permissions.remove({ permissions: ['bookmarks'] }));
  out.actionBadge = chrome.action ? await probe('action.setBadgeText', () => chrome.action.setBadgeText({ text: '1' })) : 'missing';
  out.windowsGetAll = chrome.windows ? await probe('windows.getAll', () => chrome.windows.getAll()) : 'missing';
  out.declarativeNetRequest = chrome.declarativeNetRequest ? 'present' : 'missing';
  out.runtimeGetURL = await probe('runtime.getURL', () => chrome.runtime.getURL('war.txt'));
  return out;
}

chrome.runtime.onInstalled.addListener((d) => { fired.onInstalled = true; fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from: 'runtime-onInstalled', data: d }) }).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { fired.onStartup = true; fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from: 'runtime-onStartup' }) }).catch(() => {}); });
chrome.alarms.onAlarm.addListener((a) => { fired.onAlarm = true; fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from: 'alarms-onAlarm', data: { name: a.name, scheduledTime: a.scheduledTime, observedAt: Date.now() } }) }).catch(() => {}); });
chrome.permissions?.onAdded?.addListener((added) => { fired.permissionsOnAdded = true; fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from: 'permissions-onAdded', data: added }) }).catch(() => {}); });
chrome.permissions?.onRemoved?.addListener((removed) => { fired.permissionsOnRemoved = true; fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from: 'permissions-onRemoved', data: removed }) }).catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.probe) sendLifecycle('storage-onChanged', { area, newValue: changes.probe.newValue });
});
sendLifecycle('sw-listeners', {
  alarm: chrome.alarms.onAlarm.hasListeners(),
  installed: chrome.runtime.onInstalled.hasListeners(),
  startup: chrome.runtime.onStartup.hasListeners()
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.vastProductionIsolationProbe) {
    sendLifecycle('cross-extension-received', { senderId: sender.id || null, senderUrl: sender.url || null });
    sendResponse({ unexpectedCrossExtensionDelivery: true, receiverId: chrome.runtime.id });
    return true;
  }
  if (msg && msg.type === 'probe-script') {
    chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: 'MAIN', func: () => {
      document.documentElement.setAttribute('data-probe-scripting', '1'); return true;
    } }).then((results) => sendResponse({ ok: results?.[0]?.result === true }), (error) => sendResponse({ error: String(error && error.message || error) }));
    return true;
  }
  if (msg && msg.type === 'probe-cs') {
    fired.onMessageFromCs = true;
    fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from: 'cs-via-sw', data: { received: true, senderUrl: sender.url, senderFrame: sender.frameId, hasResponse: !!sendResponse } }) }).catch(() => {});
    sendResponse({ ack: true });
    return true;
  }
});
chrome.runtime.onMessageExternal?.addListener((_message, _sender, sendResponse) => { sendResponse({ external: true }); });
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'lifecycle-keepalive') {
    port.onMessage.addListener(() => port.postMessage({ ack: true }));
    return;
  }
  if (port.name !== 'probe-port') return;
  fired.onPortFromCs = true;
  port.onMessage.addListener((message) => port.postMessage({ ack: message?.ping === true }));
});

(async () => {
  const functionalResults = await functional();
  fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from: 'sw', data: { apis: apis(), functional: functionalResults } }) }).catch(() => {});
  setTimeout(() => {
    fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from: 'sw-events', data: fired }) }).catch(() => {});
  }, 6000);
  setTimeout(() => {
    fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from: 'sw-events-late', data: fired }) }).catch(() => {});
  }, 12000);
})();
