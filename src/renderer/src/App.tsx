import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Download,
  Globe2,
  History,
  LayoutPanelLeft,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  WandSparkles,
  X
} from 'lucide-react'

type BackendState = 'checking' | 'online' | 'offline'
type OrganizeStrategy = 'semantic' | 'domain'
type SearchEngine = 'google' | 'bing' | 'baidu' | 'duckduckgo'
type StartupPage = 'velox' | 'custom'

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

type SearchAgentPlan = {
  query: string
  engine: SearchEngine
  rationale: string
  action: BrowserAction
}

type SearchAgentResult = {
  answer: string
  sources: string[]
  next_actions: string[]
  provider: string
  comparison_rows?: SearchAgentComparisonRow[]
}

type SearchAgentComparisonRow = {
  source: string
  title: string
  finding: string
  evidence: string
  gaps: string
  confidence: string
}

type SearchAgentSourceNote = {
  url: string
  title: string
  answer: string
}

type SearchAgentRunRecord = {
  id: number
  task: string
  query: string
  source_count: number
  created_at: string
  updated_at: string
}

type SearchAgentRunDetail = SearchAgentRunRecord & {
  sources: SearchAgentSourceNote[]
  synthesis: SearchAgentResult
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
  search_agent_count?: number
  history_count?: number
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

type BrowserHistoryRecord = {
  id: number
  url: string
  title: string
  visit_count: number
  first_visited_at: string
  last_visited_at: string
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

function cleanMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim() || '-'
}

function cleanReportFilename(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70)
  return `${cleaned || 'search-agent-report'}.md`
}

function buildSearchAgentReportMarkdown(payload: {
  task: string
  query: string
  synthesis: SearchAgentResult
  sources: SearchAgentSourceNote[]
  savedId: number | null
}): string {
  const generatedAt = new Date().toLocaleString()
  const lines = [
    `# Velox 搜索代理报告`,
    '',
    `- 任务：${payload.task}`,
    `- 搜索词：${payload.query}`,
    `- 生成时间：${generatedAt}`,
    `- 记录编号：${payload.savedId ? `#${payload.savedId}` : '未保存'}`,
    `- Provider：${payload.synthesis.provider}`,
    '',
    '## 阶段性结论',
    '',
    payload.synthesis.answer.trim() || '暂无结论。',
    '',
  ]

  const comparisonRows = payload.synthesis.comparison_rows ?? []
  if (comparisonRows.length > 0) {
    lines.push(
      '## 来源对比',
      '',
      '| 来源 | 主要发现 | 证据摘要 | 待核验点 | 可信度 |',
      '| --- | --- | --- | --- | --- |',
      ...comparisonRows.map((row) => (
        `| ${cleanMarkdownCell(row.title || row.source)} | ${cleanMarkdownCell(row.finding)} | ${cleanMarkdownCell(row.evidence)} | ${cleanMarkdownCell(row.gaps)} | ${cleanMarkdownCell(row.confidence)} |`
      )),
      '',
    )
  }

  if (payload.sources.length > 0) {
    lines.push('## 来源笔记', '')
    payload.sources.forEach((source, index) => {
      lines.push(
        `### ${index + 1}. ${source.title || source.url}`,
        '',
        `- URL：${source.url}`,
        '',
        source.answer.trim() || '暂无摘录。',
        '',
      )
    })
  }

  if (payload.synthesis.sources.length > 0) {
    lines.push('## 来源链接', '')
    payload.synthesis.sources.forEach((source) => {
      lines.push(`- ${source}`)
    })
    lines.push('')
  }

  return `${lines.join('\n').trim()}\n`
}

