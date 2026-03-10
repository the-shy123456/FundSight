from __future__ import annotations

from .analytics import build_diagnosis, fund_metrics
from .holdings import HoldingLot, get_holdings
from .intraday_estimator import estimate_fund_intraday
from .portfolio import find_fund, find_position
from .sample_data import FUNDS


def _default_question(question: str) -> str:
    clean_question = question.strip()
    return clean_question or "这只基金现在更适合继续拿、减仓还是分批处理？"


def _pick_fund_id(
    fund_id: str | None,
    holdings: tuple[HoldingLot, ...],
) -> str | None:
    if fund_id:
        return fund_id
    if holdings:
        return holdings[0].fund_id
    return None


def ask_assistant(
    question: str,
    fund_id: str | None = None,
    cash_available: float = 0.0,
    holdings: tuple[HoldingLot, ...] | None = None,
) -> dict[str, object]:
    active_holdings = holdings if holdings is not None else get_holdings()
    selected_fund_id = _pick_fund_id(fund_id, active_holdings)
    if not selected_fund_id:
        raise ValueError("请先选择基金或导入持仓")

    fund = find_fund(selected_fund_id, FUNDS)
    if fund is None:
        raise ValueError(f"基金不存在：{selected_fund_id}")

    clean_question = _default_question(question)
    estimate = estimate_fund_intraday(fund)
    metrics = fund_metrics(fund)
    diagnosis = build_diagnosis(fund)
    position = find_position(fund.fund_id, active_holdings, FUNDS)

    wants_to_sell = any(keyword in clean_question for keyword in ("卖", "止盈", "清仓", "落袋"))
    wants_to_buy_back = any(keyword in clean_question for keyword in ("跌", "回落", "再买", "接回", "补仓"))
    wants_maximize = any(keyword in clean_question for keyword in ("最大化", "收益最大", "赚最多"))

    stance = "中性"
    if float(estimate["estimated_return"]) > 0.003 and float(metrics["momentum"]) > 0:
        stance = "偏多"
    elif float(estimate["estimated_return"]) < -0.002:
        stance = "偏谨慎"

    summary = f"{fund.name} 当前更适合按计划分批处理，而不是把下周涨跌当成确定答案。"
    if position and float(position["total_pnl"]) > 0:
        summary = f"{fund.name} 已有浮盈，更适合分批止盈或抬高止损位，而不是一次性清仓等回调。"
    if wants_to_buy_back and cash_available > 0:
        summary = f"如果你还有 ¥{cash_available:.0f} 机动资金，更建议分两到三笔观察回撤承接，不建议一次性梭哈。"
    if wants_maximize:
        summary = "系统更适合给你情景分析和仓位建议，不能把收益最大化回答成确定性承诺。"
    if stance == "偏谨慎" and wants_to_sell:
        summary = f"{fund.name} 当前盘中估算偏弱，若你主要目标是保护浮盈，分批减仓通常比赌下周反弹更稳。"

    holding_context = None
    if position is not None:
        holding_context = {
            "shares": position["shares"],
            "avg_cost": position["avg_cost"],
            "current_value": position["current_value"],
            "total_pnl": position["total_pnl"],
            "today_estimated_pnl": position["today_estimated_pnl"],
        }

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
        "risks": risks,
        "confidence": {
            "score": estimate["confidence"]["score"],
            "label": estimate["confidence"]["label"],
            "reason": "当前置信度主要受披露新鲜度、主题波动和代理篮子稳定性影响。",
        },
        "disclaimer": estimate.get("disclaimer") or "该回答是样例级决策辅助，不构成收益承诺、投顾建议或真实交易指令。",
    }
