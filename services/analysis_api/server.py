from __future__ import annotations

import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .analytics import build_dashboard_snapshot, build_diagnosis, build_fund_snapshot, recommend_portfolio
from .assistant import ask_assistant
from .holdings import get_holdings, import_holdings_payload, parse_holdings_payload
from .intraday_estimator import estimate_fund_intraday
from .models import InvestorProfile
from .ocr_import import extract_holdings_from_image_data
from .portfolio import build_portfolio_intraday, build_portfolio_snapshot, find_fund
from .research import build_research_brief
from .real_data import fetch_fund_catalog, search_real_funds
from .sample_data import FUNDS


ROOT_DIR = Path(__file__).resolve().parents[2]
WEB_DIR = ROOT_DIR / "apps" / "web"
STATIC_FILES = {"/app.js", "/styles.css", "/fund.js", "/fund.css"}


def json_response(handler: BaseHTTPRequestHandler, payload: Any, status: int = 200) -> None:
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(encoded)))
    handler.end_headers()
    handler.wfile.write(encoded)


def search_funds(query: str) -> list[dict[str, object]]:
    clean_query = query.strip()
    if not clean_query:
        return []

    sample_matches = [
        {
            "fund_id": fund.fund_id,
            "name": fund.name,
            "category": fund.category,
            "theme": fund.theme,
            "risk_level": fund.risk_level,
        }
        for fund in FUNDS
        if clean_query.lower() in fund.fund_id.lower() or clean_query.lower() in fund.name.lower()
    ]

    real_matches = search_real_funds(clean_query)
    merged: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in [*sample_matches, *real_matches]:
        fund_id = str(item.get("fund_id", "")).strip()
        if not fund_id or fund_id in seen:
            continue
        seen.add(fund_id)
        merged.append(item)
    return merged[:5]


def build_search_response(keyword: str) -> dict[str, object]:
    items = search_funds(keyword)
    return {"items": items, "total": len(items)}


def build_funds_response(page: int = 1, page_size: int = 30, risk_level: str | None = None) -> dict[str, object]:
    try:
        return fetch_fund_catalog(page=page, page_size=page_size, risk_level=risk_level)
    except Exception:
        fallback = [
            build_diagnosis(fund)
            for fund in FUNDS
            if risk_level is None or fund.risk_level == risk_level
        ]
        start = max(0, (page - 1) * page_size)
        end = start + page_size
        return {"items": fallback[start:end], "total": len(fallback), "page": page, "page_size": page_size}


def parse_holdings_request(data: dict[str, Any], *, persist: bool) -> tuple[object, tuple[object, ...]]:
    if "holdings" in data:
        source = data.get("holdings")
    else:
        source = str(data.get("text", ""))

    if persist:
        holdings = import_holdings_payload(source, FUNDS)
    else:
        holdings = parse_holdings_payload(source, FUNDS)
    return source, holdings


