from __future__ import annotations

from datetime import datetime

from .analytics import fund_metrics, quality_score
from .models import FundProfile
from .real_data import estimate_real_fund_intraday, fetch_fund_estimate, is_real_fund_code


INTRADAY_LABELS: tuple[str, ...] = (
    "09:35",
    "10:00",
    "10:30",
    "11:00",
    "11:30",
    "13:30",
    "14:00",
    "14:30",
    "15:00",
)

_THEME_PROXY_LIBRARY: dict[str, dict[str, object]] = {
    "科技成长": {
        "freshness_days": 18,
        "style_drift": -0.0006,
        "proxies": (
            {"name": "半导体ETF", "weight": 0.42, "series": (0.0012, 0.0036, 0.0051, 0.0044, 0.0062, 0.0080, 0.0094, 0.0108, 0.0122)},
            {"name": "AI算力指数", "weight": 0.33, "series": (0.0008, 0.0028, 0.0044, 0.0040, 0.0052, 0.0066, 0.0078, 0.0086, 0.0094)},
            {"name": "科创50ETF", "weight": 0.18, "series": (0.0005, 0.0016, 0.0026, 0.0020, 0.0029, 0.0035, 0.0041, 0.0047, 0.0054)},
            {"name": "现金缓冲", "weight": 0.07, "series": (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)},
        ),
    },
    "红利价值": {
        "freshness_days": 14,
        "style_drift": -0.0002,
        "proxies": (
            {"name": "红利低波ETF", "weight": 0.48, "series": (0.0003, 0.0011, 0.0018, 0.0016, 0.0022, 0.0028, 0.0031, 0.0035, 0.0040)},
            {"name": "央企红利指数", "weight": 0.32, "series": (0.0004, 0.0010, 0.0017, 0.0015, 0.0020, 0.0025, 0.0029, 0.0033, 0.0037)},
            {"name": "沪深300价值", "weight": 0.14, "series": (0.0002, 0.0007, 0.0012, 0.0010, 0.0013, 0.0018, 0.0021, 0.0024, 0.0028)},
            {"name": "现金缓冲", "weight": 0.06, "series": (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)},
        ),
    },
    "均衡成长": {
        "freshness_days": 21,
        "style_drift": -0.0004,
        "proxies": (
            {"name": "消费ETF", "weight": 0.26, "series": (0.0004, 0.0015, 0.0022, 0.0021, 0.0028, 0.0034, 0.0039, 0.0042, 0.0047)},
            {"name": "中证500ETF", "weight": 0.28, "series": (0.0005, 0.0018, 0.0028, 0.0024, 0.0031, 0.0038, 0.0045, 0.0051, 0.0058)},
            {"name": "中短债ETF", "weight": 0.22, "series": (0.0001, 0.0002, 0.0004, 0.0004, 0.0005, 0.0007, 0.0008, 0.0009, 0.0010)},
            {"name": "沪深300ETF", "weight": 0.18, "series": (0.0003, 0.0011, 0.0019, 0.0017, 0.0023, 0.0028, 0.0034, 0.0039, 0.0045)},
            {"name": "现金缓冲", "weight": 0.06, "series": (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)},
        ),
    },
    "稳健收益": {
        "freshness_days": 7,
        "style_drift": -0.0001,
        "proxies": (
            {"name": "国债ETF", "weight": 0.54, "series": (0.0001, 0.0003, 0.0005, 0.0005, 0.0007, 0.0008, 0.0010, 0.0011, 0.0012)},
            {"name": "信用债ETF", "weight": 0.28, "series": (0.0001, 0.0002, 0.0004, 0.0004, 0.0005, 0.0007, 0.0008, 0.0009, 0.0010)},
            {"name": "短融指数", "weight": 0.12, "series": (0.0, 0.0001, 0.0002, 0.0002, 0.0003, 0.0004, 0.0004, 0.0005, 0.0006)},
            {"name": "现金缓冲", "weight": 0.06, "series": (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)},
        ),
    },
}


