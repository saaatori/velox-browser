import { contextBridge, ipcRenderer } from 'electron'

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

contextBridge.exposeInMainWorld('velox', {
  getBackendConfig: () => ipcRenderer.invoke('backend:get-config') as Promise<{ baseUrl: string }>,
  layout: {
    setSidebarCollapsed: (collapsed: boolean) => ipcRenderer.invoke('layout:set-sidebar-collapsed', collapsed) as Promise<{ sidebarWidth: number }>
  },
  reports: {
    exportMarkdown: (payload: MarkdownExportPayload) => ipcRenderer.invoke('reports:export-markdown', payload) as Promise<{ canceled: boolean; filePath: string | null }>
  },
  search: {
    getEngine: () => ipcRenderer.invoke('search:get-engine') as Promise<'google' | 'bing' | 'baidu' | 'duckduckgo'>,
    setEngine: (engine: 'google' | 'bing' | 'baidu' | 'duckduckgo') => ipcRenderer.invoke('search:set-engine', engine) as Promise<'google' | 'bing' | 'baidu' | 'duckduckgo'>
  },
  startup: {
    getConfig: () => ipcRenderer.invoke('startup:get-config') as Promise<{ page: 'velox' | 'custom'; url: string }>,
    setConfig: (payload: { page: 'velox' | 'custom'; url: string }) => ipcRenderer.invoke('startup:set-config', payload) as Promise<{ page: 'velox' | 'custom'; url: string }>
  },
  dom: {
    getSnapshot: () => ipcRenderer.invoke('dom:get-snapshot') as Promise<DomSnapshot>,
    query: (payload?: { selector?: string; limit?: number }) => ipcRenderer.invoke('dom:query', payload) as Promise<DomElementInfo[]>,
    extract: (schema: Record<string, string>) => ipcRenderer.invoke('dom:extract', schema) as Promise<Record<string, string | null>>
  },
  agent: {
    executeAction: (action: BrowserAction) => ipcRenderer.invoke('agent:execute-action', action) as Promise<Record<string, unknown>>
  },
  tabs: {
    getState: () => ipcRenderer.invoke('tabs:get-state') as Promise<{ tabs: BrowserTabState[]; activeTabId: string | null }>,
    getSnapshots: () => ipcRenderer.invoke('tabs:get-snapshots') as Promise<TabSnapshot[]>,
    create: (url?: string) => ipcRenderer.invoke('tabs:create', url) as Promise<BrowserTabState>,
    activate: (tabId: string) => ipcRenderer.invoke('tabs:activate', tabId) as Promise<void>,
    close: (tabId: string, reason?: string) => ipcRenderer.invoke('tabs:close', tabId, reason) as Promise<void>,
    navigate: (input: string) => ipcRenderer.invoke('tabs:navigate', input) as Promise<void>,
    back: () => ipcRenderer.invoke('tabs:back') as Promise<void>,
    forward: () => ipcRenderer.invoke('tabs:forward') as Promise<void>,
    reload: () => ipcRenderer.invoke('tabs:reload') as Promise<void>,
    stop: () => ipcRenderer.invoke('tabs:stop') as Promise<void>,
    hibernate: (tabId: string, reason?: string) => ipcRenderer.invoke('tabs:hibernate', { tabId, reason }) as Promise<Record<string, unknown>>,
    restoreWorkspace: (payload: { tabs: Array<{ id: string; url: string; title: string; text: string; is_start_page: boolean; group_name?: string | null }>; activeTabId: string | null }) => ipcRenderer.invoke('tabs:restore-workspace', payload) as Promise<void>,
    onStateChange: (callback: (state: { tabs: BrowserTabState[]; activeTabId: string | null }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: { tabs: BrowserTabState[]; activeTabId: string | null }) => callback(state)
      ipcRenderer.on('tabs:state', listener)
      return () => ipcRenderer.removeListener('tabs:state', listener)
    }
  },
  storage: {
    syncTabs: (payload: { tabs: TabSnapshot[]; activeTabId: string | null }) => ipcRenderer.invoke('storage:sync-tabs', payload) as Promise<{ batch_id: string; captured_at: string; tab_count: number }>,
    getSummary: () => ipcRenderer.invoke('storage:get-summary') as Promise<StorageSummary>,
    listHibernated: (limit?: number) => ipcRenderer.invoke('storage:list-hibernated', limit) as Promise<HibernatedTabRecord[]>,
    restoreHibernated: (recordId: number) => ipcRenderer.invoke('storage:restore-hibernated', recordId) as Promise<HibernatedTabRecord>,
    listClosed: (limit?: number) => ipcRenderer.invoke('storage:list-closed', limit) as Promise<HibernatedTabRecord[]>,
    restoreClosed: (recordId: number) => ipcRenderer.invoke('storage:restore-closed', recordId) as Promise<HibernatedTabRecord>,
    listHistory: (limit?: number) => ipcRenderer.invoke('storage:list-history', limit) as Promise<BrowserHistoryRecord[]>,
    deleteHistory: (recordId: number) => ipcRenderer.invoke('storage:delete-history', recordId) as Promise<Record<string, unknown>>,
    listBookmarks: (limit?: number) => ipcRenderer.invoke('storage:list-bookmarks', limit) as Promise<BookmarkRecord[]>,
    getBookmarkByUrl: (url: string) => ipcRenderer.invoke('storage:get-bookmark-by-url', url) as Promise<BookmarkRecord | null>,
    saveBookmark: (payload: { url: string; title: string }) => ipcRenderer.invoke('storage:save-bookmark', payload) as Promise<BookmarkRecord>,
    deleteBookmark: (recordId: number) => ipcRenderer.invoke('storage:delete-bookmark', recordId) as Promise<Record<string, unknown>>,
    listWorkspaces: (limit?: number) => ipcRenderer.invoke('storage:list-workspaces', limit) as Promise<WorkspaceRecord[]>,
    getWorkspace: (recordId: number) => ipcRenderer.invoke('storage:get-workspace', recordId) as Promise<WorkspaceRecord>,
    saveWorkspace: (payload: { name: string; snapshot: { groups: Array<{ name: string; description: string; tabs: string[] }>; duplicate_sets: string[][]; suggested_hibernating: string[]; strategy: string }; tabs: Array<{ id: string; url: string; title: string; text: string; is_start_page: boolean; group_name?: string | null }>; activeTabId: string | null }) => ipcRenderer.invoke('storage:save-workspace', payload) as Promise<WorkspaceRecord>,
    deleteWorkspace: (recordId: number) => ipcRenderer.invoke('storage:delete-workspace', recordId) as Promise<Record<string, unknown>>,
    hibernateTab: (payload: { tab: TabSnapshot; reason: string; originBatchId?: string | null }) => ipcRenderer.invoke('storage:hibernate-tab', payload) as Promise<Record<string, unknown>>
  }
})