function App() {
  const [backendState, setBackendState] = useState<BackendState>('checking')
  const [backendUrl, setBackendUrl] = useState('')
  const [tabs, setTabs] = useState<BrowserTabState[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('velox.sidebarCollapsed') === 'true')
  const [searchEngine, setSearchEngine] = useState<SearchEngine>('google')
  const [startupPage, setStartupPage] = useState<StartupPage>('velox')
  const [startupUrl, setStartupUrl] = useState('')
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
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
  const [searchAgentOpen, setSearchAgentOpen] = useState(false)
  const [searchAgentInput, setSearchAgentInput] = useState('')
  const [searchAgentRunning, setSearchAgentRunning] = useState(false)
  const [searchAgentError, setSearchAgentError] = useState('')
  const [searchAgentStatus, setSearchAgentStatus] = useState('')
  const [searchAgentPlan, setSearchAgentPlan] = useState<SearchAgentPlan | null>(null)
  const [searchAgentResult, setSearchAgentResult] = useState<SearchAgentResult | null>(null)
  const [searchAgentDetail, setSearchAgentDetail] = useState<SearchAgentResult | null>(null)
  const [searchAgentSourceNotes, setSearchAgentSourceNotes] = useState<SearchAgentSourceNote[]>([])
  const [searchAgentSynthesis, setSearchAgentSynthesis] = useState<SearchAgentResult | null>(null)
  const [searchAgentSearchTabId, setSearchAgentSearchTabId] = useState<string | null>(null)
  const [searchAgentHistory, setSearchAgentHistory] = useState<SearchAgentRunRecord[]>([])
  const [searchAgentSavedId, setSearchAgentSavedId] = useState<number | null>(null)
  const [searchAgentExportPath, setSearchAgentExportPath] = useState<string | null>(null)
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
  const [browserHistory, setBrowserHistory] = useState<BrowserHistoryRecord[]>([])
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
  const searchAgentInspectedUrls = useMemo(
    () => new Set(searchAgentSourceNotes.map((source) => source.url)),
    [searchAgentSourceNotes]
  )
  const searchAgentCandidateSources = useMemo(() => {
    const blockedHosts = new Set(['www.google.com', 'google.com', 'www.bing.com', 'bing.com', 'www.baidu.com', 'baidu.com', 'duckduckgo.com'])
    return (searchAgentResult?.sources ?? []).filter((source) => {
      try {
        const url = new URL(source)
        return !blockedHosts.has(url.hostname) && !url.pathname.startsWith('/search')
      } catch {
        return false
      }
    })
  }, [searchAgentResult])

  const refreshSearchAgentHistory = useCallback(async () => {
    if (!backendUrl) return
    const response = await fetch(`${backendUrl}/api/storage/search-agent/runs?limit=6`)
    if (!response.ok) throw new Error('搜索代理历史读取失败')
    const history = await response.json() as SearchAgentRunRecord[]
    setSearchAgentHistory(history)
  }, [backendUrl])

  const refreshStorageState = useCallback(async () => {
    const [summary, hibernated, closed, history, workspaces] = await Promise.all([
      window.velox.storage.getSummary(),
      window.velox.storage.listHibernated(8),
      window.velox.storage.listClosed(8),
      window.velox.storage.listHistory(20),
      window.velox.storage.listWorkspaces(8)
    ])
    setStorageSummary(summary)
    setHibernatedTabs(hibernated)
    setClosedTabs(closed)
    setBrowserHistory(history)
    setSavedWorkspaces(workspaces)
  }, [])

  useEffect(() => {
    localStorage.setItem('velox.sidebarCollapsed', String(sidebarCollapsed))
    void window.velox.layout.setSidebarCollapsed(sidebarCollapsed)
  }, [sidebarCollapsed])

  useEffect(() => {
    let cancelled = false

    async function initialize() {
      try {
        const [config, tabState, currentSearchEngine, currentStartup] = await Promise.all([
          window.velox.getBackendConfig(),
          window.velox.tabs.getState(),
          window.velox.search.getEngine(),
          window.velox.startup.getConfig()
        ])
        const response = await fetch(`${config.baseUrl}/health`)
        if (!response.ok) throw new Error('Backend health check failed')
        if (!cancelled) {
          setBackendUrl(config.baseUrl)
          setBackendState('online')
          setTabs(tabState.tabs)
          setActiveTabId(tabState.activeTabId)
          setSearchEngine(currentSearchEngine)
          setStartupPage(currentStartup.page)
          setStartupUrl(currentStartup.url)
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
    if (backendState !== 'online' || !backendUrl) return
    void refreshSearchAgentHistory().catch(() => {
      setSearchAgentHistory([])
    })
  }, [backendState, backendUrl, refreshSearchAgentHistory])

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
        void closeBrowserTab(activeTabId)
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

  async function closeBrowserTab(tabId: string) {
    try {
      await window.velox.tabs.close(tabId)
    } finally {
      const state = await window.velox.tabs.getState()
      setTabs(state.tabs)
      setActiveTabId(state.activeTabId)
    }
  }

  function toggleSidebarPanel(panel: 'search' | 'organize' | 'workspace' | 'history' | 'settings') {
    const nextSearch = panel === 'search' ? !searchAgentOpen : false
    const nextOrganize = panel === 'organize' ? !organizeOpen : false
    const nextWorkspace = panel === 'workspace' ? !workspaceOpen : false
    const nextHistory = panel === 'history' ? !historyOpen : false
    const nextSettings = panel === 'settings' ? !settingsOpen : false
    setSearchAgentOpen(nextSearch)
    setOrganizeOpen(nextOrganize)
    setWorkspaceOpen(nextWorkspace)
    setHistoryOpen(nextHistory)
    setSettingsOpen(nextSettings)
    if ((nextWorkspace || nextHistory) && backendState === 'online') {
      void refreshStorageState()
    }
  }

  function tabLabel(tab: BrowserTabState): string {
    if (tab.isLoading) return '正在加载...'
    return tab.title || (tab.url ? '未命名页面' : '新标签页')
  }

  async function waitForActivePageSettled(timeoutMs = 8000) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const state = await window.velox.tabs.getState()
      const active = state.tabs.find((tab) => tab.id === state.activeTabId)
      if (active && !active.isStartPage && !active.isLoading) return
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
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

  async function runSearchAgent() {
    const task = searchAgentInput.trim()
    if (!task || searchAgentRunning) return
    setSearchAgentRunning(true)
    setSearchAgentError('')
    setSearchAgentResult(null)
    setSearchAgentDetail(null)
    setSearchAgentSourceNotes([])
    setSearchAgentSynthesis(null)
    setSearchAgentSearchTabId(null)
    setSearchAgentSavedId(null)
    setSearchAgentExportPath(null)
    try {
      const config = backendUrl ? { baseUrl: backendUrl } : await window.velox.getBackendConfig()
      setSearchAgentStatus('规划搜索')
      const planResponse = await fetch(`${config.baseUrl}/api/search-agent/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, engine: searchEngine })
      })
      if (!planResponse.ok) {
        const detail = await planResponse.text()
        throw new Error(detail || '搜索代理规划失败')
      }
      const plan = await planResponse.json() as SearchAgentPlan
      setSearchAgentPlan(plan)
      setSearchAgentStatus('执行搜索')
      await window.velox.agent.executeAction(plan.action)
      await waitForActivePageSettled()
      const searchState = await window.velox.tabs.getState()
      setSearchAgentSearchTabId(searchState.activeTabId)
      setSearchAgentStatus('读取结果页')
      const snapshot = await window.velox.dom.getSnapshot()
      setSearchAgentStatus('生成摘要')
      const resultResponse = await fetch(`${config.baseUrl}/api/search-agent/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, query: plan.query, snapshot })
      })
      if (!resultResponse.ok) {
        const detail = await resultResponse.text()
        throw new Error(detail || '搜索结果分析失败')
      }
      const result = await resultResponse.json() as SearchAgentResult
      setSearchAgentResult(result)
      setSearchAgentStatus('完成')
    } catch (error) {
      setSearchAgentError(error instanceof Error ? error.message : '搜索代理暂时不可用')
      setSearchAgentStatus('')
    } finally {
      setSearchAgentRunning(false)
    }
  }

  async function inspectSearchSource(sourceUrl?: string) {
    const task = searchAgentInput.trim()
    const source = sourceUrl ?? searchAgentCandidateSources.find((candidate) => !searchAgentInspectedUrls.has(candidate)) ?? searchAgentCandidateSources[0]
    if (!task || !source || searchAgentRunning) return
    setSearchAgentRunning(true)
    setSearchAgentError('')
    try {
      const config = backendUrl ? { baseUrl: backendUrl } : await window.velox.getBackendConfig()
      setSearchAgentStatus('打开来源')
      await window.velox.tabs.create(source)
      await waitForActivePageSettled(10000)
      setSearchAgentStatus('提取详情')
      const snapshot = await window.velox.dom.getSnapshot()
      setSearchAgentStatus('分析来源')
      const response = await fetch(`${config.baseUrl}/api/search-agent/inspect-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          query: searchAgentPlan?.query ?? task,
          source_url: source,
          snapshot
        })
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || '来源页面分析失败')
      }
      const result = await response.json() as SearchAgentResult
      setSearchAgentDetail(result)
      setSearchAgentSourceNotes((current) => {
        const note = { url: source, title: snapshot.title || source, answer: result.answer }
        const index = current.findIndex((item) => item.url === source)
        if (index < 0) return [...current, note]
        return current.map((item, itemIndex) => itemIndex === index ? note : item)
      })
      setSearchAgentStatus('完成')
    } catch (error) {
      setSearchAgentError(error instanceof Error ? error.message : '来源页面分析失败')
      setSearchAgentStatus('')
    } finally {
      setSearchAgentRunning(false)
    }
  }

  function handleSearchAgentNextAction(action: string) {
    if (action.includes('打开') && action.includes('搜索结果')) {
      void inspectSearchSource()
      return
    }
    if (action.includes('返回搜索结果页')) {
      if (searchAgentSearchTabId) void window.velox.tabs.activate(searchAgentSearchTabId)
      return
    }
    setSearchAgentInput(action)
  }

  async function synthesizeSearchSources() {
    const task = searchAgentInput.trim()
    if (!task || searchAgentSourceNotes.length === 0 || searchAgentRunning) return
    setSearchAgentRunning(true)
    setSearchAgentError('')
    setSearchAgentExportPath(null)
    try {
      const config = backendUrl ? { baseUrl: backendUrl } : await window.velox.getBackendConfig()
      setSearchAgentStatus('汇总来源')
      const response = await fetch(`${config.baseUrl}/api/search-agent/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          query: searchAgentPlan?.query ?? task,
          sources: searchAgentSourceNotes
        })
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || '来源汇总失败')
      }
      const result = await response.json() as SearchAgentResult
      setSearchAgentSynthesis(result)
      const saveResponse = await fetch(`${config.baseUrl}/api/storage/search-agent/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          query: searchAgentPlan?.query ?? task,
          sources: searchAgentSourceNotes,
          synthesis: result
        })
      })
      if (saveResponse.ok) {
        const saved = await saveResponse.json() as SearchAgentRunRecord
        setSearchAgentSavedId(saved.id)
        await refreshSearchAgentHistory()
      }
      setSearchAgentStatus('完成')
    } catch (error) {
      setSearchAgentError(error instanceof Error ? error.message : '来源汇总失败')
      setSearchAgentStatus('')
    } finally {
      setSearchAgentRunning(false)
    }
  }

  async function loadSearchAgentRun(recordId: number) {
    if (!backendUrl || searchAgentRunning) return
    setSearchAgentRunning(true)
    setSearchAgentError('')
    setSearchAgentExportPath(null)
    try {
      setSearchAgentStatus('读取记录')
      const response = await fetch(`${backendUrl}/api/storage/search-agent/runs/${recordId}`)
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || '搜索代理记录读取失败')
      }
      const record = await response.json() as SearchAgentRunDetail
      setSearchAgentInput(record.task)
      setSearchAgentPlan({
        query: record.query,
        engine: searchEngine,
        rationale: '从历史记录恢复',
        action: { action: 'search', params: { query: record.query, engine: searchEngine } }
      })
      setSearchAgentSourceNotes(record.sources)
      setSearchAgentSynthesis(record.synthesis)
      setSearchAgentDetail(null)
      setSearchAgentResult(null)
      setSearchAgentSavedId(record.id)
      setSearchAgentStatus('完成')
    } catch (error) {
      setSearchAgentError(error instanceof Error ? error.message : '搜索代理记录读取失败')
      setSearchAgentStatus('')
    } finally {
      setSearchAgentRunning(false)
    }
  }

  async function deleteSearchAgentRun(recordId: number) {
    if (!backendUrl || searchAgentRunning) return
    if (!window.confirm('删除这条搜索记录？')) return
    const previousHistory = searchAgentHistory
    const previousSavedId = searchAgentSavedId
    setSearchAgentRunning(true)
    setSearchAgentError('')
    setSearchAgentHistory((current) => current.filter((record) => record.id !== recordId))
    if (searchAgentSavedId === recordId) {
      setSearchAgentSavedId(null)
    }
    try {
      setSearchAgentStatus('删除记录')
      const response = await fetch(`${backendUrl}/api/storage/search-agent/runs/${recordId}`, {
        method: 'DELETE'
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || '搜索代理记录删除失败')
      }
      await refreshSearchAgentHistory()
      setSearchAgentStatus('完成')
    } catch (error) {
      setSearchAgentHistory(previousHistory)
      setSearchAgentSavedId(previousSavedId)
      setSearchAgentError(error instanceof Error ? error.message : '搜索代理记录删除失败')
      setSearchAgentStatus('')
    } finally {
      setSearchAgentRunning(false)
    }
  }

  async function exportSearchAgentReport() {
    const task = searchAgentInput.trim()
    if (!task || !searchAgentSynthesis || searchAgentRunning) return
    setSearchAgentRunning(true)
    setSearchAgentError('')
    setSearchAgentExportPath(null)
    try {
      setSearchAgentStatus('导出报告')
      const query = searchAgentPlan?.query ?? task
      const content = buildSearchAgentReportMarkdown({
        task,
        query,
        synthesis: searchAgentSynthesis,
        sources: searchAgentSourceNotes,
        savedId: searchAgentSavedId
      })
      const result = await window.velox.reports.exportMarkdown({
        defaultFilename: cleanReportFilename(`velox-${task}`),
        content
      })
      if (!result.canceled && result.filePath) {
        setSearchAgentExportPath(result.filePath)
        setSearchAgentStatus('完成')
      } else {
        setSearchAgentStatus('')
      }
    } catch (error) {
      setSearchAgentError(error instanceof Error ? error.message : '搜索代理报告导出失败')
      setSearchAgentStatus('')
    } finally {
      setSearchAgentRunning(false)
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

  async function deleteWorkspace(recordId: number) {
    if (!window.confirm('删除这个已保存工作区？')) return
    const previousWorkspaces = savedWorkspaces
    setStorageBusy(true)
    setSavedWorkspaces((current) => current.filter((workspace) => workspace.id !== recordId))
    try {
      await window.velox.storage.deleteWorkspace(recordId)
      await refreshStorageState()
    } catch (error) {
      setSavedWorkspaces(previousWorkspaces)
      console.warn('Failed to delete workspace', error)
      window.alert(error instanceof Error ? error.message : '工作区删除失败')
    } finally {
      setStorageBusy(false)
    }
  }

  async function openHistoryEntry(url: string) {
    await window.velox.tabs.create(url)
    setHistoryOpen(false)
  }

  async function deleteHistoryEntry(recordId: number) {
    const previousHistory = browserHistory
    setStorageBusy(true)
    setBrowserHistory((current) => current.filter((item) => item.id !== recordId))
    try {
      await window.velox.storage.deleteHistory(recordId)
      await refreshStorageState()
    } catch (error) {
      setBrowserHistory(previousHistory)
      window.alert(error instanceof Error ? error.message : '历史记录删除失败')
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
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Sparkles size={17} /></div>
          <div className="brand-copy"><strong>Velox</strong><span>AI 浏览器</span></div>
          <button
            className="icon-button sidebar-toggle"
            type="button"
            aria-label={sidebarCollapsed ? '展开左侧功能区' : '收起左侧功能区'}
            title={sidebarCollapsed ? '展开左侧功能区' : '收起左侧功能区'}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            <LayoutPanelLeft size={15} />
          </button>
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
                    <button
                      className="tab-close"
                      type="button"
                      aria-label={`关闭${tabLabel(tab)}`}
                      title="关闭标签页"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation()
                        void closeBrowserTab(tab.id)
                      }}
                    >
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
        {searchAgentOpen && (
          <section className="search-agent-panel">
            <div className="panel-heading">
              <div>
                <strong>AI 搜索代理</strong>
                <span>{searchAgentRunning ? searchAgentStatus : '单轮搜索与结果观察'}</span>
              </div>
              <button className="icon-button" type="button" aria-label="关闭搜索代理" title="关闭" onClick={() => setSearchAgentOpen(false)}>
                <X size={14} />
              </button>
            </div>
            <form className="search-agent-form" onSubmit={(event) => { event.preventDefault(); void runSearchAgent() }}>
              <textarea
                value={searchAgentInput}
                onChange={(event) => setSearchAgentInput(event.target.value)}
                placeholder="例如：找 3 个适合 React 状态管理的轻量库"
                aria-label="搜索代理任务"
                disabled={searchAgentRunning}
              />
              <button type="submit" disabled={searchAgentRunning || !searchAgentInput.trim()}>
                <Search size={14} />{searchAgentRunning ? '执行中' : '开始'}
              </button>
            </form>
            {searchAgentError && <p className="search-agent-error">{searchAgentError}</p>}
            {searchAgentPlan && (
              <div className="search-agent-card">
                <span>搜索词</span>
                <strong>{searchAgentPlan.query}</strong>
                <small>{searchAgentPlan.engine} · {searchAgentPlan.rationale}</small>
              </div>
            )}
            {searchAgentResult && (
              <div className="search-agent-result">
                <div className="assistant-message-content">{searchAgentResult.answer}</div>
                {searchAgentCandidateSources.length > 0 && (
                  <div className="search-agent-sources">
                    {searchAgentCandidateSources.slice(0, 5).map((source) => (
                      <button type="button" key={source} onClick={() => void inspectSearchSource(source)} disabled={searchAgentRunning}>
                        {searchAgentInspectedUrls.has(source) ? '已分析 · ' : ''}{source}
                      </button>
                    ))}
                  </div>
                )}
                {searchAgentSourceNotes.length > 0 && (
                  <div className="search-agent-actions">
                    <button type="button" disabled={searchAgentRunning} onClick={() => void inspectSearchSource()}>
                      打开下一个
                    </button>
                    <button type="button" disabled={searchAgentRunning} onClick={() => void synthesizeSearchSources()}>
                      汇总来源
                    </button>
                  </div>
                )}
                {searchAgentResult.next_actions.length > 0 && (
                  <div className="assistant-suggestions">
                    {searchAgentResult.next_actions.map((action) => (
                      <button type="button" key={action} disabled={searchAgentRunning} onClick={() => handleSearchAgentNextAction(action)}>
                        {action}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {searchAgentSourceNotes.length > 0 && (
              <div className="search-agent-card">
                <span>已分析来源</span>
                <strong>{searchAgentSourceNotes.length} 个来源</strong>
                <small>{searchAgentSourceNotes.map((source) => source.title || source.url).join('；')}</small>
              </div>
            )}
            {searchAgentDetail && (
              <div className="search-agent-detail">
                <div className="search-agent-card">
                  <span>来源详情</span>
                  <strong>{searchAgentDetail.provider}</strong>
                </div>
                <div className="assistant-message-content">{searchAgentDetail.answer}</div>
                {searchAgentDetail.sources.length > 0 && (
                  <div className="search-agent-sources">
                    {searchAgentDetail.sources.slice(0, 3).map((source) => (
                      <button type="button" key={source} onClick={() => void window.velox.tabs.create(source)}>
                        {source}
                      </button>
                    ))}
                  </div>
                )}
                {searchAgentDetail.next_actions.length > 0 && (
                  <div className="assistant-suggestions">
                    {searchAgentDetail.next_actions.map((action) => (
                      <button type="button" key={action} disabled={searchAgentRunning} onClick={() => handleSearchAgentNextAction(action)}>
                        {action}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {searchAgentSynthesis && (
              <div className="search-agent-detail">
                <div className="search-agent-card">
                  <span>阶段性结论</span>
                  <strong>{searchAgentSavedId ? `已保存 #${searchAgentSavedId}` : searchAgentSynthesis.provider}</strong>
                </div>
                <div className="assistant-message-content">{searchAgentSynthesis.answer}</div>
                <div className="search-agent-actions search-agent-actions-single">
                  <button type="button" disabled={searchAgentRunning} onClick={() => void exportSearchAgentReport()}>
                    <Download size={13} />
                    导出报告
                  </button>
                </div>
                {searchAgentExportPath && (
                  <p className="search-agent-export-path">已导出：{searchAgentExportPath}</p>
                )}
                {(searchAgentSynthesis.comparison_rows?.length ?? 0) > 0 && (
                  <div className="search-agent-comparison">
                    <div className="hibernated-heading">来源对比</div>
                    {searchAgentSynthesis.comparison_rows?.map((row) => (
                      <div className="search-agent-comparison-row" key={`${row.source}-${row.finding}`}>
                        <button type="button" title={row.source} onClick={() => void window.velox.tabs.create(row.source)}>
                          {row.title || row.source}
                        </button>
                        <dl>
                          <div>
                            <dt>发现</dt>
                            <dd>{row.finding}</dd>
                          </div>
                          <div>
                            <dt>证据</dt>
                            <dd>{row.evidence}</dd>
                          </div>
                          <div>
                            <dt>待核验</dt>
                            <dd>{row.gaps}</dd>
                          </div>
                          <div>
                            <dt>可信度</dt>
                            <dd>{row.confidence}</dd>
                          </div>
                        </dl>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {searchAgentHistory.length > 0 && (
              <div className="search-agent-history">
                <div className="hibernated-heading">搜索记录</div>
                {searchAgentHistory.map((record) => (
                  <div className="search-agent-history-item" key={record.id}>
                    <button className="search-agent-history-main" type="button" disabled={searchAgentRunning} onClick={() => void loadSearchAgentRun(record.id)}>
                      <strong>{record.task}</strong>
                      <span>{record.source_count} 个来源 · {record.updated_at.replace('T', ' ').slice(0, 16)}</span>
                    </button>
                    <button
                      className="icon-button search-agent-history-delete"
                      type="button"
                      aria-label={`删除搜索记录 ${record.id}`}
                      title="删除记录"
                      disabled={searchAgentRunning}
                      onClick={() => void deleteSearchAgentRun(record.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
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
                <span>整理 {storageSummary.organize_count}</span>
                <span>休眠 {storageSummary.hibernated_count}</span>
                <span>工作区 {storageSummary.workspace_count}</span>
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
            <label className="settings-field">
              <span>启动页</span>
              <select
                value={startupPage}
                onChange={(event) => {
                  const page = event.target.value as StartupPage
                  setStartupPage(page)
                  if (page === 'velox') {
                    void window.velox.startup.setConfig({ page, url: '' })
                  }
                }}
              >
                <option value="velox">Velox 新标签页</option>
                <option value="custom">自定义网址</option>
              </select>
            </label>
            {startupPage === 'custom' && (
              <label className="settings-field">
                <span>启动网址</span>
                <input
                  value={startupUrl}
                  onChange={(event) => setStartupUrl(event.target.value)}
                  onBlur={() => {
                    if (startupUrl.trim()) void window.velox.startup.setConfig({ page: 'custom', url: startupUrl })
                  }}
                  placeholder="例如 https://example.com"
                />
              </label>
            )}
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
              <div className="workspace-list">
                {savedWorkspaces.map((item) => (
                  <div className="workspace-item" key={item.id}>
                    <button className="workspace-item-main" type="button" disabled={storageBusy} onClick={() => void loadWorkspace(item.id)}>
                      <strong>{item.name}</strong>
                      <span>{item.group_count} 组 · {item.updated_at.replace('T', ' ').slice(0, 16)}</span>
                    </button>
                    <button
                      className="icon-button workspace-item-delete"
                      type="button"
                      aria-label={`删除工作区 ${item.name}`}
                      title="删除工作区"
                      disabled={storageBusy}
                      onClick={() => void deleteWorkspace(item.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
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
        {historyOpen && (
          <section className="workspace-panel">
            <div className="panel-heading">
              <div>
                <strong>历史记录</strong>
                <span>最近访问过的网页</span>
              </div>
              <button className="icon-button" type="button" aria-label="关闭历史记录" title="关闭" onClick={() => setHistoryOpen(false)}>
                <X size={14} />
              </button>
            </div>
            <div className="workspace-panel-summary">
              <span>{browserHistory.length} 条最近历史</span>
              <button type="button" onClick={() => void refreshStorageState()} disabled={storageBusy || backendState !== 'online'}>
                刷新
              </button>
            </div>
            {browserHistory.length > 0 ? (
              <div className="workspace-list">
                {browserHistory.map((item) => (
                  <div className="workspace-item" key={item.id}>
                    <button className="workspace-item-main" type="button" disabled={storageBusy} onClick={() => void openHistoryEntry(item.url)}>
                      <strong>{item.title || item.url}</strong>
                      <span>{item.visit_count} 次 · {item.last_visited_at.replace('T', ' ').slice(0, 16)}</span>
                    </button>
                    <button
                      className="icon-button workspace-item-delete"
                      type="button"
                      aria-label={`删除历史记录 ${item.title || item.url}`}
                      title="删除历史记录"
                      disabled={storageBusy}
                      onClick={() => void deleteHistoryEntry(item.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="workspace-empty">
                <History size={18} />
                <span>还没有历史记录</span>
                <small>打开网页后，Velox 会自动记录最近访问。</small>
              </div>
            )}
          </section>
        )}
        <div className="sidebar-spacer" />
        <div className="sidebar-footer">
          <button className={`footer-button ${searchAgentOpen ? 'selected' : ''}`} type="button" onClick={() => toggleSidebarPanel('search')}>
            <Search size={16} /><span>搜索代理</span>
          </button>
          <button className={`footer-button ${organizeOpen ? 'selected' : ''}`} type="button" onClick={() => toggleSidebarPanel('organize')}>
            <WandSparkles size={16} /><span>整理标签</span>
          </button>
          <button className={`footer-button ${workspaceOpen ? 'selected' : ''}`} type="button" onClick={() => toggleSidebarPanel('workspace')}>
            <LayoutPanelLeft size={16} /><span>工作区</span>
          </button>
          <button className={`footer-button ${historyOpen ? 'selected' : ''}`} type="button" onClick={() => toggleSidebarPanel('history')}>
            <History size={16} /><span>历史记录</span>
          </button>
          <button className={`footer-button ${settingsOpen ? 'selected' : ''}`} type="button" onClick={() => toggleSidebarPanel('settings')}>
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
            <p className="eyebrow">AI 原生浏览</p>
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