def confidence_label(score: float) -> str:
    if score >= 0.78:
        return "高"
    if score >= 0.63:
        return "中"
    return "低"


def _decorate_estimate_meta(
    payload: dict[str, object],
    *,
    source: str,
    source_label: str,
    as_of: str,
    is_real_data: bool,
    disclosure_date: str = "",
) -> dict[str, object]:
    next_payload = dict(payload)
    next_payload.setdefault("estimate_source", source)
    next_payload.setdefault("estimate_source_label", source_label)
    next_payload.setdefault("estimate_as_of", as_of)
    next_payload.setdefault("is_real_data", is_real_data)
    next_payload.setdefault("holdings_disclosure_date", disclosure_date)
    next_payload.setdefault(
        "estimate_scope_label",
        "实时收益参考" if is_real_data else "原型估算",
    )
    return next_payload


def _sample_estimate_fund_intraday(fund: FundProfile) -> dict[str, object]:
    config = _THEME_PROXY_LIBRARY.get(fund.theme, _THEME_PROXY_LIBRARY["均衡成长"])
    proxies = tuple(config["proxies"])
    style_drift = float(config["style_drift"])
    latest_nav = float(fund.nav_history[-1])
    metrics = fund_metrics(fund)

    estimated_return_series = [style_drift for _ in INTRADAY_LABELS]
    contributions: list[dict[str, object]] = []
    for proxy in proxies:
        weight = float(proxy["weight"])
        series = [float(value) for value in proxy["series"]]
        estimated_return_series = [
            round(base + weight * value, 6)
            for base, value in zip(estimated_return_series, series, strict=True)
        ]
        contributions.append(
            {
                "name": str(proxy["name"]),
                "weight": round(weight, 4),
                "proxy_return": round(series[-1], 4),
                "contribution": round(weight * series[-1], 4),
            }
        )

    estimated_return = round(estimated_return_series[-1], 4)
    estimated_nav = round(latest_nav * (1 + estimated_return), 4)

    freshness_penalty = min(float(config["freshness_days"]) / 180, 0.12)
    volatility_penalty = min(float(metrics["volatility"]) * 2.6, 0.12)
    drift_penalty = min(abs(style_drift) * 12, 0.05)
    quality_bonus = min(quality_score(fund) / 260, 0.16)
    confidence_score = round(
        max(0.45, min(0.92, 0.72 + quality_bonus - freshness_penalty - volatility_penalty - drift_penalty)),
        2,
    )
    confidence = {
        "score": confidence_score,
        "label": confidence_label(confidence_score),
        "reason": f"持仓披露新鲜度约 {config['freshness_days']} 天，结合 {fund.theme} 代理篮子与基金波动水平综合估算。",
    }

    proxy_note = f"当前以 {contributions[0]['name']}、{contributions[1]['name']} 作为主要盘中代理。"

    return {
        "fund_id": fund.fund_id,
        "fund_name": fund.name,
        "theme": fund.theme,
        "latest_nav": round(latest_nav, 4),
        "estimated_nav": estimated_nav,
        "estimated_return": estimated_return,
        "estimated_intraday_return": estimated_return,
        "estimated_return_series": estimated_return_series,
        "labels": list(INTRADAY_LABELS),
        "series": [
            {"name": "盘中估算收益率", "values": estimated_return_series},
            {"name": "昨日净值基准", "values": [0.0 for _ in INTRADAY_LABELS]},
        ],
        "chart": {
            "labels": list(INTRADAY_LABELS),
            "series": [
                {"name": "盘中估算收益率", "values": estimated_return_series},
                {"name": "昨日净值基准", "values": [0.0 for _ in INTRADAY_LABELS]},
            ],
            "unit": "return",
        },
        "contributions": sorted(contributions, key=lambda item: abs(float(item["contribution"])), reverse=True),
        "confidence": confidence,
        "confidence_meta": confidence,
        "confidence_label": str(confidence["label"]),
        "proxy_note": proxy_note,
        "observations": [
            proxy_note,
            f"近 3 期动量 {float(metrics['momentum']) * 100:.2f}%，适合和盘中估算一起看节奏。",
            "盘中估算仅用于方向参考，不替代基金公司官方净值。",
        ],
        "disclaimer": "盘中收益为样例级场内穿透估算，不代表真实净值与成交结果。",
        "official_estimated_nav": round(estimated_nav, 4),
        "official_estimated_return": estimated_return,
    }


