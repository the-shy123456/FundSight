from __future__ import annotations

import unittest
from unittest.mock import patch

from services.analysis_api import real_data


PINGZHONG_JS = """
var Data_netWorthTrend = [
  {"x": 1690848000000, "y": 1.23},
  {"x": 1690934400000, "y": 1.25}
];
"""


class RealDataNavTrendTestCase(unittest.TestCase):
    @patch("services.analysis_api.real_data.fetch_pingzhong_source")
    def test_fetch_nav_trend_parses_points(self, mock_fetch) -> None:
        mock_fetch.return_value = PINGZHONG_JS
        real_data.CACHE.clear()
        points = real_data.fetch_nav_trend("005827")
        self.assertEqual(len(points), 2)
        first = points[0]
        for key in ("x", "date", "nav"):
            self.assertIn(key, first)
        self.assertEqual(first["date"], "2023-08-01")


if __name__ == "__main__":
    unittest.main()
