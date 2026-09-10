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
  search_agent_count?: number
  history_count?: number
  bookmark_count?: number
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
  latest_history?: {
    title: string
    url: string
    last_visited_at: string
  } | null
  latest_bookmark?: {
    title: string
    url: string
    updated_at: string
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

type BrowserHistoryRecord = {
  id: number
  url: string
  title: string
  visit_count: number
  first_visited_at: string
  last_visited_at: string
}

type BookmarkRecord = {
  id: number
  url: string
  title: string
  created_at: string
  updated_at: string
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

type DomElementInfo = {
  id: string
  selector: string
  tagName: string
  text: string
  role: string | null
  href: string | null
  inputType: string | null
  placeholder: string | null
  ariaLabel: string | null
  rect: {
    x: number
    y: number
    width: number
    height: number
  }
}

type DomSnapshot = {
  tabId: string
  url: string
  title: string
  text: string
  elements: DomElementInfo[]
}

type MarkdownExportPayload = {
  defaultFilename: string
  content: string
}

type BrowserAction =
  | { action: 'navigate'; params: { url: string } }
  | { action: 'search'; params: { query: string; engine?: 'google' | 'bing' | 'baidu' | 'duckduckgo' } }
  | { action: 'back'; params?: Record<string, never> }
  | { action: 'forward'; params?: Record<string, never> }
  | { action: 'reload'; params?: Record<string, never> }
  | { action: 'stop'; params?: Record<string, never> }
  | { action: 'query'; params?: { selector?: string; limit?: number } }
  | { action: 'extract'; params: { schema: Record<string, string> } }
  | { action: 'click'; params: { selector: string } }
  | { action: 'type'; params: { selector: string; text: string; replace?: boolean } }
  | { action: 'scroll'; params?: { direction?: 'up' | 'down'; amount?: number } }

interface Window {
  velox: {
    getBackendConfig: () => Promise<{ baseUrl: string }>
    layout: {
      setSidebarCollapsed: (collapsed: boolean) => Promise<{ sidebarWidth: number }>
    }
    reports: {
      exportMarkdown: (payload: MarkdownExportPayload) => Promise<{ canceled: boolean; filePath: string | null }>
    }
    search: {
      getEngine: () => Promise<'google' | 'bing' | 'baidu' | 'duckduckgo'>
      setEngine: (engine: 'google' | 'bing' | 'baidu' | 'duckduckgo') => Promise<'google' | 'bing' | 'baidu' | 'duckduckgo'>
    }
    startup: {
      getConfig: () => Promise<{ page: 'velox' | 'custom'; url: string }>
      setConfig: (payload: { page: 'velox' | 'custom'; url: string }) => Promise<{ page: 'velox' | 'custom'; url: string }>
    }
    dom: {
      getSnapshot: () => Promise<DomSnapshot>
      query: (payload?: { selector?: string; limit?: number }) => Promise<DomElementInfo[]>
      extract: (schema: Record<string, string>) => Promise<Record<string, string | null>>
    }
    agent: {
      executeAction: (action: BrowserAction) => Promise<Record<string, unknown>>
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
      listHistory: (limit?: number) => Promise<BrowserHistoryRecord[]>
      deleteHistory: (recordId: number) => Promise<Record<string, unknown>>
      listBookmarks: (limit?: number) => Promise<BookmarkRecord[]>
      getBookmarkByUrl: (url: string) => Promise<BookmarkRecord | null>
      saveBookmark: (payload: { url: string; title: string }) => Promise<BookmarkRecord>
      deleteBookmark: (recordId: number) => Promise<Record<string, unknown>>
      listWorkspaces: (limit?: number) => Promise<WorkspaceRecord[]>
      getWorkspace: (recordId: number) => Promise<WorkspaceRecord>
      saveWorkspace: (payload: { name: string; snapshot: { groups: Array<{ name: string; description: string; tabs: string[] }>; duplicate_sets: string[][]; suggested_hibernating: string[]; strategy: string }; tabs: Array<{ id: string; url: string; title: string; text: string; is_start_page: boolean; group_name?: string | null }>; activeTabId: string | null }) => Promise<WorkspaceRecord>
      deleteWorkspace: (recordId: number) => Promise<Record<string, unknown>>
      hibernateTab: (payload: { tab: TabSnapshot; reason: string; originBatchId?: string | null }) => Promise<Record<string, unknown>>
    }
  }
}
