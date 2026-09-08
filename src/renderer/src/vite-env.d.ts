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

type TabSnapshot = BrowserTabState & {
  text: string
}

type StorageSummary = {
  snapshot_count: number
  organize_count: number
  hibernated_count: number
  latest_snapshot_at: string | null
  latest_organize: {
    strategy: string
    created_at: string
    group_count: number
    duplicate_set_count: number
  } | null
}

interface Window {
  velox: {
    getBackendConfig: () => Promise<{ baseUrl: string }>
    tabs: {
      getState: () => Promise<{ tabs: BrowserTabState[]; activeTabId: string | null }>
      getSnapshots: () => Promise<TabSnapshot[]>
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
    storage: {
      syncTabs: (payload: { tabs: TabSnapshot[]; activeTabId: string | null }) => Promise<{ batch_id: string; captured_at: string; tab_count: number }>
      getSummary: () => Promise<StorageSummary>
      hibernateTab: (payload: { tab: TabSnapshot; reason: string; originBatchId?: string | null }) => Promise<Record<string, unknown>>
    }
  }
}
