import os
from datetime import UTC, datetime
from collections import defaultdict
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.app.providers import AssistantContext, AssistantTab, LocalAIProvider, OpenAICompatibleProvider
from backend.app.storage import (
    get_ai_settings,
    list_closed_tabs,
    list_hibernated_tabs,
    get_workspace_snapshot,
    list_summary,
    list_workspace_snapshots,
    restore_closed_tab,
    restore_hibernated_tab,
    save_hibernated_tab,
    save_organize_run,
    save_closed_tab,
    save_workspace_snapshot,
    save_ai_settings,
    save_tab_snapshot,
)

app = FastAPI(title="Velox AI Backend", version="0.1.0", description="Local AI services for Velox Browser.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class TabSnapshot(BaseModel):
    id: str
    url: str = ""
    title: str = ""
    text: str = ""
    is_start_page: bool = False
    group_name: str | None = None


class OrganizeTabsRequest(BaseModel):
    tabs: list[TabSnapshot] = Field(default_factory=list)
    strategy: str = "semantic"
    active_tab_id: str | None = None


class TabGroup(BaseModel):
    name: str
    description: str
    tabs: list[str]


class OrganizeTabsResponse(BaseModel):
    groups: list[TabGroup]
    duplicate_sets: list[list[str]]
    suggested_hibernating: list[str]
    strategy: str


class TabSnapshotSyncRequest(BaseModel):
    tabs: list[TabSnapshot] = Field(default_factory=list)
    active_tab_id: str | None = None


class SnapshotSyncResponse(BaseModel):
    batch_id: str
    captured_at: str
    tab_count: int


class HibernatedTabRequest(BaseModel):
    tab: TabSnapshot
    reason: str = "manual"
    origin_batch_id: str | None = None


class HibernatedTabRecord(BaseModel):
    id: int
    browser_tab_id: str
    url: str
    title: str
    text: str
    reason: str
    origin_batch_id: str | None
    restored_at: str | None
    created_at: str


class ClosedTabRecord(BaseModel):
    id: int
    browser_tab_id: str
    url: str
    title: str
    text: str
    reason: str
    restored_at: str | None
    created_at: str


class WorkspaceSnapshotRecord(BaseModel):
    id: int
    name: str
    strategy: str
    created_at: str
    updated_at: str
    group_count: int
    duplicate_set_count: int


class WorkspaceSnapshotDetail(BaseModel):
    id: int
    name: str
    strategy: str
    created_at: str
    updated_at: str
    groups: list[TabGroup]
    duplicate_sets: list[list[str]]
    suggested_hibernating: list[str]
    tabs: list[TabSnapshot] = Field(default_factory=list)
    active_tab_id: str | None = None


class WorkspaceSnapshotCreate(BaseModel):
    name: str
    snapshot: OrganizeTabsResponse
    tabs: list[TabSnapshot] = Field(default_factory=list)
    active_tab_id: str | None = None


class AssistantRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    tabs: list[TabSnapshot] = Field(default_factory=list)
    active_tab_id: str | None = None


class AssistantResponse(BaseModel):
    answer: str
    suggestions: list[str]
    intent: str
    provider: str
    referenced_tab_ids: list[str]


class AISettingsRequest(BaseModel):
    mode: str = "local"
    base_url: str = ""
    model: str = ""
    api_key: str | None = None
    clear_api_key: bool = False


class AISettingsResponse(BaseModel):
    mode: str
    base_url: str
    model: str
    api_key_configured: bool
    updated_at: str | None


class DomElementInfo(BaseModel):
    id: str
    selector: str
    tag_name: str = Field(alias="tagName")
    text: str
    role: str | None = None
    href: str | None = None
    input_type: str | None = Field(default=None, alias="inputType")
    placeholder: str | None = None
    aria_label: str | None = Field(default=None, alias="ariaLabel")
    rect: dict[str, float]


class DomSnapshotPayload(BaseModel):
    tab_id: str = Field(alias="tabId")
    url: str
    title: str
    text: str
    elements: list[DomElementInfo] = Field(default_factory=list)


class BrowserActionPayload(BaseModel):
    action: str
    params: dict[str, object] = Field(default_factory=dict)


class SearchAgentPlanRequest(BaseModel):
    task: str = Field(min_length=1, max_length=1000)
    engine: str = "google"


class SearchAgentPlanResponse(BaseModel):
    query: str
    engine: str
    rationale: str
    action: BrowserActionPayload


class SearchAgentResultRequest(BaseModel):
    task: str = Field(min_length=1, max_length=1000)
    query: str
    snapshot: DomSnapshotPayload


class SearchAgentResultResponse(BaseModel):
    answer: str
    sources: list[str]
    next_actions: list[str]
    provider: str


GROUP_RULES = (
    ("开发与代码", ("github", "stackoverflow", "stack overflow", "npm", "pypi", "代码", "编程", "api", "sdk")),
    ("文档与学习", ("docs", "documentation", "教程", "指南", "课程", "学习", "reference", "文档")),
    ("新闻与资讯", ("news", "新闻", "资讯", "报道", "博客", "blog")),
    ("购物与产品", ("amazon", "jd.com", "taobao", "淘宝", "京东", "价格", "商品", "购买")),
    ("视频与媒体", ("youtube", "bilibili", "视频", "电影", "音乐", "podcast")),
)


def normalize_url(url: str) -> str:
    parsed = urlparse(url.strip())
    if not parsed.scheme or not parsed.netloc:
        return url.strip().rstrip("/")
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if not key.lower().startswith(("utm_", "ref", "spm"))
    ]
    return urlunparse((
        parsed.scheme.lower(),
        parsed.netloc.lower(),
        parsed.path.rstrip("/") or "/",
        "",
        urlencode(sorted(query)),
        "",
    ))


