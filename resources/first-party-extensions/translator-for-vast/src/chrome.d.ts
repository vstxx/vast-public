// The subset of the extension API this extension uses, typed narrowly. Vast does not depend on
// @types/chrome; declaring only what is called keeps the typecheck honest about the surface.

declare namespace chrome {
  namespace runtime {
    const id: string
    type ContextType = 'OFFSCREEN_DOCUMENT' | 'SERVICE_WORKER' | 'POPUP' | 'TAB'
    interface MessageSender {
      id?: string
      url?: string
      tab?: tabs.Tab
      frameId?: number
      documentId?: string
    }
    interface ExtensionContext { contextType: ContextType; documentUrl?: string }
    interface MessageEvent {
      addListener(callback: (message: unknown, sender: MessageSender, sendResponse: (response?: any) => void) => boolean | void): void
    }
    const onMessage: MessageEvent
    const onInstalled: { addListener(callback: () => void): void }
    const onStartup: { addListener(callback: () => void): void }
    function getURL(path: string): string
    function sendMessage(message: unknown): Promise<any>
    function getContexts(filter: { contextTypes?: ContextType[]; documentUrls?: string[] }): Promise<ExtensionContext[]>
    function openOptionsPage(): Promise<void>
  }
  namespace offscreen {
    type Reason = 'WORKERS'
    function createDocument(parameters: { url: string; reasons: Reason[]; justification: string }): Promise<void>
    function closeDocument(): Promise<void>
  }
  namespace tabs {
    interface Tab { id?: number; url?: string; active?: boolean }
    function query(query: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>
    function get(tabId: number): Promise<Tab>
    function sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<any>
  }
  namespace scripting {
    interface InjectionTarget { tabId: number; frameIds?: number[] }
    interface InjectionResult<T> { frameId: number; result?: T }
    function executeScript<Args extends unknown[], R>(injection: { target: InjectionTarget; func: (...args: Args) => R; args?: Args }): Promise<Array<InjectionResult<Awaited<R>>>>
    function executeScript(injection: { target: InjectionTarget; files: string[] }): Promise<Array<InjectionResult<unknown>>>
    function insertCSS(injection: { target: InjectionTarget; files: string[] }): Promise<void>
    interface RegisteredContentScript {
      id: string
      js?: string[]
      matches?: string[]
      excludeMatches?: string[]
      runAt?: 'document_start' | 'document_end' | 'document_idle'
      allFrames?: boolean
      persistAcrossSessions?: boolean
    }
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>
    function unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>
    function getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<RegisteredContentScript[]>
  }
  namespace contextMenus {
    type ContextType = 'all' | 'page' | 'selection' | 'link'
    interface OnClickData { menuItemId: string | number; selectionText?: string; pageUrl?: string; frameId?: number }
    function create(properties: { id: string; title: string; contexts: ContextType[] }): void
    function removeAll(): Promise<void>
    const onClicked: { addListener(callback: (info: OnClickData, tab?: tabs.Tab) => void): void }
  }
  namespace storage {
    interface StorageArea {
      get(keys: string | string[]): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
    }
    const local: StorageArea
  }
  namespace i18n {
    function getUILanguage(): string
    function detectLanguage(text: string): Promise<{ isReliable: boolean; languages: Array<{ language: string; percentage: number }> }>
  }
}
