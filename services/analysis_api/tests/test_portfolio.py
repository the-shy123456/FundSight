from __future__ import annotations

import unittest

from services.analysis_api.holdings import HoldingLot
from services.analysis_api.portfolio import build_portfolio_intraday, build_portfolio_snapshot


class PortfolioTestCase(unittest.TestCase):
    def test_portfolio_snapshot_contains_summary_and_items(self) -> None:
        holdings = (
            HoldingLot(fund_id="F004", shares=1700, unit_cost=1.049),
            HoldingLot(fund_id="F003", shares=900, unit_cost=1.108),
        )
        payload = build_portfolio_snapshot(holdings)
        self.assertEqual(payload["summary"]["holding_count"], 2)
        self.assertEqual(len(payload["positions"]), 2)
        self.assertIn("today_estimated_pnl", payload["summary"])
        self.assertIn("proxy", payload["positions"][0])
        self.assertTrue(payload["signals"])

    def test_portfolio_intraday_contains_chart_and_contributions(self) -> None:
        holdings = (
            HoldingLot(fund_id="F004", shares=1700, unit_cost=1.049),
            HoldingLot(fund_id="F003", shares=900, unit_cost=1.108),
        )
        payload = build_portfolio_intraday(holdings)
        self.assertTrue(payload["chart"]["labels"])
        self.assertTrue(payload["chart"]["series"][0]["values"])
        self.assertTrue(payload["contributions"])


if __name__ == "__main__":
    unittest.main()
