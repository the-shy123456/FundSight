from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .models import FundProfile
from .real_data import build_real_fund_profile, is_real_fund_code
from .sample_data import FUNDS


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_STORAGE_DIR = ROOT_DIR / ".fund-insight"
DEFAULT_STORAGE_PATH = DEFAULT_STORAGE_DIR / "holdings.json"


@dataclass(frozen=True)
class HoldingLot:
    fund_id: str
    shares: float
    unit_cost: float


DEFAULT_HOLDINGS: tuple[HoldingLot, ...] = (
    HoldingLot(fund_id="F003", shares=1700.0, unit_cost=1.136),
    HoldingLot(fund_id="F004", shares=900.0, unit_cost=1.052),
    HoldingLot(fund_id="F001", shares=1200.0, unit_cost=1.018),
)


_holdings_storage_path = Path(os.environ.get("FUND_INSIGHT_HOLDINGS_PATH", DEFAULT_STORAGE_PATH))
_current_holdings: list[HoldingLot] = []


def get_holdings() -> tuple[HoldingLot, ...]:
    return tuple(_current_holdings)


def get_current_holdings() -> tuple[HoldingLot, ...]:
    return get_holdings()


def get_holdings_storage_path() -> Path:
    return _holdings_storage_path


def set_holdings_storage_path(path: str | Path | None) -> Path:
    global _holdings_storage_path
    _holdings_storage_path = Path(path) if path else DEFAULT_STORAGE_PATH
    _current_holdings[:] = list(_load_persisted_holdings())
    return _holdings_storage_path


def clear_holdings_storage() -> None:
    try:
        _holdings_storage_path.unlink()
    except FileNotFoundError:
        return


def reset_holdings(*, persist: bool = False) -> None:
    _current_holdings[:] = list(DEFAULT_HOLDINGS)
    if persist:
        _persist_holdings(get_holdings())


def replace_holdings(holdings: tuple[HoldingLot, ...], *, persist: bool = True) -> tuple[HoldingLot, ...]:
    _current_holdings[:] = list(holdings)
    if persist:
        _persist_holdings(get_holdings())
    return get_holdings()


def resolve_fund(fund_id: str, funds: tuple[FundProfile, ...] = FUNDS) -> FundProfile | None:
    normalized = str(fund_id).strip().upper()
    matched = next((fund for fund in funds if fund.fund_id == normalized), None)
    if matched is not None:
        return matched
    if is_real_fund_code(normalized):
        try:
            return build_real_fund_profile(normalized)
        except Exception:  # noqa: BLE001
            return None
    return None


def _build_from_records(records: list[dict[str, Any]], funds: tuple[FundProfile, ...]) -> tuple[HoldingLot, ...]:
    aggregated: dict[str, tuple[float, float]] = {}

    for index, record in enumerate(records, start=1):
        fund_id = str(record.get("fund_id", "")).strip().upper()
        if resolve_fund(fund_id, funds) is None:
            raise ValueError(f"第 {index} 条记录的基金代码无效：{fund_id or '空值'}")

        try:
            cost_nav = float(record.get("unit_cost", record.get("cost_nav", 0)))
            shares = float(record.get("shares", 0) or 0)
            principal = float(record.get("principal", 0) or 0)
        except (TypeError, ValueError) as error:
            raise ValueError(f"第 {index} 条记录的份额或成本格式错误") from error

        if cost_nav <= 0:
            raise ValueError(f"第 {index} 条记录的成本必须大于 0")
        if shares <= 0 and principal <= 0:
            raise ValueError(f"第 {index} 条记录必须提供正数份额或本金")

        normalized_shares = shares if shares > 0 else principal / cost_nav
        current_shares, current_cost = aggregated.get(fund_id, (0.0, 0.0))
        aggregated[fund_id] = (
            current_shares + normalized_shares,
            current_cost + normalized_shares * cost_nav,
        )

    holdings = tuple(
        HoldingLot(
            fund_id=fund_id,
            shares=round(shares, 4),
            unit_cost=round(total_cost / shares, 4),
        )
        for fund_id, (shares, total_cost) in aggregated.items()
    )
    if not holdings:
        raise ValueError("未识别到有效持仓记录")
    return holdings


def _serialize_holdings(holdings: tuple[HoldingLot, ...]) -> list[dict[str, float | str]]:
    return [
        {
            "fund_id": item.fund_id,
            "shares": round(item.shares, 4),
            "unit_cost": round(item.unit_cost, 4),
        }
        for item in holdings
    ]


def _persist_holdings(holdings: tuple[HoldingLot, ...]) -> None:
    _holdings_storage_path.parent.mkdir(parents=True, exist_ok=True)
    _holdings_storage_path.write_text(
        json.dumps(_serialize_holdings(holdings), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _load_persisted_holdings() -> tuple[HoldingLot, ...]:
    if not _holdings_storage_path.exists():
        return DEFAULT_HOLDINGS
    try:
        payload = json.loads(_holdings_storage_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return DEFAULT_HOLDINGS
    if not isinstance(payload, list):
        return DEFAULT_HOLDINGS
    try:
        return _build_from_records([item for item in payload if isinstance(item, dict)], FUNDS)
    except ValueError:
        return DEFAULT_HOLDINGS


def parse_holdings_text(text: str, funds: tuple[FundProfile, ...] = FUNDS) -> tuple[HoldingLot, ...]:
    rows: list[dict[str, Any]] = []
    for index, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 3:
            raise ValueError(f"第 {index} 行格式错误，应为 fund_id,shares,unit_cost")
        fund_id, shares, unit_cost = parts
        rows.append({"fund_id": fund_id, "shares": shares, "unit_cost": unit_cost})

    if not rows:
        raise ValueError("未提供持仓内容")
    return _build_from_records(rows, funds)


def parse_holdings_payload(payload: object, funds: tuple[FundProfile, ...] = FUNDS) -> tuple[HoldingLot, ...]:
    if isinstance(payload, str):
        return parse_holdings_text(payload, funds)
    if isinstance(payload, list):
        normalized = [item for item in payload if isinstance(item, dict)]
        if not normalized:
            raise ValueError("holdings 字段必须是对象数组")
        return _build_from_records(normalized, funds)
    raise ValueError("不支持的持仓导入格式")


def import_holdings_text(text: str, funds: tuple[FundProfile, ...] = FUNDS) -> tuple[HoldingLot, ...]:
    return replace_holdings(parse_holdings_text(text, funds))


def import_holdings_payload(payload: object, funds: tuple[FundProfile, ...] = FUNDS) -> tuple[HoldingLot, ...]:
    return replace_holdings(parse_holdings_payload(payload, funds))


_current_holdings[:] = list(_load_persisted_holdings())
