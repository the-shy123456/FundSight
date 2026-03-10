from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
import html
import json
import re
import ssl
import time
from typing import Any
import urllib.parse
import urllib.request

from .models import FundProfile


HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    "Referer": "https://fund.eastmoney.com/",
}
CACHE: dict[tuple[str, str], tuple[float, Any]] = {}
DEFAULT_REAL_FUND_CODES = ("005827", "161725", "002190")
THEME_RULES = (
    ("白酒", "白酒消费"),
    ("酒", "白酒消费"),
    ("新能源", "新能源"),
    ("纳斯达克", "美股科技"),
    ("半导体", "半导体"),
    ("医药", "医药创新"),
    ("红利", "红利价值"),
    ("蓝筹", "蓝筹价值"),
    ("科技", "科技成长"),
    ("债", "稳健收益"),
)


class RealFundDataError(RuntimeError):
    pass


def clamp(value: float, floor: float, ceiling: float) -> float:
    return max(floor, min(ceiling, value))


def is_real_fund_code(fund_code: str) -> bool:
    return bool(re.fullmatch(r"\d{6}", fund_code.strip()))


def _cache_get(namespace: str, key: str, ttl_seconds: int) -> Any | None:
    cached = CACHE.get((namespace, key))
    if cached is None:
        return None
    if time.time() - cached[0] > ttl_seconds:
        CACHE.pop((namespace, key), None)
        return None
    return cached[1]


def _cache_set(namespace: str, key: str, value: Any) -> Any:
    CACHE[(namespace, key)] = (time.time(), value)
    return value


def _is_trading_time_cn(now: datetime) -> bool:
    if now.tzinfo is None:
        cn_now = now + timedelta(hours=8)
    else:
        cn_now = now.astimezone(timezone(timedelta(hours=8)))
    if cn_now.weekday() >= 5:
        return False
    minutes = cn_now.hour * 60 + cn_now.minute
    return (9 * 60 + 30 <= minutes <= 11 * 60 + 30) or (13 * 60 <= minutes <= 15 * 60)


def _fetch_text(url: str, ttl_seconds: int = 300, referer: str = "https://fund.eastmoney.com/") -> str:
    cached = _cache_get("text", url, ttl_seconds)
    if cached is not None:
        return cached

    request = urllib.request.Request(url, headers={**HTTP_HEADERS, "Referer": referer})
    context = ssl.create_default_context()
    try:
        with urllib.request.urlopen(request, context=context, timeout=20) as response:
            text = response.read().decode("utf-8", "ignore")
    except Exception as error:  # noqa: BLE001
        raise RealFundDataError(f"真实数据请求失败：{url}") from error
    return _cache_set("text", url, text)


def _fetch_json(url: str, ttl_seconds: int = 300, referer: str = "https://fund.eastmoney.com/") -> dict[str, Any]:
    return json.loads(_fetch_text(url, ttl_seconds=ttl_seconds, referer=referer))


def _extract_js_literal(source: str, name: str) -> str | None:
    match = re.search(rf"var\s+{re.escape(name)}\s*=\s*", source)
    if match is None:
        return None

    index = match.end()
    while index < len(source) and source[index].isspace():
        index += 1
    if index >= len(source):
        return None

    opening = source[index]
    if opening in {'"', "'"}:
        quote = opening
        cursor = index + 1
        escaped = False
        while cursor < len(source):
            char = source[cursor]
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                return source[index : cursor + 1]
            cursor += 1
        return None

    if opening in {"[", "{"}:
        stack = [opening]
        cursor = index + 1
        quote: str | None = None
        escaped = False
        pairs = {"[": "]", "{": "}"}
        while cursor < len(source):
            char = source[cursor]
            if quote is not None:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
            else:
                if char in {'"', "'"}:
                    quote = char
                elif char in pairs:
                    stack.append(char)
                elif char in {"]", "}"}:
                    opening_char = stack.pop()
                    if pairs[opening_char] != char:
                        raise RealFundDataError(f"解析 {name} 时括号不匹配")
                    if not stack:
                        return source[index : cursor + 1]
            cursor += 1
        return None

    cursor = index
    while cursor < len(source) and source[cursor] != ";":
        cursor += 1
    return source[index:cursor].strip()


