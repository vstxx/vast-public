// Probe content script (MAIN world) — only meaningful if the runtime honors manifest "world": "MAIN"
const PORT = __PORT__;

(async () => {
  document.documentElement.setAttribute('data-probe-main', '1');
  const data = {
    chromeType: typeof window.chrome,
    hasRuntime: Boolean(window.chrome && window.chrome.runtime && window.chrome.runtime.id),
    hasRuntimeSendMessage: Boolean(window.chrome && window.chrome.runtime && typeof window.chrome.runtime.sendMessage === 'function')
  };
  try {
    await fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST', body: JSON.stringify({ from: 'cs-main', data }) });
  } catch (e) {}
})();
