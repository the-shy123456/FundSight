from __future__ import annotations

import math
from statistics import mean

from .models import FundProfile, InvestorProfile


RISK_ORDER = {"low": 0, "medium": 1, "high": 2}
RISK_LABELS = {"low": "低风险", "medium": "中风险", "high": "高风险"}
DEFAULT_BUDGET = {"low": 2000.0, "medium": 3000.0, "high": 4000.0}
DEFAULT_HORIZON = {"low": 18, "medium": 12, "high": 9}


def calculate_period_return(nav_history: tuple[float, ...]) -> float:
    return (nav_history[-1] / nav_history[0]) - 1


def calculate_returns(nav_history: tuple[float, ...]) -> list[float]:
    return [
        (nav_history[index] / nav_history[index - 1]) - 1
        for index in range(1, len(nav_history))
    ]


def calculate_volatility(nav_history: tuple[float, ...]) -> float:
    returns = calculate_returns(nav_history)
    if not returns:
        return 0.0
    avg = mean(returns)
    variance = mean((value - avg) ** 2 for value in returns)
    return math.sqrt(variance)


def calculate_max_drawdown(nav_history: tuple[float, ...]) -> float:
    peak = nav_history[0]
    max_drawdown = 0.0
    for value in nav_history:
        peak = max(peak, value)
        drawdown = 1 - (value / peak)
        max_drawdown = max(max_drawdown, drawdown)
    return max_drawdown


def calculate_momentum(nav_history: tuple[float, ...], window: int = 3) -> float:
    if len(nav_history) <= window:
        return calculate_period_return(nav_history)
    return (nav_history[-1] / nav_history[-1 - window]) - 1


def calculate_sharpe_like(period_return: float, volatility: float) -> float:
    return period_return / volatility if volatility else period_return


def normalize_score(value: float, floor: float, ceiling: float) -> float:
    if ceiling == floor:
        return 0.0
    return max(0.0, min(1.0, (value - floor) / (ceiling - floor)))


def fund_metrics(fund: FundProfile) -> dict[str, float]:
    period_return = calculate_period_return(fund.nav_history)
    volatility = calculate_volatility(fund.nav_history)
    max_drawdown = calculate_max_drawdown(fund.nav_history)
    momentum = calculate_momentum(fund.nav_history)
    sharpe_like = calculate_sharpe_like(period_return, volatility)
    return {
        "period_return": round(period_return, 4),
        "volatility": round(volatility, 4),
        "max_drawdown": round(max_drawdown, 4),
        "momentum": round(momentum, 4),
        "sharpe_like": round(sharpe_like, 4),
    }


def quality_score(fund: FundProfile) -> float:
    metrics = fund_metrics(fund)
    return_score = normalize_score(metrics["period_return"], 0.02, 0.25)
    volatility_score = 1 - normalize_score(metrics["volatility"], 0.0, 0.04)
    drawdown_score = 1 - normalize_score(metrics["max_drawdown"], 0.0, 0.12)
    fee_score = 1 - normalize_score(fund.fee_rate, 0.005, 0.02)
    tenure_score = normalize_score(fund.manager_tenure_years, 1.0, 6.0)
    score = (
        0.30 * return_score
        + 0.20 * volatility_score
        + 0.20 * drawdown_score
        + 0.10 * fee_score
        + 0.20 * tenure_score
    )
    return round(score * 100, 1)


def build_diagnosis(fund: FundProfile) -> dict[str, object]:
    metrics = fund_metrics(fund)
    strengths: list[str] = []
    cautions: list[str] = []

    if metrics["period_return"] >= 0.08:
        strengths.append("阶段收益表现较强")
    if metrics["max_drawdown"] <= 0.03:
        strengths.append("回撤控制较稳")
    if fund.manager_tenure_years >= 4:
        strengths.append("基金经理任期稳定")
    if fund.fee_rate <= 0.01:
        strengths.append("费率较低")

    if metrics["volatility"] >= 0.015:
        cautions.append("净值波动偏大")
    if metrics["momentum"] < 0:
        cautions.append("短期动量走弱")
    if fund.manager_tenure_years < 2.5:
        cautions.append("经理任期偏短，需要继续观察")

    if not strengths:
        strengths.append("收益与风险表现均衡")
    if not cautions:
        cautions.append("暂无明显短期风险信号")

    return {
        "fund_id": fund.fund_id,
        "name": fund.name,
        "category": fund.category,
        "risk_level": fund.risk_level,
        "risk_label": RISK_LABELS[fund.risk_level],
        "theme": fund.theme,
        "manager": fund.manager,
        "manager_tenure_years": fund.manager_tenure_years,
        "fee_rate": fund.fee_rate,
        "quality_score": quality_score(fund),
        "metrics": metrics,
        "strengths": strengths,
        "cautions": cautions,
    }


