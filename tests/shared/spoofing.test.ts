import { strict as assert } from 'node:assert'
import test from 'node:test'

import { DEFAULT_SETTINGS } from '../../src/shared/constants.ts'
import {
  buildSpoofingHeaders,
  buildSpoofingInjectionScript,
  resolveSpoofingProfile,
  normalizeSpoofingSettings
} from '../../src/shared/spoofing.ts'

test('spoofing defaults are disabled but complete', () => {
  assert.equal(DEFAULT_SETTINGS.spoofing.enabled, false)
  assert.equal(DEFAULT_SETTINGS.spoofing.browserProfile, 'chrome-windows')
  assert.equal(DEFAULT_SETTINGS.spoofing.location.mode, 'off')
})

test('Chrome Windows spoofing profile provides coherent browser identity', () => {
  const settings = normalizeSpoofingSettings({
    enabled: true,
    browserProfile: 'chrome-windows'
  })
  const profile = resolveSpoofingProfile(settings, '148.0.7778.180')
  assert.match(profile.userAgent, /Windows NT 10\.0/)
  assert.match(profile.userAgent, /Chrome\/148\.0\.7778\.180/)
  assert.equal(profile.platform, 'Win32')
  assert.equal(profile.vendor, 'Google Inc.')
})

test('spoofing headers override UA, client hints, language, and DNT when enabled', () => {
  const settings = normalizeSpoofingSettings({
    enabled: true,
    browserProfile: 'chrome-windows',
    languages: ['pl-PL', 'pl', 'en-US'],
    doNotTrack: true
  })
  const headers = buildSpoofingHeaders(settings, {
    'User-Agent': 'Electron/42',
    'Accept-Language': 'en-US',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-CH-UA-Full-Version-List': '"Electron";v="42.0.0.0"'
  }, '148.0.7778.180')
  assert.match(headers['User-Agent'], /Chrome\/148\.0\.7778\.180/)
  assert.equal(headers['Accept-Language'], 'pl-PL,pl;q=0.9,en-US;q=0.8')
  assert.equal(headers.DNT, '1')
  assert.equal(headers['Sec-CH-UA-Platform'], '"Windows"')
  assert.match(headers['Sec-CH-UA'], /Google Chrome/)
  assert.match(headers['Sec-CH-UA-Full-Version-List'], /Google Chrome";v="148\.0\.7778\.180/)
  assert.doesNotMatch(headers['Sec-CH-UA-Full-Version-List'], /Electron/)
})

test('spoofing injection script exposes navigator, timezone, WebGL, and geolocation overrides', () => {
  const settings = normalizeSpoofingSettings({
    enabled: true,
    browserProfile: 'chrome-windows',
    timezone: 'Europe/Warsaw',
    webglVendor: 'Intel Inc.',
    webglRenderer: 'Intel Iris OpenGL Engine',
    location: {
      mode: 'fixed',
      latitude: 52.2297,
      longitude: 21.0122,
      accuracy: 25
    }
  })
  const script = buildSpoofingInjectionScript(settings)
  assert.match(script, /navigator/)
  assert.match(script, /Europe\/Warsaw/)
  assert.match(script, /Intel Iris OpenGL Engine/)
  assert.match(script, /getCurrentPosition/)
  assert.match(script, /52\.2297/)
})

test('spoofing normalizes unsafe header values and invalid timezones', () => {
  const settings = normalizeSpoofingSettings({
    enabled: true,
    browserProfile: 'custom',
    customUserAgent: 'Safe UA\r\nX-Injected: yes',
    languages: ['pl-PL', 'bad\r\nheader'],
    timezone: 'Not/A_Timezone'
  })
  assert.equal(settings.customUserAgent, 'Safe UAX-Injected: yes')
  assert.deepEqual(settings.languages, ['pl-PL'])
  assert.equal(settings.timezone, 'UTC')
  const headers = buildSpoofingHeaders(settings, {})
  assert.doesNotMatch(String(headers['User-Agent']), /[\r\n]/)
  assert.equal(headers['Accept-Language'], 'pl-PL')
})
