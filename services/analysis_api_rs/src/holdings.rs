use crate::storage;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HoldingLot {
    pub fund_id: String,
    pub shares: f64,
    pub unit_cost: f64,
}

pub fn load_holdings() -> Vec<HoldingLot> {
    let path = storage::holdings_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    serde_json::from_str::<Vec<HoldingLot>>(&raw).unwrap_or_default()
}

pub fn save_holdings(holdings: &[HoldingLot]) -> Result<()> {
    let path = storage::holdings_path();
    storage::ensure_parent(&path).context("ensure holdings dir")?;
    let content = serde_json::to_string_pretty(holdings)?;
    std::fs::write(&path, content).context("write holdings")?;
    Ok(())
}

pub fn parse_holdings_text(text: &str) -> Result<Vec<HoldingLot>> {
    let mut rows: Vec<HoldingLot> = vec![];
    for (index, raw) in text.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split(',').map(|v| v.trim()).collect();
        if parts.len() != 3 {
            return Err(anyhow!("第 {line_no} 行格式错误，应为 fund_id,shares,unit_cost"));
        }
        let fund_id = parts[0].trim().to_string();
        if fund_id.is_empty() {
            return Err(anyhow!("第 {line_no} 行 fund_id 不能为空"));
        }
        let shares: f64 = parts[1]
            .parse()
            .map_err(|_| anyhow!("第 {line_no} 行 shares 格式错误"))?;
        let unit_cost: f64 = parts[2]
            .parse()
            .map_err(|_| anyhow!("第 {line_no} 行 unit_cost 格式错误"))?;
        if shares <= 0.0 {
            return Err(anyhow!("第 {line_no} 行 shares 必须大于 0"));
        }
        if unit_cost <= 0.0 {
            return Err(anyhow!("第 {line_no} 行 unit_cost 必须大于 0"));
        }
        rows.push(HoldingLot {
            fund_id,
            shares,
            unit_cost,
        });
    }

    if rows.is_empty() {
        return Err(anyhow!("未提供持仓内容"));
    }

    Ok(rows)
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum HoldingsPayload {
    Text { text: String },
    Holdings { holdings: Vec<HoldingLot> },
    Raw(String),
}

pub fn parse_holdings_payload(payload: &serde_json::Value) -> Result<Vec<HoldingLot>> {
    if let Some(holdings) = payload.get("holdings") {
        let parsed: Vec<HoldingLot> = serde_json::from_value(holdings.clone())
            .map_err(|_| anyhow!("holdings 字段必须是对象数组"))?;
        if parsed.is_empty() {
            return Err(anyhow!("holdings 字段必须是对象数组"));
        }
        return Ok(parsed);
    }
    if let Some(text) = payload.get("text").and_then(|v| v.as_str()) {
        return parse_holdings_text(text);
    }
    Err(anyhow!("不支持的持仓导入格式"))
}
