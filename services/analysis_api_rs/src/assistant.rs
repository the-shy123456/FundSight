use crate::{announcements, holdings, metrics, nav, real_data, theme};
use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde_json::{json, Value};

const ANNOUNCEMENT_EVIDENCE_LABEL: &str = "最新公告（东财 fundf10）";

const PORTFOLIO_QUESTION_KEYWORDS: &[&str] = &[
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
];

fn clamp(value: f64, floor: f64, ceil: f64) -> f64 {
    value.max(floor).min(ceil)
}

fn round_to(value: f64, digits: i32) -> f64 {
    let factor = 10_f64.powi(digits);
    (value * factor).round() / factor
}

fn is_portfolio_question(question: &str) -> bool {
    let clean = question.trim();
    if clean.is_empty() {
        return false;
    }
    PORTFOLIO_QUESTION_KEYWORDS
        .iter()
        .any(|k| clean.contains(k))
}

fn default_question(question: &str) -> String {
    let clean = question.trim();
    if clean.is_empty() {
        "这只基金现在更适合继续拿、减仓还是分批处理？".to_string()
    } else {
        clean.to_string()
    }
}

fn parse_cash_available(payload: &Value) -> f64 {
    payload
        .get("cash_available")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
}

fn parse_fund_id(payload: &Value) -> Option<String> {
    let raw = payload.get("fund_id").and_then(|v| v.as_str()).unwrap_or("");
    let clean = raw.trim();
    if clean.is_empty() {
        None
    } else {
        Some(clean.to_string())
    }
}

async fn fetch_metrics(client: &Client, fund_id: &str) -> metrics::NavMetrics {
    match nav::fetch_nav_trend_points(client, fund_id).await {
        Ok(points) => metrics::compute_nav_metrics(&points),
        Err(_) => metrics::NavMetrics::default(),
    }
}

fn build_forecast(
    estimated_return: f64,
    m: metrics::NavMetrics,
    evidence_refs: Vec<&'static str>,
) -> Value {
    // A lightweight directional heuristic inspired by the Python version.
    let intraday_score = clamp(estimated_return * 1.2, -0.08, 0.08);
    let momentum_score = clamp(m.momentum * 1.6, -0.12, 0.12);
    let drawdown_score = clamp((0.04 - m.max_drawdown) * 0.8, -0.06, 0.06);
    let volatility_penalty = clamp((m.volatility - 0.012) * 1.2, -0.03, 0.07);

    let raw = 0.5 + intraday_score + momentum_score + drawdown_score - volatility_penalty;
    let probability_up = round_to(clamp(raw, 0.1, 0.9), 2);
    let direction = if probability_up >= 0.5 { "up" } else { "down" };

    let rationale = vec![
        format!(
            "盘中官方估值收益 {:+.2}% 作为短线情绪参考。",
            estimated_return * 100.0
        ),
        format!(
            "近 3 个月动量 {:+.2}%、最大回撤 {:.2}%，用于调节方向与置信度。",
            m.momentum * 100.0,
            m.max_drawdown * 100.0
        ),
        format!(
            "日波动率（粗略）≈ {:.2}%，波动越大越不适合高频决策。",
            m.volatility * 100.0
        ),
    ];

    json!({
        "horizon_trading_days": 5,
        "direction": direction,
        "probability_up": probability_up,
        "rationale": rationale,
        "evidence_refs": evidence_refs,
    })
}

fn suggestion_for(direction: &str, probability_up: f64, total_pnl: f64) -> String {
    let direction_probability = if direction == "up" {
        probability_up
    } else {
        1.0 - probability_up
    };
    let confidence = if direction_probability >= 0.6 { "偏高" } else { "一般" };

    match (direction, total_pnl >= 0.0) {
        ("up", true) => format!("短期偏多、置信度{confidence}，可以继续持有但注意分批止盈。"),
        ("up", false) => format!("短期有修复迹象、置信度{confidence}，可观察反弹力度再决定是否补仓。"),
        ("down", true) => format!("回撤风险偏高、置信度{confidence}，建议分批锁定浮盈或提高止损位。"),
        _ => format!("方向偏弱、置信度{confidence}，更适合控制仓位等待企稳。"),
    }
}

fn build_announcement_evidence(items: &[Value]) -> Option<Value> {
    if items.is_empty() {
        return None;
    }

    let latest = &items[0];
    let latest_title = latest
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let latest_date = latest
        .get("date")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    let detail = if !latest_title.is_empty() {
        format!(
            "最近一条：{} {}",
            if latest_date.is_empty() { "--" } else { latest_date },
            latest_title
        )
    } else {
        "用于辅助判断是否存在公告事件影响。".to_string()
    };

    Some(json!({
        "label": ANNOUNCEMENT_EVIDENCE_LABEL,
        "value": format!("近 {} 条", items.len()),
        "detail": detail,
    }))
}

