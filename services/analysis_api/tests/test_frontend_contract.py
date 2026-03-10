from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
import unittest
from urllib.parse import urlparse


ROOT_DIR = Path(__file__).resolve().parents[3]
DIST_DIR = ROOT_DIR / "apps" / "web" / "dist"
INDEX_HTML = DIST_DIR / "index.html"


class DistIndexParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.element_ids: set[str] = set()
        self.script_sources: list[str] = []
        self.stylesheet_hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        element_id = attributes.get("id")
        if element_id:
            self.element_ids.add(element_id)

        if tag == "script":
            source = attributes.get("src")
            if source:
                self.script_sources.append(source)

        if tag == "link":
            href = attributes.get("href")
            rel = (attributes.get("rel") or "").split()
            if href and "stylesheet" in rel:
                self.stylesheet_hrefs.append(href)


class FrontendContractTestCase(unittest.TestCase):
    def _read_index_html(self) -> str:
        self.assertTrue(INDEX_HTML.is_file(), f"缺少前端构建产物: {INDEX_HTML}")
        return INDEX_HTML.read_text(encoding="utf-8")

    def _parse_index_html(self) -> DistIndexParser:
        parser = DistIndexParser()
        parser.feed(self._read_index_html())
        parser.close()
        return parser

    def _collect_local_assets(self, references: list[str], suffix: str) -> list[str]:
        local_assets: list[str] = []
        for reference in references:
            parsed = urlparse(reference)
            if parsed.scheme or parsed.netloc or reference.startswith("//"):
                continue
            if Path(parsed.path).suffix != suffix:
                continue
            local_assets.append(reference)
        return local_assets

    def _resolve_dist_asset(self, reference: str) -> Path:
        asset_path = urlparse(reference).path
        if asset_path.startswith("/"):
            candidate = (DIST_DIR / asset_path.lstrip("/")).resolve()
        else:
            candidate = (INDEX_HTML.parent / asset_path).resolve()

        try:
            candidate.relative_to(DIST_DIR.resolve())
        except ValueError as error:
            self.fail(f"资源路径越界: {reference} -> {candidate} ({error})")
        return candidate

    def test_dist_index_html_exists(self) -> None:
        self.assertTrue(INDEX_HTML.is_file(), f"缺少前端构建产物: {INDEX_HTML}")

    def test_dist_index_contains_root_mount_node(self) -> None:
        parser = self._parse_index_html()
        self.assertIn("root", parser.element_ids)

    def test_dist_index_local_js_and_css_assets_exist(self) -> None:
        parser = self._parse_index_html()
        local_js_assets = self._collect_local_assets(parser.script_sources, ".js")
        local_css_assets = self._collect_local_assets(parser.stylesheet_hrefs, ".css")

        self.assertTrue(local_js_assets, "dist/index.html 未引用本地 JS 资源")
        self.assertTrue(local_css_assets, "dist/index.html 未引用本地 CSS 资源")

        for reference in [*local_js_assets, *local_css_assets]:
            with self.subTest(reference=reference):
                self.assertTrue(
                    self._resolve_dist_asset(reference).is_file(),
                    f"index.html 引用的资源不存在: {reference}",
                )


if __name__ == "__main__":
    unittest.main()