def compact_text(value: str, limit: int = 120) -> str:
    text = " ".join(value.replace("\n", " ").split())
    return text[:limit].rstrip()


def classify_tab(tab: TabSnapshot) -> str:
    haystack = f"{tab.title} {tab.url} {tab.text}".lower()
    for group_name, keywords in GROUP_RULES:
        if any(keyword in haystack for keyword in keywords):
            return group_name
    hostname = urlparse(tab.url).hostname or "其他页面"
    return hostname.removeprefix("www.").split(".")[0].capitalize() or "其他页面"


def describe_group(group_name: str, tabs: list[TabSnapshot]) -> str:
    titles = [compact_text(tab.title, 42) for tab in tabs if tab.title]
    if titles:
        return "、".join(titles[:2]) + (" 等页面" if len(titles) > 2 else "")
    return f"共 {len(tabs)} 个相关标签页"


def build_search_query(task: str) -> str:
    query = " ".join(task.replace("\n", " ").split())
    prefixes = ("帮我", "请帮我", "搜索", "查找", "找一下", "帮我找", "search for", "find")
    for prefix in prefixes:
        if query.lower().startswith(prefix.lower()):
            query = query[len(prefix):].strip(" ，,。")
    return query[:160] or task.strip()[:160]


def summarize_search_snapshot(task: str, query: str, snapshot: DomSnapshotPayload) -> SearchAgentResultResponse:
    sources: list[str] = []
    for element in snapshot.elements:
        if element.href and element.href.startswith(("http://", "https://")) and element.href not in sources:
            sources.append(element.href)
        if len(sources) >= 5:
            break
    visible_items = [
        element.text for element in snapshot.elements
        if element.text and element.tag_name in {"a", "button"}
    ][:6]
    text_summary = compact_text(snapshot.text, 360)
    answer_parts = [
        f"已根据任务“{task}”搜索“{query}”。",
        f"当前结果页标题：{snapshot.title or '未命名页面'}。",
    ]
    if visible_items:
        answer_parts.append("页面上可见的主要结果包括：" + "；".join(visible_items) + "。")
    elif text_summary:
        answer_parts.append("页面摘要：" + text_summary)
    else:
        answer_parts.append("暂时没有读取到足够的结果页文本，可以等待页面加载完成后再分析。")
    return SearchAgentResultResponse(
        answer="\n".join(answer_parts),
        sources=sources,
        next_actions=["打开一个搜索结果并提取详情", "换一个关键词继续搜索", "用当前结果生成对比表"],
        provider="local-search-agent",
    )


@app.post("/api/tabs/organize", response_model=OrganizeTabsResponse)
async def organize_tabs(request: OrganizeTabsRequest) -> OrganizeTabsResponse:
    if request.strategy not in {"semantic", "domain", "date"}:
        raise HTTPException(status_code=400, detail="strategy must be semantic, domain, or date")

    groups_by_name: dict[str, list[TabSnapshot]] = defaultdict(list)
    normalized_urls: dict[str, list[str]] = defaultdict(list)
    for tab in request.tabs:
        if tab.is_start_page:
            continue
        group_name = classify_tab(tab) if request.strategy != "domain" else (
            (urlparse(tab.url).hostname or "其他页面").removeprefix("www.")
        )
        groups_by_name[group_name].append(tab)
        if tab.url:
            normalized_urls[normalize_url(tab.url)].append(tab.id)

    groups = [
        TabGroup(
            name=name,
            description=describe_group(name, grouped_tabs),
            tabs=[tab.id for tab in grouped_tabs],
        )
        for name, grouped_tabs in sorted(
            groups_by_name.items(),
            key=lambda item: (-len(item[1]), item[0]),
        )
    ]
    duplicate_sets = [
        tab_ids for normalized_url, tab_ids in normalized_urls.items()
        if normalized_url and len(tab_ids) > 1
    ]
    suggested_hibernating = [
        tab.id
        for tab in request.tabs
        if tab.id != request.active_tab_id and not tab.is_start_page
    ]

    response = OrganizeTabsResponse(
        groups=groups,
        duplicate_sets=duplicate_sets,
        suggested_hibernating=suggested_hibernating,
        strategy=request.strategy,
    )
    save_organize_run(
        request.strategy,
        request.active_tab_id,
        request.model_dump(),
        response.model_dump(),
    )
    return response


