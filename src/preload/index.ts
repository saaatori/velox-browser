import { contextBridge, ipcRenderer } from 'electron'

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
  closed_count: number
  latest_snapshot_at: string | null
  latest_closed_at: string | null
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

contextBridge.exposeInMainWorld('velox', {
  getBackendConfig: () => ipcRenderer.invoke('backend:get-config') as Promise<{ baseUrl: string }>,
  tabs: {
    getState: () => ipcRenderer.invoke('tabs:get-state') as Promise<{ tabs: BrowserTabState[]; activeTabId: string | null }>,
    getSnapshots: () => ipcRenderer.invoke('tabs:get-snapshots') as Promise<TabSnapshot[]>,
    create: (url?: string) => ipcRenderer.invoke('tabs:create', url) as Promise<BrowserTabState>,
    activate: (tabId: string) => ipcRenderer.invoke('tabs:activate', tabId) as Promise<void>,
    close: (tabId: string) => ipcRenderer.invoke('tabs:close', tabId) as Promise<void>,
    navigate: (input: string) => ipcRenderer.invoke('tabs:navigate', input) as Promise<void>,
    back: () => ipcRenderer.invoke('tabs:back') as Promise<void>,
    forward: () => ipcRenderer.invoke('tabs:forward') as Promise<void>,
    reload: () => ipcRenderer.invoke('tabs:reload') as Promise<void>,
    stop: () => ipcRenderer.invoke('tabs:stop') as Promise<void>,
    hibernate: (tabId: string, reason?: string) => ipcRenderer.invoke('tabs:hibernate', { tabId, reason }) as Promise<Record<string, unknown>>,
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
    hibernateTab: (payload: { tab: TabSnapshot; reason: string; originBatchId?: string | null }) => ipcRenderer.invoke('storage:hibernate-tab', payload) as Promise<Record<string, unknown>>
  }
})
