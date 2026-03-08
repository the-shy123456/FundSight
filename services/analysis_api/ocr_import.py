from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any

from .real_data import search_funds
from .sample_data import FUNDS


FUND_LINE_BLACKLIST = (
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
)

SIGNED_NUMBER_PATTERN = re.compile(r"([+\-][0-9]+(?:\.[0-9]{1,2})?)")
UNSIGNED_NUMBER_PATTERN = re.compile(r"([0-9]+(?:\.[0-9]{1,2})?)")
CURRENCY_PATTERN = re.compile(r"¥\s*([0-9]+(?:\.[0-9]{1,2})?)")
ELLIPSIS_PATTERN = re.compile(r"(?:\.\.\.|…)+")


def _clean_ocr_line(value: str) -> str:
    line = (
        value.replace("￥", "¥")
        .replace("—", "-")
        .replace("−", "-")
        .replace("．", ".")
        .replace("。", ".")
    )
    line = re.sub(r"\s+", "", line)
    return line.strip()


def _contains_blacklist_term(value: str) -> bool:
    return any(keyword in value for keyword in FUND_LINE_BLACKLIST)


def _sanitize_search_query(value: str) -> str:
    text = ELLIPSIS_PATTERN.sub("", value)
    text = re.split(r"[¥+\-0-9]", text, maxsplit=1)[0]
    text = re.sub(r"[^\u4e00-\u9fffA-Za-z()]+", "", text)
    return text[:18]


def _is_fund_title_candidate(value: str) -> bool:
    if not value or _contains_blacklist_term(value):
        return False
    if "%" in value:
        return False
    if re.fullmatch(r"[¥+\-0-9./]+", value):
        return False
    query = _sanitize_search_query(value)
    if len(query) < 3:
        return False
    chinese_or_alpha = len(re.findall(r"[\u4e00-\u9fffA-Za-z]", query))
    return chinese_or_alpha >= 3


# 重点启发式：优先用“¥持有金额”做每只基金的锚点，再向上回看基金名。
def _extract_amount_value(line: str) -> str:
    match = CURRENCY_PATTERN.search(line)
    if match:
        return f"{float(match.group(1)):.2f}"

    if "%" in line or line.startswith(("+", "-")):
        return ""

    candidates = [float(item) for item in UNSIGNED_NUMBER_PATTERN.findall(line)]
    candidates = [item for item in candidates if item >= 100]
    if candidates:
        return f"{candidates[0]:.2f}"
    return ""


def _find_amount_indexes(lines: list[str]) -> list[int]:
    return [index for index, line in enumerate(lines) if _extract_amount_value(line)]


def _pick_profit(block_lines: list[str], amount: str) -> str:
    joined = " ".join(block_lines)
    signed_candidates = [
        value
        for value in SIGNED_NUMBER_PATTERN.findall(joined)
        if f"{value}%" not in joined
    ]
    if signed_candidates:
        picked = signed_candidates[-1]
        number = float(picked)
        keep_plus = picked.startswith("+") and any(value.startswith("-") for value in signed_candidates)
        return f"+{number:.2f}" if keep_plus else f"{number:.2f}"



    amount_value = float(amount) if amount else 0.0
    plain_candidates = [float(value) for value in UNSIGNED_NUMBER_PATTERN.findall(joined)]
    filtered = [
        value
        for value in plain_candidates
        if value != amount_value and value < max(amount_value, 1000000) and value < amount_value
    ]
    if filtered:
        picked = max(filtered, key=lambda item: abs(item))
        return f"{picked:.2f}"
    return ""


def _score_match(query: str, item: dict[str, Any]) -> tuple[int, int]:
    name = str(item.get("name", ""))
    code = str(item.get("fund_id", ""))
    score = 0
    if code == query:
        score += 100
    if name == query:
        score += 80
    if query and name.startswith(query):
        score += 60
    if query and query in name:
        score += 40
    return score, -len(name)


def _pick_best_match(query: str, matches: list[dict[str, Any]]) -> dict[str, Any]:
    if not matches:
        return {}
    return sorted(matches, key=lambda item: _score_match(query, item), reverse=True)[0]


def _build_suggestion(amount_line_index: int, next_amount_index: int, lines: list[str]) -> dict[str, Any] | None:
    amount = _extract_amount_value(lines[amount_line_index])
    if not amount:
        return None

    title_index = None
    for index in range(amount_line_index, max(-1, amount_line_index - 4), -1):
        if _is_fund_title_candidate(lines[index]):
            title_index = index
            break
    if title_index is None:
        return None

    query = _sanitize_search_query(lines[title_index])
    if not query:
        return None

    block_lines = lines[title_index:next_amount_index]
    matches = search_funds(query, FUNDS, limit=3)
    top_match = _pick_best_match(query, matches)
    return {
        "fundQuery": top_match.get("fund_id") or query,
        "fundName": top_match.get("name") or query,
        "amount": amount,
        "profit": _pick_profit(block_lines, amount),
        "match_count": len(matches),
        "raw_text": " ".join(block_lines),
    }


