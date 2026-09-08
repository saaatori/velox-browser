from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse


@dataclass(frozen=True)
class AssistantTab:
    id: str
    title: str
    url: str
    text: str
    is_start_page: bool = False


@dataclass(frozen=True)
class AssistantContext:
    message: str
    tabs: list[AssistantTab]
    active_tab_id: str | None


@dataclass(frozen=True)
class AssistantReply:
    answer: str
    suggestions: list[str]
    intent: str
    provider: str
    referenced_tab_ids: list[str]


class AIProvider(Protocol):
    async def chat(self, context: AssistantContext) -> AssistantReply:
        ...


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


def tab_label(tab: AssistantTab) -> str:
    return tab.title.strip() or tab.url.strip() or "未命名页面"


def compact_text(value: str, limit: int = 180) -> str:
    text = " ".join(value.replace("\n", " ").split())
    return text[:limit].rstrip()


class LocalAIProvider:
    """Deterministic local provider used until a remote/local model is configured."""

    provider_name = "local-heuristic"

    async def chat(self, context: AssistantContext) -> AssistantReply:
        message = context.message.strip()
        message_lower = message.lower()
        tabs = [tab for tab in context.tabs if not tab.is_start_page and tab.url]
        active = next((tab for tab in tabs if tab.id == context.active_tab_id), None)
        referenced = [active.id] if active else []

        if any(keyword in message_lower for keyword in ("整理", "分组", "归类", "organize", "group")):
            return self._organize_reply(tabs)
        if any(keyword in message_lower for keyword in ("重复", "duplicate", "相同")):
            return self._duplicate_reply(tabs)
        if any(keyword in message_lower for keyword in ("休眠", "后台", "hibernate", "不活跃")):
            return self._hibernate_reply(tabs, context.active_tab_id)
        if any(keyword in message_lower for keyword in ("当前", "这个页面", "本页", "active", "summarize", "总结")):
            return self._active_reply(active, referenced)
        if any(keyword in message_lower for keyword in ("标签", "tab", "打开了什么", "有哪些页面")):
            return self._tabs_reply(tabs)
        return self._overview_reply(tabs, active, referenced)

    def _organize_reply(self, tabs: list[AssistantTab]) -> AssistantReply:
        if not tabs:
            answer = "现在没有可整理的网页标签。你可以先打开几个页面，再让我按主题或域名分组。"
        else:
            answer = f"我看到 {len(tabs)} 个网页标签，适合先按主题整理。我可以识别开发、文档、资讯、购物和媒体等常见主题，并把结果交给“整理标签”面板确认。"
        return AssistantReply(
            answer=answer,
            suggestions=["按主题整理标签", "检查重复标签", "建议休眠后台标签"],
            intent="organize",
            provider=self.provider_name,
            referenced_tab_ids=[tab.id for tab in tabs],
        )

    def _duplicate_reply(self, tabs: list[AssistantTab]) -> AssistantReply:
        groups: dict[str, list[AssistantTab]] = {}
        for tab in tabs:
            groups.setdefault(normalize_url(tab.url), []).append(tab)
        duplicates = [group for group in groups.values() if len(group) > 1]
        if not duplicates:
            answer = "当前没有发现相同 URL 的重复标签。整理面板还会自动忽略常见的追踪参数后再检查一次。"
            ids: list[str] = []
        else:
            labels = ["、".join(tab_label(tab) for tab in group[:3]) for group in duplicates[:3]]
            answer = f"发现 {len(duplicates)} 组重复标签：{'；'.join(labels)}。你可以打开“整理标签”面板逐组合并。"
            ids = [tab.id for group in duplicates for tab in group]
        return AssistantReply(
            answer=answer,
            suggestions=["打开整理标签", "建议休眠后台标签"],
            intent="duplicates",
            provider=self.provider_name,
            referenced_tab_ids=ids,
        )

    def _hibernate_reply(self, tabs: list[AssistantTab], active_tab_id: str | None) -> AssistantReply:
        candidates = [tab for tab in tabs if tab.id != active_tab_id]
        if not candidates:
            answer = "目前只有当前页面，没有适合休眠的后台标签。"
        else:
            labels = "、".join(tab_label(tab) for tab in candidates[:4])
            answer = f"建议优先处理 {len(candidates)} 个后台标签，例如：{labels}。休眠会保留 URL 和摘要，之后可以从“最近休眠”恢复。"
        return AssistantReply(
            answer=answer,
            suggestions=["打开整理标签", "查看当前标签"],
            intent="hibernate",
            provider=self.provider_name,
            referenced_tab_ids=[tab.id for tab in candidates],
        )

    def _active_reply(self, active: AssistantTab | None, referenced: list[str]) -> AssistantReply:
        if active is None:
            answer = "当前没有正在浏览的网页。先打开一个页面，我就能读取它的标题、网址和可见摘要。"
        else:
            summary = compact_text(active.text)
            answer = f"当前页面是“{tab_label(active)}”。\n网址：{active.url}"
            if summary:
                answer += f"\n页面摘要：{summary}"
            else:
                answer += "\n暂时没有读取到页面摘要，可以刷新页面后再试。"
        return AssistantReply(
            answer=answer,
            suggestions=["总结当前页面", "按主题整理标签", "建议休眠后台标签"],
            intent="active_page",
            provider=self.provider_name,
            referenced_tab_ids=referenced,
        )

    def _tabs_reply(self, tabs: list[AssistantTab]) -> AssistantReply:
        if not tabs:
            answer = "当前没有打开的网页标签。"
        else:
            items = [f"{index}. {tab_label(tab)}\n   {tab.url}" for index, tab in enumerate(tabs[:8], 1)]
            suffix = f"\n还有 {len(tabs) - 8} 个标签未展开。" if len(tabs) > 8 else ""
            answer = f"当前打开了 {len(tabs)} 个网页标签：\n" + "\n".join(items) + suffix
        return AssistantReply(
            answer=answer,
            suggestions=["总结当前页面", "检查重复标签", "按主题整理标签"],
            intent="tabs_overview",
            provider=self.provider_name,
            referenced_tab_ids=[tab.id for tab in tabs],
        )

    def _overview_reply(
        self,
        tabs: list[AssistantTab],
        active: AssistantTab | None,
        referenced: list[str],
    ) -> AssistantReply:
        active_label = f"当前页面是“{tab_label(active)}”" if active else "当前还没有活动网页"
        answer = (
            f"{active_label}，我可以查看当前标签上下文。"
            f"现在共有 {len(tabs)} 个网页标签。你可以让我总结当前页面、列出标签、检查重复页面，或建议哪些后台标签适合休眠。"
        )
        return AssistantReply(
            answer=answer,
            suggestions=["总结当前页面", "列出所有标签", "检查重复标签"],
            intent="overview",
            provider=self.provider_name,
            referenced_tab_ids=referenced,
        )
