use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
use std::time::Duration;

use crate::funds;

const FUND_LINE_BLACKLIST: &[&str] = &[
    "账户资产",
    "当日总收益",
    "持仓收益",
    "关联板块",
    "持有基金",
    "持有金额",
    "持有收益",
    "同步持仓",
    "批量加减仓",
    "支付宝",
    "账户汇总",
    "持仓资讯",
    "已更新",
    "完成",
    "同步添加到自选",
    "去相册选择截图",
    "手动输入",
    "新增到",
    "深证成指",
    "上证指数",
    "创业板指",
    "黄金9999",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OcrPayload {
    #[serde(default)]
    text: String,
    #[serde(default)]
    lines: Vec<String>,
}

fn clean_ocr_line(value: &str) -> String {
    let normalized = value
        .replace('￥', "¥")
        .replace('，', ",")
        .replace('（', "(")
        .replace('）', ")")
        .replace('—', "-")
        .replace('−', "-")
        .replace('．', ".")
        .replace('。', ".");
    normalized
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .trim()
        .to_string()
}

fn contains_blacklist_term(value: &str) -> bool {
    FUND_LINE_BLACKLIST.iter().any(|k| value.contains(k))
}

fn sanitize_search_query(value: &str) -> String {
    // Drop ellipsis and strip obvious numeric columns.
    let ellipsis_re = Regex::new(r"(?:\.\.\.|…)+").unwrap();
    let mut text = ellipsis_re.replace_all(value, "").to_string();

    // Stop at known separators / columns.
    for marker in ["持有金额", "持有收益", "¥", "￥"] {
        if let Some((head, _)) = text.split_once(marker) {
            text = head.to_string();
        }
    }

    // Stop at first signed number like +12.34 / -56.78 (profit column).
    let signed_re = Regex::new(r"[+\-]\d").unwrap();
    if let Some(m) = signed_re.find(&text) {
        text = text[..m.start()].to_string();
    }

    // Keep only Chinese (Han) / alpha / digits / parentheses.
    let keep_re = Regex::new(r"[^\p{Han}A-Za-z0-9()]+").unwrap();
    let clean = keep_re.replace_all(&text, "").to_string();

    clean.chars().take(22).collect()
}

fn is_fund_title_candidate(value: &str) -> bool {
    if value.is_empty() || contains_blacklist_term(value) {
        return false;
    }
    if value.contains('%') {
        return false;
    }
    if Regex::new(r"^[¥+\-0-9./]+$").unwrap().is_match(value) {
        return false;
    }

    let query = sanitize_search_query(value);
    if query.len() < 3 {
        return false;
    }
    let count = Regex::new(r"[\p{Han}A-Za-z]")
        .unwrap()
        .find_iter(&query)
        .count();
    count >= 3
}

fn parse_amount_token(raw: &str, unit: &str) -> Option<f64> {
    let cleaned = raw.trim().replace(',', "");
    if cleaned.is_empty() {
        return None;
    }
    let mut value: f64 = cleaned.parse().ok()?;
    if unit.contains('万') {
        value *= 10000.0;
    }
    Some(value)
}

fn extract_amount_value(line: &str) -> String {
    // Skip obvious non-amount rows.
    if line.contains('%') || line.starts_with('+') || line.starts_with('-') {
        return "".to_string();
    }

    // Avoid treating dates/time-only rows as amount anchors.
    if !Regex::new(r"[\p{Han}A-Za-z]").unwrap().is_match(line) {
        return "".to_string();
    }

    // Prefer currency patterns, support comma + 万.
    let currency_re = Regex::new(r"[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)(万?)").unwrap();
    if let Some(caps) = currency_re.captures(line) {
        let number = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let unit = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if let Some(v) = parse_amount_token(number, unit) {
            if v > 0.0 {
                return format!("{v:.2}");
            }
        }
    }

    // Fallback: scan numbers and pick a reasonable candidate (amount is usually the largest).
    let token_re = Regex::new(r"([0-9][0-9,]*(?:\.[0-9]{1,2})?)(万?)").unwrap();
    let mut candidates: Vec<f64> = vec![];
    for caps in token_re.captures_iter(line) {
        let raw = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let unit = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        // Skip likely fund codes (6 digits).
        if unit.is_empty() && raw.len() == 6 && raw.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if let Some(v) = parse_amount_token(raw, unit) {
            if v > 0.0 {
                candidates.push(v);
            }
        }
    }

    if candidates.is_empty() {
        return "".to_string();
    }

    // Prefer >= 50, else take the max.
    let mut preferred: Vec<f64> = candidates.iter().copied().filter(|v| *v >= 50.0).collect();
    let chosen = if !preferred.is_empty() {
        preferred
            .drain(..)
            .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or(0.0)
    } else {
        candidates
            .into_iter()
            .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or(0.0)
    };

    if chosen > 0.0 {
        format!("{chosen:.2}")
    } else {
        "".to_string()
    }
}

fn find_amount_indexes(lines: &[String]) -> Vec<usize> {
    lines
        .iter()
        .enumerate()
        .filter_map(|(idx, line)| {
            let v = extract_amount_value(line);
            if v.is_empty() {
                None
            } else {
                Some(idx)
            }
        })
        .collect()
}

fn pick_profit(block_lines: &[String], amount: &str) -> String {
    let joined = block_lines.join(" ");

    let signed_re = Regex::new(r"([+\-][0-9]+(?:\.[0-9]{1,2})?)").unwrap();
    let mut signed_candidates: Vec<String> = vec![];
    for cap in signed_re.captures_iter(&joined) {
        let value = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        if value.is_empty() {
            continue;
        }
        if joined.contains(&format!("{value}%")) {
            continue;
        }
        signed_candidates.push(value.to_string());
    }

    if let Some(picked) = signed_candidates.last() {
        if let Ok(number) = picked.parse::<f64>() {
            let keep_plus = picked.starts_with('+') && signed_candidates.iter().any(|v| v.starts_with('-'));
            if keep_plus {
                return format!("+{number:.2}");
            }
            return format!("{number:.2}");
        }
    }

    let amount_value = amount.parse::<f64>().unwrap_or(0.0);
    let plain_re = Regex::new(r"([0-9]+(?:\.[0-9]{1,2})?)").unwrap();
    let mut candidates: Vec<f64> = vec![];
    for cap in plain_re.captures_iter(&joined) {
        if let Some(m) = cap.get(1) {
            if let Ok(v) = m.as_str().parse::<f64>() {
                if (v - amount_value).abs() < 1e-6 {
                    continue;
                }
                if v < amount_value.max(1_000_000.0) && v < amount_value {
                    candidates.push(v);
                }
            }
        }
    }

    if let Some(picked) = candidates
        .into_iter()
        .max_by(|a, b| a.abs().partial_cmp(&b.abs()).unwrap_or(std::cmp::Ordering::Equal))
    {
        return format!("{picked:.2}");
    }

    "".to_string()
}

fn score_match(query: &str, item: &Value) -> (i32, i32) {
    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let code = item.get("fund_id").and_then(|v| v.as_str()).unwrap_or("");

    let mut score = 0i32;
    if code == query {
        score += 100;
    }
    if name == query {
        score += 80;
    }
    if !query.is_empty() && name.starts_with(query) {
        score += 60;
    }
    if !query.is_empty() && name.contains(query) {
        score += 40;
    }
    (score, -(name.chars().count() as i32))
}

fn pick_best_match(query: &str, matches: &[Value]) -> Option<Value> {
    matches
        .iter()
        .cloned()
        .max_by(|a, b| score_match(query, a).cmp(&score_match(query, b)))
}

async fn build_suggestion(
    client: &Client,
    amount_line_index: usize,
    next_amount_index: usize,
    lines: &[String],
) -> Result<Option<Value>> {
    let amount = extract_amount_value(&lines[amount_line_index]);
    if amount.is_empty() {
        return Ok(None);
    }

    let mut title_index: Option<usize> = None;
    let start = amount_line_index.saturating_sub(4);
    for idx in (start..=amount_line_index).rev() {
        if is_fund_title_candidate(&lines[idx]) {
            title_index = Some(idx);
            break;
        }
    }
    let Some(title_index) = title_index else {
        return Ok(None);
    };

    let query = sanitize_search_query(&lines[title_index]);
    if query.is_empty() {
        return Ok(None);
    }

    let block_lines = &lines[title_index..next_amount_index.min(lines.len())];
    let matches = funds::search_funds_basic(client, &query, 3).await.unwrap_or_default();
    let top = pick_best_match(&query, &matches).unwrap_or(json!({}));

    let fund_query = top
        .get("fund_id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .unwrap_or(query.as_str())
        .to_string();

    let fund_name = top
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .unwrap_or(query.as_str())
        .to_string();

    Ok(Some(json!({
        "fundQuery": fund_query,
        "fundName": fund_name,
        "amount": amount,
        "profit": pick_profit(block_lines, &amount),
        "match_count": matches.len(),
        "raw_text": block_lines.join(" "),
    })))
}

pub async fn parse_holdings_from_ocr_text(client: &Client, text: &str) -> Value {
    let mut lines: Vec<String> = text
        .lines()
        .map(clean_ocr_line)
        .filter(|v| !v.is_empty())
        .collect();

    // If OCR returns a single big blob, do an extra split.
    if lines.len() <= 2 && text.contains(' ') {
        let expanded: Vec<String> = text
            .split(|c| c == '\n' || c == '\r')
            .flat_map(|line| line.split(' '))
            .map(clean_ocr_line)
            .filter(|v| !v.is_empty())
            .collect();
        if expanded.len() > lines.len() {
            lines = expanded;
        }
    }

    let amount_indexes = find_amount_indexes(&lines);
    let mut suggestions: Vec<Value> = vec![];
    let mut used_title_indexes: std::collections::HashSet<usize> = std::collections::HashSet::new();

    for (pos, amount_index) in amount_indexes.iter().enumerate() {
        let next_amount_index = amount_indexes.get(pos + 1).copied().unwrap_or(lines.len());

        let mut title_index: Option<usize> = None;
        let start = amount_index.saturating_sub(4);
        for idx in (start..=*amount_index).rev() {
            if is_fund_title_candidate(&lines[idx]) {
                title_index = Some(idx);
                break;
            }
        }
        if let Some(tidx) = title_index {
            if used_title_indexes.contains(&tidx) {
                continue;
            }
        }

        match build_suggestion(client, *amount_index, next_amount_index, &lines).await {
            Ok(Some(suggestion)) => {
                if let Some(tidx) = title_index {
                    used_title_indexes.insert(tidx);
                }
                suggestions.push(suggestion);
            }
            _ => continue,
        }
    }

    if suggestions.is_empty() {
        let fund_indexes: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter_map(|(idx, line)| if is_fund_title_candidate(line) { Some(idx) } else { None })
            .collect();

        for (pos, start_index) in fund_indexes.iter().enumerate() {
            let end_index = fund_indexes.get(pos + 1).copied().unwrap_or(lines.len());
            let block_lines = &lines[*start_index..end_index];
            let query = sanitize_search_query(block_lines.first().map(|v| v.as_str()).unwrap_or(""));
            let amount = extract_amount_value(&block_lines.join(" "));
            if query.is_empty() || amount.is_empty() {
                continue;
            }

            let matches = funds::search_funds_basic(client, &query, 3).await.unwrap_or_default();
            let top = pick_best_match(&query, &matches).unwrap_or(json!({}));

            let fund_query = top
                .get("fund_id")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .unwrap_or(query.as_str())
                .to_string();

            let fund_name = top
                .get("name")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .unwrap_or(query.as_str())
                .to_string();

            suggestions.push(json!({
                "fundQuery": fund_query,
                "fundName": fund_name,
                "amount": amount,
                "profit": pick_profit(block_lines, &amount),
                "match_count": matches.len(),
                "raw_text": block_lines.join(" "),
            }));
        }
    }

    let mut warnings: Vec<String> = vec![];
    if suggestions.is_empty() {
        warnings.push("没有稳定识别出持仓行，请改用手动输入或更清晰的截图。".to_string());
    } else {
        warnings.push("OCR 为辅助识别，建议检查基金、金额、收益是否正确后再点完成。".to_string());
    }

    json!({
        "text": lines.join("\n"),
        "lines": lines,
        "suggestions": suggestions,
        "warnings": warnings,
    })
}

fn detect_extension_from_bytes(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 8 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return "png";
    }
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return "jpg";
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return "webp";
    }
    "png"
}

