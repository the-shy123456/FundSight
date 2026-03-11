from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_STORAGE_DIR = ROOT_DIR / ".fund-insight"
DEFAULT_STORAGE_PATH = DEFAULT_STORAGE_DIR / "watchlist.json"
MAX_WATCHLIST_ITEMS = 50

_watchlist_storage_path = Path(os.environ.get("FUND_INSIGHT_WATCHLIST_PATH", DEFAULT_STORAGE_PATH))


def get_watchlist_storage_path() -> Path:
    return _watchlist_storage_path


def set_watchlist_storage_path(path: str | Path | None) -> Path:
    global _watchlist_storage_path
    _watchlist_storage_path = Path(path) if path else DEFAULT_STORAGE_PATH
    return _watchlist_storage_path


def clear_watchlist_storage() -> None:
    try:
        _watchlist_storage_path.unlink()
    except FileNotFoundError:
        return


def _now_iso() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).replace(microsecond=0).isoformat()


def _normalize_fund_id(value: object) -> str:
    return str(value or "").strip().upper()


def _load_watchlist_payload() -> dict[str, object]:
    if not _watchlist_storage_path.exists():
        return {"items": [], "updated_at": ""}
    try:
        payload = json.loads(_watchlist_storage_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"items": [], "updated_at": ""}
    if not isinstance(payload, dict):
        return {"items": [], "updated_at": ""}
    return payload


def _normalize_items(raw_items: object) -> list[str]:
    if not isinstance(raw_items, list):
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        fund_id = _normalize_fund_id(item)
        if not fund_id or fund_id in seen:
            continue
        seen.add(fund_id)
        normalized.append(fund_id)
        if len(normalized) >= MAX_WATCHLIST_ITEMS:
            break
    return normalized


def _write_watchlist(items: list[str]) -> None:
    _watchlist_storage_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"items": items, "updated_at": _now_iso()}
    _watchlist_storage_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def get_watchlist_ids() -> list[str]:
    payload = _load_watchlist_payload()
    return _normalize_items(payload.get("items"))


def add_watchlist_id(fund_id: object) -> bool:
    normalized = _normalize_fund_id(fund_id)
    if not normalized:
        raise ValueError("fund_id 不能为空")

    items = get_watchlist_ids()
    if normalized in items:
        return True
    if len(items) >= MAX_WATCHLIST_ITEMS:
        raise ValueError("自选最多支持 50 只基金")
    items.append(normalized)
    _write_watchlist(items)
    return True


def remove_watchlist_id(fund_id: object) -> bool:
    normalized = _normalize_fund_id(fund_id)
    if not normalized:
        return False
    items = get_watchlist_ids()
    filtered = [item for item in items if item != normalized]
    if len(filtered) == len(items):
        return False
    _write_watchlist(filtered)
    return True
