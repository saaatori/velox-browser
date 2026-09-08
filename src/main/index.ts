import { app, BrowserWindow, ipcMain, session, WebContentsView } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'

const BACKEND_HOST = '127.0.0.1'
const SIDEBAR_WIDTH = 248
const TOOLBAR_HEIGHT = 64
const STATUSBAR_HEIGHT = 30
const START_PAGE_URL = 'velox://new-tab'

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

type BrowserTab = BrowserTabState & {
  view: WebContentsView | null
}

let backendProcess: ChildProcess | null = null
let backendPort = 18765
let mainWindow: BrowserWindow | null = null
let tabs: BrowserTab[] = []
let activeTabId: string | null = null
let nextTabId = 1
const closingTabIds = new Set<string>()

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, BACKEND_HOST, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Unable to determine a free port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function startBackend(): Promise<void> {
  backendPort = await findFreePort()
  const projectRoot = join(__dirname, '..', '..')
  const pythonExecutable = app.isPackaged
    ? join(process.resourcesPath, 'backend', 'velox-backend.exe')
    : join(projectRoot, '.venv', 'Scripts', 'python.exe')

  if (app.isPackaged && existsSync(pythonExecutable)) {
    backendProcess = spawn(pythonExecutable, ['--port', String(backendPort)], {
      windowsHide: true,
      env: { ...process.env, VELOX_BACKEND_PORT: String(backendPort) }
    })
  } else {
    backendProcess = spawn(
      existsSync(pythonExecutable) ? pythonExecutable : 'python',
      ['-m', 'uvicorn', 'backend.app.main:app', '--host', BACKEND_HOST, '--port', String(backendPort)],
      {
        cwd: projectRoot,
        windowsHide: true,
        env: { ...process.env, VELOX_BACKEND_PORT: String(backendPort) }
      }
    )
  }

  backendProcess.stdout?.on('data', (data) => console.log(`[backend] ${String(data).trim()}`))
  backendProcess.stderr?.on('data', (data) => console.error(`[backend] ${String(data).trim()}`))
  backendProcess.once('exit', (code) => {
    console.log(`[backend] exited with code ${code ?? 'unknown'}`)
    backendProcess = null
  })
}

function stopBackend(): void {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill()
    backendProcess = null
  }
}

function getBackendBaseUrl(): string {
  return `http://${BACKEND_HOST}:${backendPort}`
}

function getTabState(tab: BrowserTab): BrowserTabState {
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    isStartPage: tab.isStartPage,
    isLoading: tab.isLoading,
    canGoBack: tab.view?.webContents.canGoBack() ?? false,
    canGoForward: tab.view?.webContents.canGoForward() ?? false
  }
}

async function getTabSnapshots(): Promise<TabSnapshot[]> {
  return Promise.all(tabs.map(async (tab) => {
    let text = ''
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      try {
        text = await tab.view.webContents.executeJavaScript(
          `document.body ? document.body.innerText.slice(0, 500) : ''`,
          true
        )
      } catch {
        text = ''
      }
    }
    return { ...getTabState(tab), text }
  }))
}

function sendTabsState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('tabs:state', {
    tabs: tabs.map(getTabState),
    activeTabId
  })
}

function layoutTabViews(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { width, height } = mainWindow.getContentBounds()
  const bounds = {
    x: SIDEBAR_WIDTH,
    y: TOOLBAR_HEIGHT,
    width: Math.max(0, width - SIDEBAR_WIDTH),
    height: Math.max(0, height - TOOLBAR_HEIGHT - STATUSBAR_HEIGHT)
  }
  for (const tab of tabs) tab.view?.setBounds(bounds)
}

function updateTabState(tab: BrowserTab): void {
  if (tab.view) {
    tab.url = tab.view.webContents.getURL() || tab.url
    tab.title = tab.view.webContents.getTitle() || tab.title
  }
  sendTabsState()
}

function findTab(tabId: string): BrowserTab | undefined {
  return tabs.find((tab) => tab.id === tabId)
}

function normalizeNavigationInput(input: string): string {
  const value = input.trim()
  if (!value) return START_PAGE_URL
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value
  if (value.includes('.') && !/\s/.test(value)) return `https://${value}`
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

function showActiveTab(): void {
  for (const tab of tabs) tab.view?.setVisible(tab.id === activeTabId)
  layoutTabViews()
  sendTabsState()
}

function attachViewEvents(tab: BrowserTab): void {
  const contents = tab.view?.webContents
  if (!contents) return

  contents.on('did-start-loading', () => {
    tab.isLoading = true
    updateTabState(tab)
  })
  contents.on('did-stop-loading', () => {
    tab.isLoading = false
    updateTabState(tab)
  })
  contents.on('did-navigate', () => updateTabState(tab))
  contents.on('did-navigate-in-page', () => updateTabState(tab))
  contents.on('page-title-updated', (_event, title) => {
    tab.title = title || '新标签页'
    updateTabState(tab)
  })
  contents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (errorCode === -3) return
    tab.isLoading = false
    tab.title = `加载失败：${errorDescription}`
    updateTabState(tab)
  })
  contents.on('render-process-gone', () => {
    tab.isLoading = false
    tab.title = '页面进程已退出'
    updateTabState(tab)
  })
  contents.on('destroyed', () => {
    if (closingTabIds.has(tab.id)) {
      closingTabIds.delete(tab.id)
      sendTabsState()
      return
    }
    tabs = tabs.filter((item) => item.id !== tab.id)
    if (activeTabId === tab.id) {
      activeTabId = tabs.at(-1)?.id ?? null
      if (tabs.length === 0) createTab()
      else showActiveTab()
    } else {
      sendTabsState()
    }
  })
}