def parse_holdings_from_ocr_text(text: str) -> dict[str, Any]:
    lines = [_clean_ocr_line(item) for item in text.splitlines() if _clean_ocr_line(item)]
    amount_indexes = _find_amount_indexes(lines)
    suggestions: list[dict[str, Any]] = []
    used_title_indexes: set[int] = set()

    for position, amount_index in enumerate(amount_indexes):
        next_amount_index = amount_indexes[position + 1] if position + 1 < len(amount_indexes) else len(lines)
        title_index = next(
            (index for index in range(amount_index, max(-1, amount_index - 4), -1) if _is_fund_title_candidate(lines[index])),
            None,
        )
        if title_index is not None and title_index in used_title_indexes:
            continue
        suggestion = _build_suggestion(amount_index, next_amount_index, lines)
        if suggestion is None:
            continue
        if title_index is not None:
            used_title_indexes.add(title_index)
        suggestions.append(suggestion)

    # 兜底：OCR 如果没有稳定识别出金额行，就退回按基金标题切块。
    if not suggestions:
        fund_indexes = [index for index, line in enumerate(lines) if _is_fund_title_candidate(line)]
        for position, start_index in enumerate(fund_indexes):
            end_index = fund_indexes[position + 1] if position + 1 < len(fund_indexes) else len(lines)
            block_lines = lines[start_index:end_index]
            query = _sanitize_search_query(block_lines[0])
            amount = _extract_amount_value(" ".join(block_lines))
            if not query or not amount:
                continue
            matches = search_funds(query, FUNDS, limit=3)
            top_match = _pick_best_match(query, matches)
            suggestions.append(
                {
                    "fundQuery": top_match.get("fund_id") or query,
                    "fundName": top_match.get("name") or query,
                    "amount": amount,
                    "profit": _pick_profit(block_lines, amount),
                    "match_count": len(matches),
                    "raw_text": " ".join(block_lines),
                }
            )

    warnings: list[str] = []
    if not suggestions:
        warnings.append("没有稳定识别出持仓行，请改用手动输入或更清晰的截图。")
    else:
        warnings.append("OCR 为辅助识别，建议检查基金、金额、收益是否正确后再点完成。")

    return {
        "text": "\n".join(lines),
        "lines": lines,
        "suggestions": suggestions,
        "warnings": warnings,
    }


def _decode_image_data(image_data: str) -> tuple[bytes, str]:
    if not image_data:
        raise ValueError("缺少截图内容")
    match = re.match(r"data:image/([a-zA-Z0-9.+-]+);base64,(.+)", image_data)
    if not match:
        raise ValueError("截图格式错误，需使用 base64 图片数据")
    extension = match.group(1).lower().replace("jpeg", "jpg")
    return base64.b64decode(match.group(2)), extension


def _ocr_image_file(image_path: Path) -> dict[str, Any]:
    script = f"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
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
$path = '{str(image_path).replace("'", "''")}'
$lang = New-Object Windows.Globalization.Language('zh-Hans')
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) {{ throw '当前系统不支持中文 OCR' }}
$file = AwaitResult ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$stream = AwaitResult ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = AwaitResult ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = AwaitResult ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = AwaitResult ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
foreach ($line in $result.Lines) {{ $lines += $line.Text }}
@{{ text = $result.Text; lines = $lines }} | ConvertTo-Json -Depth 4 -Compress
"""
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        timeout=40,
        check=False,
        encoding="utf-8",
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "OCR 执行失败")
    return json.loads(completed.stdout.strip())


def extract_holdings_from_image_data(image_data: str) -> dict[str, Any]:
    image_bytes, extension = _decode_image_data(image_data)
    temp_handle = tempfile.NamedTemporaryFile(delete=False, suffix=f'.{extension}', dir=Path.cwd())
    temp_handle.close()
    image_path = Path(temp_handle.name)
    try:
        image_path.write_bytes(image_bytes)
        ocr_payload = _ocr_image_file(image_path)
    finally:
        try:
            os.remove(image_path)
        except OSError:
            pass
    raw_lines = ocr_payload.get("lines") if isinstance(ocr_payload.get("lines"), list) else []
    parsed = parse_holdings_from_ocr_text("\n".join(str(item) for item in raw_lines) if raw_lines else str(ocr_payload.get("text", "")))
    parsed["ocr_text"] = str(ocr_payload.get("text", ""))
    return parsed