def _parse_js_value(source: str, name: str, default: Any = None) -> Any:
    literal = _extract_js_literal(source, name)
    if literal is None:
        return default
    literal = literal.strip()
    if not literal:
        return default
    if literal[0] in {'"', "'"}:
        return json.loads(literal.replace("'", '"'))
    if literal[0] in {"[", "{"}:
        return json.loads(literal)
    if literal in {"true", "false", "null"}:
        return json.loads(literal)
    try:
        return float(literal) if "." in literal else int(literal)
    except ValueError:
        return literal


def _parse_work_time_years(work_time: str) -> float:
    year_match = re.search(r"(\d+)年", work_time)
    day_match = re.search(r"(\d+)天", work_time)
    years = float(year_match.group(1)) if year_match else 0.0
    days = float(day_match.group(1)) if day_match else 0.0
    return round(years + days / 365, 2)


def _infer_category(name: str, stock_position_ratio: float) -> str:
    if "QDII" in name:
        return "QDII"
    if "债" in name:
        return "债券型"
    if "指数" in name or "ETF联接" in name or "LOF" in name:
        return "指数型"
    if "混合" in name:
        return "混合型"
    if stock_position_ratio >= 0.75:
        return "股票型"
    return "混合型"


def _infer_risk_level(category: str, stock_position_ratio: float) -> str:
    if category == "债券型":
        return "low"
    if category == "QDII":
        return "high"
    if category in {"股票型", "指数型"} or stock_position_ratio >= 0.75:
        return "high"
    if stock_position_ratio >= 0.35:
        return "medium"
    return "low"


def _infer_theme(name: str) -> str:
    for keyword, theme in THEME_RULES:
        if keyword in name:
            return theme
    return "均衡成长"

def _parse_nav_history(pingzhong_source: str, max_points: int = 12) -> tuple[float, ...]:
    net_worth_trend = _parse_js_value(pingzhong_source, "Data_netWorthTrend", [])
    values = [float(item.get("y", 0.0)) for item in net_worth_trend if float(item.get("y", 0.0)) > 0]
    if len(values) >= max_points:
        return tuple(round(value, 4) for value in values[-max_points:])
    return tuple(round(value, 4) for value in values)


def _parse_stock_position_ratio(pingzhong_source: str) -> float:
    positions = _parse_js_value(pingzhong_source, "Data_fundSharesPositions", [])
    if positions:
        latest = positions[-1]
        if isinstance(latest, list) and len(latest) >= 2:
            return round(float(latest[1]) / 100, 4)

    allocation = _parse_js_value(pingzhong_source, "Data_assetAllocation", {})
    if isinstance(allocation, dict):
        for series in allocation.get("series", []):
            if series.get("name") == "股票占净比" and series.get("data"):
                return round(float(series["data"][-1]) / 100, 4)
    return 0.0


def fetch_pingzhong_source(fund_code: str) -> str:
    if not is_real_fund_code(fund_code):
        raise RealFundDataError(f"不是合法基金代码：{fund_code}")
    return _fetch_text(
        f"https://fund.eastmoney.com/pingzhongdata/{fund_code}.js",
        ttl_seconds=900,
        referer=f"https://fund.eastmoney.com/{fund_code}.html",
    )