def default_investor_for_fund(fund: FundProfile) -> InvestorProfile:
    return InvestorProfile(
        risk_level=fund.risk_level,
        monthly_budget=DEFAULT_BUDGET[fund.risk_level],
        investment_horizon_months=DEFAULT_HORIZON[fund.risk_level],
    )


def risk_compatible(fund: FundProfile, investor: InvestorProfile) -> bool:
    return RISK_ORDER[fund.risk_level] <= RISK_ORDER[investor.risk_level]


def determine_action(fund: FundProfile, investor: InvestorProfile) -> str:
    metrics = fund_metrics(fund)
    if metrics["momentum"] > 0.03 and risk_compatible(fund, investor):
        return "buy"
    if metrics["momentum"] < -0.01 or metrics["max_drawdown"] > 0.08:
        return "watch"
    return "hold"


def suggested_amount(weight: float, investor: InvestorProfile) -> float:
    return round(investor.monthly_budget * weight, 2)


def operation_plan(fund: FundProfile, investor: InvestorProfile, weight: float) -> dict[str, object]:
    action = determine_action(fund, investor)
    amount = suggested_amount(weight, investor)
    metrics = fund_metrics(fund)

    if action == "buy":
        trigger = "未来 1 至 2 周分 2 次买入"
        detail = "若基金回撤不超过 3%，继续按计划定投；若单周涨幅过快，则延后下一笔。"
    elif action == "watch":
        trigger = "先观察，暂不主动加仓"
        detail = "等待短期动量企稳或回撤收敛后再评估，必要时设置减仓提醒。"
    else:
        trigger = "维持持有，按月复核"
        detail = "若未来 4 周动量继续改善，可转入分批加仓。"

    return {
        "action": action,
        "amount": amount,
        "timing": trigger,
        "detail": detail,
        "confidence": round(
            0.55
            + min(metrics["period_return"], 0.15)
            + max(0.0, 0.05 - metrics["max_drawdown"]),
            2,
        ),
    }


def recommend_portfolio(
    funds: tuple[FundProfile, ...], investor: InvestorProfile
) -> dict[str, object]:
    eligible = [fund for fund in funds if risk_compatible(fund, investor)]
    if not eligible:
        return {
            "summary": "当前没有与风险等级匹配的基金样例。",
            "recommendations": [],
        }

    ranked = sorted(
        eligible,
        key=lambda item: (quality_score(item), fund_metrics(item)["momentum"]),
        reverse=True,
    )

    limit = {"low": 2, "medium": 3, "high": 3}[investor.risk_level]
    selected = ranked[:limit]
    raw_scores = [quality_score(fund) for fund in selected]
    total_score = sum(raw_scores) or 1

    recommendations: list[dict[str, object]] = []
    for fund, raw_score in zip(selected, raw_scores, strict=True):
        weight = raw_score / total_score
        diagnosis = build_diagnosis(fund)
        recommendations.append(
            {
                "fund": diagnosis,
                "weight": round(weight, 4),
                "allocation_amount": suggested_amount(weight, investor),
                "operation": operation_plan(fund, investor, weight),
            }
        )

    return {
        "summary": (
            f"根据 {RISK_LABELS[investor.risk_level]} 偏好，建议优先配置 "
            f"{len(recommendations)} 只基金，采用分散配置与分批执行。"
        ),
        "investor_profile": {
            "risk_level": investor.risk_level,
            "monthly_budget": investor.monthly_budget,
            "investment_horizon_months": investor.investment_horizon_months,
        },
        "recommendations": recommendations,
    }


