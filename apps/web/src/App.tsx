import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  BrainCircuit,
  Camera,
  FolderPlus,
  LineChart,
  LoaderCircle,
  RefreshCw,
  Search,
  SendHorizontal,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";
import {
  buildImportTextFromRows,
  requestAssistant,
  requestFundSearch,
  requestFundsCatalog,
  requestHoldingsImport,
  requestHoldingsOcr,
  requestPortfolio,
  requestPortfolioIntraday,
} from "./lib/api";
import {
  formatCurrency,
  formatSignedCurrency,
  formatSignedPercent,
  isValidManualRow,
  normalizeFundCode,
  parseNumber,
  toneClass,
} from "./lib/format";
import {
  DEFAULT_ROWS,
  EMPTY_ROW,
  restoreAiConfigs,
  restoreAssistantQuestion,
  restoreManualRows,
  saveAiConfigs,
  saveAssistantQuestion,
  saveManualRows,
} from "./lib/storage";
import type {
  AiConfig,
  AssistantResponse,
  FundCatalogItem,
  ImportTab,
  ManualRow,
  PortfolioIntraday,
  PortfolioPosition,
  PortfolioSnapshot,
  ViewTab,
} from "./types";

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

type ManualEntry = {
  query: string;
  fundName: string;
  amount: string;
  profit: string;
};

type ConfigFormState = {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
};

function createManualEntry(): ManualEntry {
  return { query: "", fundName: "", amount: "", profit: "" };
}

function emptySnapshot(): PortfolioSnapshot {
  return {
    summary: {
      holding_count: 0,
      current_value: 0,
      market_value: 0,
      today_estimated_pnl: 0,
      today_profit: 0,
      today_estimated_return: 0,
      today_return: 0,
      total_pnl: 0,
      total_profit: 0,
      total_return: 0,
    },
    positions: [],
    signals: [],
    disclaimer: "当前组合为空。",
  };
}