def build_real_fund_profile(fund_code: str) -> FundProfile:
    cache_key = fund_code.strip()
    cached = _cache_get("profile", cache_key, 900)
    if cached is not None:
        return cached

    source = fetch_pingzhong_source(cache_key)
    name = str(_parse_js_value(source, "fS_name", cache_key))
    fee_rate = round(float(_parse_js_value(source, "fund_Rate", 0.15)) / 100, 4)
    manager_items = _parse_js_value(source, "Data_currentFundManager", [])
    manager_name = "未知"
    manager_tenure_years = 1.0
    if manager_items:
        manager_name = str(manager_items[0].get("name", "未知"))
        manager_tenure_years = max(_parse_work_time_years(str(manager_items[0].get("workTime", "1年"))), 1.0)

    stock_position_ratio = _parse_stock_position_ratio(source)
    category = _infer_category(name, stock_position_ratio)
    risk_level = _infer_risk_level(category, stock_position_ratio)
    nav_history = _parse_nav_history(source)
    if len(nav_history) < 4:
        raise RealFundDataError(f"基金 {fund_code} 的净值历史不足")

    profile = FundProfile(
        fund_id=cache_key,
        name=name,
        category=category,
        risk_level=risk_level,
        manager=manager_name,
        manager_tenure_years=manager_tenure_years,
        fee_rate=fee_rate,
        theme=_infer_theme(name),
        nav_history=nav_history,
    )
    return _cache_set("profile", cache_key, profile)


def build_default_real_funds() -> tuple[FundProfile, ...]:
    return tuple(build_real_fund_profile(code) for code in DEFAULT_REAL_FUND_CODES)


def fetch_fund_estimate(fund_code: str) -> dict[str, Any]:
    cache_key = fund_code.strip()
    ttl_seconds = 15 if _is_trading_time_cn(datetime.utcnow()) else 300
    cached = _cache_get("estimate", cache_key, ttl_seconds)
    if cached is not None:
        return cached

    text = _fetch_text(
        f"https://fundgz.1234567.com.cn/js/{cache_key}.js?rt={int(time.time() * 1000)}",
        ttl_seconds=ttl_seconds,
        referer=f"https://fund.eastmoney.com/{cache_key}.html",
    )
    match = re.search(r"jsonpgz\((\{.*\})\);", text)
    if match is None:
        raise RealFundDataError(f"基金 {fund_code} 的实时估值格式异常")
    payload = json.loads(match.group(1))
    payload["estimated_return"] = round(float(payload.get("gszzl", 0.0)) / 100, 4)
    payload["latest_nav"] = round(float(payload.get("dwjz", 0.0)), 4)
    payload["estimated_nav"] = round(float(payload.get("gsz", payload.get("dwjz", 0.0))), 4)
    return _cache_set("estimate", cache_key, payload)


def _extract_apidata_content(source: str) -> str:
    match = re.search(r'content:\"(.*?)\",arryear:', source, re.S)
    if match is None:
        return ""
    return html.unescape(json.loads(f'"{match.group(1)}"'))


def fetch_top_holdings(fund_code: str, topline: int = 10) -> dict[str, Any]:
    cache_key = f"{fund_code}:{topline}"
    cached = _cache_get("holdings", cache_key, 3600)
    if cached is not None:
        return cached

    source = _fetch_text(
        f"https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code={urllib.parse.quote(fund_code)}&topline={topline}",
        ttl_seconds=900,
        referer=f"https://fundf10.eastmoney.com/ccmx_{fund_code}.html",
    )
    html_text = _extract_apidata_content(source)
    freshness_match = re.search(r"截止至：<font class='px12'>([^<]+)</font>", html_text)
    disclosure_date = freshness_match.group(1) if freshness_match else ""
    rows = re.findall(r"<tr>(.*?)</tr>", html_text, re.S)
    items: list[dict[str, Any]] = []
    for row in rows:
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        if len(cells) < 9:
            continue
        secid_match = re.search(r"unify/r/([0-9.]+)", row)
        code = re.sub(r"<.*?>", "", cells[1]).strip()
        name = re.sub(r"<.*?>", "", cells[2]).strip()
        weight_text = re.sub(r"<.*?>", "", cells[6]).replace("%", "").strip()
        try:
            weight_percent = float(weight_text)
        except ValueError:
            continue
        items.append(
            {
                "code": code,
                "name": name,
                "secid": secid_match.group(1) if secid_match else "",
                "weight_percent": weight_percent,
            }
        )
    payload = {"disclosure_date": disclosure_date, "items": items}
    return _cache_set("holdings", cache_key, payload)

