from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .models import FundProfile
from .real_data import build_real_fund_profile, is_real_fund_code
from .sample_data import FUNDS


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

_current_holdings: list[HoldingLot] = list(DEFAULT_HOLDINGS)


def get_holdings() -> tuple[HoldingLot, ...]:
    return tuple(_current_holdings)


def get_current_holdings() -> tuple[HoldingLot, ...]:
    return get_holdings()


def reset_holdings() -> None:
    _current_holdings[:] = list(DEFAULT_HOLDINGS)


def replace_holdings(holdings: tuple[HoldingLot, ...]) -> tuple[HoldingLot, ...]:
    _current_holdings[:] = list(holdings)
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
