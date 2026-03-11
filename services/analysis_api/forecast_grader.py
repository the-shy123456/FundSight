from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from .real_data import fetch_nav_trend, is_real_fund_code
from .sample_data import FUNDS


def _parse_created_at(value: str) -> date | None:
    clean = str(value or "").strip()
    if not clean:
        return None
    try:
        parsed = datetime.fromisoformat(clean)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo("Asia/Shanghai"))
    else:
        parsed = parsed.astimezone(ZoneInfo("Asia/Shanghai"))
    return parsed.date()


def _extract_point_date(point: dict[str, Any]) -> date | None:
    raw_date = point.get("date")
    if raw_date:
        text = str(raw_date).strip()
        try:
            parsed = datetime.fromisoformat(text)
            return parsed.date()
        except ValueError:
            try:
                return datetime.strptime(text, "%Y-%m-%d").date()
            except ValueError:
                return None

    raw_ts = point.get("x")
    if raw_ts is None:
        return None
    try:
        timestamp_ms = int(float(raw_ts))
    except (TypeError, ValueError):
        return None
    if timestamp_ms < 10**11:
        timestamp_ms *= 1000
    try:
        return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).date()
    except (OverflowError, OSError, ValueError):
        return None


def _build_sample_points(fund_id: str) -> list[dict[str, Any]]:
    fund = next((item for item in FUNDS if item.fund_id == fund_id), None)
    if fund is None:
        return []
    values = list(fund.nav_history)
    if not values:
        return []
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    start = today - timedelta(days=len(values) - 1)
    points: list[dict[str, Any]] = []
    for idx, nav in enumerate(values):
        point_date = start + timedelta(days=idx)
        points.append({"date": point_date.isoformat(), "nav": round(float(nav), 4)})
    return points


def _load_nav_points(fund_id: str) -> list[dict[str, Any]]:
    if is_real_fund_code(fund_id):
        return fetch_nav_trend(fund_id)
    return _build_sample_points(fund_id)


def _normalize_points(points: list[dict[str, Any]]) -> list[tuple[date, float]]:
    collected: list[tuple[date, float]] = []
    for point in points:
        if not isinstance(point, dict):
            continue
        point_date = _extract_point_date(point)
        if point_date is None:
            continue
        try:
            nav = float(point.get("nav", 0.0))
        except (TypeError, ValueError):
            continue
        if nav <= 0:
            continue
        collected.append((point_date, nav))
    collected.sort(key=lambda item: item[0])

    unique: list[tuple[date, float]] = []
    for point_date, nav in collected:
        if unique and unique[-1][0] == point_date:
            unique[-1] = (point_date, nav)
        else:
            unique.append((point_date, nav))
    return unique


def grade_forecast(
    fund_id: str,
    created_at: str,
    horizon_trading_days: int = 5,
    direction: str | None = None,
) -> dict[str, Any] | None:
    if horizon_trading_days <= 0:
        return None
    created_date = _parse_created_at(created_at)
    if created_date is None:
        return None

    points = _normalize_points(_load_nav_points(fund_id))
    if not points:
        return None

    base_index = None
    for idx, (point_date, _) in enumerate(points):
        if point_date <= created_date:
            base_index = idx
        else:
            break
    if base_index is None:
        return None

    target_index = base_index + horizon_trading_days
    if target_index >= len(points):
        return None

    nav_at_prediction = points[base_index][1]
    nav_after = points[target_index][1]
    if nav_at_prediction <= 0:
        return None
    return_after = nav_after / nav_at_prediction - 1
    direction_actual = "up" if return_after >= 0 else "down"

    result: dict[str, Any] = {
        "nav_after": round(nav_after, 4),
        "return_after": round(return_after, 4),
        "direction_actual": direction_actual,
    }
    if direction in {"up", "down"}:
        result["hit"] = direction == direction_actual
    return result