def fetch_security_quote(secid: str) -> dict[str, Any]:
    if not secid:
        raise RealFundDataError("缺少 secid，无法拉取行情")
    cache_key = secid.strip()
    cached = _cache_get("quote", cache_key, 60)
    if cached is not None:
        return cached

    data = _fetch_json(
        f"https://push2.eastmoney.com/api/qt/stock/get?secid={urllib.parse.quote(cache_key)}&fields=f57,f58,f43,f59,f169,f170",
        ttl_seconds=30,
        referer="https://quote.eastmoney.com/",
    ).get("data")
    if not isinstance(data, dict):
        raise RealFundDataError(f"证券 {secid} 的行情数据为空")

    decimals = int(data.get("f59") or 2)
    scale = 10**decimals
    quote = {
        "code": str(data.get("f57", "")),
        "name": str(data.get("f58", "")),
        "price": round(float(data.get("f43") or 0.0) / scale, decimals),
        "change_amount": round(float(data.get("f169") or 0.0) / scale, decimals),
        "change_rate": round(float(data.get("f170") or 0.0) / 10000, 4),
    }
    return _cache_set("quote", cache_key, quote)


def _build_confidence(
    disclosed_weight_ratio: float,
    stock_position_ratio: float,
    disclosure_date: str,
    official_return: float,
    penetration_return: float,
) -> dict[str, Any]:
    coverage_ratio = disclosed_weight_ratio / stock_position_ratio if stock_position_ratio > 0 else disclosed_weight_ratio
    freshness_days = 90
    if disclosure_date:
        try:
            freshness_days = max((date.today() - datetime.strptime(disclosure_date, "%Y-%m-%d").date()).days, 0)
        except ValueError:
            freshness_days = 90

    freshness_penalty = min(freshness_days / 240, 0.25)
    gap_penalty = min(abs(official_return - penetration_return) * 8, 0.16)
    confidence_score = clamp(0.55 + min(coverage_ratio, 1.0) * 0.22 - freshness_penalty - gap_penalty, 0.38, 0.86)
    label = "高" if confidence_score >= 0.75 else "中" if confidence_score >= 0.58 else "低"
    return {
        "score": round(confidence_score, 2),
        "label": label,
        "reason": f"最近披露日期 {disclosure_date or '未知'}，前十大持仓覆盖约 {disclosed_weight_ratio * 100:.1f}% 净值，估值偏差已做折中。",
    }


