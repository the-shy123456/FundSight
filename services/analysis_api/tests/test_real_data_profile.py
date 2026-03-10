from __future__ import annotations

import unittest
from unittest.mock import patch

from services.analysis_api.models import FundProfile
from services.analysis_api import real_data
from services.analysis_api.real_data import build_real_fund_profile


PINGZHONG_JS = """
var fS_name = "Test Fund";
var fund_Rate = "";
var Data_netWorthTrend = [
  {"y": 1.0},
  {"y": 1.1},
  {"y": 1.2},
  {"y": 1.3}
];
var Data_assetAllocation = {"series": [{"name": "stock", "data": [60]}]};
var Data_currentFundManager = [];
"""


class RealDataProfileTestCase(unittest.TestCase):
    @patch("services.analysis_api.real_data.fetch_pingzhong_source")
    def test_build_real_fund_profile_handles_empty_fee_rate(self, mock_fetch) -> None:
        mock_fetch.return_value = PINGZHONG_JS
        real_data.CACHE.clear()
        profile = build_real_fund_profile("159326")
        self.assertIsInstance(profile, FundProfile)
        self.assertAlmostEqual(profile.fee_rate, 0.0015)
        self.assertGreaterEqual(len(profile.nav_history), 4)


if __name__ == "__main__":
    unittest.main()
