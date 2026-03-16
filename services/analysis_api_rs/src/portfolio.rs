use crate::holdings::HoldingLot;
use crate::real_data;
use crate::theme;
use anyhow::Result;
use reqwest::Client;
use serde_json::{json, Value};

pub async fn build_portfolio_snapshot(client: &Client, holdings: &[HoldingLot]) -> Result<Value> {
    let mut positions: Vec<Value> = vec![];

    for lot in holdings {
        let estimate = real_data::fetch_fund_estimate(client, &lot.fund_id).await?;

        let name = estimate
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(lot.fund_id.as_str())
            .to_string();

        let inferred = theme::infer_themes(client, &lot.fund_id, &name).await;

        let latest_nav = estimate.get("latest_nav").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let estimated_nav = estimate
            .get("estimated_nav")
            .and_then(|v| v.as_f64())
            .unwrap_or(latest_nav);
        let estimated_return = estimate
            .get("estimated_return")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);

        let shares = lot.shares;
        let cost_basis = shares * lot.unit_cost;
        let previous_value = shares * latest_nav;
        let current_value = shares * estimated_nav;
        let today_estimated_pnl = current_value - previous_value;
        let total_pnl = current_value - cost_basis;
        let total_return = if cost_basis > 0.0 { total_pnl / cost_basis } else { 0.0 };

        positions.push(json!({
            "fund_id": lot.fund_id,
            "name": name,
            "name_display": name,
            "theme": inferred.theme,
            "themes": inferred.themes,
            "risk_level": "",
            "shares": (shares * 10000.0).round() / 10000.0,
            "unit_cost": (lot.unit_cost * 10000.0).round() / 10000.0,
            "avg_cost": (lot.unit_cost * 10000.0).round() / 10000.0,
            "cost_basis": (cost_basis * 100.0).round() / 100.0,
            "latest_nav": (latest_nav * 10000.0).round() / 10000.0,
            "estimated_nav": (estimated_nav * 10000.0).round() / 10000.0,
            "current_value": (current_value * 100.0).round() / 100.0,
            "market_value": (current_value * 100.0).round() / 100.0,
            "today_estimated_return": (estimated_return * 10000.0).round() / 10000.0,
            "today_return": (estimated_return * 10000.0).round() / 10000.0,
            "today_estimated_pnl": (today_estimated_pnl * 100.0).round() / 100.0,
            "today_profit": (today_estimated_pnl * 100.0).round() / 100.0,
            "total_pnl": (total_pnl * 100.0).round() / 100.0,
            "total_profit": (total_pnl * 100.0).round() / 100.0,
            "total_return": (total_return * 10000.0).round() / 10000.0,
            "estimate_as_of": estimate.get("estimate_as_of").cloned().unwrap_or(json!("")),
            "display_estimate_source_label": estimate.get("display_estimate_source_label").cloned().unwrap_or(json!("自动(官方)")),
            "is_real_data": true,
        }));
    }

    positions.sort_by(|a, b| {
        let av = a.get("current_value").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let bv = b.get("current_value").and_then(|v| v.as_f64()).unwrap_or(0.0);
        bv.partial_cmp(&av).unwrap_or(std::cmp::Ordering::Equal)
    });

    let holding_count = positions.len();
    let total_cost = positions
        .iter()
        .map(|p| p.get("cost_basis").and_then(|v| v.as_f64()).unwrap_or(0.0))
        .sum::<f64>();
    let current_value = positions
        .iter()
        .map(|p| p.get("current_value").and_then(|v| v.as_f64()).unwrap_or(0.0))
        .sum::<f64>();
    let today_estimated_pnl = positions
        .iter()
        .map(|p| p.get("today_estimated_pnl").and_then(|v| v.as_f64()).unwrap_or(0.0))
        .sum::<f64>();
    let total_pnl = positions
        .iter()
        .map(|p| p.get("total_pnl").and_then(|v| v.as_f64()).unwrap_or(0.0))
        .sum::<f64>();

    let total_return = if total_cost > 0.0 { total_pnl / total_cost } else { 0.0 };

    let as_of = chrono::Local::now().format("%H:%M").to_string();

    Ok(json!({
        "estimate_mode": "official",
        "mode_label": "官方估值",
        "as_of": as_of,
        "summary": {
            "holding_count": holding_count,
            "total_cost": (total_cost * 100.0).round() / 100.0,
            "current_value": (current_value * 100.0).round() / 100.0,
            "market_value": (current_value * 100.0).round() / 100.0,
            "today_estimated_pnl": (today_estimated_pnl * 100.0).round() / 100.0,
            "today_profit": (today_estimated_pnl * 100.0).round() / 100.0,
            "today_estimated_return": if current_value > 0.0 { (today_estimated_pnl / current_value * 10000.0).round() / 10000.0 } else { 0.0 },
            "today_return": if current_value > 0.0 { (today_estimated_pnl / current_value * 10000.0).round() / 10000.0 } else { 0.0 },
            "total_pnl": (total_pnl * 100.0).round() / 100.0,
            "total_profit": (total_pnl * 100.0).round() / 100.0,
            "total_return": (total_return * 10000.0).round() / 10000.0,
            "data_quality": {
                "holding_count": holding_count,
                "real_data_holding_count": holding_count,
                "proxy_holding_count": 0,
                "latest_estimate_as_of": "",
                "display_estimate_source_label": "自动(官方)",
            }
        },
        "positions": positions,
        "items": positions,
        "signals": [],
        "data_quality": {
            "holding_count": holding_count,
            "real_data_holding_count": holding_count,
            "proxy_holding_count": 0,
            "latest_estimate_as_of": "",
            "display_estimate_source_label": "自动(官方)",
        },
        "disclaimer": "盘中估值为参考，不构成投资建议。"
    }))
}
