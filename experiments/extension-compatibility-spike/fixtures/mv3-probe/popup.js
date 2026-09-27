// Probe extension page context
const PORT = __PORT__;

async function report(from, data) {
  try { await fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from, data }) }); } catch (e) {}
}

(async () => {
  const data = {
    hasChrome: typeof chrome !== 'undefined',
    runtimeId: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || null,
    getManifest: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) ? (() => { const m = chrome.runtime.getManifest(); return { name: m.name, version: m.version }; })() : null,
    i18n: (typeof chrome !== 'undefined' && chrome.i18n) ? chrome.i18n.getMessage('probeName') : null,
    storageValueFromSw: (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? ((await chrome.storage.local.get('probe')).probe ?? null) : 'missing'
  };
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    try { const r = await fetch(chrome.runtime.getURL('war.txt')); data.warFetch = { status: r.status, body: (await r.text()).slice(0, 40) }; }
    catch (e) { data.warFetch = { error: String(e && e.message || e).slice(0, 200) }; }
  }
  try {
    const resp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'probe-cs' }, (r) => { if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(r); });
    });
    data.sendMessageResponse = resp;
  } catch (e) { data.sendMessageResponse = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    await chrome.storage.local.set({ big: 'x'.repeat(6 * 1024 * 1024) });
    data.quotaTest = '6MB-ok';
    await chrome.storage.local.remove('big');
  } catch (e) { data.quotaTest = String(e && e.message || e).slice(0, 200); }
  await report('popup', data);
})();