function formatPlainAmount(value: unknown): string {
  return parseNumber(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function nowLabel(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function greetingText(snapshot: PortfolioSnapshot | null): string {
  if (!snapshot?.summary) {
    return "你好！我是你的专属 AI 金融助理。先导入持仓，我再结合盘中估算帮你分析。";
  }
  const todayPnl = formatSignedCurrency(snapshot.summary.today_estimated_pnl ?? snapshot.summary.today_profit);
  const todayReturn = formatSignedPercent(snapshot.summary.today_estimated_return ?? snapshot.summary.today_return);
  return `你好！我是你的专属 AI 金融助理。我已经读取了你的持仓和当前的市场实时行情（组合今日估算 ${todayPnl}，${todayReturn}）。有什么可以帮你的？`;
}

function assistantText(payload: AssistantResponse): string {
  const lines = [payload.summary || "我先给你一个简要判断。"];

  if (payload.actions?.length) {
    lines.push("", "建议：");
    payload.actions.slice(0, 2).forEach((item) => {
      lines.push(`- ${item.title}：${item.detail}`);
    });
  }

  if (payload.evidence?.length) {
    lines.push("", "依据：");
    payload.evidence.slice(0, 2).forEach((item) => {
      lines.push(`- ${item.label} ${item.value}`);
    });
  }

  if (payload.risks?.length) {
    lines.push("", `风险提示：${payload.risks[0]}`);
  }

  return lines.join("\n");
}

function formFromConfig(config?: AiConfig | null): ConfigFormState {
  return {
    id: config?.id ?? "",
    name: config?.name ?? "",
    endpoint: config?.endpoint ?? "",
    apiKey: config?.apiKey ?? "",
  };
}

function hydrateRows(rows: ManualRow[], snapshot: PortfolioSnapshot): ManualRow[] {
  const nameMap = new Map((snapshot.positions || []).map((item) => [item.fund_id, item.name]));
  return rows.filter(isValidManualRow).map((row) => {
    const code = normalizeFundCode(row.fundQuery);
    return {
      ...row,
      fundQuery: code,
      fundName: nameMap.get(code) || row.fundName || "",
      status: "confirmed" as const,
    };
  });
}

function createRowFromEntry(entry: ManualEntry, source: ManualRow["source"]): ManualRow {
  return {
    fundQuery: normalizeFundCode(entry.query) || entry.query.trim(),
    fundName: entry.fundName,
    amount: entry.amount,
    profit: entry.profit,
    status: "pending",
    source,
  };
}

function mergeRows(currentRows: ManualRow[], incomingRows: ManualRow[]): ManualRow[] {
  const nextRows = currentRows.length ? [...currentRows] : [];

  for (const incoming of incomingRows) {
    const code = normalizeFundCode(incoming.fundQuery || incoming.fundName);
    const index = code ? nextRows.findIndex((row) => normalizeFundCode(row.fundQuery) === code) : -1;

    if (index >= 0) {
      nextRows[index] = {
        ...nextRows[index],
        fundQuery: code || incoming.fundQuery,
        fundName: incoming.fundName || nextRows[index].fundName,
        amount: incoming.amount || nextRows[index].amount,
        profit: incoming.profit || nextRows[index].profit,
        status: incoming.status,
        source: incoming.source,
      };
    } else {
      nextRows.push({ ...incoming, fundQuery: code || incoming.fundQuery });
    }
  }

  return nextRows;
}

function buildAnalysisQuestion(position: PortfolioPosition): string {
  return `分析一下${position.name}今天的走势？`;
}

export default function App() {
  const initialRows = restoreManualRows();
  const initialConfigs = restoreAiConfigs();

  const [activeTab, setActiveTab] = useState<ViewTab>("portfolio");
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null>(null);
  const [intraday, setIntraday] = useState<PortfolioIntraday | null>(null);
  const [manualRows, setManualRows] = useState<ManualRow[]>(initialRows);
  const [importOpen, setImportOpen] = useState(false);
  const [importTab, setImportTab] = useState<ImportTab>("manual");
  const [manualEntry, setManualEntry] = useState<ManualEntry>(createManualEntry());
  const [manualSuggestions, setManualSuggestions] = useState<FundCatalogItem[]>([]);
  const [modalNotice, setModalNotice] = useState("");
  const [pickerStatus, setPickerStatus] = useState("");
  const [ocrRows, setOcrRows] = useState<ManualRow[]>([]);
  const [ocrWarnings, setOcrWarnings] = useState<string[]>([]);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogItems, setCatalogItems] = useState<FundCatalogItem[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogPageSize, setCatalogPageSize] = useState(10);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [question, setQuestion] = useState(restoreAssistantQuestion());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [activeFundId, setActiveFundId] = useState("");
  const [aiConfigs, setAiConfigs] = useState<AiConfig[]>(initialConfigs);
  const [configForm, setConfigForm] = useState<ConfigFormState>(() =>
    formFromConfig(initialConfigs.find((item) => item.active) || initialConfigs[0] || null),
  );
  const [configNotice, setConfigNotice] = useState("");
  const [booting, setBooting] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pageNotice, setPageNotice] = useState("");

  const positions = snapshot?.positions ?? [];
  const summary = snapshot?.summary;
  const activeConfig = useMemo(() => aiConfigs.find((item) => item.active) || aiConfigs[0] || null, [aiConfigs]);
  const topContribution = intraday?.contributions?.[0];
  const dataQuality = snapshot?.data_quality ?? summary?.data_quality;
  const realDataCount = dataQuality?.real_data_holding_count ?? 0;
  const proxyCount = dataQuality?.proxy_holding_count ?? 0;

  useEffect(() => {
    saveManualRows(manualRows);
  }, [manualRows]);

  useEffect(() => {
    saveAiConfigs(aiConfigs);
  }, [aiConfigs]);

  useEffect(() => {
    saveAssistantQuestion(question);
  }, [question]);

  useEffect(() => {
    setConfigForm(formFromConfig(activeConfig));
  }, [activeConfig]);

  useEffect(() => {
    if (!positions.length) {
      setActiveFundId("");
      return;
    }
    if (activeFundId && positions.some((item) => item.fund_id === activeFundId)) return;
    setActiveFundId(positions[0].fund_id);
  }, [positions, activeFundId]);

  useEffect(() => {
    if (!snapshot || chatMessages.length > 0) return;
    setChatMessages([{ id: crypto.randomUUID(), role: "assistant", text: greetingText(snapshot) }]);
  }, [snapshot, chatMessages.length]);

  useEffect(() => {
    if (activeTab === "library" && !catalogLoaded) {
      void loadCatalog({ query: "", page: 1, pageSize: catalogPageSize });
    }
  }, [activeTab, catalogLoaded, catalogPageSize]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setBooting(true);
      try {
        const restoredRows = initialRows.filter(isValidManualRow);
        await syncRows(restoredRows.length ? restoredRows : DEFAULT_ROWS, restoredRows.length ? "已恢复上次持仓。" : "已加载示例持仓。", false);
      } catch (error) {
        if (!cancelled) {
          setSnapshot(emptySnapshot());
          setChatMessages([{ id: crypto.randomUUID(), role: "assistant", text: "初始化失败，请稍后重试。" }]);
          setPageNotice(error instanceof Error ? error.message : "初始化失败，请稍后重试。");
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  async function syncRows(rows: ManualRow[], successMessage: string, showNotice = true) {
    const validRows = rows.filter(isValidManualRow);
    if (!validRows.length) throw new Error("请至少录入一只基金，且金额必须大于 0。");

    setModalNotice("正在反推份额与成本净值...");
    const text = await buildImportTextFromRows(validRows);
    const portfolioPayload = await requestHoldingsImport(text);
    const intradayPayload = await requestPortfolioIntraday().catch(() => null);
    const hydrated = hydrateRows(validRows, portfolioPayload);

    setManualRows(hydrated);
    setSnapshot(portfolioPayload);
    setIntraday(intradayPayload);
    setImportOpen(false);
    setManualEntry(createManualEntry());
    setManualSuggestions([]);
    setOcrRows([]);
    setOcrWarnings([]);
    setPickerStatus("");
    setModalNotice("");
    if (showNotice) setPageNotice(successMessage);
  }

  async function refreshPortfolioData() {
    setRefreshing(true);
    setPageNotice("正在刷新盘中估算...");
    try {
      const [portfolioPayload, intradayPayload] = await Promise.all([
        requestPortfolio(),
        requestPortfolioIntraday().catch(() => null),
      ]);
      setSnapshot(portfolioPayload);
      setIntraday(intradayPayload);
      setManualRows((currentRows) => hydrateRows(currentRows, portfolioPayload));
      setPageNotice("盘中估算已刷新。");
    } catch (error) {
      setPageNotice(error instanceof Error ? error.message : "刷新失败，请稍后重试。");
    } finally {
      setRefreshing(false);
    }
  }

  async function loadCatalog(params: { query: string; page: number; pageSize: number }) {
    setCatalogLoading(true);
    try {
      const payload = await requestFundsCatalog(params);
      setCatalogItems(payload.items);
      setCatalogTotal(payload.total);
      setCatalogPage(payload.page);
      setCatalogPageSize(payload.page_size);
      setCatalogLoaded(true);
    } catch (error) {
      setCatalogItems([]);
      setCatalogTotal(0);
      setPageNotice(error instanceof Error ? error.message : "基金库加载失败。");
    } finally {
      setCatalogLoading(false);
    }
  }

  async function searchManualSuggestions(value: string) {
    const cleanQuery = value.trim();
    if (cleanQuery.length < 2 && normalizeFundCode(cleanQuery).length < 6) {
      setManualSuggestions([]);
      return;
    }

    try {
      const items = await requestFundSearch(cleanQuery);
      setManualSuggestions(items);
    } catch {
      setManualSuggestions([]);
    }
  }

  function openImportModal() {
    setImportOpen(true);
    setImportTab("manual");
    setManualEntry(createManualEntry());
    setManualSuggestions([]);
    setModalNotice("");
    setPickerStatus("");
    setOcrRows([]);
    setOcrWarnings([]);
  }

  function openImportFromLibrary(item: FundCatalogItem) {
    setImportOpen(true);
    setImportTab("manual");
    setManualEntry({ query: item.fund_id, fundName: item.name, amount: "", profit: "" });
    setManualSuggestions([]);
    setModalNotice(`已选中 ${item.name}，请补充持有金额和累计收益。`);
  }

  function pickSuggestion(item: FundCatalogItem) {
    setManualEntry((current) => ({ ...current, query: item.fund_id, fundName: item.name }));
    setManualSuggestions([]);
  }

  async function submitManualImport() {
    const row = createRowFromEntry(manualEntry, "manual");
    const code = normalizeFundCode(row.fundQuery);
    if (!code) {
      setModalNotice("请输入 6 位基金代码，或先从下拉结果里选中基金。");
      return;
    }
    if (parseNumber(row.amount) <= 0) {
      setModalNotice("持有金额必须大于 0。");
      return;
    }

    try {
      await syncRows(mergeRows(manualRows, [{ ...row, fundQuery: code }]), "持仓导入成功。");
    } catch (error) {
      setModalNotice(error instanceof Error ? error.message : "导入失败，请稍后重试。");
    }
  }

  async function handleUploadFile(file: File) {
    setOcrLoading(true);
    setPickerStatus(`正在识别 ${file.name} ...`);
    setOcrWarnings([]);
    try {
      const payload = await requestHoldingsOcr(file);
      const suggestions = (payload.suggestions ?? []).map((item) => ({
        fundQuery: normalizeFundCode(item.fundQuery || item.fundName),
        fundName: item.fundName || "",
        amount: item.amount || "",
        profit: item.profit || "",
        status: "pending" as const,
        source: "ocr" as const,
      }));
      setOcrRows(suggestions);
      setOcrWarnings(payload.warnings ?? []);
      setPickerStatus(suggestions.length ? `AI 识别完成，共发现 ${suggestions.length} 支基金。` : "没有识别出可导入的基金，请换一张更清晰的截图。");
    } catch (error) {
      setPickerStatus(error instanceof Error ? error.message : "截图识别失败，请稍后重试。");
      setOcrRows([]);
    } finally {
      setOcrLoading(false);
    }
  }

  async function submitOcrImport() {
    if (!ocrRows.length) {
      setPickerStatus("请先上传截图并识别出基金后再导入。");
      return;
    }
    try {
      await syncRows(mergeRows(manualRows, ocrRows), "OCR 持仓导入成功。");
    } catch (error) {
      setPickerStatus(error instanceof Error ? error.message : "OCR 导入失败，请稍后重试。");
    }
  }

  async function ask(questionText?: string, fundId?: string) {
    const cleanQuestion = (questionText ?? question).trim();
    const targetFundId = fundId ?? activeFundId ?? positions[0]?.fund_id ?? "";

    if (!positions.length || !targetFundId) {
      setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", text: "请先导入持仓，再开始分析。" }]);
      return;
    }

    if (!cleanQuestion) return;

    setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text: cleanQuestion }]);
    setAssistantLoading(true);

    try {
      const payload = await requestAssistant({ fundId: targetFundId, question: cleanQuestion });
      setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", text: assistantText(payload) }]);
      setActiveFundId(targetFundId);
      setQuestion("");
    } catch (error) {
      setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", text: error instanceof Error ? error.message : "AI 助手暂时不可用，请稍后重试。" }]);
    } finally {
      setAssistantLoading(false);
    }
  }

  function saveConfig() {
    const name = configForm.name.trim();
    const endpoint = configForm.endpoint.trim();
    if (!name || !endpoint) {
      setConfigNotice("请至少填写配置名称和接口地址。");
      return;
    }

    const nextConfig: AiConfig = {
      id: configForm.id || crypto.randomUUID(),
      name,
      endpoint,
      apiKey: configForm.apiKey.trim(),
      active: true,
    };

    setAiConfigs((current) => [nextConfig, ...current.filter((item) => item.id !== nextConfig.id).map((item) => ({ ...item, active: false }))]);
    setConfigNotice(configForm.id ? "配置已更新。" : "配置已保存。");
  }

  return (
    <div className="bg-gray-50 text-gray-800 h-screen flex flex-col overflow-hidden relative">
      <nav className="bg-white shadow-sm border-b border-gray-200 z-10 flex-shrink-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center min-w-0">
              <div className="flex-shrink-0 flex items-center text-blue-600 font-bold text-xl">
                <LineChart className="h-5 w-5 mr-2" /> AI-Fund Matrix
              </div>
              <div className="ml-10 flex space-x-8">
                {[["portfolio", "我的持仓"], ["library", "基金库"], ["config", "模型配置"]].map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab as ViewTab)}
                    className={`inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium ${activeTab === tab ? "border-blue-500 text-gray-900" : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center">
              <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1.5 rounded-full border border-blue-100 inline-flex items-center">
                <Sparkles className="h-3 w-3 mr-1 text-yellow-500" /> {realDataCount ? `${realDataCount}只真实估值参考` : "场内穿透实时引擎: 运行中"}
              </span>
              <div className="h-8 w-8 rounded-full ml-4 border border-gray-200 bg-blue-600 text-white flex items-center justify-center text-xs font-bold">AI</div>
            </div>
          </div>
        </div>
      </nav>

      <main className="flex-1 overflow-y-auto p-4 sm:p-6 max-w-7xl mx-auto w-full">
        {pageNotice ? <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">{pageNotice}</div> : null}
        {dataQuality?.holding_count ? (
          <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
            当前组合共 {dataQuality.holding_count} 只基金，{realDataCount} 只走真实估值参考，{proxyCount} 只仍为原型代理估算。
            {dataQuality.latest_estimate_as_of ? ` 最近估值时间 ${dataQuality.latest_estimate_as_of}。` : ""}
          </div>
        ) : null}

        {activeTab === "portfolio" ? (
          <div className="h-full flex flex-col">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="bg-white rounded-xl shadow-sm p-5 border border-gray-100">
                <p className="text-sm text-gray-500 mb-1">总资产 (元)</p>
                <p className="text-3xl font-bold">{formatPlainAmount(summary?.current_value ?? summary?.market_value)}</p>
              </div>
              <div className="bg-white rounded-xl shadow-sm p-5 border border-gray-100">
                <p className="text-sm text-gray-500 mb-1">今日收益参考 (元) <span className="text-xs bg-red-50 text-red-600 px-1 rounded border border-red-100">穿透估算</span></p>
                <p className={`text-3xl font-bold ${toneClass(summary?.today_estimated_pnl ?? summary?.today_profit)}`}>{formatSignedCurrency(summary?.today_estimated_pnl ?? summary?.today_profit).replace("¥", "")}</p>
                <p className={`text-sm mt-1 ${toneClass(summary?.today_estimated_pnl ?? summary?.today_profit)}`}>{formatSignedPercent(summary?.today_estimated_return ?? summary?.today_return)}</p>
              </div>
              <div className="bg-white rounded-xl shadow-sm p-5 border border-gray-100">
                <p className="text-sm text-gray-500 mb-1">累计总收益 (元)</p>
                <p className={`text-3xl font-bold ${toneClass(summary?.total_pnl ?? summary?.total_profit)}`}>{formatSignedCurrency(summary?.total_pnl ?? summary?.total_profit).replace("¥", "")}</p>
                <p className={`text-sm mt-1 ${toneClass(summary?.total_pnl ?? summary?.total_profit)}`}>{formatSignedPercent(summary?.total_return)}</p>
              </div>
            </div>

            <div className="flex flex-col md:flex-row gap-6 flex-1 min-h-[500px]">
              <div className="w-full md:w-3/4 bg-white rounded-xl shadow-sm border border-gray-100 flex flex-col">
                <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                  <h2 className="text-lg font-bold text-gray-800">持仓明细 (实时)</h2>
                  <div className="space-x-3">
                    <button type="button" onClick={openImportModal} className="bg-blue-50 text-blue-600 border border-blue-200 px-3 py-1.5 rounded-lg text-sm hover:bg-blue-100 transition-all font-medium inline-flex items-center">
                      <FolderPlus className="h-4 w-4 mr-1" /> 导入持仓
                    </button>
                    <button type="button" onClick={() => void refreshPortfolioData()} className="text-sm text-gray-500 hover:text-gray-800 px-2 py-1.5 inline-flex items-center" disabled={refreshing}>
                      {refreshing ? <LoaderCircle className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}刷新
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto flex-1">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">基金名称/代码</th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">持仓金额</th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">实时估值</th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">今日估算收益</th>
                        <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-100">
                      {positions.length ? positions.map((item) => (
                        <tr key={item.fund_id}>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="text-sm font-medium text-gray-900">{item.name}</div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              {item.fund_id}
                              <span className={`px-1 py-0.5 rounded text-[10px] ml-1 ${item.is_real_data ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"}`}>
                                {item.is_real_data ? "真实参考" : "原型估算"}
                              </span>
                              {item.estimate_as_of ? <span className="ml-1 text-[10px] text-gray-400">{item.estimate_as_of}</span> : null}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900 font-medium">{formatPlainAmount(item.current_value ?? item.market_value)}</td>
                          <td className={`px-6 py-4 whitespace-nowrap text-right text-sm font-bold ${toneClass(item.today_estimated_return ?? item.today_return)}`}>{formatSignedPercent(item.today_estimated_return ?? item.today_return)}</td>
                          <td className={`px-6 py-4 whitespace-nowrap text-right text-sm font-bold ${toneClass(item.today_estimated_pnl ?? item.today_profit)}`}>{formatSignedCurrency(item.today_estimated_pnl ?? item.today_profit).replace("¥", "")}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-center">
                            <button type="button" className="text-blue-600 hover:text-blue-800 bg-blue-50 px-3 py-1 rounded text-sm font-medium" onClick={() => void ask(buildAnalysisQuestion(item), item.fund_id)}>AI分析</button>
                          </td>
                        </tr>
                      )) : (
                        <tr>
                          <td className="px-6 py-10 text-center text-sm text-gray-400" colSpan={5}>还没有持仓数据，先点击“导入持仓”。</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="w-full md:w-1/4 bg-white rounded-xl shadow-sm border border-indigo-100 flex flex-col overflow-hidden relative">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 to-purple-500"></div>
                <div className="p-4 border-b border-gray-100 flex items-center bg-indigo-50/30">
                  <div className="bg-gradient-to-br from-blue-500 to-purple-600 text-white p-2 rounded-lg mr-3 shadow-sm"><BrainCircuit className="h-4 w-4" /></div>
                  <div>
                    <h2 className="text-md font-bold text-gray-800">金融分析 Agent</h2>
                    <p className="text-[11px] text-gray-500 flex items-center"><span className="w-1.5 h-1.5 rounded-full bg-green-500 mr-1 animate-pulse"></span>联网与深度投研</p>
                  </div>
                </div>

                <div className="flex-1 p-4 overflow-y-auto no-scrollbar flex flex-col space-y-4 bg-gray-50/50">
                  {chatMessages.map((message) => (
                    <div key={message.id} className={message.role === "user" ? "flex items-end justify-end" : "flex items-start"}>
                      <div className={message.role === "user" ? "bg-blue-600 text-white p-3 rounded-xl rounded-tr-sm shadow-sm text-sm max-w-[85%] whitespace-pre-line" : "bg-white border border-gray-200 text-gray-700 p-3 rounded-xl rounded-tl-sm shadow-sm text-sm max-w-[92%] leading-relaxed whitespace-pre-line"}>
                        {message.text}
                      </div>
                    </div>
                  ))}
                  {assistantLoading ? <div className="flex items-start"><div className="bg-white border border-gray-200 text-gray-500 p-3 rounded-xl rounded-tl-sm shadow-sm text-sm flex items-center"><LoaderCircle className="h-4 w-4 animate-spin text-blue-500 mr-2" />大模型思考中...</div></div> : null}
                </div>

                <div className="p-3 bg-white border-t border-gray-100">
                  <div className="relative flex items-center">
                    <input
                      type="text"
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void ask();
                        }
                      }}
                      className="w-full bg-gray-100 border border-transparent rounded-full py-2.5 pl-4 pr-12 text-sm focus:border-blue-500 focus:bg-white focus:ring-1 focus:ring-blue-500 outline-none"
                      placeholder="提问..."
                    />
                    <button type="button" onClick={() => void ask()} className="absolute right-1.5 bg-blue-600 text-white p-2 rounded-full hover:bg-blue-700">
                      <SendHorizontal className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === "library" ? (
          <div className="h-full flex flex-col">
            <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 mb-6 flex items-center justify-between gap-4">
              <h2 className="text-lg font-bold text-gray-800">全市场基金库概览</h2>
              <div className="flex gap-4 w-1/2">
                <input
                  type="text"
                  value={catalogQuery}
                  onChange={(event) => setCatalogQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void loadCatalog({ query: catalogQuery, page: 1, pageSize: catalogPageSize });
                    }
                  }}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm"
                  placeholder="输入基金代码/拼音搜索..."
                />
                <button type="button" onClick={() => void loadCatalog({ query: catalogQuery, page: 1, pageSize: catalogPageSize })} className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium">搜索</button>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-100 flex-1 overflow-hidden">
              {catalogItems.length ? (
                <div className="h-full flex flex-col">
                  <div className="px-5 py-3 border-b border-gray-100 text-sm text-gray-500">共找到 {catalogTotal} 只基金</div>
                  <div className="overflow-auto flex-1">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">基金</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">主题</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">风险</th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">净值</th>
                          <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-100">
                        {catalogItems.map((item) => (
                          <tr key={item.fund_id}>
                            <td className="px-6 py-4">
                              <div className="text-sm font-medium text-gray-900">{item.name}</div>
                              <div className="text-xs text-gray-500 mt-0.5">{item.fund_id}</div>
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-600">{item.theme || "--"}</td>
                            <td className="px-6 py-4 text-sm text-gray-600">{item.risk_level || "--"}</td>
                            <td className="px-6 py-4 text-right text-sm text-gray-700">{item.latest_nav ? Number(item.latest_nav).toFixed(4) : "--"}</td>
                            <td className="px-6 py-4 text-center">
                              <button type="button" onClick={() => openImportFromLibrary(item)} className="text-blue-600 hover:text-blue-800 bg-blue-50 px-3 py-1 rounded text-sm font-medium">加入持仓</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between text-sm text-gray-500">
                    <span>第 {catalogPage} 页</span>
                    <div className="space-x-2">
                      <button type="button" onClick={() => void loadCatalog({ query: catalogQuery, page: Math.max(1, catalogPage - 1), pageSize: catalogPageSize })} className="px-3 py-1.5 rounded border border-gray-300 disabled:opacity-50" disabled={catalogPage <= 1 || catalogLoading}>上一页</button>
                      <button type="button" onClick={() => void loadCatalog({ query: catalogQuery, page: catalogPage + 1, pageSize: catalogPageSize })} className="px-3 py-1.5 rounded border border-gray-300 disabled:opacity-50" disabled={catalogLoading || catalogItems.length < catalogPageSize}>下一页</button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-gray-400 text-sm">{catalogLoading ? "基金库加载中..." : "基金库数据模块"}</div>
              )}
            </div>
          </div>
        ) : null}

        {activeTab === "config" ? (
          <div className="h-full flex items-center justify-center">
            <div className="bg-white p-8 rounded-xl shadow-md border border-gray-100 w-full max-w-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-blue-500"></div>
              <div className="flex items-center mb-6 border-b border-gray-100 pb-4">
                <div className="bg-blue-50 text-blue-600 p-3 rounded-lg mr-4 border border-blue-100"><BrainCircuit className="h-5 w-5" /></div>
                <div>
                  <h2 className="text-xl font-bold text-gray-800">AI Agent 大模型配置</h2>
                  <p className="text-sm text-gray-500 mt-1">配置您自己的 LLM API，全面兼容 OpenAI 接口规范。</p>
                </div>
              </div>
              {configNotice ? <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">{configNotice}</div> : null}
              {aiConfigs.length ? (
                <div className="mb-4">
                  <label className="block text-sm font-semibold text-gray-700 mb-1">已保存配置</label>
                  <select value={activeConfig?.id || ""} onChange={(event) => {
                    const selected = aiConfigs.find((item) => item.id === event.target.value);
                    if (!selected) return;
                    setAiConfigs((current) => current.map((item) => ({ ...item, active: item.id === selected.id })));
                    setConfigNotice(`已切换到 ${selected.name}。`);
                  }} className="w-full px-4 py-2 border border-gray-300 rounded-lg sm:text-sm bg-gray-50">
                    {aiConfigs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </div>
              ) : null}
              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">配置名称</label>
                  <input type="text" value={configForm.name} onChange={(event) => setConfigForm((current) => ({ ...current, name: event.target.value }))} className="w-full px-4 py-2 border border-gray-300 rounded-lg sm:text-sm bg-gray-50" placeholder="例如：OpenAI 主配置" />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">接口 Base URL</label>
                  <input type="text" value={configForm.endpoint} onChange={(event) => setConfigForm((current) => ({ ...current, endpoint: event.target.value }))} className="w-full px-4 py-2 border border-gray-300 rounded-lg sm:text-sm bg-gray-50 font-mono" />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">API Key</label>
                  <input type="password" value={configForm.apiKey} onChange={(event) => setConfigForm((current) => ({ ...current, apiKey: event.target.value }))} className="w-full px-4 py-2 border border-gray-300 rounded-lg sm:text-sm bg-gray-50 font-mono" placeholder="sk-..." />
                </div>
                <div className="pt-4 flex justify-between border-t border-gray-100">
                  <button type="button" onClick={() => setConfigNotice(activeConfig ? `当前启用：${activeConfig.name}` : "暂无可用配置") } className="text-sm font-medium text-gray-600 border border-gray-300 px-5 py-2 rounded-lg">测试</button>
                  <button type="button" onClick={saveConfig} className="bg-blue-600 text-white px-8 py-2 rounded-lg text-sm font-bold">保存配置</button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </main>

      {importOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/60 backdrop-blur-sm transition-opacity">
          <div className="modal-enter bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
              <h3 className="text-lg font-bold text-gray-800 flex items-center"><FolderPlus className="h-4 w-4 text-blue-500 mr-2" />导入我的持仓</h3>
              <button type="button" onClick={() => setImportOpen(false)} className="text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>
            </div>

            <div className="flex border-b border-gray-200 bg-gray-50">
              <button type="button" onClick={() => setImportTab("manual")} className={`flex-1 py-3 text-sm font-bold ${importTab === "manual" ? "text-blue-600 border-b-2 border-blue-600 bg-white" : "text-gray-500 border-b-2 border-transparent hover:bg-gray-100"}`}>手动搜索添加</button>
              <button type="button" onClick={() => setImportTab("ocr")} className={`flex-1 py-3 text-sm font-bold ${importTab === "ocr" ? "text-blue-600 border-b-2 border-blue-600 bg-white" : "text-gray-500 border-b-2 border-transparent hover:bg-gray-100"}`}>截图智能识别 <span className="bg-gradient-to-r from-red-500 to-pink-500 text-white text-[10px] px-1 rounded ml-1">AI</span></button>
            </div>

            <div className="p-6">
              {modalNotice ? <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">{modalNotice}</div> : null}

              {importTab === "manual" ? (
                <div className="space-y-4">
                  <div className="relative">
                    <label className="block text-sm font-semibold text-gray-700 mb-1">基金名称或代码</label>
                    <div className="relative">
                      <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                      <input
                        type="text"
                        value={manualEntry.query}
                        onChange={(event) => {
                          const value = event.target.value;
                          setManualEntry((current) => ({ ...current, query: value, fundName: normalizeFundCode(value) === normalizeFundCode(current.query) ? current.fundName : "" }));
                          void searchManualSuggestions(value);
                        }}
                        className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg sm:text-sm bg-gray-50 focus:bg-white focus:ring-1 focus:ring-blue-500 outline-none"
                        placeholder="输入如：易方达蓝筹精选 或 005827"
                      />
                    </div>
                    {manualSuggestions.length ? (
                      <div className="absolute z-20 w-full mt-1 bg-white shadow-lg border border-gray-200 rounded-lg max-h-40 overflow-y-auto">
                        {manualSuggestions.map((item) => (
                          <button key={item.fund_id} type="button" className="w-full px-4 py-3 hover:bg-blue-50 text-sm flex justify-between text-left" onClick={() => pickSuggestion(item)}>
                            <span className="font-medium">{item.name}</span><span className="text-xs text-gray-500">{item.fund_id}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex gap-4">
                    <div className="flex-1">
                      <label className="block text-sm font-semibold text-gray-700 mb-1">持有金额 (元)</label>
                      <input type="number" value={manualEntry.amount} onChange={(event) => setManualEntry((current) => ({ ...current, amount: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg sm:text-sm bg-gray-50 focus:bg-white outline-none" placeholder="10000.00" />
                    </div>
                    <div className="flex-1">
                      <label className="block text-sm font-semibold text-gray-700 mb-1">累计收益 (元)</label>
                      <input type="number" value={manualEntry.profit} onChange={(event) => setManualEntry((current) => ({ ...current, profit: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg sm:text-sm bg-gray-50 focus:bg-white outline-none" placeholder="+0.00 / -0.00" />
                    </div>
                  </div>
                  <button type="button" onClick={() => void submitManualImport()} className="w-full mt-2 bg-blue-600 text-white py-2.5 rounded-lg hover:bg-blue-700 text-sm font-bold flex justify-center items-center">确认添加</button>
                </div>
              ) : (
                <div className="space-y-4">
                  <label className="border-2 border-dashed border-blue-300 bg-blue-50/50 rounded-xl p-8 text-center hover:bg-blue-50 cursor-pointer block">
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void handleUploadFile(file);
                        event.currentTarget.value = "";
                      }}
                    />
                    <div className="w-14 h-14 bg-white rounded-full shadow-sm flex items-center justify-center mx-auto mb-3 border border-blue-100">
                      {ocrLoading ? <LoaderCircle className="h-7 w-7 text-blue-500 animate-spin" /> : <UploadCloud className="h-7 w-7 text-blue-500" />}
                    </div>
                    <p className="text-sm font-bold text-gray-700">点击上传或拖拽截图到此处</p>
                    <p className="text-xs text-gray-500 mt-1">支持 支付宝、天天基金、同花顺 等APP持仓截图</p>
                    <div className="mt-4 inline-flex items-center text-xs text-blue-600"><Camera className="h-3 w-3 mr-1" />OCR 智能识别</div>
                  </label>

                  {pickerStatus ? <div className="text-sm text-gray-600">{pickerStatus}</div> : null}
                  {ocrWarnings.length ? <div className="space-y-2">{ocrWarnings.map((warning) => <div key={warning} className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">{warning}</div>)}</div> : null}

                  {ocrRows.length ? (
                    <div>
                      <h4 className="text-sm font-bold text-gray-800 mb-2">AI 识别结果</h4>
                      <div className="border border-gray-200 rounded-lg overflow-hidden">
                        <table className="min-w-full divide-y divide-gray-200 text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-2 text-left font-semibold text-gray-600">识别基金</th>
                              <th className="px-4 py-2 text-right font-semibold text-gray-600">持仓金额</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-100">
                            {ocrRows.map((row) => (
                              <tr key={`${row.fundQuery}-${row.amount}`}>
                                <td className="px-4 py-2 font-medium">{row.fundName || row.fundQuery}<span className="text-xs text-gray-400 block">{row.fundQuery}</span></td>
                                <td className="px-4 py-2 text-right text-gray-800 font-medium">{formatPlainAmount(row.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <button type="button" onClick={() => void submitOcrImport()} className="w-full mt-4 bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 text-sm font-bold">批量导入至我的持仓</button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {booting ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/20 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-5 py-4 text-sm text-gray-700 flex items-center">
            <LoaderCircle className="h-4 w-4 animate-spin text-blue-500 mr-2" /> 正在初始化持仓与盘中估算...
          </div>
        </div>
      ) : null}
    </div>
  );
}