function configureWebContentsView(tab: BrowserTab): void {
  if (!tab.view) return
  mainWindow?.contentView.addChildView(tab.view)
  attachViewEvents(tab)
  tab.view.webContents.setWindowOpenHandler(({ url }) => {
    createTab(url)
    return { action: 'deny' }
  })
}

function createTab(rawUrl = START_PAGE_URL): BrowserTab {
  const isStartPage = rawUrl === START_PAGE_URL
  const tab: BrowserTab = {
    id: `tab-${nextTabId++}`,
    title: isStartPage ? '新标签页' : '正在加载...',
    url: isStartPage ? '' : rawUrl,
    isStartPage,
    isLoading: !isStartPage,
    canGoBack: false,
    canGoForward: false,
    view: null
  }

  if (!isStartPage) {
    tab.view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    configureWebContentsView(tab)
    void tab.view.webContents.loadURL(rawUrl)
  }

  tabs.push(tab)
  activeTabId = tab.id
  showActiveTab()
  return tab
}

function activateTab(tabId: string): void {
  if (!findTab(tabId)) return
  activeTabId = tabId
  showActiveTab()
}

function closeTab(tabId: string): void {
  const index = tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return
  const [tab] = tabs.splice(index, 1)
  if (tab.view && !tab.view.webContents.isDestroyed()) {
    closingTabIds.add(tabId)
    tab.view.webContents.close()
  }
  if (activeTabId === tabId) activeTabId = tabs[index]?.id ?? tabs[index - 1]?.id ?? null
  if (tabs.length === 0) createTab()
  else showActiveTab()
}