@app.post("/api/assistant/chat", response_model=AssistantResponse)
async def assistant_chat(request: AssistantRequest) -> AssistantResponse:
    settings = get_ai_settings()
    if settings["mode"] == "external":
        if not settings["base_url"] or not settings["model"] or not settings["api_key"]:
            raise HTTPException(status_code=400, detail="请先完整配置外部模型的 Base URL、模型名和 API Key")
        provider = OpenAICompatibleProvider(
            base_url=settings["base_url"],
            model=settings["model"],
            api_key=settings["api_key"],
        )
    else:
        provider = LocalAIProvider()
    try:
        reply = await provider.chat(
        AssistantContext(
            message=request.message,
            tabs=[
                AssistantTab(
                    id=tab.id,
                    title=tab.title,
                    url=tab.url,
                    text=tab.text,
                    is_start_page=tab.is_start_page,
                )
                for tab in request.tabs
            ],
            active_tab_id=request.active_tab_id,
        )
        )
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return AssistantResponse(
        answer=reply.answer,
        suggestions=reply.suggestions,
        intent=reply.intent,
        provider=reply.provider,
        referenced_tab_ids=reply.referenced_tab_ids,
    )


@app.post("/api/search-agent/plan", response_model=SearchAgentPlanResponse)
async def plan_search_agent(request: SearchAgentPlanRequest) -> SearchAgentPlanResponse:
    if request.engine not in {"google", "bing", "baidu", "duckduckgo"}:
        raise HTTPException(status_code=400, detail="unsupported search engine")
    query = build_search_query(request.task)
    return SearchAgentPlanResponse(
        query=query,
        engine=request.engine,
        rationale="先执行一次搜索并观察结果页，再决定是否需要打开具体来源。",
        action=BrowserActionPayload(
            action="search",
            params={"query": query, "engine": request.engine},
        ),
    )


@app.post("/api/search-agent/summarize", response_model=SearchAgentResultResponse)
async def summarize_search_agent(request: SearchAgentResultRequest) -> SearchAgentResultResponse:
    settings = get_ai_settings()
    if settings["mode"] == "external" and settings["base_url"] and settings["model"] and settings["api_key"]:
        provider = OpenAICompatibleProvider(
            base_url=settings["base_url"],
            model=settings["model"],
            api_key=settings["api_key"],
        )
        try:
            reply = await provider.chat(
                AssistantContext(
                    message=(
                        "请根据当前搜索结果页，简洁总结已经看到的信息，列出可用来源，"
                        "并说明下一步应该打开哪些结果继续核验。\n"
                        f"用户任务：{request.task}\n搜索词：{request.query}"
                    ),
                    tabs=[
                        AssistantTab(
                            id=request.snapshot.tab_id,
                            title=request.snapshot.title,
                            url=request.snapshot.url,
                            text=request.snapshot.text,
                            is_start_page=False,
                        )
                    ],
                    active_tab_id=request.snapshot.tab_id,
                )
            )
            return SearchAgentResultResponse(
                answer=reply.answer,
                sources=[
                    element.href for element in request.snapshot.elements
                    if element.href and element.href.startswith(("http://", "https://"))
                ][:5],
                next_actions=reply.suggestions or ["打开一个搜索结果并提取详情"],
                provider=reply.provider,
            )
        except RuntimeError:
            return summarize_search_snapshot(request.task, request.query, request.snapshot)
    return summarize_search_snapshot(request.task, request.query, request.snapshot)


@app.get("/api/settings/ai", response_model=AISettingsResponse)
async def get_ai_settings_endpoint() -> AISettingsResponse:
    settings = get_ai_settings()
    return AISettingsResponse(
        mode=settings["mode"],
        base_url=settings["base_url"],
        model=settings["model"],
        api_key_configured=bool(settings["api_key"]),
        updated_at=settings["updated_at"],
    )


