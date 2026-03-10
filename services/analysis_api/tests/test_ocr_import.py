from __future__ import annotations

import unittest
from unittest.mock import patch

from services.analysis_api.ocr_import import parse_holdings_from_ocr_text


class OcrImportTestCase(unittest.TestCase):
    @patch("services.analysis_api.ocr_import.search_funds")
    def test_parse_holdings_from_ocr_text_extracts_rows(self, mock_search_funds) -> None:
        def search_side_effect(query: str, _sample_funds, limit: int = 3):
            mapping = {
                "华夏中证电网设备": [{"fund_id": "001838", "name": "华夏中证电网设备主题ETF联接A", "category": "指数型", "theme": "电网设备", "risk_level": "high"}],
                "南方亚太精选E": [{"fund_id": "160125", "name": "南方亚太精选ETF联接(QDII)A", "category": "QDII", "theme": "亚太精选", "risk_level": "high"}],
            }
            return mapping.get(query, [])

        mock_search_funds.side_effect = search_side_effect
        text = "华夏中证电网设备…\n¥1708.64\n+11.53\n+90.52\n南方亚太精选E…\n¥382.95\n+7.95\n-13.44"
        payload = parse_holdings_from_ocr_text(text)
        self.assertEqual(len(payload["suggestions"]), 2)
        self.assertEqual(payload["suggestions"][0]["fundQuery"], "001838")
        self.assertEqual(payload["suggestions"][0]["amount"], "1708.64")
        self.assertEqual(payload["suggestions"][0]["profit"], "90.52")
        self.assertEqual(payload["suggestions"][1]["fundQuery"], "160125")
        self.assertEqual(payload["suggestions"][1]["profit"], "-13.44")

    @patch("services.analysis_api.ocr_import.search_funds")
    def test_parse_holdings_ignores_headers_and_groups_multi_fund_blocks(self, mock_search_funds) -> None:
        def search_side_effect(query: str, _sample_funds, limit: int = 3):
            mapping = {
                "国泰黄金ETF联接": [{"fund_id": "000218", "name": "国泰黄金ETF联接A", "category": "联接基金", "theme": "黄金", "risk_level": "medium"}],
                "华夏中证电网": [{"fund_id": "001838", "name": "华夏中证电网设备主题ETF联接A", "category": "指数型", "theme": "电网设备", "risk_level": "high"}],
                "广发远见智选": [{"fund_id": "016873", "name": "广发远见智选混合A", "category": "混合型", "theme": "均衡成长", "risk_level": "medium"}],
            }
            return mapping.get(query, [])

        mock_search_funds.side_effect = search_side_effect
        text = (
            "账户资产\n6798.20\n当日总收益\n-22.60\n"
            "国泰黄金ETF联接…\n已更新\n¥4499．67\n-39.94\n-0.88%\n黄金9999\n-0.89%\n-0.33\n-0.01%\n"
            "华夏中证电网…\n已更新\n¥1708．64\n+11.53\n+0.68%\n中证电网设备\n+0.71%\n+90.52\n+5.59%\n"
            "广发远见智选…\n已更新\n¥206.95\n-2.13\n-1.02%\n-\n+6.95\n+3.47%"
        )
        payload = parse_holdings_from_ocr_text(text)
        self.assertEqual([item["fundQuery"] for item in payload["suggestions"]], ["000218", "001838", "016873"])
        self.assertEqual(payload["suggestions"][0]["amount"], "4499.67")
        self.assertEqual(payload["suggestions"][1]["profit"], "90.52")
        self.assertEqual(payload["suggestions"][2]["profit"], "+6.95")

    @patch("services.analysis_api.ocr_import.search_funds")
    def test_parse_holdings_handles_truncated_names_and_full_width_decimal(self, mock_search_funds) -> None:
        def search_side_effect(query: str, _sample_funds, limit: int = 3):
            mapping = {
                "南方亚太精选E": [{"fund_id": "160125", "name": "南方亚太精选ETF联接(QDII)A", "category": "QDII", "theme": "亚太精选", "risk_level": "high"}],
            }
            return mapping.get(query, [])

        mock_search_funds.side_effect = search_side_effect
        text = "南方亚太精选E…¥382．95+7．95-13．44"
        payload = parse_holdings_from_ocr_text(text)
        self.assertEqual(len(payload["suggestions"]), 1)
        self.assertEqual(payload["suggestions"][0]["fundQuery"], "160125")
        self.assertEqual(payload["suggestions"][0]["amount"], "382.95")
        self.assertEqual(payload["suggestions"][0]["profit"], "-13.44")

    @patch("services.analysis_api.ocr_import.search_funds")
    def test_parse_holdings_returns_match_metadata_and_warning(self, mock_search_funds) -> None:
        mock_search_funds.return_value = [
            {"fund_id": "005827", "name": "易方达蓝筹精选混合", "category": "混合型", "theme": "蓝筹价值", "risk_level": "high"}
        ]
        payload = parse_holdings_from_ocr_text("易方达蓝筹精选混合\n¥3109.64\n+65.62")
        self.assertTrue(payload["warnings"])
        self.assertEqual(payload["suggestions"][0]["fundQuery"], "005827")
        self.assertEqual(payload["suggestions"][0]["fundName"], "易方达蓝筹精选混合")
        self.assertEqual(payload["suggestions"][0]["match_count"], 1)
        self.assertIn("raw_text", payload["suggestions"][0])

    @patch("services.analysis_api.ocr_import.search_funds")
    def test_parse_holdings_without_match_keeps_query_and_zero_match_count(self, mock_search_funds) -> None:
        mock_search_funds.return_value = []
        payload = parse_holdings_from_ocr_text("未知基金名称\n¥888.88\n+12.34")
        self.assertEqual(len(payload["suggestions"]), 1)
        self.assertEqual(payload["suggestions"][0]["fundQuery"], "未知基金名称")
        self.assertEqual(payload["suggestions"][0]["fundName"], "未知基金名称")
        self.assertEqual(payload["suggestions"][0]["match_count"], 0)
        self.assertTrue(payload["suggestions"][0]["raw_text"])


if __name__ == "__main__":
    unittest.main()