fn decode_image_data(image_data: &str) -> Result<(Vec<u8>, String)> {
    let raw = image_data.trim();
    if raw.is_empty() {
        return Err(anyhow!("缺少截图内容"));
    }

    if raw.starts_with("data:image/") {
        let (meta, b64) = raw
            .split_once("base64,")
            .ok_or_else(|| anyhow!("截图格式错误，需使用 base64 图片数据"))?;
        let ext = meta
            .trim_start_matches("data:image/")
            .split(';')
            .next()
            .unwrap_or("png")
            .trim()
            .to_lowercase()
            .replace("jpeg", "jpg");

        let bytes = BASE64
            .decode(b64)
            .map_err(|_| anyhow!("图片解码失败：请重新截图或换一张更清晰的图片。"))?;
        return Ok((bytes, ext));
    }

    // Also allow raw base64.
    let bytes = BASE64
        .decode(raw)
        .map_err(|_| anyhow!("图片解码失败：请重新截图或换一张更清晰的图片。"))?;
    let ext = detect_extension_from_bytes(&bytes).to_string();
    Ok((bytes, ext))
}

#[cfg(target_os = "windows")]
async fn ocr_image_file(image_path: &Path) -> Result<OcrPayload> {
    use tokio::process::Command;

    let safe_path = image_path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\"\"");

    // Ported from services/analysis_api/ocr_import.py (PowerShell WinRT OCR).
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.ExifOrientationMode, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.ColorManagementMode, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
function AwaitResult($AsyncOp, $Type) {{
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {{
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1
  }} | Select-Object -First 1
  $generic = $method.MakeGenericMethod($Type)
  $task = $generic.Invoke($null, @($AsyncOp))
  return $task.Result
}}
$path = "{path}"
$lang = New-Object Windows.Globalization.Language('zh-Hans')
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) {{ throw '当前系统不支持中文 OCR' }}
$file = AwaitResult ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$stream = AwaitResult ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = AwaitResult ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])

