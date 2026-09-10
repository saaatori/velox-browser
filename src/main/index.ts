import { app, BrowserWindow, dialog, ipcMain, Menu, session, WebContentsView, type MenuItemConstructorOptions } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'

const BACKEND_HOST = '127.0.0.1'
const SIDEBAR_WIDTH = 248
const SIDEBAR_COLLAPSED_WIDTH = 72
const TOOLBAR_HEIGHT = 64
const STATUSBAR_HEIGHT = 30
const START_PAGE_URL = 'velox://new-tab'
const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  baidu: 'https://www.baidu.com/s?wd=',
  duckduckgo: 'https://duckduckgo.com/?q='
} as const

app.setName('Velox 浏览器')
type SearchEngine = keyof typeof SEARCH_ENGINES
let searchEngine: SearchEngine = 'google'
type StartupPage = 'velox' | 'custom'
let startupPage: StartupPage = 'velox'
let startupUrl = ''

type VeloxPreferences = {
  searchEngine?: SearchEngine
  startupPage?: StartupPage
  startupUrl?: string
}

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

type BrowserTab = BrowserTabState & {
  view: WebContentsView | null
}

type WorkspaceTab = {
  id: string
  title: string
  url: string
  is_start_page: boolean
  group_name?: string | null
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

type DomExtractionSchema = Record<string, string>

type MarkdownExportPayload = {
  defaultFilename: string
  content: string
}

type BrowserAction =
  | { action: 'navigate'; params: { url: string } }
  | { action: 'search'; params: { query: string; engine?: SearchEngine } }
  | { action: 'back'; params?: Record<string, never> }
  | { action: 'forward'; params?: Record<string, never> }
  | { action: 'reload'; params?: Record<string, never> }
  | { action: 'stop'; params?: Record<string, never> }
  | { action: 'query'; params?: { selector?: string; limit?: number } }
  | { action: 'extract'; params: { schema: DomExtractionSchema } }
  | { action: 'click'; params: { selector: string } }
  | { action: 'type'; params: { selector: string; text: string; replace?: boolean } }
  | { action: 'scroll'; params?: { direction?: 'up' | 'down'; amount?: number } }

let backendProcess: ChildProcess | null = null
let backendPort = 18765
let mainWindow: BrowserWindow | null = null
let tabs: BrowserTab[] = []
let activeTabId: string | null = null
let nextTabId = 1
let sidebarWidth = SIDEBAR_WIDTH
const closingTabIds = new Set<string>()

function getPreferencesPath(): string {
  return join(app.getPath('userData'), 'preferences.json')
}

function isSearchEngine(value: unknown): value is SearchEngine {
  return typeof value === 'string' && value in SEARCH_ENGINES
}

function isStartupPage(value: unknown): value is StartupPage {
  return value === 'velox' || value === 'custom'
}

function loadPreferences(): void {
  try {
    const preferences = JSON.parse(readFileSync(getPreferencesPath(), 'utf8')) as VeloxPreferences
    if (isSearchEngine(preferences.searchEngine)) searchEngine = preferences.searchEngine
    if (isStartupPage(preferences.startupPage)) startupPage = preferences.startupPage
    if (typeof preferences.startupUrl === 'string') startupUrl = preferences.startupUrl
  } catch {
    // A missing or malformed preferences file falls back to defaults.
  }
}

function savePreferences(): void {
  const preferencesPath = getPreferencesPath()
  mkdirSync(join(preferencesPath, '..'), { recursive: true })
  writeFileSync(preferencesPath, `${JSON.stringify({ searchEngine, startupPage, startupUrl }, null, 2)}\n`, 'utf8')
}

function getNewTabUrl(): string {
  return startupPage === 'custom' && startupUrl ? startupUrl : START_PAGE_URL
}

function normalizeStartupUrl(input: string): string {
  const value = input.trim()
  if (!value) throw new Error('启动网址不能为空')
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`
  const parsed = new URL(candidate)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('启动网址只支持 HTTP 或 HTTPS')
  }
  return parsed.toString()
}

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
    groupName: tab.groupName,
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
    x: sidebarWidth,
    y: TOOLBAR_HEIGHT,
    width: Math.max(0, width - sidebarWidth),
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

function shouldRecordHistoryUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

async function recordHistoryForTab(tab: BrowserTab): Promise<void> {
  if (!tab.view || tab.view.webContents.isDestroyed()) return
  const url = tab.view.webContents.getURL() || tab.url
  if (!shouldRecordHistoryUrl(url)) return
  const title = tab.view.webContents.getTitle() || tab.title || url
  try {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title })
    })
    if (!response.ok) console.warn(`Failed to record history: ${response.status}`)
  } catch (error) {
    console.warn('Failed to record history', error)
  }
}

function findTab(tabId: string): BrowserTab | undefined {
  return tabs.find((tab) => tab.id === tabId)
}

function getActiveWebTab(): BrowserTab {
  const tab = activeTabId ? findTab(activeTabId) : undefined
  if (!tab || tab.isStartPage || !tab.view || tab.view.webContents.isDestroyed()) {
    throw new Error('当前没有可供 Agent 操作的网页标签')
  }
  return tab
}

function normalizeNavigationInput(input: string): string {
  const value = input.trim()
  if (!value) return START_PAGE_URL
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value
  if (value.includes('.') && !/\s/.test(value)) return `https://${value}`
  return `${SEARCH_ENGINES[searchEngine]}${encodeURIComponent(value)}`
}

function getSearchUrl(query: string, engine = searchEngine): string {
  return `${SEARCH_ENGINES[engine]}${encodeURIComponent(query.trim())}`
}

function buildDomQueryScript(selector = 'a, button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]', limit = 80): string {
  return `
    (() => {
      const selector = ${JSON.stringify(selector)};
      const limit = ${JSON.stringify(limit)};
      const cssPath = (element) => {
        if (!(element instanceof Element)) return '';
        const parts = [];
        let current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
          const tag = current.tagName.toLowerCase();
          if (current.id) {
            parts.unshift('#' + CSS.escape(current.id));
            break;
          }
          const parent = current.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const sameTagSiblings = Array.from(parent.children).filter((sibling) => sibling.tagName === current.tagName);
          if (sameTagSiblings.length === 1) parts.unshift(tag);
          else parts.unshift(tag + ':nth-of-type(' + (sameTagSiblings.indexOf(current) + 1) + ')');
          current = parent;
        }
        return parts.join(' > ');
      };
      const labelFor = (element) => {
        const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : '';
        return (
          element.getAttribute('aria-label') ||
          element.getAttribute('title') ||
          element.getAttribute('placeholder') ||
          element.innerText ||
          value ||
          element.getAttribute('href') ||
          ''
        ).replace(/\\s+/g, ' ').trim();
      };
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      return Array.from(document.querySelectorAll(selector))
        .filter(isVisible)
        .slice(0, limit)
        .map((element, index) => {
          const rect = element.getBoundingClientRect();
          return {
            id: 'el-' + (index + 1),
            selector: cssPath(element),
            tagName: element.tagName.toLowerCase(),
            text: labelFor(element).slice(0, 160),
            role: element.getAttribute('role'),
            href: element instanceof HTMLAnchorElement ? element.href : null,
            inputType: element instanceof HTMLInputElement ? element.type : null,
            placeholder: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder : null,
            ariaLabel: element.getAttribute('aria-label'),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          };
        });
    })()
  `
}

function buildDomExtractScript(schema: DomExtractionSchema): string {
  return `
    (() => {
      const schema = ${JSON.stringify(schema)};
      const readValue = (element) => {
        if (!element) return null;
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          return element.value;
        }
        if (element instanceof HTMLAnchorElement) {
          return element.href || element.innerText.trim();
        }
        if (element instanceof HTMLImageElement) {
          return element.currentSrc || element.src || element.alt;
        }
        return (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
      };
      return Object.fromEntries(
        Object.entries(schema).map(([field, selector]) => [field, readValue(document.querySelector(selector))])
      );
    })()
  `
}

async function queryActiveDom(selector?: string, limit?: number): Promise<DomElementInfo[]> {
  const tab = getActiveWebTab()
  return tab.view!.webContents.executeJavaScript(buildDomQueryScript(selector, limit), true) as Promise<DomElementInfo[]>
}

async function extractActiveDom(schema: DomExtractionSchema): Promise<Record<string, string | null>> {
  const tab = getActiveWebTab()
  return tab.view!.webContents.executeJavaScript(buildDomExtractScript(schema), true) as Promise<Record<string, string | null>>
}

async function getActiveDomSnapshot(): Promise<DomSnapshot> {
  const tab = getActiveWebTab()
  const [text, elements] = await Promise.all([
    tab.view!.webContents.executeJavaScript(`document.body ? document.body.innerText.slice(0, 2000) : ''`, true) as Promise<string>,
    queryActiveDom(undefined, 60)
  ])
  return {
    tabId: tab.id,
    url: tab.view!.webContents.getURL() || tab.url,
    title: tab.view!.webContents.getTitle() || tab.title,
    text,
    elements
  }
}

async function executeBrowserAction(action: BrowserAction): Promise<Record<string, unknown>> {
  switch (action.action) {
    case 'navigate':
      navigateActiveTab(action.params.url)
      return { status: 'ok', action: action.action }
    case 'search':
      if (!action.params.query.trim()) throw new Error('搜索内容不能为空')
      if (action.params.engine && !isSearchEngine(action.params.engine)) throw new Error('无效的搜索引擎')
      navigateActiveTab(getSearchUrl(action.params.query, action.params.engine))
      return { status: 'ok', action: action.action, engine: action.params.engine ?? searchEngine }
    case 'back': {
      const tab = getActiveWebTab()
      if (tab.view!.webContents.canGoBack()) tab.view!.webContents.goBack()
      return { status: 'ok', action: action.action }
    }
    case 'forward': {
      const tab = getActiveWebTab()
      if (tab.view!.webContents.canGoForward()) tab.view!.webContents.goForward()
      return { status: 'ok', action: action.action }
    }
    case 'reload': {
      const tab = getActiveWebTab()
      tab.view!.webContents.reload()
      return { status: 'ok', action: action.action }
    }
    case 'stop': {
      const tab = getActiveWebTab()
      tab.view!.webContents.stop()
      return { status: 'ok', action: action.action }
    }
    case 'query':
      return { status: 'ok', action: action.action, elements: await queryActiveDom(action.params?.selector, action.params?.limit) }
    case 'extract':
      return { status: 'ok', action: action.action, data: await extractActiveDom(action.params.schema) }
    case 'click': {
      const tab = getActiveWebTab()
      const clicked = await tab.view!.webContents.executeJavaScript(`
        (() => {
          const element = document.querySelector(${JSON.stringify(action.params.selector)});
          if (!element) return false;
          element.scrollIntoView({ block: 'center', inline: 'center' });
          element.click();
          return true;
        })()
      `, true) as boolean
      if (!clicked) throw new Error(`未找到可点击元素：${action.params.selector}`)
      return { status: 'ok', action: action.action }
    }
    case 'type': {
      const tab = getActiveWebTab()
      const typed = await tab.view!.webContents.executeJavaScript(`
        (() => {
          const element = document.querySelector(${JSON.stringify(action.params.selector)});
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) return false;
          element.scrollIntoView({ block: 'center', inline: 'center' });
          element.focus();
          if (element.isContentEditable) {
            if (${JSON.stringify(action.params.replace ?? true)}) element.textContent = '';
            document.execCommand('insertText', false, ${JSON.stringify(action.params.text)});
          } else {
            if (${JSON.stringify(action.params.replace ?? true)}) element.value = ${JSON.stringify(action.params.text)};
            else element.value += ${JSON.stringify(action.params.text)};
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return true;
        })()
      `, true) as boolean
      if (!typed) throw new Error(`未找到可输入元素：${action.params.selector}`)
      return { status: 'ok', action: action.action }
    }
    case 'scroll': {
      const tab = getActiveWebTab()
      const direction = action.params?.direction ?? 'down'
      const amount = action.params?.amount ?? 600
      await tab.view!.webContents.executeJavaScript(`window.scrollBy({ top: ${direction === 'down' ? amount : -amount}, behavior: 'smooth' })`, true)
      return { status: 'ok', action: action.action, direction, amount }
    }
  }
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
  contents.on('did-finish-load', () => {
    updateTabState(tab)
    void recordHistoryForTab(tab)
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

function createTab(rawUrl = getNewTabUrl(), groupName: string | null = null, forcedId?: string): BrowserTab {
  const isStartPage = rawUrl === START_PAGE_URL
  if (forcedId) {
    const numericId = Number(forcedId.replace(/^tab-/, ''))
    if (Number.isFinite(numericId)) nextTabId = Math.max(nextTabId, numericId + 1)
  }
  const tab: BrowserTab = {
    id: forcedId ?? `tab-${nextTabId++}`,
    title: isStartPage ? '新标签页' : '正在加载...',
    url: isStartPage ? '' : rawUrl,
    isStartPage,
    groupName,
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

function clearTabsForWorkspace(): void {
  const existingTabs = [...tabs]
  tabs = []
  activeTabId = null
  for (const tab of existingTabs) {
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      closingTabIds.add(tab.id)
      mainWindow?.contentView.removeChildView(tab.view)
      tab.view.webContents.close()
    }
  }
}

function restoreWorkspace(workspaceTabs: WorkspaceTab[], savedActiveTabId: string | null): void {
  clearTabsForWorkspace()
  const pages = workspaceTabs.filter((tab) => !tab.is_start_page && tab.url)
  if (pages.length === 0) {
    createTab()
    return
  }

  const restoredTabs = pages.map((tab) => createTab(tab.url, tab.group_name ?? null, tab.id))
  const activeRestoredTab = restoredTabs.find((tab) => tab.id === savedActiveTabId)
  activeTabId = activeRestoredTab?.id ?? restoredTabs[0]?.id ?? null
  showActiveTab()
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
    mainWindow?.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
  }
  if (activeTabId === tabId) activeTabId = tabs[index]?.id ?? tabs[index - 1]?.id ?? null
  if (tabs.length === 0) createTab()
  else showActiveTab()
}

function createApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建标签页',
          accelerator: 'CmdOrCtrl+T',
          click: () => createTab(getNewTabUrl())
        },
        {
          label: '关闭当前标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (activeTabId) closeTab(activeTabId)
          }
        },
        { type: 'separator' },
        { label: '退出 Velox', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '查看',
      submenu: [
        {
          label: '刷新当前页',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const tab = activeTabId ? findTab(activeTabId) : undefined
            if (tab?.view) tab.view.webContents.reload()
          }
        },
        {
          label: '停止加载',
          accelerator: 'Esc',
          click: () => {
            const tab = activeTabId ? findTab(activeTabId) : undefined
            if (tab?.view) tab.view.webContents.stop()
          }
        },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '实际大小', role: 'resetZoom' },
        { type: 'separator' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭窗口', role: 'close' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 Velox 浏览器',
          click: () => {
            const options = {
              type: 'info',
              title: '关于 Velox 浏览器',
              message: 'Velox 浏览器',
              detail: 'AI 原生桌面浏览器'
            } as const
            void (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options))
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
    title: 'Velox 浏览器',
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
  loadPreferences()
  createApplicationMenu()
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'notifications')
  })

  await startBackend()
  ipcMain.handle('backend:get-config', () => ({ baseUrl: getBackendBaseUrl() }))
  ipcMain.handle('layout:set-sidebar-collapsed', (_event, collapsed: boolean) => {
    sidebarWidth = collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH
    layoutTabViews()
    return { sidebarWidth }
  })
  ipcMain.handle('reports:export-markdown', async (_event, payload: MarkdownExportPayload) => {
    const filename = payload.defaultFilename.trim() || 'velox-search-agent-report.md'
    const options = {
      title: '导出搜索代理报告',
      defaultPath: filename.toLowerCase().endsWith('.md') ? filename : `${filename}.md`,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    }
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true, filePath: null }
    const filePath = result.filePath.toLowerCase().endsWith('.md') ? result.filePath : `${result.filePath}.md`
    writeFileSync(filePath, payload.content, 'utf8')
    return { canceled: false, filePath }
  })
  ipcMain.handle('search:get-engine', () => searchEngine)
  ipcMain.handle('search:set-engine', (_event, engine: SearchEngine) => {
    if (isSearchEngine(engine)) {
      searchEngine = engine
      savePreferences()
    }
    return searchEngine
  })
  ipcMain.handle('startup:get-config', () => ({ page: startupPage, url: startupUrl }))
  ipcMain.handle('startup:set-config', (_event, payload: { page: StartupPage; url: string }) => {
    if (!isStartupPage(payload.page)) throw new Error('无效的启动页类型')
    startupPage = payload.page
    startupUrl = payload.page === 'custom' ? normalizeStartupUrl(payload.url) : ''
    savePreferences()
    return { page: startupPage, url: startupUrl }
  })
  ipcMain.handle('tabs:get-state', () => ({ tabs: tabs.map(getTabState), activeTabId }))
  ipcMain.handle('tabs:get-snapshots', () => getTabSnapshots())
  ipcMain.handle('dom:get-snapshot', () => getActiveDomSnapshot())
  ipcMain.handle('dom:query', (_event, payload?: { selector?: string; limit?: number }) => {
    return queryActiveDom(payload?.selector, payload?.limit)
  })
  ipcMain.handle('dom:extract', (_event, schema: DomExtractionSchema) => extractActiveDom(schema))
  ipcMain.handle('agent:execute-action', (_event, action: BrowserAction) => executeBrowserAction(action))
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
  ipcMain.handle('storage:list-history', async (_event, limit: number = 50) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/history?limit=${encodeURIComponent(String(limit))}`)
    if (!response.ok) {
      throw new Error(`Failed to load browser history: ${response.status}`)
    }
    return response.json() as Promise<BrowserHistoryRecord[]>
  })
  ipcMain.handle('storage:delete-history', async (_event, recordId: number) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/history/${recordId}`, {
      method: 'DELETE'
    })
    if (!response.ok) {
      throw new Error(`Failed to delete browser history: ${response.status}`)
    }
    return response.json() as Promise<Record<string, unknown>>
  })
  ipcMain.handle('storage:list-bookmarks', async (_event, limit: number = 50) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/bookmarks?limit=${encodeURIComponent(String(limit))}`)
    if (!response.ok) {
      throw new Error(`Failed to load bookmarks: ${response.status}`)
    }
    return response.json() as Promise<BookmarkRecord[]>
  })
  ipcMain.handle('storage:get-bookmark-by-url', async (_event, url: string) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/bookmarks/by-url?url=${encodeURIComponent(url)}`)
    if (!response.ok) {
      throw new Error(`Failed to load bookmark: ${response.status}`)
    }
    return response.json() as Promise<BookmarkRecord | null>
  })
  ipcMain.handle('storage:save-bookmark', async (_event, payload: { url: string; title: string }) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!response.ok) {
      throw new Error(`Failed to save bookmark: ${response.status}`)
    }
    return response.json() as Promise<BookmarkRecord>
  })
  ipcMain.handle('storage:delete-bookmark', async (_event, recordId: number) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/bookmarks/${recordId}`, {
      method: 'DELETE'
    })
    if (!response.ok) {
      throw new Error(`Failed to delete bookmark: ${response.status}`)
    }
    return response.json() as Promise<Record<string, unknown>>
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
  ipcMain.handle('storage:save-workspace', async (_event, payload: {
    name: string
    snapshot: {
      groups: unknown[]
      duplicate_sets: unknown[][]
      suggested_hibernating: string[]
      strategy: string
    }
    tabs: WorkspaceTab[]
    activeTabId: string | null
  }) => {
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
  ipcMain.handle('storage:delete-workspace', async (_event, recordId: number) => {
    const response = await fetch(`${getBackendBaseUrl()}/api/storage/workspaces/${recordId}`, {
      method: 'DELETE'
    })
    if (!response.ok) {
      throw new Error(`Failed to delete workspace: ${response.status}`)
    }
    return response.json() as Promise<Record<string, unknown>>
  })
  ipcMain.handle('tabs:restore-workspace', (_event, payload: { tabs: WorkspaceTab[]; activeTabId: string | null }) => {
    restoreWorkspace(payload.tabs, payload.activeTabId)
  })
  ipcMain.handle('tabs:create', (_event, url?: string) => getTabState(createTab(url ? normalizeNavigationInput(url) : getNewTabUrl())))
  ipcMain.handle('tabs:activate', (_event, tabId: string) => activateTab(tabId))
  ipcMain.handle('tabs:close', async (_event, tabId: string, reason: string = 'manual') => {
    try {
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
          console.warn(`Failed to store closed tab: ${response.status}`)
        }
      }
    } catch (error) {
      console.warn('Failed to store closed tab before closing', error)
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
  createTab(getNewTabUrl())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', stopBackend)