def estimate_real_fund_intraday(fund: FundProfile) -> dict[str, Any]:
    estimate = fetch_fund_estimate(fund.fund_id)
    holdings_payload = fetch_top_holdings(fund.fund_id)
    stock_position_ratio = _parse_stock_position_ratio(fetch_pingzhong_source(fund.fund_id))
    holdings = holdings_payload["items"]

    quotes: dict[str, dict[str, Any]] = {}
    secids = [item["secid"] for item in holdings if item["secid"]]
    if secids:
        with ThreadPoolExecutor(max_workers=min(6, len(secids))) as executor:
            for secid, quote in zip(secids, executor.map(fetch_security_quote, secids), strict=True):
                quotes[secid] = quote

    disclosed_weight_ratio = 0.0
    penetration_return = 0.0
    contributions: list[dict[str, Any]] = []
    for item in holdings:
        quote = quotes.get(item["secid"])
        if quote is None:
            continue
        weight_ratio = float(item["weight_percent"]) / 100
        contribution = weight_ratio * float(quote["change_rate"])
        disclosed_weight_ratio += weight_ratio
        penetration_return += contribution
        contributions.append(
            {
                "name": item["name"],
                "code": item["code"],
                "weight": round(weight_ratio, 4),
                "proxy_return": round(float(quote["change_rate"]), 4),
                "contribution": round(contribution, 4),
                "price": quote["price"],
            }
        )

    official_return = float(estimate["estimated_return"])
    if disclosed_weight_ratio > 0 and stock_position_ratio > disclosed_weight_ratio:
        residual_weight = stock_position_ratio - disclosed_weight_ratio
        average_change = penetration_return / disclosed_weight_ratio if disclosed_weight_ratio else official_return
        residual_contribution = residual_weight * average_change
        penetration_return += residual_contribution
        contributions.append(
            {
                "name": "未披露持仓篮子",
                "code": "OTHER",
                "weight": round(residual_weight, 4),
                "proxy_return": round(average_change, 4),
                "contribution": round(residual_contribution, 4),
                "price": 0.0,
            }
        )

    if disclosed_weight_ratio < 0.10:
        penetration_return = official_return
        contributions = [
            {
                "name": "官方实时估值",
                "code": fund.fund_id,
                "weight": 1.0,
                "proxy_return": round(official_return, 4),
                "contribution": round(official_return, 4),
                "price": float(estimate["estimated_nav"]),
            }
        ]

    confidence = _build_confidence(
        disclosed_weight_ratio=disclosed_weight_ratio,
        stock_position_ratio=stock_position_ratio,
        disclosure_date=str(holdings_payload.get("disclosure_date", "")),
        official_return=official_return,
        penetration_return=penetration_return,
    )
    estimated_nav = round(float(estimate["latest_nav"]) * (1 + penetration_return), 4)
    labels = ["昨收", str(estimate.get("gztime", "当前")).split(" ")[-1][:5] or "当前"]
    series = [
        {"name": "穿透估算收益率", "values": [0.0, round(penetration_return, 4)]},
        {"name": "官方估算收益率", "values": [0.0, round(official_return, 4)]},
    ]

    return {
        "fund_id": fund.fund_id,
        "fund_name": fund.name,
        "theme": fund.theme,
        "latest_nav": round(float(estimate["latest_nav"]), 4),
        "estimated_nav": estimated_nav,
        "official_estimated_nav": round(float(estimate["estimated_nav"]), 4),
        "estimated_return": round(penetration_return, 4),
        "estimated_intraday_return": round(penetration_return, 4),
        "official_estimated_return": round(official_return, 4),
        "estimated_return_series": [0.0, round(penetration_return, 4)],
        "labels": labels,
        "series": series,
        "chart": {"labels": labels, "series": series, "unit": "return"},
        "contributions": sorted(contributions, key=lambda item: abs(float(item["contribution"])), reverse=True),
        "confidence": confidence,
        "confidence_meta": confidence,
        "confidence_label": str(confidence["label"]),
        "proxy_note": "使用东财前十大持仓与实时行情做穿透估算，并与官方实时估值交叉校验。",
        "estimate_as_of": str(estimate.get("gztime", "")).split(" ")[-1][:5] or "当前",
        "holdings_disclosure_date": str(holdings_payload.get("disclosure_date", "")),
        "observations": [
            f"官方估值收益 {official_return * 100:.2f}% ，穿透估算收益 {penetration_return * 100:.2f}% 。",
            f"前十大持仓覆盖约 {disclosed_weight_ratio * 100:.1f}% 净值，股票仓位约 {stock_position_ratio * 100:.1f}% 。",
            f"估值时间 {estimate.get('gztime', '未知')}，适合看盘中节奏，不适合替代真实成交结果。",
        ],
        "disclaimer": "实时收益来自天天基金官方估值与东财持仓穿透联合估算，不代表基金公司最终净值与成交结果。",
    }



def _infer_category_from_ftype(ftype: str, stock_position_ratio: float = 0.0) -> str:
    value = str(ftype)
    if "QDII" in value:
        return "QDII"
    if "债" in value:
        return "债券型"
    if "指数" in value or "LOF" in value:
        return "指数型"
    if "混合" in value:
        return "混合型"
    if "股票" in value or stock_position_ratio >= 0.75:
        return "股票型"
    return "混合型"


