import os
from datetime import UTC, datetime
from collections import defaultdict
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.app.providers import AssistantContext, AssistantTab, LocalAIProvider
from backend.app.storage import (
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

assistant_provider = LocalAIProvider()


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
    reply = await assistant_provider.chat(
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
    return AssistantResponse(
        answer=reply.answer,
        suggestions=reply.suggestions,
        intent=reply.intent,
        provider=reply.provider,
        referenced_tab_ids=reply.referenced_tab_ids,
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
