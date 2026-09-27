const port = __PORT__;
function report(from, data) {
  fetch(`http://127.0.0.1:${port}/report`, { method: 'POST', body: JSON.stringify({ from, data }) }).catch(() => {});
}
const before = {
  chromeTabs: typeof chrome.tabs,
  chromeWebNavigation: typeof chrome.webNavigation,
  chromePermissions: typeof chrome.permissions,
  chromePermissionsOnAdded: typeof chrome.permissions?.onAdded,
  browser: typeof globalThis.browser,
  browserRuntime: typeof globalThis.browser?.runtime,
  browserTabs: typeof globalThis.browser?.tabs,
  browserWebNavigation: typeof globalThis.browser?.webNavigation,
  browserPermissions: typeof globalThis.browser?.permissions,
  chromeFrozen: Object.isFrozen(chrome),
  browserExtensible: Object.isExtensible(globalThis.browser),
  browserRuntimeDescriptor: Object.getOwnPropertyDescriptor(globalThis.browser, 'runtime')
    ? { configurable: Object.getOwnPropertyDescriptor(globalThis.browser, 'runtime').configurable, writable: Object.getOwnPropertyDescriptor(globalThis.browser, 'runtime').writable }
    : null
};
importScripts('browser-polyfill.min.js');
const after = {
  browserTabs: typeof browser.tabs,
  browserTabsUpdate: typeof browser.tabs?.update,
  browserWebNavigation: typeof browser.webNavigation,
  browserOnCommitted: typeof browser.webNavigation?.onCommitted,
  browserPermissions: typeof browser.permissions,
  browserPermissionsOnAdded: typeof browser.permissions?.onAdded
};
report('polyfill-wrapper', { before, after });
