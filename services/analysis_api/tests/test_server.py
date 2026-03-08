from __future__ import annotations

import json
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch
from http.server import ThreadingHTTPServer

from services.analysis_api.holdings import reset_holdings
from services.analysis_api.server import FundInsightHandler


class ServerRouteTestCase(unittest.TestCase):
    def setUp(self) -> None:
        reset_holdings()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FundInsightHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)
        reset_holdings()

    def _post_json(self, path: str, payload: dict[str, object]) -> dict[str, object]:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        response = urllib.request.urlopen(request)
        return json.loads(response.read().decode("utf-8"))

    def test_snapshot_endpoint_returns_detail_contract(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds/F001/snapshot")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["fund"]["fund_id"], "F001")
        self.assertTrue(payload["overview"]["summary"])
        self.assertIn("latest_nav", payload["overview"])
        self.assertTrue(payload["chart"]["series"][0]["values"])
        self.assertTrue(payload["peer_recommendations"])

    def test_snapshot_endpoint_returns_404_for_unknown_fund(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(f"{self.base_url}/api/v1/funds/UNKNOWN/snapshot")
        self.assertEqual(context.exception.code, 404)

    def test_portfolio_endpoint_returns_positions_and_exposure(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/portfolio")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertTrue(payload["positions"])
        self.assertIn("today_estimated_pnl", payload["summary"])
        self.assertTrue(payload["exposures"])
        self.assertEqual(payload["summary"]["holding_count"], len(payload["positions"]))

    def test_portfolio_intraday_endpoint_returns_chart(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/portfolio/intraday")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertTrue(payload["chart"]["labels"])
        self.assertTrue(payload["chart"]["series"][0]["values"])
        self.assertTrue(payload["contributions"])

    def test_import_endpoint_replaces_holdings(self) -> None:
        payload = self._post_json(
            "/api/v1/holdings/import",
            {"text": "F003,1000,1.10\nF004,600,1.01"},
        )
        self.assertEqual(payload["summary"]["holding_count"], 2)
        self.assertEqual({item["fund_id"] for item in payload["positions"]}, {"F003", "F004"})


    def test_import_endpoint_accepts_holdings_payload(self) -> None:
        payload = self._post_json(
            "/api/v1/holdings/import",
            {
                "holdings": [
                    {"fund_id": "F002", "shares": 800, "cost_nav": 1.05},
                    {"fund_id": "F004", "shares": 600, "cost_nav": 1.01},
                ]
            },
        )
        self.assertEqual(payload["summary"]["holding_count"], 2)
        self.assertEqual({item["fund_id"] for item in payload["positions"]}, {"F002", "F004"})

    def test_fund_intraday_estimate_endpoint_returns_contract(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds/F003/intraday-estimate")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["fund_id"], "F003")
        self.assertIn("estimated_nav", payload)
        self.assertTrue(payload["contributions"])
        self.assertIn("confidence", payload)


    @patch("services.analysis_api.server.extract_holdings_from_image_data")
    def test_holdings_ocr_endpoint_returns_suggestions(self, mock_ocr) -> None:
        mock_ocr.return_value = {
            "ocr_text": "华夏中证电网设备...",
            "suggestions": [{"fundQuery": "001838", "fundName": "华夏中证电网设备主题ETF联接A", "amount": "1708.64", "profit": "90.52"}],
            "warnings": ["OCR 为辅助识别，建议检查后再导入。"],
        }
        payload = self._post_json(
            "/api/v1/holdings/ocr",
            {"image_base64": "data:image/png;base64,ZmFrZQ=="},
        )
        self.assertTrue(payload["suggestions"])
        self.assertIn("warnings", payload)

    def test_assistant_endpoint_returns_structured_answer(self) -> None:
        payload = self._post_json(
            "/api/v1/assistant/ask",
            {
                "question": "这只基金下周会继续涨吗，我要不要先卖了等跌下来再买？",
                "fund_id": "F003",
                "cash_available": 2000,
            },
        )
        self.assertTrue(payload["summary"])
        self.assertTrue(payload["scenarios"])
        self.assertTrue(payload["evidence"])
        self.assertTrue(payload["actions"])
        self.assertIn("confidence", payload)



    def test_assistant_endpoint_accepts_inline_holdings(self) -> None:
        payload = self._post_json(
            "/api/v1/assistant/ask",
            {
                "question": "这只基金现在更适合继续拿还是观察？",
                "fund_id": "F002",
                "holdings": [{"fund_id": "F002", "shares": 880, "cost_nav": 1.06}],
            },
        )
        self.assertEqual(payload["fund"]["fund_id"], "F002")
        self.assertIsNotNone(payload["holding_context"])
        self.assertEqual(payload["holding_context"]["shares"], 880)


    @patch("services.analysis_api.server.fetch_fund_catalog")
    def test_funds_endpoint_returns_paginated_catalog(self, mock_catalog) -> None:
        mock_catalog.return_value = {
            "items": [
                {"fund_id": "005827", "name": "易方达蓝筹精选混合", "category": "混合型", "theme": "蓝筹价值", "risk_level": "high", "latest_nav": 1.8228},
                {"fund_id": "161725", "name": "招商中证白酒指数(LOF)A", "category": "指数型", "theme": "白酒消费", "risk_level": "high", "latest_nav": 0.6545},
            ],
            "total": 19311,
            "page": 2,
            "page_size": 30,
        }
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds?page=2&page_size=30")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["page"], 2)
        self.assertEqual(payload["page_size"], 30)
        self.assertEqual(payload["total"], 19311)
        self.assertEqual(len(payload["items"]), 2)

    def test_funds_endpoint_supports_query_param(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds?q={urllib.parse.quote('白酒')}")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertIn("items", payload)
        self.assertIn("total", payload)

    def test_fund_search_endpoint_returns_results(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds/search?q={urllib.parse.quote('科技')}")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertIn("items", payload)
        self.assertIn("total", payload)



    def test_fund_search_endpoint_requires_q(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(f"{self.base_url}/api/v1/funds/search")
        self.assertEqual(context.exception.code, 400)

if __name__ == "__main__":
    unittest.main()
