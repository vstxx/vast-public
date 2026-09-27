// Experimental ECE 4.9.0 patch. It changes only this harness's ignored
// node_modules copy; production Vast never loads it.
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const path = join(__dirname, 'node_modules', 'electron-chrome-extensions', 'dist', 'chrome-extension-api.preload.js');
const original = readFileSync(path, 'utf8');
const anchor = '      delete globalThis.electron;\n      Object.freeze(chrome);';
const replacement = `      // Keep Electron's partial browser alias in sync with the augmented chrome
      // namespace. webextension-polyfill selects browser when runtime.id exists.
      const browser = globalThis.browser;
      if (browser && browser.runtime?.id === extensionId) {
        for (const apiName of Reflect.ownKeys(chrome)) {
          if (typeof apiName !== "string") continue;
          const chromeApi = chrome[apiName];
          if (chromeApi === void 0) continue;
          if (browser[apiName] === void 0) {
            Object.defineProperty(browser, apiName, { value: chromeApi, enumerable: true, configurable: true });
          } else if (chromeApi && typeof chromeApi === "object" && browser[apiName] && typeof browser[apiName] === "object") {
            for (const member of Reflect.ownKeys(chromeApi)) {
              if (typeof member !== "string" || browser[apiName][member] !== void 0) continue;
              Object.defineProperty(browser[apiName], member, { value: chromeApi[member], enumerable: true, configurable: true });
            }
          }
        }
      }
      delete globalThis.electron;
      // Chrome's API object is mutable; freezing it makes ordinary extension
      // proxies violate JavaScript's non-configurable property invariant.`;
if (original.includes(replacement)) {
  console.log('ECE experimental preload patch already applied');
} else {
  if (!original.includes(anchor)) throw new Error('ECE 4.9.0 preload anchor changed; inspect before patching');
  writeFileSync(path, original.replace(anchor, replacement));
  console.log('Patched ignored ECE 4.9.0 preload for experiment');
}

// The upstream permissions request mutates its map but never dispatches the
// matching event. Keep the experiment scoped to a single extension's listeners.
const browserPath = join(__dirname, 'node_modules', 'electron-chrome-extensions', 'dist', 'cjs', 'index.js');
let browserSource = readFileSync(browserPath, 'utf8');
const permissionAnchor = `      const permissions = this.permissionMap.get(extension.id);
      if (request.origins) {
        for (const origin of request.origins) {
          if (!permissions.origins.includes(origin)) {
            permissions.origins.push(origin);
          }
        }
      }
      if (request.permissions) {
        for (const permission of request.permissions) {
          if (!permissions.permissions.includes(permission)) {
            permissions.permissions.push(permission);
          }
        }
      }
      return true;`;
const permissionReplacement = `      const permissions = this.permissionMap.get(extension.id);
      const added = { permissions: [], origins: [] };
      if (request.origins) {
        for (const origin of request.origins) {
          if (!permissions.origins.includes(origin)) {
            permissions.origins.push(origin);
            added.origins.push(origin);
          }
        }
      }
      if (request.permissions) {
        for (const permission of request.permissions) {
          if (!permissions.permissions.includes(permission)) {
            permissions.permissions.push(permission);
            added.permissions.push(permission);
          }
        }
      }
      if (added.permissions.length || added.origins.length) {
        this.ctx.router.sendEvent(extension.id, "permissions.onAdded", added);
      }
      return true;`;
if (!browserSource.includes(permissionReplacement)) {
  if (!browserSource.includes(permissionAnchor)) throw new Error('ECE 4.9.0 permissions anchor changed');
  browserSource = browserSource.replace(permissionAnchor, permissionReplacement);
  writeFileSync(browserPath, browserSource);
  console.log('Patched ignored ECE 4.9.0 permissions event for experiment');
}
browserSource = readFileSync(browserPath, 'utf8');
const removeAnchor = `    this.remove = ({ extension }, permissions) => {
      return true;
    };`;
const removeReplacement = `    this.remove = ({ extension }, request) => {
      const granted = this.permissionMap.get(extension.id);
      if (!granted) return false;
      const optionalPermissions = new Set(extension.manifest.optional_permissions || []);
      const optionalOrigins = new Set(extension.manifest.optional_host_permissions || []);
      const removed = { permissions: [], origins: [] };
      for (const permission of request.permissions || []) {
        if (!optionalPermissions.has(permission)) continue;
        const index = granted.permissions.indexOf(permission);
        if (index >= 0) {
          granted.permissions.splice(index, 1);
          removed.permissions.push(permission);
        }
      }
      for (const origin of request.origins || []) {
        if (!optionalOrigins.has(origin)) continue;
        const index = granted.origins.indexOf(origin);
        if (index >= 0) {
          granted.origins.splice(index, 1);
          removed.origins.push(origin);
        }
      }
      if (removed.permissions.length || removed.origins.length) {
        this.ctx.router.sendEvent(extension.id, "permissions.onRemoved", removed);
        return true;
      }
      return false;
    };`;
if (!browserSource.includes(removeReplacement)) {
  if (!browserSource.includes(removeAnchor)) throw new Error('ECE 4.9.0 permissions.remove anchor changed');
  writeFileSync(browserPath, browserSource.replace(removeAnchor, removeReplacement));
  console.log('Patched ignored ECE 4.9.0 permission removal for experiment');
}
