use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde_json::{json, Value};

fn category_label(raw: &str) -> String {
    let clean = raw.trim();
    if clean.is_empty() {
        return "其他公告".to_string();
    }

    let mut labels: Vec<&str> = vec![];
    for part in clean.split(',') {
        let t = part.trim();
        if t.is_empty() {
            continue;
        }
        let label = match t {
            "1" => "发行运作",
            "2" => "分红送配",
            "3" => "定期报告",
            "4" => "人事调整",
            "5" => "基金销售",
            "6" => "其他公告",
            _ => "其他公告",
        };
        if !labels.contains(&label) {
            labels.push(label);
        }
    }

    if labels.is_empty() {
        "其他公告".to_string()
    } else {
        labels.join(",")
    }
}

pub async fn fetch_announcements(
    client: &Client,
    fund_code: &str,
    page_index: usize,
    page_size: usize,
    notice_type: &str,
) -> Result<Value> {
    let code = fund_code.trim();
    if code.is_empty() {
        return Err(anyhow!("fund_id 不能为空"));
    }

    let page_index = page_index.max(1);
    let page_size = page_size.clamp(1, 50);
    let notice_type = notice_type.trim();
    let notice_type = if notice_type.is_empty() { "0" } else { notice_type };

    let page_index_s = page_index.to_string();
    let page_size_s = page_size.to_string();

    let url = "https://api.fund.eastmoney.com/f10/JJGG";
    let payload: Value = client
        .get(url)
        .query(&[
            ("fundcode", code),
            ("pageIndex", page_index_s.as_str()),
            ("pageSize", page_size_s.as_str()),
            ("type", notice_type),
        ])
        .header(
            "Referer",
            format!("https://fundf10.eastmoney.com/jjgg_{code}.html"),
        )
        .send()
        .await
        .context("fetch announcements request")?
        .json()
        .await
        .context("parse announcements json")?;

    let err_code = payload.get("ErrCode").and_then(|v| v.as_i64()).unwrap_or(-1);
    if err_code != 0 {
        let msg = payload
            .get("ErrMsg")
            .and_then(|v| v.as_str())
            .unwrap_or("公告接口返回错误");
        return Err(anyhow!(msg.to_string()));
    }

    let total = payload
        .get("TotalCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let rows = payload
        .get("Data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut items: Vec<Value> = vec![];

    for row in rows {
        let id = row.get("ID").and_then(|v| v.as_str()).unwrap_or("").trim();
        let title = row
            .get("TITLE")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let date = row
            .get("PUBLISHDATEDesc")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let category = row
            .get("NEWCATEGORY")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let attach_type = row
            .get("ATTACHTYPE")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();

        if id.is_empty() || title.is_empty() {
            continue;
        }

        let url = format!("https://fund.eastmoney.com/gonggao/{code},{id}.html");
        let pdf_url = if attach_type == "0" {
            Some(format!("https://pdf.dfcfw.com/pdf/H2_{id}_1.pdf"))
        } else {
            None
        };

        items.push(json!({
            "date": date,
            "title": title,
            "type": category_label(category),
            "url": url,
            "pdf_url": pdf_url,
        }));
    }

    Ok(json!({
        "fund_id": code,
        "page_index": page_index,
        "page_size": page_size,
        "total": total,
        "items": items,
        "disclaimer": "公告来自东财 fundf10，仅供参考。",
    }))
}