function navigateActiveTab(input: string): void {
  const tab = activeTabId ? findTab(activeTabId) : undefined
  const url = normalizeNavigationInput(input)
  if (!tab) {
    createTab(url)
    return
  }
  if (url === START_PAGE_URL) {
    tab.isStartPage = true
    tab.isLoading = false
    tab.url = ''
    tab.title = '新标签页'
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      mainWindow?.contentView.removeChildView(tab.view)
      tab.view.webContents.close()
    }
    tab.view = null
    showActiveTab()
    return
  }
  if (!tab.view) {
    tab.view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    tab.isStartPage = false
    configureWebContentsView(tab)
  }
  tab.url = url
  tab.title = '正在加载...'
  tab.isLoading = true
  void tab.view.webContents.loadURL(url)
  showActiveTab()
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Velox Browser',
    backgroundColor: '#0c1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow = window
  window.on('resize', layoutTabViews)
  window.on('closed', () => {
    mainWindow = null
    tabs = []
    activeTabId = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'notifications')
  })

  await startBackend()
  ipcMain.handle('backend:get-config', () => ({ baseUrl: getBackendBaseUrl() }))
  ipcMain.handle('tabs:get-state', () => ({ tabs: tabs.map(getTabState), activeTabId }))
  ipcMain.handle('tabs:get-snapshots', () => getTabSnapshots())
  ipcMain.handle('storage:sync-tabs', async (_event, payload: { tabs: TabSnapshot[]; activeTabId: string | null }) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/tabs/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!response.ok) {
      throw new Error(`Failed to sync tabs snapshot: ${response.status}`)
    }
    return response.json() as Promise<{ batch_id: string; captured_at: string; tab_count: number }>
  })
  ipcMain.handle('storage:get-summary', async () => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/summary`)
    if (!response.ok) {
      throw new Error(`Failed to load storage summary: ${response.status}`)
    }
    return response.json() as Promise<Record<string, unknown>>
  })
  ipcMain.handle('storage:hibernate-tab', async (_event, payload: { tab: TabSnapshot; reason: string; originBatchId?: string | null }) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/tabs/hibernate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tab: payload.tab,
        reason: payload.reason,
        origin_batch_id: payload.originBatchId ?? null
      })
    })
    if (!response.ok) {
      throw new Error(`Failed to hibernate tab: ${response.status}`)
    }
    return response.json() as Promise<Record<string, unknown>>
  })
  ipcMain.handle('storage:list-hibernated', async (_event, limit: number = 20) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/hibernated?limit=${encodeURIComponent(String(limit))}`)
    if (!response.ok) {
      throw new Error(`Failed to load hibernated tabs: ${response.status}`)
    }
    return response.json() as Promise<Array<Record<string, unknown>>>
  })
  ipcMain.handle('storage:restore-hibernated', async (_event, recordId: number) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/hibernated/${recordId}/restore`, {
      method: 'POST'
    })
    if (!response.ok) {
      throw new Error(`Failed to restore hibernated tab: ${response.status}`)
    }
    const record = await response.json() as { url?: string }
    if (record.url) createTab(record.url)
    return record
  })
  ipcMain.handle('storage:list-closed', async (_event, limit: number = 20) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/closed?limit=${encodeURIComponent(String(limit))}`)
    if (!response.ok) {
      throw new Error(`Failed to load closed tabs: ${response.status}`)
    }
    return response.json() as Promise<Array<Record<string, unknown>>>
  })
  ipcMain.handle('storage:restore-closed', async (_event, recordId: number) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/closed/${recordId}/restore`, {
      method: 'POST'
    })
    if (!response.ok) {
      throw new Error(`Failed to restore closed tab: ${response.status}`)
    }
    const record = await response.json() as { url?: string }
    if (record.url) createTab(record.url)
    return record
  })
  ipcMain.handle('storage:list-workspaces', async (_event, limit: number = 20) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/workspaces?limit=${encodeURIComponent(String(limit))}`)
    if (!response.ok) {
      throw new Error(`Failed to load workspaces: ${response.status}`)
    }
    return response.json() as Promise<Array<Record<string, unknown>>>
  })
  ipcMain.handle('storage:get-workspace', async (_event, recordId: number) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/workspaces/${recordId}`)
    if (!response.ok) {
      throw new Error(`Failed to load workspace: ${response.status}`)
    }
    return response.json() as Promise<Record<string, unknown>>
  })
  ipcMain.handle('storage:save-workspace', async (_event, payload: { name: string; snapshot: { groups: unknown[]; duplicate_sets: unknown[]; suggested_hibernating: string[]; strategy: string } }) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/workspaces/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!response.ok) {
      throw new Error(`Failed to save workspace: ${response.status}`)
    }
    return response.json() as Promise<Record<string, unknown>>
  })
  ipcMain.handle('tabs:create', (_event, url?: string) => getTabState(createTab(normalizeNavigationInput(url ?? START_PAGE_URL))))
  ipcMain.handle('tabs:activate', (_event, tabId: string) => activateTab(tabId))
  ipcMain.handle('tabs:close', async (_event, tabId: string, reason: string = 'manual') => {
    const snapshot = (await getTabSnapshots()).find((item) => item.id === tabId)
    if (snapshot && !snapshot.isStartPage) {
      const response = await fetch(`${getBackendBaseUrl()}/api/storage/tabs/closed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tab: snapshot,
          reason
        })
      })
      if (!response.ok) {
        throw new Error(`Failed to store closed tab: ${response.status}`)
      }
    }
    closeTab(tabId)
  })
  ipcMain.handle('tabs:navigate', (_event, input: string) => navigateActiveTab(input))
  ipcMain.handle('tabs:back', () => {
    const tab = activeTabId ? findTab(activeTabId) : undefined
    if (tab?.view?.webContents.canGoBack()) tab.view.webContents.goBack()
  })
  ipcMain.handle('tabs:forward', () => {
    const tab = activeTabId ? findTab(activeTabId) : undefined
    if (tab?.view?.webContents.canGoForward()) tab.view.webContents.goForward()
  })
  ipcMain.handle('tabs:reload', () => {
    const tab = activeTabId ? findTab(activeTabId) : undefined
    if (tab?.view) tab.view.webContents.reload()
  })
  ipcMain.handle('tabs:stop', () => {
    const tab = activeTabId ? findTab(activeTabId) : undefined
    if (tab?.view) tab.view.webContents.stop()
  })
  ipcMain.handle('tabs:hibernate', async (_event, payload: { tabId: string; reason?: string }) => {
    const tab = findTab(payload.tabId)
    if (!tab) {
      throw new Error(`Tab not found: ${payload.tabId}`)
    }
    if (tab.isStartPage) {
      closeTab(tab.id)
      return { status: 'ignored' }
    }
    const snapshot = (await getTabSnapshots()).find((item) => item.id === payload.tabId)
    if (!snapshot) {
      throw new Error(`Unable to capture snapshot for tab: ${payload.tabId}`)
    }
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/tabs/hibernate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tab: snapshot,
        reason: payload.reason ?? 'manual',
        origin_batch_id: null
      })
    })
    if (!response.ok) {
      throw new Error(`Failed to hibernate tab: ${response.status}`)
    }
    closeTab(tab.id)
    return response.json() as Promise<Record<string, unknown>>
  })
  createWindow()
  createTab()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', stopBackend)
