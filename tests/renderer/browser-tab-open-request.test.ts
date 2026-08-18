import assert from 'node:assert/strict'
import test from 'node:test'
import { handleBrowserTabOpenRequest } from '../../src/renderer/lib/browser-tab-open.ts'
import type { ID, Tab } from '../../src/shared/types.ts'

const sourceWorkspace = { id: 'workspace-private', isPrivate: true }
const sourceGroupId = 'group-private'
const sourceWebContentsId = 777

function tab(id: ID, workspaceId = sourceWorkspace.id, groupId = sourceGroupId): Tab {
  return {
    id,
    workspaceId,
    groupId,
    title: 'Source',
    url: 'https://source.example',
    displayUrl: 'source.example',
    pinned: false,
    status: 'idle',
    lifecycle: 'active',
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    createdAt: 1,
    lastAccessedAt: 1
  }
}

function modelFixture() {
  const source = tab('tab-source')
  const tabs = [source]
  let activeTabId = source.id
  return {
    source,
    tabs,
    activeTabId: () => activeTabId,
    context: {
      getTabIdForWebContents: (id: number) => id === sourceWebContentsId ? source.id : undefined,
      getTabModel: () => ({
        tabs,
        createTab: (options: { url: string; title: string; workspaceId?: ID; groupId?: ID; activate: boolean }) => {
          const created = {
            ...tab(`tab-created-${tabs.length}`, options.workspaceId, options.groupId),
            url: options.url,
            title: options.title,
            lifecycle: options.activate ? 'active' as const : 'sleeping' as const
          }
          tabs.push(created)
          if (options.activate) activeTabId = created.id
          return created
        }
      }),
      isSafeUrl: (url: string) => url.startsWith('https://'),
      routeUrl: (url: string) => url,
      titleForUrl: (url: string) => url
    }
  }
}

test('target blank and window.open requests create a Vast tab in the source private workspace and group', () => {
  for (const disposition of ['foreground-tab', 'default']) {
    const fixture = modelFixture()
    const created = handleBrowserTabOpenRequest(
      { url: 'https://example.com/new', sourceWebContentsId, disposition, activate: true },
      fixture.context
    )

    assert.ok(created)
    assert.equal(fixture.tabs.length, 2)
    assert.equal(created.workspaceId, sourceWorkspace.id)
    assert.equal(created.groupId, sourceGroupId)
    assert.equal(sourceWorkspace.isPrivate, true)
    assert.equal(fixture.activeTabId(), created.id)
  }
})

test('background-tab creates a sleeping source-owned tab without activating it', () => {
  const fixture = modelFixture()
  const activeBefore = fixture.activeTabId()
  const created = handleBrowserTabOpenRequest(
    { url: 'https://example.com/background', sourceWebContentsId, disposition: 'background-tab', activate: false },
    fixture.context
  )

  assert.ok(created)
  assert.equal(created.lifecycle, 'sleeping')
  assert.equal(created.workspaceId, sourceWorkspace.id)
  assert.equal(created.groupId, sourceGroupId)
  assert.equal(fixture.activeTabId(), activeBefore)
})

test('unsafe tab-open requests never reach the tab model', () => {
  const fixture = modelFixture()
  const created = handleBrowserTabOpenRequest(
    { url: 'javascript:alert(1)', disposition: 'foreground-tab', activate: true },
    fixture.context
  )
  assert.equal(created, undefined)
  assert.equal(fixture.tabs.length, 1)
})
