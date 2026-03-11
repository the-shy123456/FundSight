from __future__ import annotations

from datetime import datetime
from uuid import uuid4
from zoneinfo import ZoneInfo

from .analytics import build_diagnosis, fund_metrics
from .forecast_grader import grade_forecast
from .holdings import HoldingLot, get_holdings
from .intraday_estimator import estimate_fund_intraday
from .name_display import normalize_name_display
from .portfolio import find_fund
from .predictions_store import append_prediction, compact_to_max
from .real_data import fetch_fund_announcements, is_real_fund_code
from .research import NEGATIVE_KEYWORDS, POSITIVE_KEYWORDS
from .sample_data import FUNDS


def _default_question(question: str) -> str:
    clean_question = question.strip()
    return clean_question or "这只基金现在更适合继续拿、减仓还是分批处理？"


PORTFOLIO_QUESTION_KEYWORDS = (
    "组合",
    "持仓",
    "这几只",
    "几只基金",
    "几只",
    "全部",
    "全仓",
    "所有基金",
    "全部基金",
    "我持仓",
    "我的基金",
    "仓位",
)


def _is_portfolio_question(question: str) -> bool:
    clean = question.strip()
    if not clean:
        return False
    lowered = clean.lower()
    return any(keyword.lower() in lowered for keyword in PORTFOLIO_QUESTION_KEYWORDS)


def _pick_fund_id(
    fund_id: str | None,
    holdings: tuple[HoldingLot, ...],
) -> str | None:
    if fund_id:
        return fund_id
    if holdings:
        return holdings[0].fund_id
    return None


ANNOUNCEMENT_POSITIVE_KEYWORDS = (
    *POSITIVE_KEYWORDS,
    "分红",
    "收益分配",
    "开放申购",
    "恢复申购",
)
ANNOUNCEMENT_NEGATIVE_KEYWORDS = (
    *NEGATIVE_KEYWORDS,
    "暂停申购",
    "暂停赎回",
    "基金经理变更",
    "经理变更",
    "离任",
    "清盘",
    "巨额赎回",
)


def _clamp(value: float, floor: float, ceiling: float) -> float:
    return max(floor, min(ceiling, value))


def _count_keyword_hits(texts: list[str], keywords: tuple[str, ...]) -> int:
    lowered = " ".join(texts).lower()
    return sum(lowered.count(keyword.lower()) for keyword in keywords)


def _normalize_announcements(items: list[dict[str, object]]) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    for item in items:
        normalized.append(
            {
                "date": str(item.get("date") or ""),
                "title": str(item.get("title") or ""),
                "type": str(item.get("type") or ""),
                "url": str(item.get("url") or ""),
                "pdf_url": str(item.get("pdf_url") or ""),
            }
        )
    return normalized


def _build_announcement_evidence(items: list[dict[str, object]]) -> dict[str, str]:
    if not items:
        return {
            "label": "最新公告（东财 fundf10）",
            "value": "暂无",
            "detail": "暂无最新公告或该基金为样例数据。来源：东财 fundf10。",
        }

    lines: list[str] = []
    for item in items[:3]:
        title = str(item.get("title") or "未命名公告")
        date = str(item.get("date") or "未知日期")
        announcement_type = str(item.get("type") or "")
        suffix = f"（{announcement_type}）" if announcement_type else ""
        lines.append(f"{date} {title}{suffix}")
    detail = "；".join(lines) + "。来源：东财 fundf10。"
    return {"label": "最新公告（东财 fundf10）", "value": f"{len(items[:3])} 条", "detail": detail}


def _now_iso() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).replace(microsecond=0).isoformat()


