from __future__ import annotations

from pathlib import Path
import unittest

from services.analysis_api.predictions_store import (
    append_prediction,
    clear_predictions_storage,
    compact_to_max,
    get_predictions_storage_path,
    load_predictions,
    set_predictions_storage_path,
)


ROOT_DIR = Path(__file__).resolve().parents[3]
TEST_STORAGE_PATH = ROOT_DIR / ".tmp-tests" / "predictions-test.jsonl"


class PredictionsStoreTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.original_storage_path = get_predictions_storage_path()
        TEST_STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
        set_predictions_storage_path(TEST_STORAGE_PATH)
        clear_predictions_storage()

    def tearDown(self) -> None:
        clear_predictions_storage()
        set_predictions_storage_path(self.original_storage_path)

    def test_compact_trims_to_max(self) -> None:
        for idx in range(5):
            append_prediction(
                {
                    "id": f"pred-{idx}",
                    "created_at": f"2025-01-0{idx + 1}T09:30:00+08:00",
                    "fund_id": "F001",
                    "fund_name": "稳盈债券增强",
                    "horizon_trading_days": 5,
                    "direction": "up",
                    "probability_up": 0.6,
                    "basis": {"estimate_as_of": "2025-01-01", "estimate_mode": "auto", "evidence_refs": []},
                    "status": "pending",
                }
            )

        removed = compact_to_max(3)
        self.assertEqual(removed, 2)

        records = load_predictions()
        self.assertEqual(len(records), 3)
        self.assertEqual([record["id"] for record in records], ["pred-2", "pred-3", "pred-4"])


if __name__ == "__main__":
    unittest.main()
