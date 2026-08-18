import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relativePath: string): string => readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8')
const publicPrivacyCopy = [read('README.md'), read('SECURITY.md'), read('docs/FEATURE_STATUS.md'), read('docs/PRIVACY.md')].join('\n')

test('privacy documentation distinguishes browsing telemetry from the bounded Relay check-in', () => {
  assert.doesNotMatch(publicPrivacyCopy, /there is no analytics or telemetry/i)
  assert.match(publicPrivacyCopy, /no browsing telemetry/i)
  assert.match(publicPrivacyCopy, /random(?:ly generated)?,? (?:persistent )?installation (?:UUID|identifier)/i)
  assert.match(publicPrivacyCopy, /running Vast version|current Vast version/i)
  assert.match(publicPrivacyCopy, /cumulative (?:application )?launch count/i)
  assert.match(publicPrivacyCopy, /anonymous aggregate install/i)
  assert.match(publicPrivacyCopy, /does not (?:transmit|persist)[\s\S]*visited URLs/i)
})
