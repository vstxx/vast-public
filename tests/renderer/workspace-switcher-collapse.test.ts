import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/renderer/components/${path}`, import.meta.url), 'utf8')
const switcher = read('workspaces/WorkspaceSwitcher.tsx')

test('clicking the active workspace toggles the list; other workspaces still switch', () => {
  assert.match(switcher, /onClick=\{\(\) => \(active \? toggleCollapsed\(\) : setActiveWorkspace\(workspace\.id\)\)\}/)
  assert.match(switcher, /aria-expanded=\{active \? !collapsed : undefined\}/)
})

test('collapsed shows only the active workspace, first, and hides New workspace', () => {
  assert.match(switcher, /const visible = collapsed && activeWorkspace \? \[activeWorkspace\] : ordered/)
  assert.match(switcher, /\{!collapsed && renderNewWorkspace\(\)\}/)
})

test('the collapsed state is remembered, tolerating unavailable storage', () => {
  assert.match(switcher, /const COLLAPSED_KEY = 'vast:workspace-switcher-collapsed'/)
  assert.match(switcher, /try \{\s+return window\.localStorage\.getItem\(COLLAPSED_KEY\) === '1'\s+\} catch \{\s+return false/)
})

// FLIP: the layout changes once; every frame after that is transform/opacity.
test('the animation only touches transform and opacity, and respects reduced motion', () => {
  const keyframes = [...switcher.matchAll(/\{ (?:opacity|transform): [^}]+\}/g)].map((match) => match[0])
  assert.ok(keyframes.length >= 6)
  for (const frame of keyframes) assert.doesNotMatch(frame, /height|top|margin|width/, frame)
  // Off and the system's reduced motion both resolve to the 'off' level (resolveMotionLevel).
  assert.match(switcher, /if \(!root \|\| currentMotionLevel\(\) === 'off'\) return null/)
  // A toggle during a running transition retargets instead of being ignored.
  assert.doesNotMatch(switcher, /if \(runningRef\.current\.length > 0\) return/)
  assert.match(switcher, /for \(const animation of runningRef\.current\) animation\.cancel\(\)/)
})

test('the tab list below glides with the switcher', () => {
  const sidebar = read('tabs/Sidebar.tsx')
  assert.match(sidebar, /<WorkspaceSwitcher compact=\{showCompactContents\} followRef=\{tabsListRef\} \/>/)
  assert.match(sidebar, /<div ref=\{tabsListRef\} className="space-y-1" data-testid="vertical-tabs-list">/)
})
