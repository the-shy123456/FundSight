from __future__ import annotations

import unittest
from unittest.mock import patch

from services.analysis_api.forecast_grader import grade_forecast


class ForecastGraderTestCase(unittest.TestCase):
    @patch("services.analysis_api.forecast_grader._load_nav_points")
    def test_grade_forecast_finds_fifth_day_and_hit(self, mock_load) -> None:
        mock_load.return_value = [
            {"date": "2025-01-01", "nav": 1.0},
            {"date": "2025-01-02", "nav": 1.01},
            {"date": "2025-01-03", "nav": 1.02},
            {"date": "2025-01-03", "nav": 1.025},
            {"date": "2025-01-04", "nav": 1.03},
            {"date": "2025-01-05", "nav": 1.04},
            {"date": "2025-01-06", "nav": 1.05},
            {"date": "2025-01-07", "nav": 1.06},
        ]

        result = grade_forecast("F001", "2025-01-01T10:00:00+08:00", 5, direction="up")
        self.assertIsNotNone(result)
        self.assertEqual(result["nav_after"], 1.05)
        self.assertEqual(result["direction_actual"], "up")
        self.assertTrue(result["hit"])


if __name__ == "__main__":
    unittest.main()
