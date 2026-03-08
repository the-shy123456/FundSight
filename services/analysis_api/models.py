from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FundProfile:
    fund_id: str
    name: str
    category: str
    risk_level: str
    manager: str
    manager_tenure_years: float
    fee_rate: float
    theme: str
    nav_history: tuple[float, ...]


@dataclass(frozen=True)
class InvestorProfile:
    risk_level: str
    monthly_budget: float
    investment_horizon_months: int


@dataclass(frozen=True)
class HoldingInput:
    fund_id: str
    shares: float
    cost_nav: float


@dataclass(frozen=True)
class ProxyQuote:
    symbol: str
    name: str
    change_rate: float
    confidence: float