def _build_search_item_from_profile(profile: FundProfile) -> dict[str, Any]:
    return {
        "fund_id": profile.fund_id,
        "name": profile.name,
        "category": profile.category,
        "theme": profile.theme,
        "risk_level": profile.risk_level,
    }


def _build_search_item_from_api(raw_item: dict[str, Any]) -> dict[str, Any] | None:
    fund_info = raw_item.get("FundBaseInfo") or {}
    fund_code = str(raw_item.get("CODE") or fund_info.get("FCODE") or "").strip()
    fund_name = str(raw_item.get("NAME") or fund_info.get("SHORTNAME") or "").strip()
    if not fund_code or not fund_name:
        return None

    category = _infer_category_from_ftype(str(fund_info.get("FTYPE", "")))
    theme = _infer_theme(fund_name)
    risk_level = _infer_risk_level(category, 0.8 if category in {"股票型", "指数型", "QDII"} else 0.45)
    return {
        "fund_id": fund_code,
        "name": fund_name,
        "category": category,
        "theme": theme,
        "risk_level": risk_level,
    }


def _search_real_funds_api(query: str, limit: int = 5) -> list[dict[str, Any]]:
    encoded_query = urllib.parse.quote(query)
    payload = _fetch_json(
        f"https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key={encoded_query}",
        ttl_seconds=300,
        referer="https://fund.eastmoney.com/",
    )
    items: list[dict[str, Any]] = []
    for raw_item in payload.get("Datas", []):
        if raw_item.get("CATEGORY") != 700:
            continue
        normalized = _build_search_item_from_api(raw_item)
        if normalized is not None:
            items.append(normalized)
        if len(items) >= limit:
            break
    return items


def search_funds(query: str, sample_funds: tuple[FundProfile, ...] = (), limit: int = 5) -> list[dict[str, Any]]:
    clean_query = query.strip()
    if not clean_query:
        return []

    results: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    if is_real_fund_code(clean_query):
        try:
            profile = build_real_fund_profile(clean_query)
            item = _build_search_item_from_profile(profile)
            results.append(item)
            seen_ids.add(item["fund_id"])
        except Exception:
            pass
    else:
        try:
            for item in _search_real_funds_api(clean_query, limit=limit):
                if item["fund_id"] in seen_ids:
                    continue
                results.append(item)
                seen_ids.add(item["fund_id"])
                if len(results) >= limit:
                    return results
        except Exception:
            pass

    lowered_query = clean_query.lower()
    for fund in sample_funds:
        if fund.fund_id in seen_ids:
            continue
        if lowered_query in fund.fund_id.lower() or lowered_query in fund.name.lower() or lowered_query in fund.theme.lower():
            item = _build_search_item_from_profile(fund)
            results.append(item)
            seen_ids.add(item["fund_id"])
            if len(results) >= limit:
                break

    return results[:limit]



def _infer_search_category(ftype: str, name: str) -> str:
    raw = (ftype or '').strip()
    if raw:
        return raw.split('-')[0]
    return _infer_category(name, 0.6)


def _infer_search_risk(category: str) -> str:
    if any(keyword in category for keyword in ('货币', '债券')):
        return 'low'
    if any(keyword in category for keyword in ('股票', '指数', 'QDII')):
        return 'high'
    return 'medium'


def _search_item_to_payload(item: dict[str, Any]) -> dict[str, Any]:
    base = item.get('FundBaseInfo') or {}
    fund_id = str(item.get('CODE') or base.get('FCODE') or '').strip()
    name = str(item.get('NAME') or base.get('SHORTNAME') or fund_id)
    category = _infer_search_category(str(base.get('FTYPE') or ''), name)
    return {
        'fund_id': fund_id,
        'name': name,
        'category': category,
        'theme': _infer_theme(name),
        'risk_level': _infer_search_risk(category),
    }


