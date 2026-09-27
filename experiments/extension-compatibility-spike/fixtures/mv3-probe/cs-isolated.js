// Probe content script (ISOLATED world)
const PORT = __PORT__;

async function report(from, data) {
  try { await fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from, data }) }); } catch (e) {}
}

(async () => {
  document.documentElement.setAttribute('data-probe-cs', '1');
  const env = {
    hasChrome: typeof chrome !== 'undefined',
    runtimeId: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || null,
    getURL: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('war.txt') : null,
    storage: (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? 'present' : 'missing',
    i18n: (typeof chrome !== 'undefined' && chrome.i18n) ? (chrome.i18n.getMessage('probeName') || null) : 'missing'
  };
  await report('cs-isolated', env);
  try {
    const resp = await new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'probe-cs' }, (r) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(r);
        });
      } catch (e) { reject(e); }
    });
    await report('cs-sendmessage-result', { response: resp });
  } catch (e) {
    await report('cs-sendmessage-result', { error: String(e && e.message || e).slice(0, 300) });
  }
  try {
    const r = await fetch((typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('war.txt') : 'about:blank');
    await report('cs-war-fetch', { status: r.status, text: (await r.text()).slice(0, 60) });
  } catch (e) {
    await report('cs-war-fetch', { error: String(e && e.message || e).slice(0, 300) });
  }
  try {
    const portResult = await new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'probe-port' });
      port.onMessage.addListener((value) => { resolve(value); port.disconnect(); });
      port.onDisconnect.addListener(() => reject(new Error(chrome.runtime.lastError?.message || 'port disconnected')));
      port.postMessage({ ping: true });
      setTimeout(() => reject(new Error('port timeout')), 2000);
    });
    await report('cs-port-result', portResult);
  } catch (error) { await report('cs-port-result', { error: String(error && error.message || error) }); }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'probe-script' });
    await report('cs-dynamic-main', response);
  } catch (error) { await report('cs-dynamic-main', { error: String(error && error.message || error) }); }
})();
