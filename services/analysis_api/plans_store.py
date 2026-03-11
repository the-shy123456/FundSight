from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_STORAGE_DIR = ROOT_DIR / ".fund-insight"
DEFAULT_STORAGE_PATH = DEFAULT_STORAGE_DIR / "plans.json"

_plans_storage_path = Path(os.environ.get("FUND_INSIGHT_PLANS_PATH", DEFAULT_STORAGE_PATH))


def get_plans_storage_path() -> Path:
    return _plans_storage_path


def set_plans_storage_path(path: str | Path | None) -> Path:
    global _plans_storage_path
    _plans_storage_path = Path(path) if path else DEFAULT_STORAGE_PATH
    return _plans_storage_path


def clear_plans_storage() -> None:
    try:
        _plans_storage_path.unlink()
    except FileNotFoundError:
        return


def _load_plans() -> list[dict[str, Any]]:
    if not _plans_storage_path.exists():
        return []
    try:
        payload = json.loads(_plans_storage_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(payload, list):
        return []
    return [item for item in payload if isinstance(item, dict)]


def _write_plans(records: list[dict[str, Any]]) -> None:
    _plans_storage_path.parent.mkdir(parents=True, exist_ok=True)
    _plans_storage_path.write_text(
        json.dumps(records, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def list_plans(fund_id: str | None = None) -> list[dict[str, Any]]:
    records = _load_plans()
    if fund_id:
        target = str(fund_id).strip().upper()
        records = [record for record in records if str(record.get("fund_id", "")).strip().upper() == target]
    return records


def append_plan(record: dict[str, Any]) -> None:
    if not isinstance(record, dict):
        raise ValueError("plan record 必须是字典")
    records = _load_plans()
    records.append(record)
    _write_plans(records)


def delete_plan(plan_id: str) -> bool:
    target = str(plan_id).strip()
    if not target:
        return False
    records = _load_plans()
    filtered = [record for record in records if str(record.get("id", "")).strip() != target]
    if len(filtered) == len(records):
        return False
    _write_plans(filtered)
    return True
