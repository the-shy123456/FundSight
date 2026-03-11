from __future__ import annotations

from collections import defaultdict

from .analytics import build_diagnosis
from .holdings import HoldingLot, get_holdings, parse_holdings_payload, resolve_fund
from .intraday_estimator import estimate_fund_intraday
from .models import FundProfile
from .name_display import normalize_name_display
from .sample_data import FUNDS


def find_fund(fund_id: str, funds: tuple[FundProfile, ...] = FUNDS) -> FundProfile | None:
    return resolve_fund(fund_id, funds)


def _is_fund_tuple(value: object) -> bool:
    return isinstance(value, tuple) and all(isinstance(item, FundProfile) for item in value)


def _is_holding_tuple(value: object) -> bool:
    return isinstance(value, tuple) and all(isinstance(item, HoldingLot) for item in value)


def _resolve_inputs(primary: object | None, secondary: object | None) -> tuple[tuple[FundProfile, ...], tuple[HoldingLot, ...]]:
    if _is_fund_tuple(primary):
        funds = primary
        if secondary is None:
            return funds, get_holdings()
        if _is_holding_tuple(secondary):
            return funds, secondary
        return funds, parse_holdings_payload(secondary, funds)

    if primary is None:
        return FUNDS, get_holdings()
    if _is_holding_tuple(primary):
        return FUNDS, primary
    return FUNDS, parse_holdings_payload(primary, FUNDS)


def _build_position(
    holding: HoldingLot,
    funds: tuple[FundProfile, ...],
    *,
    estimate_mode: str = "auto",
) -> dict[str, object]:
    fund = resolve_fund(holding.fund_id, funds)
    if fund is None:
        raise ValueError(f"基金不存在：{holding.fund_id}")

    name_display = normalize_name_display(fund.name)
    diagnosis = build_diagnosis(fund)
    estimate = estimate_fund_intraday(fund, estimate_mode=estimate_mode)
    latest_nav = round(float(fund.nav_history[-1]), 4)
    previous_value = holding.shares * latest_nav
    cost_basis = holding.shares * holding.unit_cost
    current_value = holding.shares * float(estimate["estimated_nav"])
    today_estimated_pnl = current_value - previous_value
    total_pnl = current_value - cost_basis
    total_return = total_pnl / cost_basis if cost_basis else 0.0

    return {
        "fund_id": fund.fund_id,
        "name": fund.name,
        "name_display": name_display,
        "category": fund.category,
        "theme": fund.theme,
        "risk_level": fund.risk_level,
        "risk_label": diagnosis["risk_label"],
        "holding": {
            "shares": round(holding.shares, 4),
            "cost_nav": round(holding.unit_cost, 4),
            "unit_cost": round(holding.unit_cost, 4),
            "cost_basis": round(cost_basis, 2),
        },
        "valuation": {
            "latest_nav": latest_nav,
            "estimated_nav": round(float(estimate["estimated_nav"]), 4),
            "current_value": round(current_value, 2),
            "today_profit": round(today_estimated_pnl, 2),
            "today_return": round(float(estimate["estimated_return"]), 4),
            "total_profit": round(total_pnl, 2),
            "total_return": round(total_return, 4),
        },
        "shares": round(holding.shares, 4),
        "avg_cost": round(holding.unit_cost, 4),
        "unit_cost": round(holding.unit_cost, 4),
        "cost_basis": round(cost_basis, 2),
        "latest_nav": latest_nav,
        "estimated_nav": round(float(estimate["estimated_nav"]), 4),
        "official_estimated_nav": round(float(estimate.get("official_estimated_nav", estimate["estimated_nav"])), 4),
        "current_value": round(current_value, 2),
        "market_value": round(current_value, 2),
        "today_estimated_pnl": round(today_estimated_pnl, 2),
        "estimated_today_pnl": round(today_estimated_pnl, 2),
        "today_estimated_return": round(float(estimate["estimated_return"]), 4),
        "estimated_today_return": round(float(estimate["estimated_return"]), 4),
        "official_estimated_return": round(float(estimate.get("official_estimated_return", estimate["estimated_return"])), 4),
        "total_pnl": round(total_pnl, 2),
        "total_profit": round(total_pnl, 2),
        "total_return": round(total_return, 4),
        "quality_score": diagnosis["quality_score"],
        "confidence": estimate["confidence"],
        "confidence_label": estimate["confidence_label"],
        "proxy": estimate["contributions"][0]["name"],
        "proxy_note": estimate["proxy_note"],
        "signal": {"label": estimate["confidence_label"], "reason": (diagnosis["strengths"][0] if diagnosis["strengths"] else diagnosis["cautions"][0])},
        "strengths": diagnosis["strengths"],
        "cautions": diagnosis["cautions"],
        "estimate_source": estimate.get("estimate_source", "unknown"),
        "estimate_source_label": estimate.get("estimate_source_label", "未知来源"),
        "display_estimate_source_label": estimate.get("display_estimate_source_label", estimate.get("estimate_source_label", "未知来源")),
        "estimate_scope_label": estimate.get("estimate_scope_label", "收益参考"),
        "estimate_as_of": estimate.get("estimate_as_of", ""),
        "holdings_disclosure_date": estimate.get("holdings_disclosure_date", ""),
        "is_real_data": bool(estimate.get("is_real_data", False)),
        "estimate_disclaimer": estimate.get("disclaimer", ""),
    }


