import assert from 'node:assert/strict'
import test from 'node:test'

import { findOwnTabBookmark } from '../../src/shared/bookmark-identity.ts'
import type { Bookmark } from '../../src/shared/types.ts'

test('tab bookmark toggle selects only its own manual root record among identical URLs', () => {
  const base = { title: 'Same', url: 'https://same.example/', createdAt: 1, updatedAt: 1 }
  const items: Bookmark[] = [
    { ...base, id: 'imported', workspaceId: 'workspace', importSource: { browser: 'chrome', profileId: 'p', itemId: '1' } },
    { ...base, id: 'folder', workspaceId: 'workspace', folderId: 'folder' },
    { ...base, id: 'other-workspace', workspaceId: 'other' },
    { ...base, id: 'own', workspaceId: 'workspace' }
  ]
  assert.equal(findOwnTabBookmark(items, base.url, 'workspace')?.id, 'own')
  assert.equal(findOwnTabBookmark(items.slice(0, 3), base.url, 'workspace'), undefined)
})
