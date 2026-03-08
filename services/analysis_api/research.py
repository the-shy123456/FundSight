from __future__ import annotations

from collections import Counter
import re


THEME_KEYWORDS = {
    "科技成长": ["ai", "人工智能", "芯片", "半导体", "算力", "云计算", "科技"],
    "红利价值": ["红利", "分红", "价值", "高股息", "央企"],
    "稳健债券": ["债券", "票息", "久期", "利率", "信用债"],
    "消费复苏": ["消费", "零售", "白酒", "旅游", "餐饮"],
}

POSITIVE_KEYWORDS = ["增长", "改善", "修复", "提升", "上调", "增持", "反弹", "景气"]
NEGATIVE_KEYWORDS = ["下滑", "承压", "波动", "回撤", "风险", "减持", "赎回", "不确定"]
SPLIT_PATTERN = re.compile(r"[。！？!?\n]+")


def split_sentences(text: str) -> list[str]:
    return [item.strip() for item in SPLIT_PATTERN.split(text) if item.strip()]


def summarize(text: str, max_sentences: int = 2) -> str:
    sentences = split_sentences(text)
    if not sentences:
        return "未提供研究文本。"
    return "；".join(sentences[:max_sentences])


def detect_themes(text: str) -> list[str]:
    lowered = text.lower()
    counter: Counter[str] = Counter()
    for theme, keywords in THEME_KEYWORDS.items():
        for keyword in keywords:
            if keyword in lowered:
                counter[theme] += 1
    return [theme for theme, _count in counter.most_common(3)]


def keyword_hits(text: str, keywords: list[str]) -> list[str]:
    sentences = split_sentences(text)
    hits: list[str] = []
    for sentence in sentences:
        lowered = sentence.lower()
        if any(keyword in lowered for keyword in keywords):
            hits.append(sentence)
    return hits[:3]


def sentiment_label(text: str) -> str:
    lowered = text.lower()
    positive = sum(lowered.count(keyword) for keyword in POSITIVE_KEYWORDS)
    negative = sum(lowered.count(keyword) for keyword in NEGATIVE_KEYWORDS)
    if positive - negative >= 2:
        return "positive"
    if negative - positive >= 1:
        return "negative"
    return "neutral"


def build_research_brief(text: str) -> dict[str, object]:
    clean_text = text.strip()
    if not clean_text:
        return {
            "summary": "未提供研究文本。",
            "sentiment": "neutral",
            "themes": [],
            "opportunities": [],
            "risks": [],
            "next_actions": ["补充公告、季报或研报原文后再分析。"],
        }

    themes = detect_themes(clean_text)
    opportunities = keyword_hits(clean_text, POSITIVE_KEYWORDS)
    risks = keyword_hits(clean_text, NEGATIVE_KEYWORDS)
    sentiment = sentiment_label(clean_text)

    next_actions = [
        "结合基金近 3 个月净值表现复核文本结论。",
        "检查基金经理近期是否有调仓或风格漂移。",
    ]
    if risks:
        next_actions.append("为负面信号设置观察窗口，避免一次性重仓。")
    else:
        next_actions.append("若基本面和净值动量同步改善，可考虑分批布局。")

    return {
        "summary": summarize(clean_text),
        "sentiment": sentiment,
        "themes": themes,
        "opportunities": opportunities or ["文本中暂无明显正向催化词。"],
        "risks": risks or ["文本中暂无明显负向风险词。"],
        "next_actions": next_actions,
    }
