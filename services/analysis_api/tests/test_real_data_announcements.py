from __future__ import annotations

import unittest
from unittest.mock import patch

from services.analysis_api import real_data


APIDATA_SAMPLE = '''var apidata={content:"<table><tr><td><a href=\\"https://fundf10.eastmoney.com/notice1.html\\">关于基金经理变更的公告</a><a href=\\"https://pdf.dfcfw.com/pdf/AAA.pdf\\">PDF</a></td><td>临时公告</td><td>2026-03-10</td></tr></table>",records:1,pages:1,curpage:1};'''


class RealDataAnnouncementTestCase(unittest.TestCase):
    @patch("services.analysis_api.real_data._fetch_text")
    def test_fetch_fund_announcements_parses_items(self, mock_fetch) -> None:
        mock_fetch.return_value = APIDATA_SAMPLE
        real_data.CACHE.clear()

        payload = real_data.fetch_fund_announcements("005827", page=1, per=20)
        self.assertEqual(payload["total"], 1)
        self.assertEqual(len(payload["items"]), 1)

        item = payload["items"][0]
        for key in ("title", "type", "date", "url", "pdf_url"):
            self.assertIn(key, item)
        self.assertEqual(item["title"], "关于基金经理变更的公告")
        self.assertEqual(item["type"], "临时公告")
        self.assertEqual(item["date"], "2026-03-10")
        self.assertTrue(item["url"].startswith("https://"))
        self.assertTrue(item["pdf_url"].endswith(".pdf"))


if __name__ == "__main__":
    unittest.main()