class FundInsightHandler(BaseHTTPRequestHandler):
    server_version = "FundInsightHub/0.3"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/v1/health":
            json_response(self, {"status": "ok", "service": "analysis_api", "fund_count": len(FUNDS)})
            return

        if parsed.path == "/api/v1/dashboard":
            json_response(self, build_dashboard_snapshot(FUNDS))
            return

        if parsed.path == "/api/v1/portfolio":
            json_response(self, build_portfolio_snapshot())
            return

        if parsed.path == "/api/v1/portfolio/intraday":
            json_response(self, build_portfolio_intraday())
            return

        if parsed.path == "/api/v1/funds/search":
            query = parse_qs(parsed.query)
            keyword = str(query.get("q", [""])[0]).strip()
            if not keyword:
                json_response(self, {"message": "q 不能为空"}, HTTPStatus.BAD_REQUEST)
                return
            json_response(self, build_search_response(keyword))
            return

        if parsed.path == "/api/v1/funds":
            query = parse_qs(parsed.query)
            search_query = query.get("q", [None])[0]
            if search_query is not None:
                keyword = str(search_query).strip()
                json_response(self, build_search_response(keyword) if keyword else {"items": [], "total": 0, "page": 1, "page_size": 30})
                return

            risk_level = query.get("risk_level", [None])[0]
            try:
                page = int(query.get("page", [1])[0])
                page_size = int(query.get("page_size", [30])[0])
            except (TypeError, ValueError):
                json_response(self, {"message": "page 和 page_size 必须是数字"}, HTTPStatus.BAD_REQUEST)
                return
            json_response(self, build_funds_response(page=page, page_size=page_size, risk_level=str(risk_level) if risk_level else None))
            return
        if parsed.path.startswith("/api/v1/funds/"):
            relative_path = parsed.path.removeprefix("/api/v1/funds/")
            if relative_path.endswith("/snapshot"):
                fund_id = relative_path.removesuffix("/snapshot")
                fund = find_fund(fund_id, FUNDS)
                if not fund:
                    json_response(self, {"message": "基金不存在"}, HTTPStatus.NOT_FOUND)
                    return
                json_response(self, build_fund_snapshot(fund, FUNDS))
                return

            if relative_path.endswith("/intraday-estimate"):
                fund_id = relative_path.removesuffix("/intraday-estimate")
                fund = find_fund(fund_id, FUNDS)
                if not fund:
                    json_response(self, {"message": "基金不存在"}, HTTPStatus.NOT_FOUND)
                    return
                json_response(self, estimate_fund_intraday(fund))
                return

            fund = find_fund(relative_path, FUNDS)
            if not fund:
                json_response(self, {"message": "基金不存在"}, HTTPStatus.NOT_FOUND)
                return
            json_response(self, build_diagnosis(fund))
            return

        if parsed.path in {"/", "/index.html"}:
            self._serve_static("index.html")
            return

        if parsed.path == "/fund.html":
            self._serve_static("fund.html")
            return

        if parsed.path in STATIC_FILES:
            self._serve_static(parsed.path.lstrip("/"))
            return

        json_response(self, {"message": "资源不存在"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/v1/analyze/recommendation":
            self._handle_recommendation()
            return

        if self.path == "/api/v1/research/brief":
            self._handle_research_brief()
            return

        if self.path == "/api/v1/holdings/import":
            self._handle_holdings_import()
            return

        if self.path == "/api/v1/holdings/ocr":
            self._handle_holdings_ocr()
            return

        if self.path == "/api/v1/assistant/ask":
            self._handle_assistant_ask()
            return

        json_response(self, {"message": "资源不存在"}, HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args: object) -> None:
        return

    def _handle_recommendation(self) -> None:
        data = self._read_json()
        if data is None:
            return

        try:
            investor = InvestorProfile(
                risk_level=str(data.get("risk_level", "medium")),
                monthly_budget=float(data.get("monthly_budget", 3000)),
                investment_horizon_months=int(data.get("investment_horizon_months", 12)),
            )
        except (TypeError, ValueError):
            json_response(self, {"message": "参数格式错误"}, HTTPStatus.BAD_REQUEST)
            return

        if investor.risk_level not in {"low", "medium", "high"}:
            json_response(self, {"message": "risk_level 仅支持 low、medium、high"}, HTTPStatus.BAD_REQUEST)
            return

        json_response(self, recommend_portfolio(FUNDS, investor))

    def _handle_research_brief(self) -> None:
        data = self._read_json()
        if data is None:
            return
        json_response(self, build_research_brief(str(data.get("text", ""))))

    def _handle_holdings_import(self) -> None:
        data = self._read_json()
        if data is None:
            return
        try:
            _, holdings = parse_holdings_request(data, persist=True)
        except ValueError as error:
            json_response(self, {"message": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        json_response(self, build_portfolio_snapshot(holdings, FUNDS))

    def _handle_holdings_ocr(self) -> None:
        data = self._read_json()
        if data is None:
            return
        try:
            payload = extract_holdings_from_image_data(str(data.get("image_base64", "")))
        except (TypeError, ValueError, RuntimeError) as error:
            json_response(self, {"message": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        json_response(self, payload)

    def _handle_assistant_ask(self) -> None:
        data = self._read_json()
        if data is None:
            return
        try:
            holdings = get_holdings()
            if "holdings" in data or "text" in data:
                _, holdings = parse_holdings_request(data, persist=False)
            payload = ask_assistant(
                question=str(data.get("question", "")),
                fund_id=str(data.get("fund_id", "")) or None,
                cash_available=float(data.get("cash_available", 0)),
                holdings=holdings,
            )
        except (TypeError, ValueError) as error:
            json_response(self, {"message": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        json_response(self, payload)

    def _read_json(self) -> dict[str, Any] | None:
        content_length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(content_length) if content_length else b"{}"
        try:
            return json.loads(payload.decode("utf-8"))
        except json.JSONDecodeError:
            json_response(self, {"message": "请求体不是合法 JSON"}, HTTPStatus.BAD_REQUEST)
            return None

    def _serve_static(self, filename: str) -> None:
        file_path = WEB_DIR / filename
        if not file_path.exists():
            json_response(self, {"message": "页面不存在"}, HTTPStatus.NOT_FOUND)
            return

        content = file_path.read_bytes()
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
        }.get(file_path.suffix, "application/octet-stream")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(content)


def run_server(host: str = "127.0.0.1", port: int = 8080) -> None:
    httpd = ThreadingHTTPServer((host, port), FundInsightHandler)
    print(f"Fund Insight Hub listening on http://{host}:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    run_server()

