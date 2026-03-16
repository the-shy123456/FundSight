use crate::html;
use anyhow::{anyhow, Context, Result};
use regex::Regex;
use reqwest::Client;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Default)]
pub struct FundOverview {
    pub fund_type: String,
    pub track_target: String,
    pub benchmark: String,
}

fn normalize_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_whitespace() {
            continue;
        }
        // Strip common punctuation in fund names.
        if matches!(
            ch,
            '（' | '）' | '(' | ')' | '【' | '】' | '[' | ']' | '《' | '》' | '—' | '-' | '_' | '·' | '•' | '/'
                | '\\' | '|' | ':' | '：' | '，' | ',' | '。' | '.' | '、'
        ) {
            continue;
        }
        out.push(ch);
    }
    out.to_uppercase()
}

fn is_index_like_name(name: &str) -> bool {
    let upper = normalize_text(name);
    upper.contains("ETF")
        || upper.contains("指数")
        || upper.contains("联接")
        || upper.contains("LOF")
        || upper.contains("增强")
}

static OVERVIEW_CACHE: OnceLock<Mutex<HashMap<String, (Instant, FundOverview)>>> = OnceLock::new();

fn overview_cache() -> &'static Mutex<HashMap<String, (Instant, FundOverview)>> {
    OVERVIEW_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn fetch_fund_overview(client: &Client, fund_code: &str) -> Result<FundOverview> {
    let code = fund_code.trim();
    if code.is_empty() {
        return Err(anyhow!("fund_id 不能为空"));
    }

    let ttl = Duration::from_secs(86400);
    {
        let guard = overview_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some((ts, cached)) = guard.get(code) {
            if ts.elapsed() <= ttl {
                return Ok(cached.clone());
            }
        }
    }

    let url = format!("https://fundf10.eastmoney.com/jbgk_{code}.html");
    let html_text = client
        .get(url)
        .header("Referer", "https://fundf10.eastmoney.com/")
        .send()
        .await
        .context("fetch fund overview")?
        .text()
        .await
        .context("read fund overview")?;

    fn extract(label: &str, html_text: &str) -> String {
        // Example: <th>基金类型</th><td>指数型-股票</td>
        let escaped = regex::escape(label);
        let re1 = Regex::new(&format!(
            r#"{}</th>\s*<td[^>]*>(.*?)</td>"#,
            escaped
        ))
        .ok();
        let re2 = Regex::new(&format!(
            r#"<th[^>]*>{}</th>\s*<td[^>]*>(.*?)</td>"#,
            escaped
        ))
        .ok();
        let raw = re1
            .as_ref()
            .and_then(|re| re.captures(html_text))
            .or_else(|| re2.as_ref().and_then(|re| re.captures(html_text)))
            .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
            .unwrap_or_default();
        html::strip_tags(&raw)
    }

    let overview = FundOverview {
        fund_type: extract("基金类型", &html_text),
        track_target: extract("跟踪标的", &html_text),
        benchmark: extract("业绩比较基准", &html_text),
    };

    {
        let mut guard = overview_cache().lock().unwrap_or_else(|e| e.into_inner());
        guard.insert(code.to_string(), (Instant::now(), overview.clone()));
    }

    Ok(overview)
}

