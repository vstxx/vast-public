import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { radiusViolations } = require('../../scripts/check-radius.cjs')

test('radius guard rejects raw CSS, inline styles, Tailwind presets and disconnected radius aliases', () => {
  for (const source of [
    '.card { border-radius: 12px; }',
    '.card { border-top-left-radius: 9px; }',
    '<div style={{ borderRadius: 16 }} />',
    '<div className="rounded-lg" />',
    '<div className="rounded-full" />',
    '<div className="rounded-t-lg" />',
    '<div className="hover:rounded-t-[13px]" />',
    '.card { border-start-start-radius: 9px; }',
    '<div className="rounded-[13px]" />',
    '<div className="rounded bg-white" />',
    "<div className={'rounded'} />",
    ':root { --vast-radius-control: 13px; }'
  ]) assert.ok(radiusViolations(source).length, source)
})

test('radius guard permits semantic tokens and only explicitly named structural exceptions', () => {
  for (const source of [
    '.card { border-radius: var(--vast-radius-card); }',
    '<div className="rounded-card hover:rounded-control" />',
    '.vast-geometry-circle { border-radius: 50%; }',
    '.side-panel-slot.is-docked .side-panel { border-radius: 0; }'
  ]) assert.equal(radiusViolations(source).length, 0, source)
  assert.ok(radiusViolations('.new-chip { border-radius: 50%; }').length)
  assert.ok(radiusViolations('.new-card { border-radius: 0; }').length)
})

test('all Vast renderer and preload source passes the radius CI guard', () => {
  execFileSync(process.execPath, ['scripts/check-radius.cjs'], { cwd: new URL('../../', import.meta.url), stdio: 'pipe' })
})