# Upscale small images to improve OCR for phone photos.
$transform = New-Object Windows.Graphics.Imaging.BitmapTransform
$w = [uint32]$decoder.PixelWidth
$h = [uint32]$decoder.PixelHeight
$scale = 1
if ($w -lt 1600) { $scale = 2 }
$scaledW = [uint32]([math]::Min($w * $scale, 4000))
$scaledH = [uint32]([math]::Min($h * $scale, 4000))
$transform.ScaledWidth = $scaledW
$transform.ScaledHeight = $scaledH

$bitmap = AwaitResult ($decoder.GetSoftwareBitmapAsync(
  [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
  [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
  $transform,
  [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
  [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
)) ([Windows.Graphics.Imaging.SoftwareBitmap])

$result = AwaitResult ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
foreach ($line in $result.Lines) {{ $lines += $line.Text }}
@{{ text = $result.Text; lines = $lines }} | ConvertTo-Json -Depth 4 -Compress
"#,
        path = safe_path
    );

    let mut cmd = Command::new("powershell.exe");
    cmd.arg("-NoProfile").arg("-Command").arg(script);

    let output = tokio::time::timeout(Duration::from_secs(45), cmd.output())
        .await
        .context("OCR timeout")
        .map_err(|_| anyhow!("OCR 超时：请换一张更小/更清晰的截图"))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if !stderr.is_empty() { stderr } else { stdout };
        return Err(anyhow!(message));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let payload: OcrPayload = serde_json::from_str(&stdout)
        .with_context(|| format!("ocr json parse failed: {}", stdout.chars().take(80).collect::<String>()))?;
    Ok(payload)
}

#[cfg(not(target_os = "windows"))]
async fn ocr_image_file(_image_path: &Path) -> Result<OcrPayload> {
    Err(anyhow!("OCR 仅支持 Windows 桌面端"))
}

pub async fn extract_holdings_from_image_data(client: &Client, image_base64: &str) -> Value {
    let (bytes, ext) = match decode_image_data(image_base64) {
        Ok(v) => v,
        Err(error) => {
            return json!({
                "suggestions": [],
                "warnings": [error.to_string()],
            })
        }
    };

    // Backward-compat: allow feeding plain CSV text via base64.
    if let Ok(text) = String::from_utf8(bytes.clone()) {
        if text.contains(',') {
            return json!({
                "suggestions": [],
                "warnings": ["OCR 当前需要截图图片；你似乎传入了文本（CSV）。请用手动导入。"],
                "text": text,
            });
        }
    }

    match ocr_and_parse(client, &bytes, &ext).await {
        Ok(payload) => payload,
        Err(error) => json!({
            "suggestions": [],
            "warnings": [error.to_string()],
        }),
    }
}

async fn ocr_and_parse(client: &Client, image_bytes: &[u8], extension: &str) -> Result<Value> {
    // Write image to temp file.
    let mut path: PathBuf = std::env::temp_dir();
    let filename = format!(
        "fundsight-ocr-{}.{ext}",
        chrono::Utc::now().timestamp_millis(),
        ext = extension
    );
    path.push(filename);

    std::fs::write(&path, image_bytes).context("write temp image")?;

    let ocr_payload = ocr_image_file(&path).await;

    // best-effort cleanup.
    let _ = std::fs::remove_file(&path);

    let ocr = match ocr_payload {
        Ok(v) => v,
        Err(error) => return Err(error),
    };

    let raw_text = if !ocr.lines.is_empty() {
        ocr.lines.join("\n")
    } else {
        ocr.text.clone()
    };

    let mut parsed = parse_holdings_from_ocr_text(client, &raw_text).await;

    if let Some(obj) = parsed.as_object_mut() {
        obj.insert("ocr_text".to_string(), json!(ocr.text));
    }

    Ok(parsed)
}
