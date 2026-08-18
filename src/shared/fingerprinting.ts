import type { FingerprintingProtectionMode } from './types'

/**
 * Builds one coherent, stable protection profile. Noise is derived from the
 * identity and origin, so repeated reads agree instead of making the browser
 * more unique through per-call random values.
 */
export function buildFingerprintingProtectionScript(
  mode: FingerprintingProtectionMode,
  identitySeed: string,
  disableWebRtc = false
): string {
  return `
(() => {
  if (globalThis.__vastFingerprintProfile === ${JSON.stringify(`${mode}:${identitySeed}:${disableWebRtc}`)}) return true;
  const profile = ${JSON.stringify(mode)};
  const seedText = ${JSON.stringify(identitySeed)} + '|' + location.origin;
  let seed = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    seed ^= seedText.charCodeAt(index);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const stableNoise = (index) => (((seed + Math.imul(index + 1, 2654435761)) >>> 0) % 3) - 1;
  const define = (target, key, getter) => {
    try { Object.defineProperty(target, key, { configurable: true, get: getter }); } catch {}
  };
  define(Navigator.prototype, 'hardwareConcurrency', () => profile === 'maximum' ? 4 : 8);
  define(Navigator.prototype, 'deviceMemory', () => 8);
  try { Object.defineProperty(Navigator.prototype, 'getBattery', { configurable: true, value: undefined }); } catch {}

  if (navigator.mediaDevices?.enumerateDevices) {
    const originalEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    try {
      navigator.mediaDevices.enumerateDevices = async () => (await originalEnumerate()).map((device, index) => ({
        deviceId: profile === 'standard' ? device.deviceId : 'vast-device-' + device.kind + '-' + index,
        groupId: profile === 'standard' ? '' : 'vast-group-' + index,
        kind: device.kind,
        label: '',
        toJSON: () => ({ deviceId: '', groupId: '', kind: device.kind, label: '' })
      }));
    } catch {}
  }

  if (profile !== 'standard') {
    const commonFonts = new Set(['arial', 'calibri', 'cambria', 'courier new', 'georgia', 'segoe ui', 'tahoma', 'times new roman', 'trebuchet ms', 'verdana']);
    if (globalThis.FontFaceSet?.prototype?.check) {
      const originalFontCheck = FontFaceSet.prototype.check;
      FontFaceSet.prototype.check = function(font, text) {
        const family = String(font).replace(/^[^ ]+\s+/, '').replace(/["']/g, '').split(',')[0].trim().toLowerCase();
        if (family && !commonFonts.has(family) && !/^(serif|sans-serif|monospace|system-ui)$/.test(family)) return false;
        return originalFontCheck.call(this, font, text);
      };
    }
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      try {
        const context = this.getContext('2d');
        if (context && this.width > 0 && this.height > 0) {
          const pixel = context.getImageData(0, 0, 1, 1);
          pixel.data[0] = Math.max(0, Math.min(255, pixel.data[0] + stableNoise(0)));
          context.putImageData(pixel, 0, 0);
        }
      } catch {}
      return originalToDataURL.apply(this, args);
    };
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
      const data = originalGetImageData.apply(this, args);
      if (data.data.length >= 4) data.data[0] = Math.max(0, Math.min(255, data.data[0] + stableNoise(1)));
      return data;
    };
    const patchWebGl = (prototype) => {
      if (!prototype?.getParameter) return;
      const original = prototype.getParameter;
      prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Google Inc. (Intel)';
        if (parameter === 37446) return 'ANGLE (Intel, Direct3D11)';
        return original.call(this, parameter);
      };
    };
    patchWebGl(globalThis.WebGLRenderingContext?.prototype);
    patchWebGl(globalThis.WebGL2RenderingContext?.prototype);
    if (globalThis.AnalyserNode?.prototype?.getFloatFrequencyData) {
      const originalAudio = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(array) {
        originalAudio.call(this, array);
        if (array.length) array[0] += stableNoise(2) * 0.00001;
      };
    }
    const roundedWidth = Math.max(800, Math.round(screen.width / 100) * 100);
    const roundedHeight = Math.max(600, Math.round(screen.height / 100) * 100);
    define(Screen.prototype, 'width', () => roundedWidth);
    define(Screen.prototype, 'height', () => roundedHeight);
    define(Screen.prototype, 'availWidth', () => roundedWidth);
    define(Screen.prototype, 'availHeight', () => Math.max(560, roundedHeight - 40));
  }

  if (profile === 'maximum') {
    define(Screen.prototype, 'width', () => 1920);
    define(Screen.prototype, 'height', () => 1080);
    define(Screen.prototype, 'availWidth', () => 1920);
    define(Screen.prototype, 'availHeight', () => 1040);
    define(Screen.prototype, 'colorDepth', () => 24);
    define(Screen.prototype, 'pixelDepth', () => 24);
    define(globalThis, 'devicePixelRatio', () => 1);
    define(Navigator.prototype, 'language', () => 'en-US');
    define(Navigator.prototype, 'languages', () => ['en-US', 'en']);
    const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function() {
      return { ...originalResolvedOptions.call(this), locale: 'en-US', timeZone: 'UTC' };
    };
    try { Date.prototype.getTimezoneOffset = () => 0; } catch {}
  }

  if (${JSON.stringify(disableWebRtc)}) {
    try { Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: undefined }); } catch {}
    try { Object.defineProperty(globalThis, 'webkitRTCPeerConnection', { configurable: true, value: undefined }); } catch {}
  }
  globalThis.__vastFingerprintProfile = ${JSON.stringify(`${mode}:${identitySeed}:${disableWebRtc}`)};
  return true;
})()
`
}