@app.put("/api/settings/ai", response_model=AISettingsResponse)
async def update_ai_settings(request: AISettingsRequest) -> AISettingsResponse:
    if request.mode not in {"local", "external"}:
        raise HTTPException(status_code=400, detail="mode must be local or external")
    if request.mode == "external" and (not request.base_url.strip() or not request.model.strip()):
        raise HTTPException(status_code=400, detail="外部模式需要填写 Base URL 和模型名")
    saved = save_ai_settings(
        mode=request.mode,
        base_url=request.base_url.strip(),
        model=request.model.strip(),
        api_key=request.api_key,
        clear_api_key=request.clear_api_key,
    )
    return AISettingsResponse(
        mode=saved["mode"],
        base_url=saved["base_url"],
        model=saved["model"],
        api_key_configured=bool(saved["api_key"]),
        updated_at=saved["updated_at"],
    )


@app.post("/api/storage/tabs/snapshot", response_model=SnapshotSyncResponse)
async def sync_tab_snapshot(request: TabSnapshotSyncRequest) -> SnapshotSyncResponse:
    result = save_tab_snapshot(
        [tab.model_dump() for tab in request.tabs],
        request.active_tab_id,
    )
    return SnapshotSyncResponse(**result)


@app.post("/api/storage/tabs/hibernate")
async def hibernate_tab(request: HibernatedTabRequest) -> dict[str, str | int | None]:
    result = save_hibernated_tab(request.tab.model_dump(), request.reason, request.origin_batch_id)
    return {"status": "ok", **result}


@app.get("/api/storage/hibernated", response_model=list[HibernatedTabRecord])
async def list_hibernated(limit: int = 20) -> list[HibernatedTabRecord]:
    return [HibernatedTabRecord(**record) for record in list_hibernated_tabs(limit)]


@app.post("/api/storage/hibernated/{record_id}/restore", response_model=HibernatedTabRecord)
async def restore_hibernated(record_id: int) -> HibernatedTabRecord:
    record = restore_hibernated_tab(record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Hibernated tab not found")
    return HibernatedTabRecord(**record)


@app.get("/api/storage/summary")
async def storage_summary() -> dict[str, object]:
    return list_summary()


@app.post("/api/storage/tabs/closed")
async def close_tab_record(request: HibernatedTabRequest) -> dict[str, str | int | None]:
    result = save_closed_tab(request.tab.model_dump(), request.reason)
    return {"status": "ok", **result}


@app.get("/api/storage/closed", response_model=list[ClosedTabRecord])
async def list_closed(limit: int = 20) -> list[ClosedTabRecord]:
    return [ClosedTabRecord(**record) for record in list_closed_tabs(limit)]


@app.post("/api/storage/closed/{record_id}/restore", response_model=ClosedTabRecord)
async def restore_closed(record_id: int) -> ClosedTabRecord:
    record = restore_closed_tab(record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Closed tab not found")
    return ClosedTabRecord(**record)


@app.post("/api/storage/workspaces/save", response_model=WorkspaceSnapshotRecord)
async def save_workspace(request: WorkspaceSnapshotCreate) -> WorkspaceSnapshotRecord:
    saved = save_workspace_snapshot(
        name=request.name,
        strategy=request.snapshot.strategy,
        organize_payload={
            **request.snapshot.model_dump(),
            "tabs": [tab.model_dump() for tab in request.tabs],
            "active_tab_id": request.active_tab_id,
        },
    )
    return WorkspaceSnapshotRecord(
        **saved,
        group_count=len(request.snapshot.groups),
        duplicate_set_count=len(request.snapshot.duplicate_sets),
    )


@app.get("/api/storage/workspaces", response_model=list[WorkspaceSnapshotRecord])
async def list_workspaces(limit: int = 20) -> list[WorkspaceSnapshotRecord]:
    return [WorkspaceSnapshotRecord(**record) for record in list_workspace_snapshots(limit)]


@app.get("/api/storage/workspaces/{record_id}", response_model=WorkspaceSnapshotDetail)
async def get_workspace(record_id: int) -> WorkspaceSnapshotDetail:
    record = get_workspace_snapshot(record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Workspace snapshot not found")
    return WorkspaceSnapshotDetail(**record)


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "velox-ai-backend",
        "python": "3.13",
        "timestamp": datetime.now(UTC).isoformat(),
    }

@app.get("/api/meta")
async def meta() -> dict[str, str | None]:
    return {
        "name": "Velox Browser",
        "version": "0.1.0",
        "backend_port": os.getenv("VELOX_BACKEND_PORT"),
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.app.main:app", host="127.0.0.1", port=int(os.getenv("VELOX_BACKEND_PORT", "18765")))
