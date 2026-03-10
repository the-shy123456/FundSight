from __future__ import annotations

from pathlib import Path
import unittest

from services.analysis_api.assistant import ask_assistant
from services.analysis_api.holdings import clear_holdings_storage, get_holdings_storage_path, reset_holdings, set_holdings_storage_path


ROOT_DIR = Path(__file__).resolve().parents[3]
TEST_STORAGE_PATH = ROOT_DIR / ".tmp-tests" / "assistant-test.json"


class AssistantTestCase(unittest.TestCase):
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

    def test_assistant_requires_existing_fund(self) -> None:
        with self.assertRaises(ValueError):
            ask_assistant("这只要不要买", "UNKNOWN")

    def test_assistant_returns_structured_sections(self) -> None:
        payload = ask_assistant(
            question="我这只已经赚了，要不要卖了等跌了再买？",
            fund_id="F003",
            cash_available=2000,
        )
        self.assertEqual(payload["fund"]["fund_id"], "F003")
        self.assertTrue(payload["summary"])
        self.assertEqual(len(payload["scenarios"]), 3)
        self.assertTrue(payload["actions"])
        self.assertTrue(payload["evidence"])
        self.assertTrue(payload["risks"])
        self.assertIn("disclaimer", payload)

    def test_assistant_result_contains_single_page_workbench_keys(self) -> None:
        payload = ask_assistant(
            question="为什么最近会跌，接下来什么时候更适合卖？",
            fund_id="F003",
            cash_available=1500,
        )
        self.assertIn("fund", payload)
        self.assertIn("holding_context", payload)
        self.assertIn("summary", payload)
        self.assertIn("stance", payload)
        self.assertIn("scenarios", payload)
        self.assertIn("evidence", payload)
        self.assertIn("actions", payload)
        self.assertIn("risks", payload)
        self.assertIn("confidence", payload)
        self.assertIn("disclaimer", payload)

        confidence = payload["confidence"]
        self.assertIn("score", confidence)
        self.assertIn("label", confidence)
        self.assertIn("reason", confidence)

        first_scenario = payload["scenarios"][0]
        for key in ("name", "condition", "impact"):
            self.assertIn(key, first_scenario)

        first_evidence = payload["evidence"][0]
        for key in ("label", "value", "detail"):
            self.assertIn(key, first_evidence)

        first_action = payload["actions"][0]
        for key in ("title", "fit", "detail"):
            self.assertIn(key, first_action)

    def test_assistant_confidence_and_context_have_reasonable_shape(self) -> None:
        payload = ask_assistant(
            question="为什么最近会跌，接下来什么时候更适合卖？",
            fund_id="F003",
            cash_available=1800,
        )
        confidence = payload["confidence"]
        self.assertGreaterEqual(confidence["score"], 0.0)
        self.assertLessEqual(confidence["score"], 1.0)
        self.assertIn(confidence["label"], {"高", "中", "低"})
        self.assertTrue(confidence["reason"])

        context = payload["holding_context"]
        self.assertIsInstance(context["shares"], (int, float))
        self.assertIsInstance(context["avg_cost"], (int, float))
        self.assertIsInstance(context["current_value"], (int, float))
        self.assertIsInstance(context["total_pnl"], (int, float))
        self.assertIsInstance(context["today_estimated_pnl"], (int, float))

    def test_assistant_sections_are_non_empty_and_string_like(self) -> None:
        payload = ask_assistant(
            question="为什么最近会跌，接下来什么时候更适合卖？",
            fund_id="F003",
            cash_available=1800,
        )
        self.assertEqual(len(payload["scenarios"]), 3)
        self.assertTrue(all(str(item["name"]) for item in payload["scenarios"]))
        self.assertTrue(all(str(item["condition"]) for item in payload["scenarios"]))
        self.assertTrue(all(str(item["impact"]) for item in payload["scenarios"]))
        self.assertTrue(all(str(item["label"]) for item in payload["evidence"]))
        self.assertTrue(all(str(item["value"]) for item in payload["evidence"]))
        self.assertTrue(all(str(item["detail"]) for item in payload["evidence"]))
        self.assertTrue(all(str(item["title"]) for item in payload["actions"]))
        self.assertTrue(all(str(item["fit"]) for item in payload["actions"]))
        self.assertTrue(all(str(item["detail"]) for item in payload["actions"]))

    def test_assistant_requested_fund_matches_holding_context(self) -> None:
        payload = ask_assistant(
            question="这只基金现在更适合继续拿还是观察？",
            fund_id="F003",
            cash_available=1200,
        )
        self.assertEqual(payload["fund"]["fund_id"], "F003")
        self.assertGreater(payload["holding_context"]["shares"], 0)
        self.assertGreater(payload["holding_context"]["current_value"], 0)

    def test_assistant_evidence_exposes_estimate_source(self) -> None:
        payload = ask_assistant(
            question="这只基金现在更适合继续拿还是观察？",
            fund_id="F003",
            cash_available=1200,
        )
        self.assertIn("估算", payload["evidence"][0]["label"])


if __name__ == "__main__":
    unittest.main()
