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
    onStateChange: (callback: (state: { tabs: BrowserTabState[]; activeTabId: string | null }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: { tabs: BrowserTabState[]; activeTabId: string | null }) => callback(state)
      ipcRenderer.on('tabs:state', listener)
      return () => ipcRenderer.removeListener('tabs:state', listener)
    }
  }
})
