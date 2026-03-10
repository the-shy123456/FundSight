from __future__ import annotations

from pathlib import Path
import unittest

from services.analysis_api.holdings import (
    HoldingLot,
    clear_holdings_storage,
    get_holdings_storage_path,
    import_holdings_text,
    parse_holdings_text,
    reset_holdings,
    set_holdings_storage_path,
)
from services.analysis_api.portfolio import build_portfolio_snapshot


ROOT_DIR = Path(__file__).resolve().parents[3]
TEST_STORAGE_PATH = ROOT_DIR / ".tmp-tests" / "holdings-test.json"


class HoldingsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.original_storage_path = get_holdings_storage_path()
        TEST_STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
        set_holdings_storage_path(TEST_STORAGE_PATH)
        clear_holdings_storage()
        reset_holdings()

    def tearDown(self) -> None:
        reset_holdings()
        clear_holdings_storage()
        set_holdings_storage_path(self.original_storage_path)

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
        self.assertIn("data_quality", snapshot)

    def test_import_holdings_persists_to_disk(self) -> None:
        import_holdings_text("F001,2000,1.00\nF003,1000,1.10")
        self.assertTrue(TEST_STORAGE_PATH.is_file())
        content = TEST_STORAGE_PATH.read_text(encoding="utf-8")
        self.assertIn('"fund_id": "F001"', content)
        self.assertIn('"fund_id": "F003"', content)


if __name__ == "__main__":
    unittest.main()
