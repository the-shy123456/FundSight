from __future__ import annotations

import unittest

from services.analysis_api.holdings import HoldingLot, import_holdings_text, parse_holdings_text, reset_holdings
from services.analysis_api.portfolio import build_portfolio_snapshot


class HoldingsTestCase(unittest.TestCase):
    def tearDown(self) -> None:
        reset_holdings()

    def test_parse_holdings_supports_multiple_lines(self) -> None:
        holdings = parse_holdings_text("F003,1500,1.08\nF004,800,1.02")
        self.assertEqual(len(holdings), 2)
        self.assertIsInstance(holdings[0], HoldingLot)
        self.assertEqual(holdings[1].fund_id, "F004")

    def test_parse_holdings_rejects_unknown_fund(self) -> None:
        with self.assertRaises(ValueError):
            parse_holdings_text("UNKNOWN,100,1.00")

    def test_portfolio_snapshot_reflects_imported_holdings(self) -> None:
        imported = import_holdings_text("F001,2000,1.00\nF003,1000,1.10")
        snapshot = build_portfolio_snapshot(imported)
        self.assertEqual(snapshot["summary"]["holding_count"], 2)
        self.assertGreater(snapshot["summary"]["current_value"], 0)
        self.assertTrue(snapshot["risk_exposures"])


if __name__ == "__main__":
    unittest.main()
