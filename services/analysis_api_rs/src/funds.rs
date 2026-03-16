use crate::theme;
use anyhow::{anyhow, Context, Result};
use regex::Regex;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

pub async fn search_funds(client: &Client, query: &str, limit: usize) -> Result<Vec<Value>> {
    let clean = query.trim();
    if clean.is_empty() {
        return Ok(vec![]);
    }

    // If it's already a fund code, try to infer its theme via overview (track target / fund type).
    if clean.len() == 6 && clean.chars().all(|c| c.is_ascii_digit()) {
        let inferred = theme::infer_themes(client, clean, "").await;
        return Ok(vec![json!({
            "fund_id": clean,
            "name": clean,
            "category": "",
            "theme": inferred.theme,
            "themes": inferred.themes,
            "risk_level": "",
        })]);
    }

    let url = format!(
        "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key={}",
        urlencoding::encode(clean)
    );

    let payload: Value = client
        .get(url)
        .header("Referer", "https://fund.eastmoney.com/")
        .send()
        .await
        .context("fund search request")?
        .json()
        .await
        .context("fund search json")?;

    let mut results: Vec<Value> = vec![];
    let mut seen = std::collections::HashSet::new();

    let items = payload
        .get("Datas")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for item in items {
        let code = item
            .get("CODE")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if seen.contains(code) {
            continue;
        }
        seen.insert(code.to_string());
        let name = item
            .get("NAME")
            .and_then(|v| v.as_str())
            .unwrap_or(code)
            .trim();
        let inferred = theme::infer_themes(client, code, name).await;
        results.push(json!({
            "fund_id": code,
            "name": name,
            "name_display": name,
            "category": "",
            "theme": inferred.theme,
            "themes": inferred.themes,
            "risk_level": "",
        }));
        if results.len() >= limit {
            break;
        }
    }

    Ok(results)
}

pub async fn fetch_catalog(client: &Client, page: usize, page_size: usize) -> Result<Value> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 100);

    let today = chrono::Local::now().date_naive();
    let start = today
        .checked_sub_months(chrono::Months::new(12))
        .unwrap_or(today);

    let v = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();

    let url = format!(
        "https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=all&rs=&gs=0&sc=6yzf&st=desc&sd={}&ed={}&qdii=042|&tabSubtype=,,,,,&pi={}&pn={}&dx=1&v={:.6}",
        start,
        today,
        page,
        page_size,
        v
    );

    let text = client
        .get(url)
        .header(
            "Referer",
            "https://fund.eastmoney.com/data/fundranking.html",
        )
        .send()
        .await
        .context("rankhandler request")?
        .text()
        .await
        .context("rankhandler body")?;

    // match: datas:[...],allRecords:123
    let datas_start = text
        .find("datas:")
        .ok_or_else(|| anyhow!("catalog parse failed"))?;
    let bracket_start = text[datas_start..]
        .find('[')
        .map(|idx| datas_start + idx)
        .ok_or_else(|| anyhow!("catalog parse failed"))?;
    let mut level = 0isize;
    let mut end = None;
    for (i, ch) in text[bracket_start..].char_indices() {
        if ch == '[' {
            level += 1;
        } else if ch == ']' {
            level -= 1;
            if level == 0 {
                end = Some(bracket_start + i);
                break;
            }
        }
    }
    let bracket_end = end.ok_or_else(|| anyhow!("catalog parse failed"))?;
    let json_text = &text[bracket_start..=bracket_end];
    let rows: Vec<String> = serde_json::from_str(json_text).unwrap_or_default();

    let mut items: Vec<Value> = vec![];
    for row in rows {
        let parts: Vec<&str> = row.split(',').collect();
        if parts.len() < 5 {
            continue;
        }
        let fund_id = parts[0].trim();
        let name = parts[1].trim();
        let latest_nav = parts[4].trim().parse::<f64>().unwrap_or(0.0);
        if fund_id.len() != 6 || !fund_id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if name.is_empty() {
            continue;
        }
        let inferred = theme::infer_themes(client, fund_id, name).await;
        items.push(json!({
            "fund_id": fund_id,
            "name": name,
            "name_display": name,
            "latest_nav": (latest_nav * 10000.0).round() / 10000.0,
            "category": "",
            "theme": inferred.theme,
            "themes": inferred.themes,
            "risk_level": "",
        }));
    }

    let total_records = Regex::new(r"allRecords\s*:\s*(\d+)")
        .ok()
        .and_then(|re| re.captures(&text))
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(items.len());

    Ok(json!({
        "items": items,
        "total": total_records,
        "page": page,
        "page_size": page_size
    }))
}
