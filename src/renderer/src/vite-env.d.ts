/// <reference types="vite/client" />

type BrowserTabState = {
  id: string
  title: string
  url: string
  isStartPage: boolean
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

interface Window {
  velox: {
    getBackendConfig: () => Promise<{ baseUrl: string }>
    tabs: {
      getState: () => Promise<{ tabs: BrowserTabState[]; activeTabId: string | null }>
      create: (url?: string) => Promise<BrowserTabState>
      activate: (tabId: string) => Promise<void>
      close: (tabId: string) => Promise<void>
      navigate: (input: string) => Promise<void>
      back: () => Promise<void>
      forward: () => Promise<void>
      reload: () => Promise<void>
      stop: () => Promise<void>
      onStateChange: (callback: (state: { tabs: BrowserTabState[]; activeTabId: string | null }) => void) => () => void
    }
  }
}
