import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
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
type SearchEngine = 'google' | 'bing' | 'baidu' | 'duckduckgo'

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

type AssistantResponse = {
  answer: string
  suggestions: string[]
  intent: string
  provider: string
  referenced_tab_ids: string[]
}

type AssistantMessage = {
  role: 'user' | 'assistant'
  content: string
  suggestions?: string[]
}

type AISettings = {
  mode: 'local' | 'external'
  base_url: string
  model: string
  api_key: string
  api_key_configured: boolean
  updated_at: string | null
}

type DuplicateGroupPreview = {
  keepId: string
  keepLabel: string
  closeIds: string[]
  closeLabels: string[]
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

type ClosedTabRecord = HibernatedTabRecord

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

function App() {
  const [backendState, setBackendState] = useState<BackendState>('checking')
  const [backendUrl, setBackendUrl] = useState('')
  const [tabs, setTabs] = useState<BrowserTabState[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [searchEngine, setSearchEngine] = useState<SearchEngine>('google')
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantInput, setAssistantInput] = useState('')
  const [assistantSending, setAssistantSending] = useState(false)
  const [assistantError, setAssistantError] = useState('')
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessage[]>([
    {
      role: 'assistant',
      content: '你好，我是 Velox 助手。我可以读取当前标签上下文，帮你总结页面、检查重复标签或给出休眠建议。'
    }
  ])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [aiSettings, setAiSettings] = useState<AISettings>({
    mode: 'local',
    base_url: '',
    model: '',
    api_key: '',
    api_key_configured: false,
    updated_at: null
  })
  const [organizeStrategy, setOrganizeStrategy] = useState<OrganizeStrategy>('semantic')
  const [organizeLoading, setOrganizeLoading] = useState(false)
  const [organizeError, setOrganizeError] = useState('')
  const [organizeResult, setOrganizeResult] = useState<OrganizeResult | null>(null)
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null)
  const [hibernatedTabs, setHibernatedTabs] = useState<HibernatedTabRecord[]>([])
  const [closedTabs, setClosedTabs] = useState<ClosedTabRecord[]>([])
  const [savedWorkspaces, setSavedWorkspaces] = useState<WorkspaceRecord[]>([])
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspaceSaving, setWorkspaceSaving] = useState(false)
  const [hibernatingTabId, setHibernatingTabId] = useState<string | null>(null)
  const [storageBusy, setStorageBusy] = useState(false)
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [tabs, activeTabId])
  const duplicateGroups = useMemo<DuplicateGroupPreview[]>(() => {
    if (!organizeResult) return []
    return organizeResult.duplicate_sets.map((group) => {
      const keepId = group.includes(activeTabId ?? '') ? (activeTabId as string) : group[0]
      const closeIds = group.filter((tabId) => tabId !== keepId)
      return {
        keepId,
        keepLabel: tabs.find((tab) => tab.id === keepId)?.title || keepId,
        closeIds,
        closeLabels: closeIds.map((tabId) => tabs.find((tab) => tab.id === tabId)?.title || tabId)
      }
    })
  }, [activeTabId, organizeResult, tabs])
  const tabGroups = useMemo(() => {
    const groups = new Map<string, BrowserTabState[]>()
    for (const tab of tabs) {
      const name = tab.groupName || '未分组'
      const group = groups.get(name) ?? []
      group.push(tab)
      groups.set(name, group)
    }
    return Array.from(groups.entries())
  }, [tabs])

  const refreshStorageState = useCallback(async () => {
    const [summary, hibernated, closed, workspaces] = await Promise.all([
      window.velox.storage.getSummary(),
      window.velox.storage.listHibernated(8),
      window.velox.storage.listClosed(8),
      window.velox.storage.listWorkspaces(8)
    ])
    setStorageSummary(summary)
    setHibernatedTabs(hibernated)
    setClosedTabs(closed)
    setSavedWorkspaces(workspaces)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function initialize() {
      try {
        const [config, tabState, currentSearchEngine] = await Promise.all([
          window.velox.getBackendConfig(),
          window.velox.tabs.getState(),
          window.velox.search.getEngine()
        ])
        const response = await fetch(`${config.baseUrl}/health`)
        if (!response.ok) throw new Error('Backend health check failed')
        if (!cancelled) {
          setBackendUrl(config.baseUrl)
          setBackendState('online')
          setTabs(tabState.tabs)
          setActiveTabId(tabState.activeTabId)
          setSearchEngine(currentSearchEngine)
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
    if (backendState !== 'online') return
    let cancelled = false
    async function refreshStorageLists() {
      try {
        await refreshStorageState()
      } catch {
        if (!cancelled) {
          setClosedTabs([])
        }
      }
    }
    void refreshStorageLists()
    return () => {
      cancelled = true
    }
  }, [backendState, organizeResult])

  useEffect(() => {
    if (backendState !== 'online' || !backendUrl) return
    let cancelled = false
    async function loadAISettings() {
      try {
        const response = await fetch(`${backendUrl}/api/settings/ai`)
        if (!response.ok) throw new Error('无法读取模型设置')
        const settings = await response.json() as Omit<AISettings, 'api_key'>
        if (!cancelled) setAiSettings((current) => ({ ...current, ...settings, api_key: '' }))
      } catch (error) {
        if (!cancelled) setSettingsError(error instanceof Error ? error.message : '无法读取模型设置')
      }
    }
    void loadAISettings()
    return () => {
      cancelled = true
    }
  }, [backendState, backendUrl])

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
      await refreshStorageState()
    } catch (error) {
      setOrganizeError(error instanceof Error ? error.message : '标签整理失败')
    } finally {
      setOrganizeLoading(false)
    }
  }

  async function sendAssistantMessage(rawMessage = assistantInput) {
    const message = rawMessage.trim()
    if (!message || assistantSending) return
    setAssistantMessages((current) => [...current, { role: 'user', content: message }])
    setAssistantInput('')
    setAssistantSending(true)
    setAssistantError('')
    try {
      const config = backendUrl ? { baseUrl: backendUrl } : await window.velox.getBackendConfig()
      const snapshots = await window.velox.tabs.getSnapshots()
      const response = await fetch(`${config.baseUrl}/api/assistant/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          tabs: snapshots.map((tab) => ({
            id: tab.id,
            url: tab.url,
            title: tab.title,
            text: tab.text,
            is_start_page: tab.isStartPage
          })),
          active_tab_id: activeTabId
        })
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || 'AI 助手暂时不可用')
      }
      const result = await response.json() as AssistantResponse
      setAssistantMessages((current) => [
        ...current,
        { role: 'assistant', content: result.answer, suggestions: result.suggestions }
      ])
    } catch (error) {
      setAssistantError(error instanceof Error ? error.message : 'AI 助手暂时不可用')
    } finally {
      setAssistantSending(false)
    }
  }

  async function saveAISettings() {
    if (!backendUrl) return
    setSettingsSaving(true)
    setSettingsError('')
    try {
      const response = await fetch(`${backendUrl}/api/settings/ai`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: aiSettings.mode,
          base_url: aiSettings.base_url,
          model: aiSettings.model,
          api_key: aiSettings.api_key || null
        })
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || '模型设置保存失败')
      }
      const saved = await response.json() as Omit<AISettings, 'api_key'>
      setAiSettings((current) => ({ ...current, ...saved, api_key: '' }))
      setAssistantMessages((current) => [
        ...current,
        { role: 'assistant', content: saved.mode === 'external' ? '外部模型设置已保存，后续消息会使用该 Provider。' : '已切换到本地模式，浏览内容不会发送到外部服务。' }
      ])
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : '模型设置保存失败')
    } finally {
      setSettingsSaving(false)
    }
  }

  async function saveWorkspace() {
    if (!organizeResult) return
    setWorkspaceSaving(true)
    try {
      const name = workspaceName.trim() || organizeResult.groups[0]?.name || '工作区快照'
      const snapshots = await window.velox.tabs.getSnapshots()
      const groupByTabId = new Map(
        organizeResult.groups.flatMap((group) => group.tabs.map((tabId) => [tabId, group.name] as const))
      )
      await window.velox.storage.saveWorkspace({
        name,
        snapshot: organizeResult,
        tabs: snapshots.map((tab) => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          text: tab.text,
          is_start_page: tab.isStartPage,
          group_name: groupByTabId.get(tab.id) ?? null
        })),
        activeTabId
      })
      setWorkspaceName(name)
      await refreshStorageState()
    } finally {
      setWorkspaceSaving(false)
    }
  }

  async function loadWorkspace(recordId: number) {
    setStorageBusy(true)
    try {
      const workspace = await window.velox.storage.getWorkspace(recordId)
      setOrganizeStrategy(workspace.strategy === 'domain' ? 'domain' : 'semantic')
      setOrganizeResult({
        groups: workspace.groups ?? [],
        duplicate_sets: workspace.duplicate_sets ?? [],
        suggested_hibernating: workspace.suggested_hibernating ?? [],
        strategy: workspace.strategy
      })
      if (workspace.tabs?.length) {
        await window.velox.tabs.restoreWorkspace({
          tabs: workspace.tabs,
          activeTabId: workspace.active_tab_id ?? null
        })
      }
      setWorkspaceName(workspace.name)
      setWorkspaceOpen(false)
      setOrganizeOpen(true)
      await refreshStorageState()
    } finally {
      setStorageBusy(false)
    }
  }

  async function hibernateActiveTab(tabId: string) {
    setHibernatingTabId(tabId)
    setStorageBusy(true)
    try {
      await window.velox.tabs.hibernate(tabId, 'manual')
      await refreshStorageState()
    } finally {
      setHibernatingTabId(null)
      setStorageBusy(false)
    }
  }

  async function restoreHibernated(recordId: number) {
    setStorageBusy(true)
    try {
      await window.velox.storage.restoreHibernated(recordId)
      await refreshStorageState()
    } finally {
      setStorageBusy(false)
    }
  }

  async function restoreClosedTab(recordId: number) {
    setStorageBusy(true)
    try {
      await window.velox.storage.restoreClosed(recordId)
      await refreshStorageState()
    } finally {
      setStorageBusy(false)
    }
  }

  async function mergeDuplicateGroup(group: DuplicateGroupPreview) {
    if (group.closeIds.length === 0) return
    setStorageBusy(true)
    try {
      for (const tabId of group.closeIds) {
        await window.velox.tabs.close(tabId, 'duplicate-merge')
      }
      await refreshStorageState()
      await organizeTabs()
    } finally {
      setStorageBusy(false)
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
            {tabGroups.map(([groupName, groupTabs]) => (
              <div className="tab-group" key={groupName}>
                {tabGroups.length > 1 && <div className="tab-group-label">{groupName}</div>}
                {groupTabs.map((tab) => (
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
            ))}
          </div>
        </div>
        {assistantOpen && (
          <section className="assistant-panel">
            <div className="panel-heading">
              <div>
                <strong>Velox AI 助手</strong>
                <span>本地分析当前标签页，不上传浏览内容</span>
              </div>
              <button className="icon-button" type="button" aria-label="关闭 AI 助手" title="关闭" onClick={() => setAssistantOpen(false)}>
                <X size={14} />
              </button>
            </div>
            <div className="assistant-messages">
              {assistantMessages.slice(-8).map((message, index) => (
                <div className={`assistant-message ${message.role}`} key={`${message.role}-${index}-${message.content.slice(0, 12)}`}>
                  <div className="assistant-message-content">{message.content}</div>
                  {message.role === 'assistant' && message.suggestions && message.suggestions.length > 0 && (
                    <div className="assistant-suggestions">
                      {message.suggestions.map((suggestion) => (
                        <button type="button" key={suggestion} disabled={assistantSending} onClick={() => void sendAssistantMessage(suggestion)}>
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {assistantSending && <div className="assistant-message assistant"><div className="assistant-message-content">正在查看当前标签...</div></div>}
            </div>
            {assistantError && <p className="assistant-error">{assistantError}</p>}
            <form className="assistant-input" onSubmit={(event) => { event.preventDefault(); void sendAssistantMessage() }}>
              <input
                value={assistantInput}
                onChange={(event) => setAssistantInput(event.target.value)}
                placeholder="问问当前页面或标签..."
                aria-label="询问 Velox AI 助手"
                disabled={assistantSending}
              />
              <button type="submit" aria-label="发送消息" title="发送" disabled={assistantSending || !assistantInput.trim()}>
                <ArrowRight size={15} />
              </button>
            </form>
          </section>
        )}
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
                <div className="workspace-save">
                  <input
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    placeholder="工作区名称"
                  />
                  <button type="button" onClick={() => void saveWorkspace()} disabled={workspaceSaving}>
                    {workspaceSaving ? '保存中...' : '保存工作区'}
                  </button>
                </div>
                {organizeResult.groups.map((group) => (
                  <div className="result-group" key={group.name}>
                    <div className="result-group-title"><strong>{group.name}</strong><span>{group.tabs.length}</span></div>
                    <p>{group.description}</p>
                  </div>
                ))}
                {duplicateGroups.length > 0 && (
                  <div className="duplicate-list">
                    <div className="hibernate-note">
                      <span>发现 {duplicateGroups.length} 组重复标签</span>
                    </div>
                    {duplicateGroups.map((group) => (
                      <div className="duplicate-item" key={`${group.keepId}-${group.closeIds.join('-')}`}>
                        <div className="duplicate-item-main">
                          <strong>保留 {group.keepLabel}</strong>
                          <span>关闭 {group.closeLabels.join('、')}</span>
                        </div>
                        <button type="button" disabled={storageBusy || group.closeIds.length === 0} onClick={() => void mergeDuplicateGroup(group)}>
                          合并重复
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {organizeResult.suggested_hibernating.length > 0 && (
                  <div className="hibernate-note">
                    <span>建议稍后处理 {organizeResult.suggested_hibernating.length} 个后台标签</span>
                    <div className="hibernate-actions">
                      {organizeResult.suggested_hibernating.slice(0, 3).map((tabId) => (
                        <button key={tabId} type="button" onClick={() => void hibernateActiveTab(tabId)} disabled={storageBusy || hibernatingTabId === tabId}>
                          {hibernatingTabId === tabId ? '处理中...' : `休眠 ${tabId}`}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {storageSummary && (
              <div className="storage-summary">
                <span>快照 {storageSummary.snapshot_count}</span>
                <span>整理 {storageSummary.organize_count}</span>
                <span>休眠 {storageSummary.hibernated_count}</span>
                <span>关闭 {storageSummary.closed_count}</span>
                <span>工作区 {storageSummary.workspace_count}</span>
              </div>
            )}
            {savedWorkspaces.length > 0 && (
              <div className="hibernated-list">
                <div className="hibernated-heading">已保存工作区</div>
                {savedWorkspaces.map((item) => (
                  <button className="hibernated-item" type="button" key={item.id} disabled={storageBusy} onClick={() => void loadWorkspace(item.id)}>
                    <strong>{item.name}</strong>
                    <span>{item.group_count} 组 · {item.duplicate_set_count} 组重复</span>
                  </button>
                ))}
              </div>
            )}
            {hibernatedTabs.length > 0 && (
              <div className="hibernated-list">
                <div className="hibernated-heading">最近休眠</div>
                {hibernatedTabs.map((item) => (
                  <button className="hibernated-item" type="button" key={item.id} disabled={storageBusy} onClick={() => void restoreHibernated(item.id)}>
                    <strong>{item.title || item.url}</strong>
                    <span>{item.reason} · 恢复</span>
                  </button>
                ))}
              </div>
            )}
            {closedTabs.length > 0 && (
              <div className="hibernated-list">
                <div className="hibernated-heading">最近关闭</div>
                {closedTabs.map((item) => (
                  <button className="hibernated-item" type="button" key={item.id} disabled={storageBusy} onClick={() => void restoreClosedTab(item.id)}>
                    <strong>{item.title || item.url}</strong>
                    <span>关闭恢复 · {item.reason}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        {settingsOpen && (
          <section className="settings-panel">
            <div className="panel-heading">
              <div>
                <strong>模型设置</strong>
                <span>选择 Provider，Velox 不替你绑定厂商</span>
              </div>
              <button className="icon-button" type="button" aria-label="关闭模型设置" title="关闭" onClick={() => setSettingsOpen(false)}>
                <X size={14} />
              </button>
            </div>
            <label className="settings-field">
              <span>运行模式</span>
              <select
                value={aiSettings.mode}
                onChange={(event) => setAiSettings((current) => ({ ...current, mode: event.target.value as AISettings['mode'] }))}
              >
                <option value="local">本地模式</option>
                <option value="external">外部模型</option>
              </select>
            </label>
            <label className="settings-field">
              <span>搜索引擎</span>
              <select
                value={searchEngine}
                onChange={(event) => {
                  const engine = event.target.value as SearchEngine
                  setSearchEngine(engine)
                  void window.velox.search.setEngine(engine)
                }}
              >
                <option value="google">Google</option>
                <option value="bing">Bing</option>
                <option value="baidu">百度</option>
                <option value="duckduckgo">DuckDuckGo</option>
              </select>
            </label>
            {aiSettings.mode === 'external' && (
              <>
                <label className="settings-field">
                  <span>Base URL</span>
                  <input
                    value={aiSettings.base_url}
                    onChange={(event) => setAiSettings((current) => ({ ...current, base_url: event.target.value }))}
                    placeholder="例如 https://api.example.com/v1"
                  />
                </label>
                <label className="settings-field">
                  <span>模型名</span>
                  <input
                    value={aiSettings.model}
                    onChange={(event) => setAiSettings((current) => ({ ...current, model: event.target.value }))}
                    placeholder="填写你选择的模型 ID"
                  />
                </label>
                <label className="settings-field">
                  <span>API Key {aiSettings.api_key_configured && <em>已配置</em>}</span>
                  <input
                    type="password"
                    value={aiSettings.api_key}
                    onChange={(event) => setAiSettings((current) => ({ ...current, api_key: event.target.value }))}
                    placeholder={aiSettings.api_key_configured ? '留空以保持现有 Key' : '输入 API Key'}
                  />
                </label>
              </>
            )}
            {settingsError && <p className="settings-error">{settingsError}</p>}
            <button className="settings-save" type="button" onClick={() => void saveAISettings()} disabled={settingsSaving || backendState !== 'online'}>
              {settingsSaving ? '保存中...' : '保存模型设置'}
            </button>
          </section>
        )}
        {workspaceOpen && (
          <section className="workspace-panel">
            <div className="panel-heading">
              <div>
                <strong>工作区</strong>
                <span>恢复之前保存的标签页组合</span>
              </div>
              <button className="icon-button" type="button" aria-label="关闭工作区" title="关闭" onClick={() => setWorkspaceOpen(false)}>
                <X size={14} />
              </button>
            </div>
            <div className="workspace-panel-summary">
              <span>{savedWorkspaces.length} 个最近工作区</span>
              <button type="button" onClick={() => void refreshStorageState()} disabled={storageBusy || backendState !== 'online'}>
                刷新
              </button>
            </div>
            {savedWorkspaces.length > 0 ? (
              <div className="hibernated-list">
                {savedWorkspaces.map((item) => (
                  <button className="hibernated-item" type="button" key={item.id} disabled={storageBusy} onClick={() => void loadWorkspace(item.id)}>
                    <strong>{item.name}</strong>
                    <span>{item.group_count} 组 · {item.duplicate_set_count} 组重复 · {item.updated_at.replace('T', ' ').slice(0, 16)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="workspace-empty">
                <LayoutPanelLeft size={18} />
                <span>还没有保存的工作区</span>
                <small>先打开“整理标签”，分析后即可保存当前标签组合。</small>
              </div>
            )}
          </section>
        )}
        <div className="sidebar-spacer" />
        <div className="sidebar-footer">
          <button className={`footer-button ${organizeOpen ? 'selected' : ''}`} type="button" onClick={() => setOrganizeOpen((open) => !open)}>
            <WandSparkles size={16} /><span>整理标签</span>
          </button>
          <button className={`footer-button ${workspaceOpen ? 'selected' : ''}`} type="button" onClick={() => setWorkspaceOpen((open) => !open)}>
            <LayoutPanelLeft size={16} /><span>工作区</span>
          </button>
          <button className={`footer-button ${settingsOpen ? 'selected' : ''}`} type="button" onClick={() => setSettingsOpen((open) => !open)}>
            <Settings2 size={16} /><span>设置</span>
          </button>
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
          <button className={`ai-button ${assistantOpen ? 'selected' : ''}`} type="button" onClick={() => setAssistantOpen((open) => !open)}>
            <Bot size={17} /><span>AI 助手</span>
          </button>
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
              <button type="button" onClick={() => setAssistantOpen(true)}><Bot size={15} />询问 AI</button>
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
