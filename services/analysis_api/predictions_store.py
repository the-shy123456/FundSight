from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_STORAGE_DIR = ROOT_DIR / ".fund-insight"
DEFAULT_STORAGE_PATH = DEFAULT_STORAGE_DIR / "predictions.jsonl"

_predictions_storage_path = Path(os.environ.get("FUND_INSIGHT_PREDICTIONS_PATH", DEFAULT_STORAGE_PATH))


def get_predictions_storage_path() -> Path:
    return _predictions_storage_path


def set_predictions_storage_path(path: str | Path | None) -> Path:
    global _predictions_storage_path
    _predictions_storage_path = Path(path) if path else DEFAULT_STORAGE_PATH
    return _predictions_storage_path


def clear_predictions_storage() -> None:
    try:
        _predictions_storage_path.unlink()
    except FileNotFoundError:
        return


def _load_predictions() -> list[dict[str, Any]]:
    if not _predictions_storage_path.exists():
        return []
    try:
        raw_lines = _predictions_storage_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []

    records: list[dict[str, Any]] = []
    for line in raw_lines:
        clean = line.strip()
        if not clean:
            continue
        try:
            payload = json.loads(clean)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            records.append(payload)
    return records


def _write_predictions(records: list[dict[str, Any]]) -> None:
    _predictions_storage_path.parent.mkdir(parents=True, exist_ok=True)
    payload = "\n".join(json.dumps(item, ensure_ascii=False) for item in records)
    if payload:
        payload += "\n"
    _predictions_storage_path.write_text(payload, encoding="utf-8")


def load_predictions(fund_id: str | None = None) -> list[dict[str, Any]]:
    records = _load_predictions()
    if fund_id:
        target = str(fund_id).strip().upper()
        records = [record for record in records if str(record.get("fund_id", "")).strip().upper() == target]
    return records


def overwrite_predictions(records: list[dict[str, Any]]) -> None:
    _write_predictions(records)


def append_prediction(record: dict[str, Any]) -> None:
    if not isinstance(record, dict):
        raise ValueError("prediction record 必须是字典")
    _predictions_storage_path.parent.mkdir(parents=True, exist_ok=True)
    with _predictions_storage_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def list_predictions(fund_id: str | None = None, limit: int | None = 50) -> list[dict[str, Any]]:
    records = _load_predictions()
    if fund_id:
        target = str(fund_id).strip().upper()
        records = [record for record in records if str(record.get("fund_id", "")).strip().upper() == target]

    if limit is None or limit <= 0:
        selected = records
    else:
        selected = records[-limit:]

    return list(reversed(selected))


def compact_to_max(max_records: int = 200) -> int:
    if max_records <= 0:
        return 0
    records = _load_predictions()
    if len(records) <= max_records:
        return 0
    trimmed = records[-max_records:]
    _write_predictions(trimmed)
    return len(records) - len(trimmed)
