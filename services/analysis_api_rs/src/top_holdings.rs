use crate::html;
use anyhow::{anyhow, Context, Result};
use regex::Regex;
use reqwest::Client;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
struct Quote {
    price: f64,
    change_rate: f64,
    industry: String,
}

async fn fetch_security_quote(client: &Client, secid: &str) -> Result<Quote> {
    let secid = secid.trim();
    if secid.is_empty() {
        return Err(anyhow!("缺少 secid"));
    }

    let url = format!(
        "https://push2.eastmoney.com/api/qt/stock/get?secid={}&fields=f57,f58,f43,f59,f169,f170,f127,f128",
        urlencoding::encode(secid)
    );

    let payload: Value = client
        .get(url)
        .header("Referer", "https://quote.eastmoney.com/")
        .send()
        .await
        .context("fetch security quote")?
        .json()
        .await
        .context("parse security quote")?;

    let data = payload.get("data").cloned().unwrap_or(json!({}));
    let decimals = data.get("f59").and_then(|v| v.as_i64()).unwrap_or(2);
    let scale = 10_f64.powi(decimals as i32);

    let price_raw = data.get("f43").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let price = (price_raw / scale * scale).round() / scale;

    let change_rate_raw = data.get("f170").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let change_rate = (change_rate_raw / 10000.0 * 10000.0).round() / 10000.0;

    let industry = data
        .get("f127")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(Quote {
        price,
        change_rate,
        industry,
    })
}

pub async fn fetch_top_holdings_with_quotes(
    client: &Client,
    fund_code: &str,
    limit: usize,
) -> Result<Value> {
    let code = fund_code.trim();
    if code.is_empty() {
        return Err(anyhow!("fund_id 不能为空"));
    }

    let topline = limit.clamp(1, 50);
    let url = format!(
        "https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code={}&topline={}",
        urlencoding::encode(code),
        topline
    );

    let source = client
        .get(url)
        .header("Referer", format!("https://fundf10.eastmoney.com/ccmx_{code}.html"))
        .send()
        .await
        .context("fetch top holdings")?
        .text()
        .await
        .context("read top holdings")?;

    let html_text = html::extract_apidata_content(&source);
    if html_text.is_empty() {
        return Ok(json!({ "disclosure_date": "", "items": [] }));
    }

    static DISC_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let disc_re = DISC_RE.get_or_init(|| {
        Regex::new(r"截止至：<font class='px12'>([^<]+)</font>")
            .expect("disclosure regex")
    });
    let disclosure_date = disc_re
        .captures(&html_text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    static TR_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static TD_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static SECID_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

    let tr_re = TR_RE.get_or_init(|| Regex::new(r"(?s)<tr>(.*?)</tr>").expect("tr regex"));
    let td_re = TD_RE.get_or_init(|| Regex::new(r"(?s)<td[^>]*>(.*?)</td>").expect("td regex"));
    let secid_re = SECID_RE.get_or_init(|| Regex::new(r"unify/r/([0-9.]+)").expect("secid regex"));

    let mut items: Vec<Value> = vec![];

    for cap in tr_re.captures_iter(&html_text) {
        let row = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let cells: Vec<String> = td_re
            .captures_iter(row)
            .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
            .collect();
        if cells.len() < 9 {
            continue;
        }

        let secid = secid_re
            .captures(row)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let code_text = html::strip_tags(&cells[1]);
        let name_text = html::strip_tags(&cells[2]);
        let weight_text = html::strip_tags(&cells[6]).replace('%', "");
        let weight_percent = weight_text.trim().parse::<f64>().unwrap_or(0.0);
        if code_text.is_empty() || name_text.is_empty() || weight_percent <= 0.0 {
            continue;
        }

        let quote = if !secid.is_empty() {
            fetch_security_quote(client, &secid).await.ok()
        } else {
            None
        };

        let (price, change_rate, industry) = match quote {
            Some(q) => (q.price, q.change_rate, q.industry),
            None => (0.0, 0.0, "".to_string()),
        };
        let contribution = (weight_percent / 100.0) * change_rate;

        items.push(json!({
            "code": code_text,
            "name": name_text,
            "industry": industry,
            "weight_percent": (weight_percent * 10000.0).round() / 10000.0,
            "price": price,
            "change_rate": (change_rate * 10000.0).round() / 10000.0,
            "contribution": (contribution * 10000.0).round() / 10000.0,
        }));

        if items.len() >= topline {
            break;
        }
    }

    Ok(json!({
        "disclosure_date": disclosure_date,
        "items": items
    }))
}
