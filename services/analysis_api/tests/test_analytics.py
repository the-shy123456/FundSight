from __future__ import annotations

import unittest

from services.analysis_api.analytics import (
    build_dashboard_snapshot,
    build_diagnosis,
    build_fund_snapshot,
    calculate_max_drawdown,
    calculate_period_return,
    quality_score,
    recommend_portfolio,
)
from services.analysis_api.models import InvestorProfile
from services.analysis_api.sample_data import FUNDS


class AnalyticsTestCase(unittest.TestCase):
    def test_period_return_is_positive_for_growth_fund(self) -> None:
        period_return = calculate_period_return(FUNDS[2].nav_history)
        self.assertGreater(period_return, 0.15)

    def test_max_drawdown_stays_in_expected_range(self) -> None:
        drawdown = calculate_max_drawdown(FUNDS[1].nav_history)
        self.assertGreaterEqual(drawdown, 0.0)
        self.assertLess(drawdown, 0.05)

    def test_quality_score_has_reasonable_bounds(self) -> None:
        score = quality_score(FUNDS[0])
        self.assertGreaterEqual(score, 0)
        self.assertLessEqual(score, 100)

    def test_diagnosis_contains_strengths_and_cautions(self) -> None:
        diagnosis = build_diagnosis(FUNDS[3])
        self.assertTrue(diagnosis["strengths"])
        self.assertTrue(diagnosis["cautions"])

    def test_recommendation_matches_risk_level(self) -> None:
        investor = InvestorProfile(
            risk_level="low",
            monthly_budget=2000,
            investment_horizon_months=12,
        )
        recommendation = recommend_portfolio(FUNDS, investor)
        self.assertTrue(recommendation["recommendations"])
        self.assertTrue(
            all(
                item["fund"]["risk_level"] == "low"
                for item in recommendation["recommendations"]
            )
        )

    def test_dashboard_snapshot_contains_chart_and_spotlight(self) -> None:
        snapshot = build_dashboard_snapshot(FUNDS)
        self.assertEqual(snapshot["headline"]["title"], "基金机会雷达")
        self.assertEqual(len(snapshot["chart"]["series"]), len(FUNDS))
        self.assertTrue(snapshot["signals"])
        self.assertIsNotNone(snapshot["spotlight"])

    def test_fund_snapshot_contains_required_sections(self) -> None:
        snapshot = build_fund_snapshot(FUNDS[1], FUNDS)
        self.assertEqual(snapshot["fund"]["fund_id"], "F002")
        self.assertTrue(snapshot["overview"]["summary"])
        self.assertIn("latest_nav", snapshot["overview"])
        self.assertTrue(snapshot["chart"]["series"][0]["values"])
        self.assertTrue(snapshot["peer_recommendations"])
        self.assertTrue(snapshot["cautions"])


if __name__ == "__main__":
    unittest.main()
