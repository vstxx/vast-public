import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Electron patchset permits declared web-accessible extension frames in app-owned webviews', async () => {
  const patch = await readFile(
    'experiments/electron-44-patches/0005-chromium-lifecycle-auth-support.patch',
    'utf8'
  )

  assert.match(patch, /extensions\/browser\/extension_navigation_throttle\.cc/)
  assert.match(patch, /if \(owner_extension\) \{/)
  assert.match(patch, /AllowCrossRendererResourceLoadHelper/)
  assert.match(patch, /App-owned views fall through to the normal web-accessible-resource/)
  assert.match(patch, /checks below instead of using the extension-owned/)
})

test('Electron patchset provides a valid splitViewId for external message senders', async () => {
  const patch = await readFile(
    'experiments/electron-44-patches/0006-electron-messaging-split-view-compat.patch',
    'utf8'
  )

  assert.match(patch, /electron_messaging_delegate\.cc/)
  assert.match(patch, /tab\.split_view_id = -1/)
  assert.match(patch, /"splitViewId"/)
  assert.match(patch, /-\s+"optional": "true"/)
  assert.match(patch, /\+\s+"optional": true/)
})

test('Electron patchset forwards native action.openPopup calls to the owning session', async () => {
  const patch = await readFile(
    'experiments/electron-44-patches/0007-electron-action-open-popup-event.patch',
    'utf8'
  )

  assert.match(patch, /extension-action-open-popup/)
  assert.match(patch, /GetSenderWebContents/)
  assert.match(patch, /extension\(\)->id\(\)/)
  assert.match(patch, /sender->ID\(\)/)
  assert.match(patch, /NotifyActionOpenPopup/)
})

test('Electron patchset exposes Chromium native extension reload without uninstalling', async () => {
  const patch = await readFile(
    'experiments/electron-44-patches/0008-electron-extensions-reload-api.patch',
    'utf8'
  )

  assert.match(patch, /ReloadExtension/)
  assert.match(patch, /extension_system->ReloadExtension\(extension_id\)/)
  assert.match(patch, /SetMethod\("reloadExtension", &Extensions::ReloadExtension\)/)
  assert.doesNotMatch(patch, /UnloadedExtensionReason::UNINSTALL/)
})
