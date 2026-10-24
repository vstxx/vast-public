import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `${selector} rule exists`)
  return css.slice(start, css.indexOf('}', start))
}

test('the New Tab logo breathes a bounded number of times and then rests', () => {
  const animation = ruleBody('.vast-logo-image').match(/animation:\s*([^;]+);/)?.[1] ?? ''
  assert.match(animation, /\bvast-logo-breathe\b/)
  assert.doesNotMatch(animation, /\binfinite\b/, 'an infinite loop keeps the compositor producing frames while the New Tab page is idle')
  assert.match(animation, /\s[12]\s/, 'one or two iterations')
  assert.match(animation, /\bforwards\b/, 'the final keyframe is held so the logo does not jump when the animation ends')
})

test('the resting keyframe matches the held frame', () => {
  const keyframes = css.slice(css.indexOf('@keyframes vast-logo-breathe'), css.indexOf('@keyframes internal-page-rise'))
  assert.match(keyframes, /0%,\s*100%\s*\{[^}]*opacity:\s*0\.96;[^}]*scale\(1\)/)
})