def _coerce_positive_float(value: object | None) -> float | None:
    try:
        parsed = float(value) if value is not None else None
    except (TypeError, ValueError):
        return None
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _persist_forecast_prediction(
    *,
    fund_id: str,
    fund_name: str,
    forecast: dict[str, object],
    estimate: dict[str, object],
    estimate_mode: str,
    created_at: str | None = None,
) -> None:
    created_at_value = created_at or _now_iso()
    horizon = int(forecast.get("horizon_trading_days", 5) or 5)
    direction = str(forecast.get("direction", "up")).lower()
    probability_up = _coerce_positive_float(forecast.get("probability_up", 0.0))
    if probability_up is None:
        probability_up = 0.5
    evidence_refs = forecast.get("evidence_refs", [])
    if not isinstance(evidence_refs, list):
        evidence_refs = []

    nav_at_prediction = _coerce_positive_float(estimate.get("estimated_nav"))
    if nav_at_prediction is None:
        nav_at_prediction = _coerce_positive_float(estimate.get("latest_nav"))

    basis = {
        "estimate_as_of": str(estimate.get("estimate_as_of", "")),
        "estimate_mode": str(estimate.get("estimate_mode", estimate_mode)),
        "evidence_refs": [str(item) for item in evidence_refs if item is not None],
    }
    if nav_at_prediction is not None:
        basis["nav_at_prediction"] = round(nav_at_prediction, 4)

    record: dict[str, object] = {
        "id": str(uuid4()),
        "created_at": created_at_value,
        "fund_id": fund_id,
        "fund_name": fund_name,
        "horizon_trading_days": horizon,
        "direction": direction,
        "probability_up": round(float(probability_up), 4),
        "basis": basis,
        "status": "pending",
    }

    result = grade_forecast(fund_id, created_at_value, horizon, direction=direction)
    if result is not None:
        record["status"] = "settled"
        record["settled_at"] = _now_iso()
        record["result"] = result

    append_prediction(record)
    compact_to_max(200)


def _build_direction_forecast(
    metrics: dict[str, float],
    announcements: list[dict[str, object]],
    evidence_labels: list[str],
) -> dict[str, object]:
    titles = [str(item.get("title") or "") for item in announcements if str(item.get("title") or "")]
    positive_hits = _count_keyword_hits(titles, ANNOUNCEMENT_POSITIVE_KEYWORDS)
    negative_hits = _count_keyword_hits(titles, ANNOUNCEMENT_NEGATIVE_KEYWORDS)
    announcement_score = _clamp((positive_hits - negative_hits) * 0.04, -0.16, 0.16)

    momentum_score = _clamp(metrics.get("momentum", 0.0) * 1.6, -0.12, 0.12)
    drawdown_score = _clamp((0.04 - metrics.get("max_drawdown", 0.0)) * 0.8, -0.06, 0.06)
    volatility_penalty = _clamp((metrics.get("volatility", 0.0) - 0.012) * 1.2, -0.03, 0.07)

    raw_score = 0.5 + momentum_score + drawdown_score - volatility_penalty + announcement_score
    probability_up = round(_clamp(raw_score, 0.1, 0.9), 2)
    direction = "up" if probability_up >= 0.5 else "down"

    rationale: list[str] = [
        f"近 3 期动量 {metrics.get('momentum', 0.0) * 100:.2f}% 为短线方向提供基准。",
        f"波动率 {metrics.get('volatility', 0.0) * 100:.2f}%、最大回撤 {metrics.get('max_drawdown', 0.0) * 100:.2f}% 用于调节置信度。",
    ]
    if positive_hits or negative_hits:
        rationale.append(f"公告标题出现正向词 {positive_hits} 个、负向词 {negative_hits} 个，公告因子优先加权。")
    else:
        rationale.append("最新公告未出现明显正负催化，预测更依赖净值动量与回撤。")
    if any(keyword in " ".join(titles) for keyword in ("经理变更", "离任", "增聘", "更换")):
        rationale.append("公告涉及基金经理变更或离任等字样，短期不确定性偏高。")

    return {
        "horizon_trading_days": 5,
        "direction": direction,
        "probability_up": probability_up,
        "rationale": rationale,
        "evidence_refs": evidence_labels,
    }


