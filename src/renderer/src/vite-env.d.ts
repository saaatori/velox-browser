/// <reference types="vite/client" />

type BrowserTabState = {
  id: string
  title: string
  url: string
  isStartPage: boolean
  groupName: string | null
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
  closed_count: number
  workspace_count: number
  latest_snapshot_at: string | null
  latest_closed_at: string | null
  latest_workspace: {
    name: string
    created_at: string
  } | null
  latest_organize: {
    strategy: string
    created_at: string
    group_count: number
    duplicate_set_count: number
  } | null
}

type HibernatedTabRecord = {
  id: number
  browser_tab_id: string
  url: string
  title: string
  text: string
  reason: string
  origin_batch_id: string | null
  restored_at: string | null
  created_at: string
}

type WorkspaceRecord = {
  id: number
  name: string
  strategy: string
  created_at: string
  updated_at: string
  group_count: number
  duplicate_set_count: number
  groups?: Array<{
    name: string
    description: string
    tabs: string[]
  }>
  duplicate_sets?: string[][]
  suggested_hibernating?: string[]
  tabs?: Array<{
    id: string
    url: string
    title: string
    text: string
    is_start_page: boolean
    group_name?: string | null
  }>
  active_tab_id?: string | null
}

interface Window {
  velox: {
    getBackendConfig: () => Promise<{ baseUrl: string }>
    search: {
      getEngine: () => Promise<'google' | 'bing' | 'baidu' | 'duckduckgo'>
      setEngine: (engine: 'google' | 'bing' | 'baidu' | 'duckduckgo') => Promise<'google' | 'bing' | 'baidu' | 'duckduckgo'>
    }
    tabs: {
      getState: () => Promise<{ tabs: BrowserTabState[]; activeTabId: string | null }>
      getSnapshots: () => Promise<TabSnapshot[]>
      create: (url?: string) => Promise<BrowserTabState>
      activate: (tabId: string) => Promise<void>
      close: (tabId: string, reason?: string) => Promise<void>
      navigate: (input: string) => Promise<void>
      back: () => Promise<void>
      forward: () => Promise<void>
      reload: () => Promise<void>
      stop: () => Promise<void>
      hibernate: (tabId: string, reason?: string) => Promise<Record<string, unknown>>
      restoreWorkspace: (payload: { tabs: Array<{ id: string; url: string; title: string; text: string; is_start_page: boolean; group_name?: string | null }>; activeTabId: string | null }) => Promise<void>
      onStateChange: (callback: (state: { tabs: BrowserTabState[]; activeTabId: string | null }) => void) => () => void
    }
    storage: {
      syncTabs: (payload: { tabs: TabSnapshot[]; activeTabId: string | null }) => Promise<{ batch_id: string; captured_at: string; tab_count: number }>
      getSummary: () => Promise<StorageSummary>
      listHibernated: (limit?: number) => Promise<HibernatedTabRecord[]>
      restoreHibernated: (recordId: number) => Promise<HibernatedTabRecord>
      listClosed: (limit?: number) => Promise<HibernatedTabRecord[]>
      restoreClosed: (recordId: number) => Promise<HibernatedTabRecord>
      listWorkspaces: (limit?: number) => Promise<WorkspaceRecord[]>
      getWorkspace: (recordId: number) => Promise<WorkspaceRecord>
      saveWorkspace: (payload: { name: string; snapshot: { groups: Array<{ name: string; description: string; tabs: string[] }>; duplicate_sets: string[][]; suggested_hibernating: string[]; strategy: string }; tabs: Array<{ id: string; url: string; title: string; text: string; is_start_page: boolean; group_name?: string | null }>; activeTabId: string | null }) => Promise<WorkspaceRecord>
      hibernateTab: (payload: { tab: TabSnapshot; reason: string; originBatchId?: string | null }) => Promise<Record<string, unknown>>
    }
  }
}
