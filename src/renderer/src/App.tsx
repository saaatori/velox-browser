import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Globe2,
  LayoutPanelLeft,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Square,
  WandSparkles,
  X
} from 'lucide-react'

type BackendState = 'checking' | 'online' | 'offline'
type OrganizeStrategy = 'semantic' | 'domain'

type OrganizeResult = {
  groups: Array<{
    name: string
    description: string
    tabs: string[]
  }>
  duplicate_sets: string[][]
  suggested_hibernating: string[]
  strategy: string
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

function App() {
  const [backendState, setBackendState] = useState<BackendState>('checking')
  const [backendUrl, setBackendUrl] = useState('')
  const [tabs, setTabs] = useState<BrowserTabState[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const [organizeStrategy, setOrganizeStrategy] = useState<OrganizeStrategy>('semantic')
  const [organizeLoading, setOrganizeLoading] = useState(false)
  const [organizeError, setOrganizeError] = useState('')
  const [organizeResult, setOrganizeResult] = useState<OrganizeResult | null>(null)
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null)
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [tabs, activeTabId])

  useEffect(() => {
    let cancelled = false

    async function initialize() {
      try {
        const [config, tabState] = await Promise.all([
          window.velox.getBackendConfig(),
          window.velox.tabs.getState()
        ])
        const response = await fetch(`${config.baseUrl}/health`)
        if (!response.ok) throw new Error('Backend health check failed')
        if (!cancelled) {
          setBackendUrl(config.baseUrl)
          setBackendState('online')
          setTabs(tabState.tabs)
          setActiveTabId(tabState.activeTabId)
        }
      } catch {
        if (!cancelled) setBackendState('offline')
        try {
          const tabState = await window.velox.tabs.getState()
          if (!cancelled) {
            setTabs(tabState.tabs)
            setActiveTabId(tabState.activeTabId)
          }
        } catch {
          // The bridge is unavailable only during a broken startup.
        }
      }
    }

    void initialize()
    const unsubscribe = window.velox.tabs.onStateChange((state) => {
      if (cancelled) return
      setTabs(state.tabs)
      setActiveTabId(state.activeTabId)
      void (async () => {
        try {
          const snapshots = await window.velox.tabs.getSnapshots()
          await window.velox.storage.syncTabs({ tabs: snapshots, activeTabId: state.activeTabId })
        } catch {
          // Snapshot sync is best-effort.
        }
      })()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadSummary() {
      try {
        const summary = await window.velox.storage.getSummary()
        if (!cancelled) setStorageSummary(summary)
      } catch {
        if (!cancelled) setStorageSummary(null)
      }
    }
    void loadSummary()
    return () => {
      cancelled = true
    }
  }, [organizeResult])

  useEffect(() => {
    setAddress(activeTab?.url ?? '')
  }, [activeTab?.id, activeTab?.url])

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (!event.ctrlKey && !event.metaKey) return
      if (event.key.toLowerCase() === 'l') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('.address-bar input')?.select()
      }
      if (event.key.toLowerCase() === 't') {
        event.preventDefault()
        void window.velox.tabs.create()
      }
      if (event.key.toLowerCase() === 'w' && activeTabId) {
        event.preventDefault()
        void window.velox.tabs.close(activeTabId)
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [activeTabId])

  function submitNavigation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void window.velox.tabs.navigate(address)
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem('search') as HTMLInputElement
    if (input.value.trim()) void window.velox.tabs.navigate(input.value)
  }

  function tabLabel(tab: BrowserTabState): string {
    if (tab.isLoading) return '正在加载...'
    return tab.title || (tab.url ? '未命名页面' : '新标签页')
  }

  async function organizeTabs() {
    setOrganizeLoading(true)
    setOrganizeError('')
    try {
      const config = await window.velox.getBackendConfig()
      const snapshots = await window.velox.tabs.getSnapshots()
      const response = await fetch(`${config.baseUrl}/api/tabs/organize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tabs: snapshots.map((tab) => ({
            id: tab.id,
            url: tab.url,
            title: tab.title,
            text: tab.text,
            is_start_page: tab.isStartPage
          })),
          strategy: organizeStrategy,
          active_tab_id: activeTabId
        })
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || '标签整理失败')
      }
      const result = await response.json() as OrganizeResult
      setOrganizeResult(result)
      await window.velox.storage.syncTabs({ tabs: snapshots, activeTabId })
    } catch (error) {
      setOrganizeError(error instanceof Error ? error.message : '标签整理失败')
    } finally {
      setOrganizeLoading(false)
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Sparkles size={17} /></div>
          <div><strong>velox</strong><span>AI browser</span></div>
        </div>
        <button className="new-tab-button" type="button" onClick={() => void window.velox.tabs.create()}>
          <Plus size={17} /><span>新建标签页</span><kbd>Ctrl T</kbd>
        </button>
        <div className="sidebar-section">
          <div className="section-label">
            <span>标签页</span>
            <button className="icon-button" type="button" aria-label="添加标签页" title="添加标签页" onClick={() => void window.velox.tabs.create()}>
              <Plus size={15} />
            </button>
          </div>
          <div className="tab-list">
            {tabs.map((tab) => (
              <div className={`tab-item ${tab.id === activeTabId ? 'active' : ''}`} key={tab.id}>
                <button className="tab-select" type="button" onClick={() => void window.velox.tabs.activate(tab.id)}>
                  <Globe2 size={16} />
                  <span>{tabLabel(tab)}</span>
                </button>
                <button className="tab-close" type="button" aria-label={`关闭${tabLabel(tab)}`} title="关闭标签页" onClick={() => void window.velox.tabs.close(tab.id)}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
        {organizeOpen && (
          <section className="organize-panel">
            <div className="panel-heading">
              <div>
                <strong>AI 整理标签</strong>
                <span>分析标题、域名和页面摘要</span>
              </div>
              <button className="icon-button" type="button" aria-label="关闭整理面板" title="关闭" onClick={() => setOrganizeOpen(false)}>
                <X size={14} />
              </button>
            </div>
            <div className="strategy-switcher" role="group" aria-label="整理策略">
              <button className={organizeStrategy === 'semantic' ? 'selected' : ''} type="button" onClick={() => setOrganizeStrategy('semantic')}>主题</button>
              <button className={organizeStrategy === 'domain' ? 'selected' : ''} type="button" onClick={() => setOrganizeStrategy('domain')}>域名</button>
            </div>
            <button className="organize-action" type="button" disabled={organizeLoading || tabs.length === 0} onClick={() => void organizeTabs()}>
              <WandSparkles size={15} />
              {organizeLoading ? '分析中...' : '开始分析'}
            </button>
            {organizeError && <p className="organize-error">{organizeError}</p>}
            {organizeResult && (
              <div className="organize-result">
                <div className="result-summary">
                  <span>{organizeResult.groups.length} 个分组</span>
                  <span>{organizeResult.duplicate_sets.length} 组重复</span>
                </div>
                {organizeResult.groups.map((group) => (
                  <div className="result-group" key={group.name}>
                    <div className="result-group-title"><strong>{group.name}</strong><span>{group.tabs.length}</span></div>
                    <p>{group.description}</p>
                  </div>
                ))}
                {organizeResult.suggested_hibernating.length > 0 && (
                  <p className="hibernate-note">建议稍后处理 {organizeResult.suggested_hibernating.length} 个后台标签</p>
                )}
              </div>
            )}
            {storageSummary && (
              <div className="storage-summary">
                <span>快照 {storageSummary.snapshot_count}</span>
                <span>整理 {storageSummary.organize_count}</span>
                <span>休眠 {storageSummary.hibernated_count}</span>
              </div>
            )}
          </section>
        )}
        <div className="sidebar-spacer" />
        <div className="sidebar-footer">
          <button className={`footer-button ${organizeOpen ? 'selected' : ''}`} type="button" onClick={() => setOrganizeOpen((open) => !open)}>
            <WandSparkles size={16} /><span>整理标签</span>
          </button>
          <button className="footer-button" type="button"><LayoutPanelLeft size={16} /><span>工作区</span></button>
          <button className="footer-button" type="button"><Settings2 size={16} /><span>设置</span></button>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="navigation-controls">
            <button className="toolbar-button" type="button" aria-label="后退" title="后退" disabled={!activeTab?.canGoBack} onClick={() => void window.velox.tabs.back()}>
              <ArrowLeft size={16} />
            </button>
            <button className="toolbar-button" type="button" aria-label="前进" title="前进" disabled={!activeTab?.canGoForward} onClick={() => void window.velox.tabs.forward()}>
              <ArrowRight size={16} />
            </button>
            <button className="toolbar-button" type="button" aria-label={activeTab?.isLoading ? '停止加载' : '刷新'} title={activeTab?.isLoading ? '停止加载' : '刷新'} onClick={() => void (activeTab?.isLoading ? window.velox.tabs.stop() : window.velox.tabs.reload())}>
              {activeTab?.isLoading ? <Square size={13} /> : <RefreshCw size={15} />}
            </button>
          </div>
          <form className="address-bar" onSubmit={submitNavigation}>
            <Globe2 size={16} />
            <input aria-label="地址栏" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="输入网址或搜索内容" />
            <kbd>Ctrl L</kbd>
          </form>
          <button className="ai-button" type="button"><Bot size={17} /><span>AI 助手</span></button>
        </header>
        <section className={`start-page ${activeTab?.isStartPage ? '' : 'hidden'}`}>
          <div className="start-content">
            <div className="hero-icon"><Sparkles size={27} /></div>
            <p className="eyebrow">AI-native browsing</p>
            <h1>让浏览更快一步</h1>
            <p className="hero-copy">Velox 会理解你的目标，帮你搜索、整理标签页，并把重复的网页操作变成可复用的工作流。</p>
            <form className="search-box" onSubmit={submitSearch}>
              <Search size={18} />
              <input name="search" aria-label="搜索" placeholder="搜索网页，或告诉 Velox 你想完成什么" />
              <kbd>Enter</kbd>
            </form>
            <div className="quick-actions">
              <button type="button" onClick={() => document.querySelector<HTMLInputElement>('.search-box input')?.focus()}><Search size={15} />开始搜索</button>
              <button type="button"><Bot size={15} />询问 AI</button>
            </div>
          </div>
        </section>
        <footer className="statusbar">
          <span className={`status-dot ${backendState}`} />
          <span>{backendState === 'checking' && '正在连接 Velox AI 服务...'}{backendState === 'online' && `Velox AI 服务已连接 · ${backendUrl}`}{backendState === 'offline' && 'Velox AI 服务未连接'}</span>
        </footer>
      </section>
    </main>
  )
}

export default App
