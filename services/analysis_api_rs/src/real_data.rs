use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

pub async fn fetch_fund_estimate(client: &Client, fund_code: &str) -> Result<Value> {
    let code = fund_code.trim();
    if code.is_empty() {
        return Err(anyhow!("fund_id 不能为空"));
    }

    let rt = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let url = format!("https://fundgz.1234567.com.cn/js/{code}.js?rt={rt}");

    let text = client
        .get(url)
        .header("Referer", format!("https://fund.eastmoney.com/{code}.html"))
        .send()
        .await
        .context("fetch fundgz")?
        .text()
        .await
        .context("read fundgz body")?;

    // jsonpgz({...});
    let start = text.find("jsonpgz(").ok_or_else(|| anyhow!("实时估值格式异常"))?;
    let brace_start = text[start..]
        .find('{')
        .map(|idx| start + idx)
        .ok_or_else(|| anyhow!("实时估值格式异常"))?;
    let brace_end = text.rfind('}').ok_or_else(|| anyhow!("实时估值格式异常"))?;
    if brace_end <= brace_start {
        return Err(anyhow!("实时估值格式异常"));
    }

    let json_text = &text[brace_start..=brace_end];
    let mut payload: Value = serde_json::from_str(json_text).context("parse estimate json")?;

    let gszzl = payload
        .get("gszzl")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let estimated_return = (gszzl / 100.0 * 10000.0).round() / 10000.0;

    let latest_nav = payload
        .get("dwjz")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);

    let estimated_nav = payload
        .get("gsz")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(latest_nav);

    let estimate_as_of = payload
        .get("gztime")
        .and_then(|v| v.as_str())
        .and_then(|v| v.split_whitespace().last())
        .unwrap_or("当前")
        .chars()
        .take(5)
        .collect::<String>();

    // Enrich with normalized keys used by the frontend.
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("estimated_return".to_string(), json!(estimated_return));
        obj.insert("latest_nav".to_string(), json!(latest_nav));
        obj.insert("estimated_nav".to_string(), json!(estimated_nav));
        obj.insert("estimate_as_of".to_string(), json!(estimate_as_of));
        obj.insert("estimate_source_label".to_string(), json!("官方估值"));
        obj.insert("display_estimate_source_label".to_string(), json!("自动(官方)"));
        obj.insert("estimate_mode".to_string(), json!("official"));
        obj.insert("is_real_data".to_string(), json!(true));
    }

    Ok(payload)
}