def search_real_funds(query: str, limit: int = 5) -> list[dict[str, Any]]:
    clean_query = query.strip()
    if not clean_query:
        return []

    if is_real_fund_code(clean_query):
        try:
            profile = build_real_fund_profile(clean_query)
        except Exception:
            return []
        return [{
            'fund_id': profile.fund_id,
            'name': profile.name,
            'category': profile.category,
            'theme': profile.theme,
            'risk_level': profile.risk_level,
        }]

    url = (
        'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx'
        f'?m=1&key={urllib.parse.quote(clean_query)}'
    )
    try:
        payload = _fetch_json(url, ttl_seconds=300, referer='https://fund.eastmoney.com/')
    except Exception:
        return []

    items = payload.get('Datas') or []
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        code = str(item.get('CODE') or '').strip()
        if not is_real_fund_code(code) or code in seen:
            continue
        seen.add(code)
        results.append(_search_item_to_payload(item))
        if len(results) >= limit:
            break
    return results


search_real_funds = search_funds



def _fetch_rankhandler_payload(page: int = 1, page_size: int = 30, sort_key: str = "6yzf") -> tuple[list[str], int]:
    today = date.today()
    start_date = date(today.year - 1, today.month, today.day) if not (today.month == 2 and today.day == 29) else date(today.year - 1, 2, 28)
    url = (
        "https://fund.eastmoney.com/data/rankhandler.aspx"
        f"?op=ph&dt=kf&ft=all&rs=&gs=0&sc={urllib.parse.quote(sort_key)}&st=desc"
        f"&sd={start_date.isoformat()}&ed={today.isoformat()}&qdii=042|&tabSubtype=,,,,,"
        f"&pi={page}&pn={page_size}&dx=1&v={time.time():.6f}"
    )
    text = _fetch_text(url, ttl_seconds=300, referer="https://fund.eastmoney.com/data/fundranking.html")
    match = re.search(r"datas:(\[.*?\]),allRecords:(\d+)", text, re.S)
    if match is None:
        raise RealFundDataError("真实基金池解析失败")
    return json.loads(match.group(1)), int(match.group(2))


def _build_catalog_item_from_rank_row(row: str) -> dict[str, Any] | None:
    parts = row.split(",")
    if len(parts) < 5:
        return None
    fund_id = str(parts[0]).strip()
    name = str(parts[1]).strip()
    if not is_real_fund_code(fund_id) or not name:
        return None
    latest_nav = 0.0
    try:
        latest_nav = float(parts[4] or 0.0)
    except ValueError:
        latest_nav = 0.0
    category = _infer_category(name, 0.65 if any(keyword in name for keyword in ("指数", "ETF", "LOF", "股票")) else 0.35)
    risk_level = _infer_risk_level(category, 0.8 if category in {"股票型", "指数型", "QDII"} else 0.45)
    return {
        "fund_id": fund_id,
        "name": name,
        "category": category,
        "theme": _infer_theme(name),
        "risk_level": risk_level,
        "manager": "",
        "latest_nav": round(latest_nav, 4) if latest_nav else 0.0,
    }


def fetch_fund_catalog(page: int = 1, page_size: int = 30, risk_level: str | None = None) -> dict[str, Any]:
    normalized_page = max(1, int(page or 1))
    normalized_page_size = max(1, min(int(page_size or 30), 100))

    if risk_level is None:
        rows, total = _fetch_rankhandler_payload(page=normalized_page, page_size=normalized_page_size)
        items = [item for item in (_build_catalog_item_from_rank_row(row) for row in rows) if item is not None]
        return {"items": items, "total": total, "page": normalized_page, "page_size": normalized_page_size}

    requested_count = max(normalized_page * normalized_page_size * 3, 120)
    rows, _ = _fetch_rankhandler_payload(page=1, page_size=requested_count)
    filtered = [
        item
        for item in (_build_catalog_item_from_rank_row(row) for row in rows)
        if item is not None and item["risk_level"] == risk_level
    ]
    start = (normalized_page - 1) * normalized_page_size
    end = start + normalized_page_size
    return {
        "items": filtered[start:end],
        "total": len(filtered),
        "page": normalized_page,
        "page_size": normalized_page_size,
    }
