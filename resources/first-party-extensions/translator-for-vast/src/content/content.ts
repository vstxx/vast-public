// The page translator, injected into a tab's top frame on demand. Injection is idempotent: a second
// injection into the same document finds the flag and does nothing.

import { parsePageCommand, type PageCommand } from '../shared/protocol.ts'
import { PageTranslator } from './page.ts'
import { SelectionPopup } from './selection.ts'

const scope = globalThis as { __tfvContent?: boolean }

if (!scope.__tfvContent) {
  scope.__tfvContent = true
  const page = new PageTranslator()
  const popup = new SelectionPopup()

  const handle = async (command: PageCommand): Promise<unknown> => {
    switch (command.type) {
      case 'page:translate':
        popup.close()
        // Answer once translation has started; progress goes out as state reports.
        void page.translate(command.source, command.target, command.displayMode)
        return { ...page.state }
      case 'page:restore':
        return page.restore()
      case 'page:state':
        return { ...page.state }
      case 'page:selection':
        void popup.show(command.text, command.target, command.targets)
        return { shown: true }
      case 'page:offer':
        void popup.offerPage(command.source, command.target, command.targets, () => page.translate(command.source, command.target, command.displayMode))
        return { shown: true }
    }
  }

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // Commands come from this extension's service worker only, never from another content script.
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background.js')) return false
    const command = parsePageCommand(message)
    if (!command) return false
    handle(command).then(sendResponse, () => sendResponse(null))
    return true
  })
}
