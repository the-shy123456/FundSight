# Fund Insight Hub

基金分析系统第一阶段原型。

当前目标：

- 提供基金画像、风险指标、操作建议的最小可运行闭环
- 为后续 Web、Windows、Mobile 三端复用统一分析能力
- 为后续深度搜索、文章解析、RAG、回测引擎预留边界

## 目录

```text
apps/
  desktop/       Windows 桌面端占位
  mobile/        手机端占位
  web/           Web 原型页面
docs/
  architecture.md
  roadmap.md
  realtime-holding-ai-feature.md
services/
  analysis_api/  Python 分析服务
```

## 本地运行

```powershell
python -m services.analysis_api.server
```

启动后访问：

- Web 原型：`http://127.0.0.1:8080/`
- 健康检查：`http://127.0.0.1:8080/api/v1/health`

## 运行测试

```powershell
python -m unittest discover -s services/analysis_api/tests -p "test_*.py"
```

## 当前能力

- 基金列表与详情接口
- 基于样例净值的收益、波动、最大回撤、动量计算
- 根据风险等级、预算、投资周期输出基金组合建议
- 给出分批买入 / 减仓观察类操作建议
- 对公告、研报、新闻摘要做研究简报提炼
- 支持导入持仓并输出今日收益估算原型
- 支持基于场内代理标的的盘中穿透估算原型
- 支持针对单只持仓基金的 AI 问答原型

## 原型接口

```text
GET  /api/v1/portfolio
GET  /api/v1/portfolio/intraday
POST /api/v1/holdings/import
GET  /api/v1/funds/{id}/intraday-estimate
POST /api/v1/assistant/ask
```

说明：

- 当前“场内穿透”仍是原型实现，使用 ETF / 指数代理估算，不等同基金官方实时净值
- 当前 AI 助手基于持仓状态、盘中估算、历史动量与规则引擎生成建议
- 详细方案见 `docs/realtime-holding-ai-feature.md`

## 下一步

- 接真实基金净值、公告、季报与基金经理数据
- 引入向量检索和文章解析增强
- 建立回测引擎与策略评估
- 接入 Tauri 与 React Native 客户端