def _positions(
    holdings: tuple[HoldingLot, ...],
    funds: tuple[FundProfile, ...],
    *,
    estimate_mode: str = "auto",
) -> list[dict[str, object]]:
    positions = [_build_position(holding, funds, estimate_mode=estimate_mode) for holding in holdings]
    return sorted(positions, key=lambda item: float(item["current_value"]), reverse=True)


def build_portfolio_snapshot(
    primary: object = FUNDS,
    holdings: object | None = None,
    *,
    estimate_mode: str = "auto",
) -> dict[str, object]:
    funds, active_holdings = _resolve_inputs(primary, holdings)
    positions = _positions(active_holdings, funds, estimate_mode=estimate_mode)
    if not positions:
        empty_quality = {
            "holding_count": 0,
            "real_data_holding_count": 0,
            "proxy_holding_count": 0,
            "latest_estimate_as_of": "",
            "display_estimate_source_label": "",
        }
        return {
            "estimate_mode": estimate_mode,
            "mode_label": "场内穿透估算",
            "as_of": __import__("datetime").datetime.now().strftime("%H:%M"),
            "summary": {
                "holding_count": 0,
                "total_cost": 0.0,
                "current_value": 0.0,
                "market_value": 0.0,
                "today_estimated_pnl": 0.0,
                "today_profit": 0.0,
                "estimated_today_return": 0.0,
                "today_return": 0.0,
                "total_pnl": 0.0,
                "total_profit": 0.0,
                "total_return": 0.0,
                "highest_exposure": None,
                "data_quality": empty_quality,
            },
            "positions": [],
            "items": [],
            "exposures": [],
            "risk_exposures": [],
            "signals": [],
            "data_quality": empty_quality,
            "disclaimer": "暂无持仓，可先导入样例仓位。",
        }

    total_cost = sum(float(item["cost_basis"]) for item in positions)
    current_value = sum(float(item["current_value"]) for item in positions)
    previous_value = sum(float(item["shares"]) * float(item["latest_nav"]) for item in positions)
    today_estimated_pnl = sum(float(item["today_estimated_pnl"]) for item in positions)
    total_pnl = sum(float(item["total_pnl"]) for item in positions)
    today_estimated_return = today_estimated_pnl / previous_value if previous_value else 0.0
    total_return = total_pnl / total_cost if total_cost else 0.0

    exposure_map: dict[str, float] = defaultdict(float)
    for item in positions:
        exposure_map[str(item["theme"])] += float(item["current_value"])

    exposures = [
        {
            "theme": theme,
            "weight": round(value / current_value, 4) if current_value else 0.0,
            "current_value": round(value, 2),
            "market_value": round(value, 2),
        }
        for theme, value in sorted(exposure_map.items(), key=lambda entry: entry[1], reverse=True)
    ]
    highest_exposure = exposures[0]

    best_position = max(positions, key=lambda item: float(item["today_estimated_pnl"]))
    riskiest_position = max(positions, key=lambda item: abs(float(item["today_estimated_return"])))
    real_data_holding_count = sum(1 for item in positions if bool(item["is_real_data"]))
    proxy_holding_count = len(positions) - real_data_holding_count
    latest_estimate_as_of = next((str(item["estimate_as_of"]) for item in positions if item.get("estimate_as_of")), "")
    display_estimate_source_label = ""
    for item in positions:
        label = str(item.get("display_estimate_source_label") or "")
        if not label:
            continue
        if bool(item.get("is_real_data")):
            display_estimate_source_label = label
            break
        if not display_estimate_source_label:
            display_estimate_source_label = label
    data_quality = {
        "holding_count": len(positions),
        "real_data_holding_count": real_data_holding_count,
        "proxy_holding_count": proxy_holding_count,
        "latest_estimate_as_of": latest_estimate_as_of,
        "display_estimate_source_label": display_estimate_source_label,
    }

    signals = [
        f"当前仓位最多集中在 {highest_exposure['theme']}，权重约 {highest_exposure['weight'] * 100:.1f}%。",
        f"盘中估算贡献最高的是 {best_position['name']}，今日参考收益 {best_position['today_estimated_pnl']:.2f} 元。",
        f"波动最明显的是 {riskiest_position['name']}，建议结合置信度 {riskiest_position['confidence_label']} 观察。",
    ]
    if real_data_holding_count:
        signals.append(f"当前有 {real_data_holding_count} 只基金使用真实估值参考，最近估值时间 {latest_estimate_as_of or '当前'}。")
    if proxy_holding_count:
        signals.append(f"仍有 {proxy_holding_count} 只基金使用原型代理估算，适合看方向，不适合替代官方净值。")

    summary = {
        "holding_count": len(positions),
        "lot_count": len(active_holdings),
        "total_cost": round(total_cost, 2),
        "current_value": round(current_value, 2),
        "market_value": round(current_value, 2),
        "today_estimated_pnl": round(today_estimated_pnl, 2),
        "estimated_today_pnl": round(today_estimated_pnl, 2),
        "today_profit": round(today_estimated_pnl, 2),
        "estimated_today_return": round(today_estimated_return, 4),
        "today_return": round(today_estimated_return, 4),
        "total_pnl": round(total_pnl, 2),
        "total_profit": round(total_pnl, 2),
        "total_return": round(total_return, 4),
        "highest_exposure": highest_exposure,
        "data_quality": data_quality,
    }

    disclaimer = "组合收益为盘中收益参考，不替代基金公司官方净值。"
    if proxy_holding_count == 0:
        disclaimer = "组合收益基于真实基金官方估值与持仓穿透联合估算，适合看盘中节奏，不替代最终净值。"
    elif real_data_holding_count == 0:
        disclaimer = "组合收益为样例级盘中代理估算，仅适合做方向参考。"

    return {
        "estimate_mode": estimate_mode,
        "mode_label": "场内穿透估算",
        "as_of": __import__("datetime").datetime.now().strftime("%H:%M"),
        "summary": summary,
        "positions": positions,
        "items": positions,
        "exposures": exposures,
        "risk_exposures": exposures,
        "signals": signals,
        "data_quality": data_quality,
        "disclaimer": disclaimer,
    }


