# FundSight 开发进度（自动播报源）

更新时间：2026-03-12

## 当前目标
把现有 Python `services/analysis_api` 的 HTTP API 逐步迁移为 Rust（优先保证前端接口兼容），再做 Windows 端跑腿与可打包。

## 已完成（Rust: `services/analysis_api_rs`）
- /api/v1/health
- /api/v1/portfolio
- /api/v1/holdings/import
- /api/v1/watchlist (GET/POST)
- /api/v1/watchlist/{fund_id} (DELETE)
- /api/v1/watchlist/intraday
- /api/v1/funds
- /api/v1/funds/search
- /api/v1/funds/{fund_id}/intraday-estimate
- /api/v1/funds/{fund_id}/nav-trend
- /api/v1/funds/{fund_id}/top-holdings

## 下一步（按前端依赖顺序）
1. /api/v1/portfolio/intraday（补齐 contributions/图表结构，保证持仓页 UI 完整）
2. /api/v1/assistant/ask（结构化输出，后续融合 LLM）
3. /api/v1/holdings/ocr（已先做占位响应；下一步接 Windows 原生 OCR）
4. 桌面端：默认上游改为 Rust `analysis_api_rs`（已改代码，待 Windows 真机验证）