// The canonical labels follow the screenshot from "养基宝" (板块名称页)。
// NOTE: keyword rules are intentionally conservative; step-2 can use holdings-based classification.
static THEME_RULES: &[(&'static str, &'static [&'static str])] = &[
    ("红利低波", &["红利低波", "低波红利"]),
    ("港股红利", &["港股红利", "港股高股息", "恒生高股息", "高股息港股"]),
    ("沪港深消费", &["沪港深消费", "港股消费", "港股消费"]),
    ("海外医药", &["海外医药", "美股医药", "海外医疗"]),

    ("恒生科技", &["恒生科技", "HSTECH", "恒生科", "恒生科技指数"]),
    ("恒生", &["恒生", "HSI", "恒生指数"]),
    ("标普", &["标普", "S&P", "SP500", "标普500"]),
    ("亚太", &["亚太", "亚太精选"]),

    ("沪深300", &["沪深300", "HS300"]),
    ("上证50", &["上证50", "上证50ETF"]),
    ("中证500", &["中证500"]),
    ("双创50", &["双创50"]),
    ("创业板", &["创业板", "创业板指"]),
    ("科创板", &["科创板", "科创50", "科创"]),
    ("北证", &["北证", "北交所"]),

    ("货币基金", &["货币基金", "货币"]),
    ("债基", &["债基", "债券", "债券型"]),
    ("混债", &["混债", "偏债", "债券增强", "二级债"]),
    ("可转债", &["可转债", "转债"]),

    ("存储芯片", &["存储芯片", "存储", "DRAM", "NAND", "闪存", "内存"]),
    ("半导体材料设备", &["半导体材料", "半导体设备", "材料设备", "光刻", "晶圆"]),
    ("半导体", &["半导体", "芯片"]),
    ("CPO", &["CPO"]),
    ("云计算", &["云计算", "云", "CLOUD"]),
    ("AI应用", &["AI应用", "AIGC", "大模型应用"]),
    ("人工智能", &["人工智能", "AI", "AIGC", "大模型", "算力"]),
    ("大科技", &["大科技"]),
    ("通信", &["通信"]),
    ("消费电子", &["消费电子"]),
    ("传媒游戏", &["传媒", "游戏"]),

    ("机器人", &["机器人"]),
    ("低空经济", &["低空经济", "EVTOL", "飞行汽车"]),
    ("商业航天", &["商业航天", "卫星", "航天"]),
    ("脑机接口", &["脑机接口", "BCI"]),
    ("可控核聚变", &["可控核聚变", "核聚变"]),

    ("固态电池", &["固态电池", "固态"]),
    ("储能", &["储能"]),
    ("锂矿", &["锂矿", "锂"]),
    ("新能源", &["新能源", "光伏", "风电", "新能源车", "新能源汽车"]),
    ("电网设备", &["电网设备", "特高压", "电网", "电力设备"]),
    ("电力", &["电力"]),

    ("油气资源", &["油气", "油气资源", "石油", "天然气"]),
    ("煤炭", &["煤炭"]),
    ("黄金股", &["黄金股"]),
    ("黄金", &["黄金"]),
    ("有色金属", &["有色金属", "有色"]),
    ("稀土永磁", &["稀土永磁", "稀土"]),
    ("钢铁", &["钢铁"]),
    ("化工", &["化工"]),

    ("证券保险", &["证券", "券商", "保险"]),
    ("金融科技", &["金融科技"]),

    ("食品饮料", &["食品饮料"]),
    ("白酒", &["白酒"]),
    ("家用电器", &["家用电器"]),
    ("交通运输", &["交通运输", "交运"]),
    ("汽车整车", &["汽车整车", "整车"]),
    ("房地产", &["房地产", "地产"]),
    ("农林牧渔", &["农林牧渔"]),

    ("创新药", &["创新药"]),
    ("医药", &["医药"]),
    ("医疗", &["医疗"]),
    ("养老产业", &["养老产业", "养老"]),

    ("先进制造", &["先进制造", "高端制造", "智能制造"]),
    ("基建", &["基建"]),

    ("红利", &["红利", "高股息"]),
    ("蓝筹", &["蓝筹"]),
    ("现金流", &["现金流", "自由现金流"]),
    ("量化", &["量化"]),
    ("小微盘量化", &["小微盘量化", "小微盘"]),
    ("微盘股", &["微盘股", "微盘"]),
];

fn detect_by_text(text: &str, weight: f64, scores: &mut HashMap<&'static str, f64>) {
    let norm = normalize_text(text);
    if norm.is_empty() {
        return;
    }

    for (theme, keywords) in THEME_RULES.iter() {
        let theme = *theme;
        let keywords = *keywords;

        let mut hit_score = 0.0f64;
        for keyword in keywords.iter() {
            let k = normalize_text(keyword);
            if k.is_empty() {
                continue;
            }
            if norm.contains(&k) {
                // Prefer longer keywords (more specific).
                let len = keyword.chars().count().max(1) as f64;
                hit_score += len;
            }
        }
        if hit_score > 0.0 {
            *scores.entry(theme).or_insert(0.0) += hit_score * weight;
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ThemeInfo {
    pub theme: String,
    pub themes: Vec<String>,
    pub source: String,
    pub confidence: f64,
}

fn finalize_scores(mut scores: HashMap<&'static str, f64>) -> Vec<(&'static str, f64)> {
    let mut items: Vec<(&'static str, f64)> = scores.drain().collect();
    items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    items
}

pub async fn infer_themes(client: &Client, fund_id: &str, name: &str) -> ThemeInfo {
    let mut scores: HashMap<&'static str, f64> = HashMap::new();

    detect_by_text(name, 1.0, &mut scores);

    let mut source = "name".to_string();

    // Only fetch overview for index-like funds (or when we have no name at all).
    // Avoid hammering upstream for generic active funds.
    if is_index_like_name(name) || name.trim().is_empty() {
        if let Ok(overview) = fetch_fund_overview(client, fund_id).await {
            if !overview.track_target.is_empty() {
                detect_by_text(&overview.track_target, 0.75, &mut scores);
                source = "track_target".to_string();
            }
            if !overview.fund_type.is_empty() {
                detect_by_text(&overview.fund_type, 0.65, &mut scores);
            }
            // Hard category-like fallbacks from fund type.
            let ft = overview.fund_type;
            if ft.contains("货币") {
                scores.insert("货币基金", 99.0);
                source = "fund_type".to_string();
            } else if ft.contains("债") {
                // Not forcing 混债/可转债 here; leave to keyword matches.
                scores.entry("债基").or_insert(20.0);
                source = "fund_type".to_string();
            }
        }
    }

    let sorted = finalize_scores(scores);
    let themes: Vec<String> = sorted.iter().take(5).map(|(t, _)| (*t).to_string()).collect();
    let theme = themes.first().cloned().unwrap_or_default();

    // A very rough confidence proxy.
    let confidence = if sorted.is_empty() {
        0.0
    } else if sorted.len() == 1 {
        0.85
    } else {
        let top = sorted[0].1;
        let second = sorted[1].1;
        if top <= 0.0 {
            0.0
        } else {
            ((top - second) / top).clamp(0.25, 0.9)
        }
    };

    ThemeInfo {
        theme,
        themes,
        source,
        confidence,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_multiple_themes() {
        let mut scores: HashMap<&'static str, f64> = HashMap::new();
        detect_by_text("某某CPO通信ETF", 1.0, &mut scores);
        let sorted = finalize_scores(scores);
        let themes: Vec<&'static str> = sorted.iter().map(|(t, _)| *t).collect();
        assert!(themes.contains(&"CPO"));
        assert!(themes.contains(&"通信"));
    }

    #[test]
    fn detects_index_theme() {
        let mut scores: HashMap<&'static str, f64> = HashMap::new();
        detect_by_text("沪深300ETF联接A", 1.0, &mut scores);
        let sorted = finalize_scores(scores);
        assert_eq!(sorted.first().map(|v| v.0), Some("沪深300"));
    }

    #[test]
    fn detects_bond_like_theme() {
        let mut scores: HashMap<&'static str, f64> = HashMap::new();
        detect_by_text("某某可转债增强", 1.0, &mut scores);
        let sorted = finalize_scores(scores);
        let themes: Vec<&'static str> = sorted.iter().map(|(t, _)| *t).collect();
        assert!(themes.contains(&"可转债"));
    }
}