def build_portfolio_intraday(
    primary: object = FUNDS,
    holdings: object | None = None,
    *,
    estimate_mode: str = "auto",
) -> dict[str, object]:
    funds, active_holdings = _resolve_inputs(primary, holdings)
    labels: list[str] = []
    pnl_series: list[float] = []
    contributions: list[dict[str, object]] = []
    previous_total = 0.0
    base_values: dict[str, float] = {}
    real_data_count = 0

    for holding in active_holdings:
        fund = resolve_fund(holding.fund_id, funds)
        if fund is None:
            continue

        estimate = estimate_fund_intraday(fund, estimate_mode=estimate_mode)
        previous_value = holding.shares * float(fund.nav_history[-1])
        previous_total += previous_value
        base_values[fund.fund_id] = previous_value
        if bool(estimate.get("is_real_data", False)):
            real_data_count += 1

        if not labels:
            labels = list(estimate["labels"])
            pnl_series = [0.0 for _ in labels]

        for index, estimated_return in enumerate(estimate["estimated_return_series"]):
            pnl_series[index] += previous_value * float(estimated_return)

        contributions.append(
            {
                "fund_id": fund.fund_id,
                "name": fund.name,
                "name_display": normalize_name_display(fund.name),
                "theme": fund.theme,
                "today_estimated_pnl": round(previous_value * float(estimate["estimated_return"]), 2),
                "confidence_label": estimate["confidence_label"],
                "weight": 0.0,
                "estimate_source_label": estimate.get("estimate_source_label", "未知来源"),
                "estimate_as_of": estimate.get("estimate_as_of", ""),
                "is_real_data": bool(estimate.get("is_real_data", False)),
            }
        )

    for item in contributions:
        item["weight"] = round(base_values.get(str(item["fund_id"]), 0.0) / previous_total, 4) if previous_total else 0.0

    return_series = [round(value / previous_total, 4) if previous_total else 0.0 for value in pnl_series]
    chart = {
        "labels": labels,
        "series": [
            {"name": "组合盘中估算收益率", "values": return_series},
            {"name": "昨日净值基准", "values": [0.0 for _ in labels]},
        ],
        "unit": "return",
    }

    disclaimer = "组合盘中曲线由各持仓主题代理叠加生成，仅用于 MVP 演示。"
    if contributions and real_data_count == len(contributions):
        disclaimer = "组合盘中曲线基于真实基金估值参考聚合生成，可用于观察盘中节奏，不替代官方最终净值。"
    elif real_data_count:
        disclaimer = "组合盘中曲线混合了真实基金估值参考与原型代理估算，请重点关注来源标签。"

    return {
        "estimate_mode": estimate_mode,
        "chart": chart,
        "labels": labels,
        "series": chart["series"],
        "estimated_pnl_series": [round(value, 2) for value in pnl_series],
        "estimated_return_series": return_series,
        "contributions": sorted(contributions, key=lambda item: abs(float(item["today_estimated_pnl"])), reverse=True),
        "disclaimer": disclaimer,
    }


def find_position(fund_id: str, primary: object = FUNDS, holdings: object | None = None) -> dict[str, object] | None:
    snapshot = build_portfolio_snapshot(primary, holdings)
    return next((item for item in snapshot["positions"] if item["fund_id"] == fund_id), None)


def build_portfolio_answer(
    funds: tuple[FundProfile, ...],
    holdings: object,
    question: str,
    fund_id: str | None = None,
    cash_available: float | None = None,
) -> dict[str, object]:
    from .assistant import ask_portfolio_assistant

    return ask_portfolio_assistant(funds, question, fund_id, cash_available, holdings)
