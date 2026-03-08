from __future__ import annotations

import unittest

from services.analysis_api.research import build_research_brief


class ResearchTestCase(unittest.TestCase):
    def test_research_brief_extracts_theme_and_sentiment(self) -> None:
        payload = build_research_brief(
            "科技板块景气修复，半导体订单改善，盈利预期上调，但短期仍有波动风险。"
        )
        self.assertIn("科技成长", payload["themes"])
        self.assertIn(payload["sentiment"], {"positive", "neutral"})
        self.assertTrue(payload["opportunities"])
        self.assertTrue(payload["risks"])

    def test_empty_text_returns_safe_defaults(self) -> None:
        payload = build_research_brief("")
        self.assertEqual(payload["sentiment"], "neutral")
        self.assertFalse(payload["themes"])


if __name__ == "__main__":
    unittest.main()
