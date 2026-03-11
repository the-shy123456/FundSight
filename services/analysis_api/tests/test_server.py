from __future__ import annotations

import json
from pathlib import Path
import re
import threading
import unittest
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from services.analysis_api.holdings import (
    clear_holdings_storage,
    get_holdings_storage_path,
    reset_holdings,
    set_holdings_storage_path,
)
from services.analysis_api.models import FundProfile
from services.analysis_api.server import FundInsightHandler


ROOT_DIR = Path(__file__).resolve().parents[3]
DIST_DIR = ROOT_DIR / "apps" / "web" / "dist"
INDEX_HTML = DIST_DIR / "index.html"
TEST_STORAGE_PATH = ROOT_DIR / ".tmp-tests" / "server-test.json"


class ServerRouteTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.original_storage_path = get_holdings_storage_path()
        TEST_STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
        set_holdings_storage_path(TEST_STORAGE_PATH)
        clear_holdings_storage()
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
        clear_holdings_storage()
        set_holdings_storage_path(self.original_storage_path)

    def _post_json(self, path: str, payload: dict[str, object]) -> dict[str, object]:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        response = urllib.request.urlopen(request)
        return json.loads(response.read().decode("utf-8"))

    def _read_dist_index(self) -> str:
        return INDEX_HTML.read_text(encoding="utf-8")

    def _read_first_dist_asset_path(self, extension: str) -> str:
        content = self._read_dist_index()
        matched = re.search(rf'(?:src|href)="(/assets/[^"]+\.{extension})"', content)
        self.assertIsNotNone(matched)
        return str(matched.group(1))

    def test_root_route_serves_frontend_index(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/")
        payload = response.read().decode("utf-8")
        self.assertEqual(response.headers.get_content_type(), "text/html")
        self.assertIn('id="root"', payload)

    def test_static_asset_route_serves_frontend_asset(self) -> None:
        asset_path = self._read_first_dist_asset_path("js")
        response = urllib.request.urlopen(f"{self.base_url}{asset_path}")
        payload = response.read().decode("utf-8")
        self.assertEqual(response.status, 200)
        self.assertIn("javascript", response.headers.get("Content-Type", ""))
        self.assertTrue(payload)

    def test_unknown_frontend_route_falls_back_to_index(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/workspace/portfolio")
        payload = response.read().decode("utf-8")
        self.assertEqual(response.headers.get_content_type(), "text/html")
        self.assertIn('id="root"', payload)

    def test_missing_asset_route_returns_404(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(f"{self.base_url}/assets/missing.js")
        self.assertEqual(context.exception.code, 404)

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
        self.assertIn("data_quality", payload)

    def test_portfolio_endpoint_rejects_invalid_estimate_mode(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(f"{self.base_url}/api/v1/portfolio?estimate_mode=invalid")
        self.assertEqual(context.exception.code, 400)

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

    @patch("services.analysis_api.holdings.search_funds")
    @patch("services.analysis_api.holdings.build_real_fund_profile")
    def test_import_endpoint_accepts_fund_name_with_search(
        self,
        mock_build_profile,
        mock_search_funds,
    ) -> None:
        mock_search_funds.return_value = [
            {
                "fund_id": "005827",
                "name": "易方达蓝筹精选混合",
                "category": "混合型",
                "theme": "蓝筹价值",
                "risk_level": "high",
            }
        ]
        mock_build_profile.return_value = FundProfile(
            fund_id="005827",
            name="易方达蓝筹精选混合",
            category="混合型",
            risk_level="high",
            manager="张坤",
            manager_tenure_years=5.2,
            fee_rate=0.015,
            theme="蓝筹价值",
            nav_history=(1.0, 1.01, 1.02, 1.03),
        )

        payload = self._post_json(
            "/api/v1/holdings/import",
            {"text": "易方达蓝筹精选混合,1000,1.10"},
        )
        self.assertEqual(payload["summary"]["holding_count"], 1)
        self.assertEqual(payload["positions"][0]["fund_id"], "005827")

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
        self.assertEqual(payload["estimate_source_label"], "主题代理估算")
        self.assertFalse(payload["is_real_data"])

    def test_fund_intraday_estimate_endpoint_returns_estimate_mode(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds/F003/intraday-estimate?estimate_mode=auto")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertIn("estimate_mode", payload)
        self.assertEqual(payload["estimate_mode"], "theme_proxy")

    @patch("services.analysis_api.server.load_predictions")
    @patch("services.analysis_api.server.list_predictions")
    def test_fund_predictions_endpoint_returns_stats(self, mock_list_predictions, mock_load_predictions) -> None:
        records = [
            {"id": "pred-1", "fund_id": "F001", "status": "settled", "result": {"hit": True}},
            {"id": "pred-2", "fund_id": "F001", "status": "pending"},
        ]
        mock_load_predictions.return_value = records
        mock_list_predictions.return_value = records

        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds/F001/predictions?limit=50")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertIn("items", payload)
        self.assertIn("stats", payload)
        self.assertEqual(payload["stats"]["total"], 2)
        self.assertEqual(payload["stats"]["settled"], 1)
        self.assertEqual(payload["stats"]["hit_rate"], 1.0)

    def test_real_fund_intraday_estimate_endpoint_returns_key_fields(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds/005827/intraday-estimate")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["fund_id"], "005827")
        self.assertIn("estimated_nav", payload)
        self.assertIn("latest_nav", payload)
        self.assertIn("confidence", payload)
        self.assertIn("contributions", payload)
        self.assertEqual(payload["estimate_source_label"], "官方估值+持仓穿透")
        self.assertTrue(payload["is_real_data"])

    @patch("services.analysis_api.server.fetch_fund_announcements")
    def test_fund_announcements_endpoint_returns_items(self, mock_fetch) -> None:
        mock_fetch.return_value = {
            "items": [
                {
                    "title": "关于基金经理变更的公告",
                    "type": "临时公告",
                    "date": "2026-03-10",
                    "url": "https://fundf10.eastmoney.com/notice1.html",
                    "pdf_url": "https://pdf.dfcfw.com/pdf/AAA.pdf",
                }
            ],
            "total": 1,
        }
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds/005827/announcements?limit=3")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["fund_id"], "005827")
        self.assertEqual(payload["total"], 1)
        self.assertEqual(len(payload["items"]), 1)
        first = payload["items"][0]
        for key in ("title", "type", "date", "url", "pdf_url"):
            self.assertIn(key, first)

    @patch("services.analysis_api.server.fetch_nav_trend")
    def test_fund_nav_trend_endpoint_returns_points(self, mock_fetch) -> None:
        now_ms = int(time.time() * 1000)
        mock_fetch.return_value = [{"x": now_ms, "date": "2026-03-10", "nav": 1.2345}]
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds/005827/nav-trend?range=1m")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["fund_id"], "005827")
        self.assertEqual(payload["range"], "1m")
        self.assertTrue(payload["points"])

    @patch("services.analysis_api.server.fetch_top_holdings_with_quotes")
    def test_fund_top_holdings_endpoint_returns_items(self, mock_fetch) -> None:
        mock_fetch.return_value = {
            "disclosure_date": "2026-03-10",
            "items": [
                {
                    "code": "600519",
                    "name": "贵州茅台",
                    "weight_percent": 9.8,
                    "price": 1800.0,
                    "change_rate": 0.0123,
                    "contribution": 0.0012,
                }
            ],
        }
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds/005827/top-holdings?limit=10")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertIn("disclosure_date", payload)
        self.assertIn("items", payload)
        self.assertTrue(payload["items"])
        first = payload["items"][0]
        for key in ("code", "name", "weight_percent", "price", "change_rate", "contribution"):
            self.assertIn(key, first)

    @patch("services.analysis_api.intraday_estimator.fetch_fund_estimate")
    @patch("services.analysis_api.intraday_estimator.estimate_real_fund_intraday")
    @patch("services.analysis_api.holdings.build_real_fund_profile")
    def test_real_fund_intraday_estimate_falls_back_to_official_estimate(
        self,
        mock_build_profile,
        mock_estimate_real,
        mock_fetch_estimate,
    ) -> None:
        mock_build_profile.return_value = FundProfile(
            fund_id="005827",
            name="易方达蓝筹精选混合",
            category="混合型",
            risk_level="high",
            manager="张坤",
            manager_tenure_years=5.2,
            fee_rate=0.015,
            theme="蓝筹价值",
            nav_history=(1.0, 1.01, 1.02, 1.03),
        )
        mock_estimate_real.side_effect = RuntimeError("penetration failed")
        mock_fetch_estimate.return_value = {
            "estimated_return": 0.0123,
            "latest_nav": 1.2345,
            "estimated_nav": 1.2496,
            "gztime": "2026-03-10 10:30",
        }

        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds/005827/intraday-estimate")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertTrue(payload["is_real_data"])
        self.assertEqual(payload["estimate_source_label"], "官方实时估值(天天基金)")

    @patch("services.analysis_api.server.fetch_fund_catalog")
    def test_funds_endpoint_returns_paginated_catalog(self, mock_catalog) -> None:
        mock_catalog.return_value = {
            "items": [
                {
                    "fund_id": "005827",
                    "name": "易方达蓝筹精选混合",
                    "category": "混合型",
                    "theme": "蓝筹价值",
                    "risk_level": "high",
                    "manager": "张坤",
                    "latest_nav": 1.8228,
                },
                {
                    "fund_id": "161725",
                    "name": "招商中证白酒指数(LOF)A",
                    "category": "指数型",
                    "theme": "白酒消费",
                    "risk_level": "high",
                    "manager": "侯昊",
                    "latest_nav": 0.6545,
                },
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
        self.assertTrue(all("fund_id" in item for item in payload["items"]))
        self.assertTrue(all("name" in item for item in payload["items"]))
        self.assertTrue(all("latest_nav" in item for item in payload["items"]))

    def test_funds_search_endpoint_returns_field_complete_results(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds/search?q={urllib.parse.quote('白酒')}")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertIn("items", payload)
        self.assertIn("total", payload)
        self.assertGreaterEqual(payload["total"], 1)
        first = payload["items"][0]
        for key in ("fund_id", "name", "category", "theme", "risk_level"):
            self.assertIn(key, first)

    def test_funds_endpoint_supports_query_param(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds?q={urllib.parse.quote('易方达')}")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertIn("items", payload)
        self.assertIn("total", payload)
        self.assertGreaterEqual(payload["total"], 1)

    def test_fund_search_endpoint_requires_q(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(f"{self.base_url}/api/v1/funds/search")
        self.assertEqual(context.exception.code, 400)

    @patch("services.analysis_api.server.extract_holdings_from_image_data")
    def test_holdings_ocr_endpoint_returns_suggestions_and_warnings(self, mock_ocr) -> None:
        mock_ocr.return_value = {
            "ocr_text": "华夏中证电网设备...",
            "suggestions": [
                {
                    "fundQuery": "001838",
                    "fundName": "华夏中证电网设备主题ETF联接A",
                    "amount": "1708.64",
                    "profit": "90.52",
                }
            ],
            "warnings": ["OCR 为辅助识别，建议检查后再导入。"],
        }
        payload = self._post_json(
            "/api/v1/holdings/ocr",
            {"image_base64": "data:image/png;base64,ZmFrZQ=="},
        )
        self.assertIn("ocr_text", payload)
        self.assertIn("suggestions", payload)
        self.assertIn("warnings", payload)
        self.assertEqual(payload["suggestions"][0]["fundQuery"], "001838")
        self.assertEqual(payload["suggestions"][0]["fundName"], "华夏中证电网设备主题ETF联接A")
        self.assertEqual(payload["suggestions"][0]["amount"], "1708.64")
        self.assertEqual(payload["suggestions"][0]["profit"], "90.52")
        self.assertTrue(payload["warnings"])

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

    def test_assistant_endpoint_returns_forecast(self) -> None:
        payload = self._post_json(
            "/api/v1/assistant/ask",
            {
                "question": "未来几天会怎么走？",
                "fund_id": "F003",
                "cash_available": 1200,
            },
        )
        self.assertIn("forecast", payload)
        forecast = payload["forecast"]
        self.assertEqual(forecast["horizon_trading_days"], 5)
        self.assertIn(forecast["direction"], {"up", "down"})

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

    def test_assistant_endpoint_returns_portfolio_answer_for_holdings_question(self) -> None:
        payload = self._post_json(
            "/api/v1/assistant/ask",
            {
                "question": "我持仓的这几只基金接下来几天有什么动向？我是否需要操作",
                "fund_id": "F003",
                "holdings": [
                    {"fund_id": "F002", "shares": 800, "cost_nav": 1.05},
                    {"fund_id": "F003", "shares": 900, "cost_nav": 1.10},
                ],
            },
        )
        self.assertIn("per_fund", payload)
        self.assertGreaterEqual(len(payload["per_fund"]), 2)
        self.assertEqual(payload["portfolio"]["holding_count"], 2)

    def test_funds_endpoint_with_risk_level_returns_page_contract(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds?risk_level=high&page=1&page_size=20")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertIn("items", payload)
        self.assertIn("total", payload)
        self.assertIn("page", payload)
        self.assertIn("page_size", payload)
        self.assertEqual(payload["page"], 1)
        self.assertEqual(payload["page_size"], 20)

    def test_funds_search_endpoint_result_items_have_stable_shape(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/v1/funds/search?q={urllib.parse.quote('易方达')}")
        payload = json.loads(response.read().decode("utf-8"))
        self.assertGreaterEqual(payload["total"], 1)
        first = payload["items"][0]
        for key in ("fund_id", "name", "category", "theme", "risk_level"):
            self.assertIn(key, first)
        self.assertTrue(str(first["fund_id"]))
        self.assertTrue(str(first["name"]))

    @patch("services.analysis_api.server.extract_holdings_from_image_data")
    def test_holdings_ocr_endpoint_preserves_match_metadata(self, mock_ocr) -> None:
        mock_ocr.return_value = {
            "ocr_text": "易方达蓝筹精选混合",
            "suggestions": [
                {
                    "fundQuery": "005827",
                    "fundName": "易方达蓝筹精选混合",
                    "amount": "3109.64",
                    "profit": "65.62",
                    "match_count": 1,
                    "raw_text": "易方达蓝筹精选混合 ¥3109.64 +65.62",
                }
            ],
            "warnings": ["OCR 为辅助识别，建议检查后再导入。"],
        }
        payload = self._post_json(
            "/api/v1/holdings/ocr",
            {"image_base64": "data:image/png;base64,ZmFrZQ=="},
        )
        self.assertEqual(payload["suggestions"][0]["match_count"], 1)
        self.assertTrue(payload["suggestions"][0]["raw_text"])

    def test_assistant_endpoint_confidence_shape_is_stable(self) -> None:
        payload = self._post_json(
            "/api/v1/assistant/ask",
            {
                "question": "为什么最近会跌，接下来什么时候更适合卖？",
                "fund_id": "F003",
                "cash_available": 1800,
            },
        )
        self.assertIn("confidence", payload)
        self.assertIn("score", payload["confidence"])
        self.assertIn("label", payload["confidence"])
        self.assertIn("reason", payload["confidence"])


if __name__ == "__main__":
    unittest.main()
