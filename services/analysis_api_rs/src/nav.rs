use anyhow::{anyhow, Context, Result};
use regex::Regex;
use reqwest::Client;
use serde_json::Value;

#[derive(Debug, Clone, Copy)]
pub enum NavRange {
    M1,
    M3,
    M6,
    Y1,
    All,
}

impl NavRange {
    pub fn from_str(value: &str) -> Self {
        match value.trim() {
            "1m" => Self::M1,
            "3m" => Self::M3,
            "6m" => Self::M6,
            "1y" => Self::Y1,
            "all" => Self::All,
            _ => Self::M6,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::M1 => "1m",
            Self::M3 => "3m",
            Self::M6 => "6m",
            Self::Y1 => "1y",
            Self::All => "all",
        }
    }

    pub fn window_days(&self) -> Option<i64> {
        match self {
            Self::M1 => Some(30),
            Self::M3 => Some(90),
            Self::M6 => Some(180),
            Self::Y1 => Some(365),
            Self::All => None,
        }
    }
}

pub async fn fetch_nav_trend_points(client: &Client, fund_code: &str) -> Result<Vec<Value>> {
    let code = fund_code.trim();
    if code.is_empty() {
        return Err(anyhow!("fund_id 不能为空"));
    }

    let url = format!("https://fund.eastmoney.com/pingzhongdata/{code}.js");
    let text = client
        .get(url)
        .header("Referer", format!("https://fund.eastmoney.com/{code}.html"))
        .send()
        .await
        .context("fetch pingzhongdata")?
        .text()
        .await
        .context("read pingzhongdata")?;

    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?s)Data_netWorthTrend\s*=\s*(\[.*?\]);")
            .expect("nav trend regex")
    });

    let caps = re
        .captures(&text)
        .ok_or_else(|| anyhow!("净值曲线解析失败"))?;
    let raw = caps.get(1).map(|m| m.as_str()).unwrap_or("[]");
    let items: Vec<Value> = serde_json::from_str(raw).unwrap_or_default();

    let mut points: Vec<Value> = vec![];
    for item in items {
        let nav = item.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if nav <= 0.0 {
            continue;
        }
        let x = item.get("x").and_then(|v| v.as_i64()).unwrap_or(0);
        if x <= 0 {
            continue;
        }
        // pingzhongdata uses ms.
        let date = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(x)
            .map(|dt| (dt + chrono::Duration::hours(8)).date_naive().to_string())
            .unwrap_or_default();
        points.push(serde_json::json!({
            "x": x,
            "date": date,
            "nav": (nav * 10000.0).round() / 10000.0
        }));
    }

    Ok(points)
}

pub fn filter_points_by_range(points: Vec<Value>, range: NavRange) -> Vec<Value> {
    let Some(days) = range.window_days() else {
        return points;
    };

    let now = chrono::Local::now();
    let cutoff = now - chrono::Duration::days(days);
    let cutoff_ms = cutoff.timestamp_millis();

    let filtered: Vec<Value> = points
        .iter()
        .cloned()
        .filter(|p| p.get("x").and_then(|v| v.as_i64()).unwrap_or(0) >= cutoff_ms)
        .collect();

    if filtered.len() >= 10 {
        return filtered;
    }

    // Avoid too few points after filtering: return last 60 points if possible.
    let keep = 60usize;
    if points.len() <= keep {
        points
    } else {
        points[points.len() - keep..].to_vec()
    }
}