def _estimate_current_value(
    *,
    shares: float,
    unit_cost: float,
    fund: object,
    estimate: dict[str, object],
) -> tuple[float, float, float, float]:
    try:
        estimated_nav = float(estimate.get("estimated_nav", 0.0) or 0.0)
    except (TypeError, ValueError):
        estimated_nav = 0.0
    latest_nav = 0.0
    if estimated_nav <= 0:
        try:
            latest_nav = float(getattr(fund, "nav_history", [0.0])[-1])
        except (TypeError, ValueError, IndexError):
            latest_nav = 0.0
        estimated_nav = latest_nav
    if latest_nav <= 0:
        try:
            latest_nav = float(getattr(fund, "nav_history", [0.0])[-1])
        except (TypeError, ValueError, IndexError):
            latest_nav = estimated_nav
    current_value = shares * estimated_nav
    previous_value = shares * latest_nav
    cost_basis = shares * unit_cost
    total_pnl = current_value - cost_basis
    today_estimated_pnl = current_value - previous_value
    return current_value, total_pnl, today_estimated_pnl, cost_basis


def _portfolio_suggestion(direction: str, probability_up: float, total_pnl: float) -> str:
    direction_probability = probability_up if direction == "up" else 1 - probability_up
    confidence = "偏高" if direction_probability >= 0.6 else "一般"
    if direction == "up" and total_pnl >= 0:
        return f"短期偏多、置信度{confidence}，可以继续持有但注意分批止盈。"
    if direction == "up" and total_pnl < 0:
        return f"短期有修复迹象、置信度{confidence}，可观察反弹力度再决定是否补仓。"
    if direction == "down" and total_pnl >= 0:
        return f"回撤风险偏高、置信度{confidence}，建议分批锁定浮盈或提高止损位。"
    return f"方向偏弱、置信度{confidence}，更适合控制仓位等待企稳。"