def build_nav_history(fund: FundProfile) -> list[dict[str, object]]:
    return [
        {"label": f"M{index}", "value": round(value, 4)}
        for index, value in enumerate(fund.nav_history, start=1)
    ]


def build_nav_chart(fund: FundProfile, peer_funds: list[FundProfile] | None = None) -> dict[str, object]:
    nav_history = build_nav_history(fund)
    series = [
        {
            "name": fund.name,
            "type": "fund",
            "values": [item["value"] for item in nav_history],
        }
    ]
    if peer_funds:
        averaged_values = [
            round(mean(values), 4)
            for values in zip(*(peer.nav_history for peer in peer_funds), strict=True)
        ]
        series.append(
            {
                "name": "同类均值",
                "type": "peer_average",
                "values": averaged_values,
            }
        )
    return {
        "labels": [item["label"] for item in nav_history],
        "series": series,
    }


def build_score_breakdown(fund: FundProfile) -> list[dict[str, object]]:
    metrics = fund_metrics(fund)
    return [
        {"label": "阶段收益", "display": f"{metrics['period_return'] * 100:.2f}%"},
        {"label": "最大回撤", "display": f"{metrics['max_drawdown'] * 100:.2f}%"},
        {"label": "短期动量", "display": f"{metrics['momentum'] * 100:.2f}%"},
        {"label": "经理任期", "display": f"{fund.manager_tenure_years:.1f} 年"},
        {"label": "费率", "display": f"{fund.fee_rate * 100:.2f}%"},
    ]


def related_reason(base_fund: FundProfile, candidate: FundProfile) -> str:
    if candidate.theme == base_fund.theme and candidate.risk_level == base_fund.risk_level:
        return "同主题且风险等级接近，可直接用于横向对比。"
    if candidate.theme == base_fund.theme:
        return "同主题基金，可比较经理风格和净值节奏。"
    if candidate.risk_level == base_fund.risk_level:
        return "风险等级相近，适合补充同风险候选池。"
    return "作为备选基金，可扩展观察范围。"


def build_peer_recommendations(base_fund: FundProfile, funds: tuple[FundProfile, ...]) -> list[dict[str, object]]:
    peers = [
        fund
        for fund in funds
        if fund.fund_id != base_fund.fund_id
        and (fund.theme == base_fund.theme or fund.risk_level == base_fund.risk_level)
    ]
    if not peers:
        peers = [fund for fund in funds if fund.fund_id != base_fund.fund_id]

    ranked = sorted(
        peers,
        key=lambda item: (
            item.theme == base_fund.theme,
            item.risk_level == base_fund.risk_level,
            quality_score(item),
            fund_metrics(item)["momentum"],
        ),
        reverse=True,
    )

    return [
        {
            "fund_id": peer.fund_id,
            "name": peer.name,
            "category": peer.category,
            "theme": peer.theme,
            "risk_label": RISK_LABELS[peer.risk_level],
            "quality_score": quality_score(peer),
            "metrics": {
                "period_return": fund_metrics(peer)["period_return"],
                "momentum": fund_metrics(peer)["momentum"],
            },
            "reason": related_reason(base_fund, peer),
        }
        for peer in ranked[:3]
    ]


def build_fund_snapshot(fund: FundProfile, funds: tuple[FundProfile, ...]) -> dict[str, object]:
    diagnosis = build_diagnosis(fund)
    default_investor = default_investor_for_fund(fund)
    peers = [item for item in funds if item.fund_id != fund.fund_id and item.theme == fund.theme]

    return {
        "fund": {
            **diagnosis,
            "observation_points": len(fund.nav_history),
            "latest_nav": round(fund.nav_history[-1], 4),
            "initial_nav": round(fund.nav_history[0], 4),
        },
        "overview": {
            "summary": (
                f"{fund.name} 当前质量分 {diagnosis['quality_score']}，"
                f"阶段收益 {diagnosis['metrics']['period_return'] * 100:.2f}%，"
                "更适合采用分批观察和执行。"
            ),
            "latest_nav": round(fund.nav_history[-1], 4),
            "manager_tenure_years": fund.manager_tenure_years,
            "fee_rate_display": f"{fund.fee_rate * 100:.2f}%",
        },
        "metrics": diagnosis["metrics"],
        "nav_history": build_nav_history(fund),
        "chart": build_nav_chart(fund, peers[:3]),
        "operation": operation_plan(fund, default_investor, 0.35),
        "strengths": diagnosis["strengths"],
        "cautions": diagnosis["cautions"],
        "peer_recommendations": build_peer_recommendations(fund, funds),
        "score_breakdown": build_score_breakdown(fund),
        "default_investor_profile": {
            "risk_level": default_investor.risk_level,
            "monthly_budget": default_investor.monthly_budget,
            "investment_horizon_months": default_investor.investment_horizon_months,
        },
    }