fn evidence_items(
    source_label: &str,
    estimate_as_of: &str,
    estimated_return: f64,
    m: metrics::NavMetrics,
) -> Vec<Value> {
    vec![
        json!({
            "label": source_label,
            "value": format!("{:+.2}%", estimated_return * 100.0),
            "detail": format!("估值时间 {}。", if estimate_as_of.is_empty() { "当前" } else { estimate_as_of }),
        }),
        json!({
            "label": "近 3 个月动量",
            "value": format!("{:+.2}%", m.momentum * 100.0),
            "detail": "用于判断短期趋势是否延续。",
        }),
        json!({
            "label": "最大回撤",
            "value": format!("{:.2}%", m.max_drawdown * 100.0),
            "detail": "回撤越大，越不适合短线频繁操作。",
        }),
    ]
}

pub async fn ask(client: &Client, payload: &Value) -> Result<Value> {
    let question = payload
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let question = default_question(question);
    let cash_available = parse_cash_available(payload);

    let active_holdings = if payload.get("holdings").is_some() || payload.get("text").is_some() {
        holdings::parse_holdings_payload(payload).context("parse holdings payload")?
    } else {
        holdings::load_holdings()
    };

    if active_holdings.is_empty() {
        return Err(anyhow!("请先导入持仓"));
    }

    // Portfolio question.
    if is_portfolio_question(&question) && active_holdings.len() >= 2 {
        let mut candidates: Vec<(f64, Value)> = vec![];

        for lot in &active_holdings {
            let estimate = match real_data::fetch_fund_estimate(client, &lot.fund_id).await {
                Ok(v) => v,
                Err(_) => continue,
            };

            let name = estimate
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(lot.fund_id.as_str())
                .to_string();

            let latest_nav = estimate.get("latest_nav").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let estimated_nav = estimate
                .get("estimated_nav")
                .and_then(|v| v.as_f64())
                .unwrap_or(latest_nav);
            let estimated_return = estimate
                .get("estimated_return")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let estimate_as_of = estimate
                .get("estimate_as_of")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let shares = lot.shares;
            let cost_basis = shares * lot.unit_cost;
            let previous_value = shares * latest_nav;
            let current_value = shares * estimated_nav;
            let today_estimated_pnl = current_value - previous_value;
            let total_pnl = current_value - cost_basis;

            let current_value_rounded = round_to(current_value, 2);

            // For performance, only fetch NAV metrics for the top few by value.
            let m = fetch_metrics(client, &lot.fund_id).await;
            let forecast = build_forecast(estimated_return, m, vec!["官方估值", "动量", "回撤"]);
            let direction = forecast
                .get("direction")
                .and_then(|v| v.as_str())
                .unwrap_or("up");
            let probability_up = forecast
                .get("probability_up")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.5);

            let suggestion = suggestion_for(direction, probability_up, total_pnl);

            let evidence = evidence_items(
                estimate
                    .get("estimate_source_label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("官方估值"),
                estimate_as_of,
                estimated_return,
                m,
            );

            let ann_payload = announcements::fetch_announcements(client, &lot.fund_id, 1, 3, "0")
                .await
                .ok();
            let ann_items: Vec<Value> = ann_payload
                .as_ref()
                .and_then(|v| v.get("items"))
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let announcement_evidence = build_announcement_evidence(&ann_items);

            let item = json!({
                "fund_id": lot.fund_id,
                "name": name,
                "name_display": name,
                "holding": {
                    "current_value": current_value_rounded,
                    "total_pnl": round_to(total_pnl, 2),
                    "today_estimated_pnl": round_to(today_estimated_pnl, 2)
                },
                "forecast": forecast,
                "suggestion": suggestion,
                "evidence": evidence,
                "announcement_evidence": announcement_evidence,
                "announcements": ann_items,
            });

            candidates.push((current_value, item));
        }

        candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let per_fund: Vec<Value> = candidates
            .into_iter()
            .take(8)
            .map(|(_, v)| v)
            .collect();

        let mut up_count = 0usize;
        let mut down_count = 0usize;
        for item in &per_fund {
            match item
                .get("forecast")
                .and_then(|v| v.get("direction"))
                .and_then(|v| v.as_str())
                .unwrap_or("up")
            {
                "down" => down_count += 1,
                _ => up_count += 1,
            }
        }

        let mut portfolio_actions = vec![
            "优先关注下跌概率更高且已有浮盈的基金，分批锁定收益。".to_string(),
            "对上涨概率较高的基金保持观察，避免一次性加仓。".to_string(),
            "若整体波动放大，先把仓位降到自己可承受的回撤区间。".to_string(),
        ];
        if cash_available > 0.0 {
            portfolio_actions.push("如需加仓，建议预设分批承接位，避免追涨。".to_string());
        }

        let summary = format!(
            "组合层面：{} 只基金中 {} 只偏向上行、{} 只偏向回撤，未来 5 个交易日更适合分批处理。",
            per_fund.len(),
            up_count,
            down_count
        );

        return Ok(json!({
            "question": question,
            "summary": summary,
            "portfolio": {
                "holding_count": active_holdings.len(),
                "horizon_trading_days": 5,
                "estimate_mode": "official",
            },
            "per_fund": per_fund,
            "portfolio_actions": portfolio_actions,
            "risks": [
                "组合判断基于官方盘中估值与历史净值曲线的粗略指标，仍不等于最终净值。",
                "短线高频操作容易被震荡反复打脸，建议以分批执行为主。",
            ],
            "disclaimer": "该回答是样例级决策辅助，不构成收益承诺、投顾建议或真实交易指令。"
        }));
    }

    // Single fund question.
    let fund_id = parse_fund_id(payload).or_else(|| active_holdings.first().map(|v| v.fund_id.clone()));
    let fund_id = fund_id.ok_or_else(|| anyhow!("请先选择基金或导入持仓"))?;

    let estimate = real_data::fetch_fund_estimate(client, &fund_id)
        .await
        .context("fetch fund estimate")?;

    let name = estimate
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(fund_id.as_str())
        .to_string();
    let latest_nav = estimate.get("latest_nav").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let estimated_nav = estimate
        .get("estimated_nav")
        .and_then(|v| v.as_f64())
        .unwrap_or(latest_nav);
    let estimated_return = estimate
        .get("estimated_return")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let estimate_as_of = estimate
        .get("estimate_as_of")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let holding = active_holdings.iter().find(|h| h.fund_id == fund_id);

    let (current_value, total_pnl, today_estimated_pnl) = if let Some(lot) = holding {
        let shares = lot.shares;
        let cost_basis = shares * lot.unit_cost;
        let previous_value = shares * latest_nav;
        let current_value = shares * estimated_nav;
        let today_estimated_pnl = current_value - previous_value;
        let total_pnl = current_value - cost_basis;
        (current_value, total_pnl, today_estimated_pnl)
    } else {
        (0.0, 0.0, 0.0)
    };

    let m = fetch_metrics(client, &fund_id).await;
    let forecast = build_forecast(estimated_return, m, vec!["官方估值", "动量", "回撤"]);

    let direction = forecast
        .get("direction")
        .and_then(|v| v.as_str())
        .unwrap_or("up");
    let probability_up = forecast
        .get("probability_up")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.5);

    let direction_label = if direction == "up" { "上涨" } else { "下跌" };
    let direction_probability = if direction == "up" {
        probability_up
    } else {
        1.0 - probability_up
    };

    let mut summary = format!(
        "{name} 当前更适合按计划分批处理，而不是把下周涨跌当成确定答案。未来5个交易日方向预测：{direction_label}（概率{:.0}%）。",
        direction_probability * 100.0
    );

    if holding.is_some() && total_pnl > 0.0 {
        summary = format!(
            "{name} 已有浮盈，更适合分批止盈或抬高止损位。未来5个交易日方向预测：{direction_label}（概率{:.0}%）。",
            direction_probability * 100.0
        );
    }
    if cash_available > 0.0 {
        summary.push_str(&format!(" 若你还有 ¥{:.0} 机动资金，建议分两到三笔观察回撤承接。", cash_available));
    }

    let mut evidence = evidence_items(
        estimate
            .get("estimate_source_label")
            .and_then(|v| v.as_str())
            .unwrap_or("官方估值"),
        estimate_as_of,
        estimated_return,
        m,
    );

    let ann_payload = announcements::fetch_announcements(client, &fund_id, 1, 6, "0")
        .await
        .ok();
    let ann_items: Vec<Value> = ann_payload
        .as_ref()
        .and_then(|v| v.get("items"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if let Some(ev) = build_announcement_evidence(&ann_items) {
        evidence.push(ev);
    }

    let inferred = theme::infer_themes(client, &fund_id, &name).await;

    let actions = vec![
        json!({
            "title": "继续持有",
            "fit": if direction == "up" { "高" } else { "中" },
            "detail": "若你更看重趋势延续，可以继续拿，但要接受短期波动与估算误差。",
        }),
        json!({
            "title": "分批止盈",
            "fit": if holding.is_some() && total_pnl > 0.0 { "高" } else { "中" },
            "detail": "更适合已经有浮盈的仓位，通过分批落袋降低判断错误成本。",
        }),
        json!({
            "title": "回撤承接",
            "fit": if cash_available > 0.0 { "中" } else { "低" },
            "detail": "只有在你还能接受继续回撤时才考虑，建议预设分批承接位。",
        }),
    ];

    Ok(json!({
        "question": question,
        "fund": {
            "fund_id": fund_id,
            "name": name,
            "theme": inferred.theme,
            "themes": inferred.themes,
            "risk_label": "",
        },
        "summary": summary,
        "evidence": evidence,
        "announcements": ann_items,
        "actions": actions,
        "forecast": forecast,
        "risks": [
            "盘中收益来自官方估值参考，仍不等于基金公司最终净值与真实成交结果。",
            "短线高频操作容易被震荡反复打脸，建议以分批执行为主。",
        ],
        "confidence": {
            "score": 0.62,
            "label": "中",
            "reason": "置信度来自盘中估值、历史净值动量与回撤等粗略指标综合。",
        },
        "disclaimer": "该回答是样例级决策辅助，不构成收益承诺、投顾建议或真实交易指令。",
        "holding": {
            "current_value": round_to(current_value, 2),
            "total_pnl": round_to(total_pnl, 2),
            "today_estimated_pnl": round_to(today_estimated_pnl, 2)
        }
    }))
}
