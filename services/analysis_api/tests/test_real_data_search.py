from __future__ import annotations

import unittest
from unittest.mock import patch

from services.analysis_api.models import FundProfile
from services.analysis_api.real_data import search_funds
from services.analysis_api.sample_data import FUNDS


class RealDataSearchTestCase(unittest.TestCase):
    @patch("services.analysis_api.real_data.build_real_fund_profile")
    def test_search_funds_supports_code_lookup(self, mock_build_real_fund_profile) -> None:
        mock_build_real_fund_profile.return_value = FundProfile(
            fund_id="005827",
            name="易方达蓝筹精选混合",
            category="混合型",
            risk_level="high",
            manager="张坤",
            manager_tenure_years=13.4,
            fee_rate=0.0015,
            theme="蓝筹价值",
            nav_history=(1.7, 1.72, 1.75, 1.79),
        )
        items = search_funds("005827", FUNDS)
        self.assertTrue(items)
        self.assertEqual(items[0]["fund_id"], "005827")

    @patch("services.analysis_api.real_data._search_real_funds_api")
    def test_search_funds_supports_name_lookup(self, mock_search_real_funds_api) -> None:
        mock_search_real_funds_api.return_value = [
            {
                "fund_id": "005827",
                "name": "易方达蓝筹精选混合",
                "category": "混合型",
                "theme": "蓝筹价值",
                "risk_level": "high",
            }
        ]
        items = search_funds("易方达蓝筹", FUNDS)
        self.assertTrue(items)
        self.assertEqual(items[0]["name"], "易方达蓝筹精选混合")


if __name__ == "__main__":
    unittest.main()
