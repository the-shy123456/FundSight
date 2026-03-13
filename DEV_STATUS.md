# FundSight 开发进度（自动播报源）

更新时间：2026-03-13

## 当前目标
把现有 Python `services/analysis_api` 的 HTTP API 逐步迁移为 Rust（优先保证前端接口兼容），再做 Windows 端跑腿与可打包。

## 已完成（Rust: `services/analysis_api_rs`）
- /api/v1/health
- /api/v1/portfolio
- /api/v1/holdings/import
- /api/v1/holdings/ocr（占位 + 支持用 CSV 文本冒充 OCR 结果做联调）
- /api/v1/assistant/ask（规则版：单基金 + 组合问答）
- /api/v1/portfolio/intraday（官方估值聚合的 contributions/图表）
- /api/v1/watchlist (GET/POST)
- /api/v1/watchlist/{fund_id} (DELETE)
- /api/v1/watchlist/intraday
- /api/v1/funds
- /api/v1/funds/search
- /api/v1/funds/{fund_id}/intraday-estimate
- /api/v1/funds/{fund_id}/nav-trend
- /api/v1/funds/{fund_id}/top-holdings

## 下一步（按前端依赖顺序）
1. 继续提升 Rust 版 assistant：接入 LLM（当前是规则版），补 announcement_evidence/announcements 等证据结构。
2. holdings/ocr：接 Windows 原生 OCR（当前只做联调占位：可解析 CSV 文本）。
3. 桌面端：Windows 真机打包验证（Tauri + Rust 上游自启动）。
4. Rust 版 portfolio snapshot：补齐 theme/risk_level 等展示字段（当前多数为空）。