def build_dashboard_snapshot(funds: tuple[FundProfile, ...]) -> dict[str, object]:
    if not funds:
        return {
            "headline": {"title": "基金机会雷达", "subtitle": "暂无可展示的数据。"},
            "metrics": [],
            "spotlight": None,
            "chart": {"labels": [], "series": []},
            "signals": [],
        }

    diagnoses = [build_diagnosis(fund) for fund in funds]
    avg_return = sum(item["metrics"]["period_return"] for item in diagnoses) / len(diagnoses)
    avg_drawdown = sum(item["metrics"]["max_drawdown"] for item in diagnoses) / len(diagnoses)
    avg_volatility = sum(item["metrics"]["volatility"] for item in diagnoses) / len(diagnoses)
    high_quality_count = sum(1 for item in diagnoses if item["quality_score"] >= 65)
    spotlight = max(
        funds,
        key=lambda item: (quality_score(item), fund_metrics(item)["momentum"]),
    )
    medium_investor = InvestorProfile(
        risk_level="medium",
        monthly_budget=3000,
        investment_horizon_months=12,
    )

    theme_count: dict[str, int] = {}
    for fund in funds:
        theme_count[fund.theme] = theme_count.get(fund.theme, 0) + 1
    dominant_theme, dominant_theme_count = sorted(
        theme_count.items(),
        key=lambda item: item[1],
        reverse=True,
    )[0]

    return {
        "headline": {
            "title": "基金机会雷达",
            "subtitle": "用净值、回撤、动量和研究摘要，快速筛出更值得关注的基金。",
        },
        "metrics": [
            {
                "label": "样例基金池",
                "value": len(funds),
                "display": f"{len(funds)} 只",
                "detail": "已纳入当前原型分析的基金数量",
            },
            {
                "label": "平均阶段收益",
                "value": round(avg_return, 4),
                "display": f"{avg_return * 100:.2f}%",
                "detail": "样例基金近 12 个观察点平均收益",
            },
            {
                "label": "平均最大回撤",
                "value": round(avg_drawdown, 4),
                "display": f"{avg_drawdown * 100:.2f}%",
                "detail": "用于衡量整体防守能力",
            },
            {
                "label": "高质量候选",
                "value": high_quality_count,
                "display": f"{high_quality_count} 只",
                "detail": "质量分大于等于 65 的基金",
            },
            {
                "label": "平均波动",
                "value": round(avg_volatility, 4),
                "display": f"{avg_volatility * 100:.2f}%",
                "detail": "净值波动平均水平",
            },
        ],
        "spotlight": {
            "fund": build_diagnosis(spotlight),
            "operation": operation_plan(spotlight, medium_investor, 0.35),
        },
        "chart": {
            "labels": [f"M{index}" for index in range(1, len(funds[0].nav_history) + 1)],
            "series": [
                {
                    "fund_id": fund.fund_id,
                    "name": fund.name,
                    "theme": fund.theme,
                    "values": [round(value, 4) for value in fund.nav_history],
                }
                for fund in funds
            ],
        },
        "signals": [
            f"当前质量分领先基金是 {spotlight.name}，主题偏向 {spotlight.theme}。",
            f"主题覆盖上，{dominant_theme} 当前出现 {dominant_theme_count} 次。",
            f"样例池平均最大回撤为 {avg_drawdown * 100:.2f}%，更适合分批执行而不是一次性重仓。",
            f"平均波动为 {avg_volatility * 100:.2f}%，建议用研究结论与净值节奏一起决策。",
        ],
    }