def _build_portfolio_answer(
    *,
    question: str,
    holdings: tuple[HoldingLot, ...],
    cash_available: float,
    estimate_mode: str,
) -> dict[str, object]:
    candidates: list[dict[str, object]] = []
    prediction_created_at = _now_iso()

    for holding in holdings:
        fund = find_fund(holding.fund_id, FUNDS)
        if fund is None:
            continue
        estimate = estimate_fund_intraday(fund, estimate_mode=estimate_mode)
        metrics = fund_metrics(fund)
        current_value, total_pnl, today_estimated_pnl, _ = _estimate_current_value(
            shares=holding.shares,
            unit_cost=holding.unit_cost,
            fund=fund,
            estimate=estimate,
        )

        announcement_items: list[dict[str, object]] = []
        if is_real_fund_code(fund.fund_id):
            try:
                announcements_payload = fetch_fund_announcements(fund.fund_id, page=1, per=3)
                announcement_items = list(announcements_payload.get("items") or [])[:3]
            except Exception:
                announcement_items = []
        announcement_structured = _normalize_announcements(announcement_items)

        evidence = [
            {
                "label": str(estimate.get("estimate_source_label", "收益参考")),
                "value": f"{float(estimate.get('estimated_return', 0.0)) * 100:.2f}%",
                "detail": f"估值时间 {str(estimate.get('estimate_as_of', '')) or '当前'}。{str(estimate.get('confidence', {}).get('reason', '') or '')}",
            },
            {
                "label": "近 3 期动量",
                "value": f"{float(metrics.get('momentum', 0.0)) * 100:.2f}%",
                "detail": "用于判断短期方向是否延续。",
            },
            {
                "label": "最大回撤",
                "value": f"{float(metrics.get('max_drawdown', 0.0)) * 100:.2f}%",
                "detail": "回撤越大，越不适合短线频繁操作。",
            },
        ]
        disclosure_date = str(estimate.get("holdings_disclosure_date", ""))
        if disclosure_date:
            evidence.append(
                {
                    "label": "持仓披露日期",
                    "value": disclosure_date,
                    "detail": "披露越新，穿透估算通常越有参考价值。",
                }
            )

        forecast = _build_direction_forecast(
            metrics,
            announcement_items,
            ["最新公告（东财 fundf10）", "近 3 期动量", "最大回撤"],
        )
        _persist_forecast_prediction(
            fund_id=fund.fund_id,
            fund_name=fund.name,
            forecast=forecast,
            estimate=estimate,
            estimate_mode=estimate_mode,
            created_at=prediction_created_at,
        )
        suggestion = _portfolio_suggestion(
            str(forecast.get("direction", "up")),
            float(forecast.get("probability_up", 0.5)),
            float(total_pnl),
        )

        candidates.append(
            {
                "fund_id": fund.fund_id,
                "name": fund.name,
                "name_display": normalize_name_display(fund.name),
                "holding": {
                    "current_value": round(current_value, 2),
                    "total_pnl": round(total_pnl, 2),
                    "today_estimated_pnl": round(today_estimated_pnl, 2),
                },
                "forecast": forecast,
                "suggestion": suggestion,
                "evidence": evidence,
                "announcement_evidence": _build_announcement_evidence(announcement_items),
                "announcements": announcement_structured,
            }
        )

    candidates.sort(key=lambda item: float(item.get("holding", {}).get("current_value", 0.0)), reverse=True)
    limit = 8
    per_fund = candidates[:limit]

    up_count = sum(1 for item in per_fund if item.get("forecast", {}).get("direction") == "up")
    down_count = len(per_fund) - up_count
    summary_lines = [
        f"组合层面：{len(per_fund)} 只基金中 {up_count} 只偏向上行、{down_count} 只偏向回撤，未来 5 个交易日更适合分批处理。",
    ]
    if len(holdings) > len(per_fund):
        summary_lines[0] += f"（仅展示市值前 {len(per_fund)} 只）"
    summary_lines.append("")
    summary_lines.append("逐只参考：")
    for item in per_fund:
        name = item.get("name_display") or item.get("name") or item.get("fund_id")
        forecast = item.get("forecast", {})
        direction = forecast.get("direction", "up")
        direction_label = "上涨" if direction == "up" else "下跌"
        probability_up = float(forecast.get("probability_up", 0.5))
        direction_probability = probability_up if direction == "up" else 1 - probability_up
        suggestion = item.get("suggestion", "")
        summary_lines.append(f"- {name}：{direction_label}（概率{direction_probability * 100:.0f}%），{suggestion}")

    portfolio_actions = [
        "优先关注下跌概率更高且已有浮盈的基金，分批锁定收益。",
        "对上涨概率较高的基金保持观察，避免一次性加仓。",
        "若整体波动放大，先把仓位降到自己可承受的回撤区间。",
    ]
    if cash_available > 0:
        portfolio_actions.append("如需加仓，建议预设分批承接位，避免追涨。")

    return {
        "question": question,
        "summary": "\n".join(summary_lines),
        "portfolio": {
            "holding_count": len(holdings),
            "horizon_trading_days": 5,
            "estimate_mode": estimate_mode,
        },
        "per_fund": per_fund,
        "portfolio_actions": portfolio_actions,
        "risks": [
            "组合预测为盘中估算+动量参考，仍不等于最终净值。",
            "短线高频操作容易被震荡反复打脸，建议以分批执行为主。",
        ],
        "disclaimer": "该回答是样例级决策辅助，不构成收益承诺、投顾建议或真实交易指令。",
    }