def _build_official_estimate_only_payload(fund: FundProfile) -> dict[str, object]:
    estimate = fetch_fund_estimate(fund.fund_id)
    official_return = round(float(estimate.get("estimated_return", 0.0)), 4)
    latest_nav = round(float(estimate.get("latest_nav", 0.0)), 4)
    estimated_nav = round(float(estimate.get("estimated_nav", latest_nav)), 4)
    raw_time = str(estimate.get("gztime", "")).strip()
    estimate_as_of = raw_time.split(" ")[-1][:5] if raw_time else "当前"
    labels = ["昨收", "当前"]
    series = [
        {"name": "官方估算收益率", "values": [0.0, official_return]},
        {"name": "昨日净值基准", "values": [0.0, 0.0]},
    ]
    confidence = {
        "score": 0.66,
        "label": "中",
        "reason": "穿透失败，退回官方估值。",
    }
    contributions = [
        {
            "name": "官方实时估值",
            "code": fund.fund_id,
            "weight": 1.0,
            "proxy_return": official_return,
            "contribution": official_return,
            "price": estimated_nav,
        }
    ]
    display_time = raw_time or "当前"

    return {
        "fund_id": fund.fund_id,
        "fund_name": fund.name,
        "theme": fund.theme,
        "latest_nav": latest_nav,
        "estimated_nav": estimated_nav,
        "official_estimated_nav": estimated_nav,
        "estimated_return": official_return,
        "estimated_intraday_return": official_return,
        "official_estimated_return": official_return,
        "estimated_return_series": [0.0, official_return],
        "labels": labels,
        "series": series,
        "chart": {"labels": labels, "series": series, "unit": "return"},
        "contributions": contributions,
        "confidence": confidence,
        "confidence_meta": confidence,
        "confidence_label": str(confidence["label"]),
        "proxy_note": "穿透失败，当前仅采用天天基金官方实时估值作为盘中参考。",
        "estimate_as_of": estimate_as_of,
        "holdings_disclosure_date": "",
        "observations": [
            f"官方估值收益 {official_return * 100:.2f}% ，估值时间 {display_time}。",
            "穿透数据暂不可用，盘中仅显示官方实时估值。",
            "盘中估值仅供参考，不代表基金公司最终净值与成交结果。",
        ],
        "disclaimer": "盘中收益仅基于天天基金官方实时估值，穿透数据暂不可用，最终以基金公司净值为准。",
    }


def estimate_fund_intraday(fund: FundProfile) -> dict[str, object]:
    if is_real_fund_code(fund.fund_id):
        try:
            payload = estimate_real_fund_intraday(fund)
            return _decorate_estimate_meta(
                payload,
                source="official_estimate_penetration",
                source_label="官方估值+持仓穿透",
                as_of=str(payload.get("estimate_as_of", datetime.now().strftime("%H:%M"))),
                is_real_data=True,
                disclosure_date=str(payload.get("holdings_disclosure_date", "")),
            )
        except Exception:
            payload = _build_official_estimate_only_payload(fund)
            return _decorate_estimate_meta(
                payload,
                source="official_estimate_only",
                source_label="官方实时估值(天天基金)",
                as_of=str(payload.get("estimate_as_of", datetime.now().strftime("%H:%M"))),
                is_real_data=True,
                disclosure_date=str(payload.get("holdings_disclosure_date", "")),
            )

    payload = _sample_estimate_fund_intraday(fund)
    return _decorate_estimate_meta(
        payload,
        source="theme_proxy_simulation",
        source_label="主题代理估算",
        as_of=datetime.now().strftime("%H:%M"),
        is_real_data=False,
    )
