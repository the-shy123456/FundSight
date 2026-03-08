from __future__ import annotations

import unittest

from services.analysis_api.assistant import ask_assistant
from services.analysis_api.holdings import reset_holdings


class AssistantTestCase(unittest.TestCase):
    def setUp(self) -> None:
        reset_holdings()

    def test_assistant_requires_existing_fund(self) -> None:
        with self.assertRaises(ValueError):
            ask_assistant("这只要不要买", "UNKNOWN")

    def test_assistant_returns_structured_sections(self) -> None:
        payload = ask_assistant(
            question="我这只已经赚了，要不要卖了等跌了再买？",
            fund_id="F003",
            cash_available=2000,
        )
        self.assertTrue(payload["summary"])
        self.assertEqual(payload["fund"]["fund_id"], "F003")
        self.assertEqual(len(payload["scenarios"]), 3)
        self.assertTrue(payload["actions"])
        self.assertIn("disclaimer", payload)


if __name__ == "__main__":
    unittest.main()