def ask_assistant(
    question: str,
    fund_id: str | None = None,
    cash_available: float = 0.0,
    holdings: tuple[HoldingLot, ...] | None = None,
    estimate_mode: str = "auto",
) -> dict[str, object]:
    active_holdings = holdings if holdings is not None else get_holdings()
    clean_question = _default_question(question)

    if _is_portfolio_question(clean_question) and len(active_holdings) >= 2:
        return _build_portfolio_answer(
            question=clean_question,
            holdings=active_holdings,
            cash_available=cash_available,
            estimate_mode=estimate_mode,
        )

    selected_fund_id = _pick_fund_id(fund_id, active_holdings)
    if not selected_fund_id:
        raise ValueError("请先选择基金或导入持仓")

    fund = find_fund(selected_fund_id, FUNDS)
    if fund is None:
        raise ValueError(f"基金不存在：{selected_fund_id}")

    estimate = estimate_fund_intraday(fund, estimate_mode=estimate_mode)
    metrics = fund_metrics(fund)
    diagnosis = build_diagnosis(fund)
    announcement_items: list[dict[str, object]] = []
    if is_real_fund_code(fund.fund_id):
        try:
            announcements_payload = fetch_fund_announcements(fund.fund_id, page=1, per=3)
            announcement_items = list(announcements_payload.get("items") or [])[:3]
        except Exception:
            announcement_items = []
    announcement_structured = _normalize_announcements(announcement_items)

    wants_to_sell = any(keyword in clean_question for keyword in ("卖", "止盈", "清仓", "落袋"))
    wants_to_buy_back = any(keyword in clean_question for keyword in ("跌", "回落", "再买", "接回", "补仓"))
    wants_maximize = any(keyword in clean_question for keyword in ("最大化", "收益最大", "赚最多"))

    stance = "中性"
    if float(estimate["estimated_return"]) > 0.003 and float(metrics["momentum"]) > 0:
        stance = "偏多"
    elif float(estimate["estimated_return"]) < -0.002:
        stance = "偏谨慎"

    holding_context = None
    holding = next((item for item in active_holdings if item.fund_id == fund.fund_id), None)
    if holding is not None:
        current_value, total_pnl, today_estimated_pnl, _ = _estimate_current_value(
            shares=holding.shares,
            unit_cost=holding.unit_cost,
            fund=fund,
            estimate=estimate,
        )
        holding_context = {
            "shares": holding.shares,
            "avg_cost": holding.unit_cost,
            "current_value": round(current_value, 2),
            "total_pnl": round(total_pnl, 2),
            "today_estimated_pnl": round(today_estimated_pnl, 2),
        }

    summary = f"{fund.name} 当前更适合按计划分批处理，而不是把下周涨跌当成确定答案。"
    if holding_context and float(holding_context["total_pnl"]) > 0:
        summary = f"{fund.name} 已有浮盈，更适合分批止盈或抬高止损位，而不是一次性清仓等回调。"
    if wants_to_buy_back and cash_available > 0:
        summary = f"如果你还有 ¥{cash_available:.0f} 机动资金，更建议分两到三笔观察回撤承接，不建议一次性梭哈。"
    if wants_maximize:
        summary = "系统更适合给你情景分析和仓位建议，不能把收益最大化回答成确定性承诺。"
    if stance == "偏谨慎" and wants_to_sell:
        summary = f"{fund.name} 当前盘中估算偏弱，若你主要目标是保护浮盈，分批减仓通常比赌下周反弹更稳。"

    source_label = str(estimate.get("estimate_source_label", "收益参考"))
    estimate_as_of = str(estimate.get("estimate_as_of", "")) or "当前"
    disclosure_date = str(estimate.get("holdings_disclosure_date", ""))
    is_real_data = bool(estimate.get("is_real_data", False))

    scenarios = [
        {
            "name": "乐观",
            "condition": f"{fund.theme} 主题继续获得资金承接，且盘中估算维持正斜率。",
            "impact": "下周延续修复，更适合继续持有或小幅减仓锁定部分收益。",
        },
        {
            "name": "中性",
            "condition": "指数震荡，主题热度回落但没有出现明显利空。",
            "impact": "净值大概率以震荡为主，更适合分批决策而不是频繁来回切换。",
        },
        {
            "name": "谨慎",
            "condition": "主题龙头冲高回落，或风险事件导致板块估值压缩。",
            "impact": "若回撤放大，应优先控制仓位和回撤，而不是继续追涨。",
        },
    ]

    evidence = [
        {
            "label": source_label,
            "value": f"{float(estimate['estimated_return']) * 100:.2f}%",
            "detail": f"估值时间 {estimate_as_of}。{str(estimate['confidence']['reason'])}",
        },
        {
            "label": "近 3 期动量",
            "value": f"{float(metrics['momentum']) * 100:.2f}%",
            "detail": "用于判断当前节奏是否仍在延续。",
        },
        {
            "label": "最大回撤",
            "value": f"{float(metrics['max_drawdown']) * 100:.2f}%",
            "detail": "回撤越大，越不适合重仓频繁搏反弹。",
        },
        {
            "label": "持仓状态",
            "value": f"浮盈 {holding_context['total_pnl']:.2f} 元" if holding_context else "当前未导入该基金持仓",
            "detail": "AI 助手会优先结合你的成本和持仓盈亏给建议。",
        },
    ]
    if disclosure_date:
        evidence.append(
            {
                "label": "持仓披露日期",
                "value": disclosure_date,
                "detail": "披露越新，穿透估算通常越有参考价值。",
            }
        )
    evidence.append(_build_announcement_evidence(announcement_items))

    prediction_created_at = _now_iso()
    forecast = _build_direction_forecast(
        metrics,
        announcement_items,
        ["最新公告（东财 fundf10）", "近 3 期动量", "最大回撤"],
    )
    _persist_forecast_prediction(
        fund_id=fund.fund_id,
        fund_name=fund.name,
        forecast=forecast,
        estimate=estimate,
        estimate_mode=estimate_mode,
        created_at=prediction_created_at,
    )
    direction_label = "上涨" if forecast["direction"] == "up" else "下跌"
    direction_probability = float(forecast["probability_up"])
    if forecast["direction"] != "up":
        direction_probability = 1 - direction_probability
    summary = f"{summary} 未来5个交易日方向预测：{direction_label}（概率{direction_probability * 100:.0f}%）。"

    actions = [
        {
            "title": "继续持有",
            "fit": "高" if stance == "偏多" else "中",
            "detail": "若你更看重趋势延续，可以继续拿，但要接受短期波动与估算误差。",
        },
        {
            "title": "分批止盈",
            "fit": "高" if wants_to_sell and holding_context else "中",
            "detail": "更适合已经有浮盈的仓位，通过分批落袋降低判断错误成本。",
        },
        {
            "title": "跌了再买",
            "fit": "中" if cash_available > 0 else "低",
            "detail": "只有在你还能接受继续回撤时才考虑，建议预设分批承接位。",
        },
    ]

    if is_real_data:
        risks = [
            "当前盘中收益来自官方估值与持仓穿透联合参考，仍不等于基金公司最终净值与真实成交结果。",
            "前十大持仓披露存在时滞，盘中风格漂移会让穿透结果产生误差。",
            "即使有真实估值参考，短线频繁择时仍可能被震荡反复打脸。",
        ]
    else:
        risks = [
            "当前盘中估算仍来自原型级主题代理，不代表官方净值与真实成交结果。",
            "主题基金短期受板块波动影响较大，追涨后容易遇到回撤。",
            "如果你频繁试图卖在高点、买在低点，实际更容易被震荡反复打脸。",
        ]

    return {
        "question": clean_question,
        "fund": {
            "fund_id": fund.fund_id,
            "name": fund.name,
            "theme": fund.theme,
            "risk_label": diagnosis["risk_label"],
        },
        "holding_context": holding_context,
        "summary": summary,
        "stance": stance,
        "scenarios": scenarios,
        "evidence": evidence,
        "actions": actions,
        "forecast": forecast,
        "risks": risks,
        "announcements": announcement_structured,
        "confidence": {
            "score": estimate["confidence"]["score"],
            "label": estimate["confidence"]["label"],
            "reason": "当前置信度主要受披露新鲜度、主题波动和代理篮子稳定性影响。",
        },
        "disclaimer": estimate.get("disclaimer") or "该回答是样例级决策辅助，不构成收益承诺、投顾建议或真实交易指令。",
    }
