import { useEffect, useMemo, useRef, useState } from "react";
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
  addToWatchlist,
  buildImportTextFromRows,
  removeFromWatchlist,
  requestIntradayEstimate,
  requestAssistant,
  requestFundSearch,
  requestFundNavTrend,
  requestFundTopHoldings,
  requestFundsCatalog,
  requestHoldingsImport,
  requestHoldingsOcr,
  requestPortfolio,
  requestPortfolioIntraday,
  requestWatchlist,
  requestWatchlistIntraday,
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
  restoreEstimateMode,
  restoreManualRows,
  saveAiConfigs,
  saveAssistantQuestion,
  saveEstimateMode,
  saveManualRows,
} from "./lib/storage";
import type {
  AiConfig,
  AnnouncementItem,
  AssistantResponse,
  FundCatalogItem,
  ImportTab,
  ManualRow,
  IntradayEstimate,
  NavTrendPoint,
  NavTrendResponse,
  PortfolioIntraday,
  PortfolioPosition,
  PortfolioSnapshot,
  TopHoldingsResponse,
  ViewTab,
  WatchlistIntradayItem,
  WatchlistItem,
} from "./types";

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  announcements?: AnnouncementItem[];
  perFundAnnouncements?: Array<{ fund_id: string; name: string; items: AnnouncementItem[] }>;
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

type EstimateMode = "auto" | "official" | "penetration";
type NavRange = "1m" | "3m" | "6m" | "1y" | "all";
type DetailFundInfo = {
  fund_id: string;
  name?: string;
  name_display?: string;
  theme?: string;
  holdings_disclosure_date?: string;
};

function createManualEntry(): ManualEntry {
  return { query: "", fundName: "", amount: "", profit: "" };
}

const ESTIMATE_MODE_LABELS: Record<EstimateMode, string> = {
  auto: "自动",
  official: "官方",
  penetration: "穿透",
};

const NAV_RANGE_OPTIONS: Array<{ value: NavRange; label: string }> = [
  { value: "1m", label: "1个月" },
  { value: "3m", label: "3个月" },
  { value: "6m", label: "6个月" },
  { value: "1y", label: "1年" },
  { value: "all", label: "全部" },
];

const PORTFOLIO_QUESTION_KEYWORDS = [
  "组合",
  "持仓",
  "这几只",
  "几只基金",
  "几只",
  "全部",
  "全仓",
  "所有基金",
  "全部基金",
  "我持仓",
  "我的基金",
  "仓位",
];

const ANNOUNCEMENT_EVIDENCE_LABEL = "最新公告（东财 fundf10）";

function isPortfolioQuestion(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  const lowered = clean.toLowerCase();
  return PORTFOLIO_QUESTION_KEYWORDS.some((keyword) => lowered.includes(keyword.toLowerCase()));
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

function formatWeightPercent(value: unknown): string {
  return `${parseNumber(value).toFixed(2)}%`;
}

function resolveFundName(name?: string | null, nameDisplay?: string | null): string {
  return (nameDisplay ?? name ?? "").trim();
}

const NAV_CHART_WIDTH = 600;
const NAV_CHART_HEIGHT = 180;
const NAV_CHART_PADDING_X = 56;
const NAV_CHART_PADDING_Y = 24;
const NAV_RETURN_MIN_PADDING = 0.01;
const NAV_RETURN_TICK_COUNT = 5;

type ReturnSummary = {
  min: number;
  max: number;
  paddedMin: number;
  paddedMax: number;
  span: number;
  ticks: number[];
};

function computeReturnSeries(points: NavTrendPoint[]): { baseNav: number; returns: number[] } {
  if (!points.length) return { baseNav: 0, returns: [] };
  const baseNav = points[0]?.nav ?? 0;
  if (!baseNav) {
    return { baseNav, returns: points.map(() => 0) };
  }
  return {
    baseNav,
    returns: points.map((point) => point.nav / baseNav - 1),
  };
}

function buildReturnSummary(returns: number[], tickCount = NAV_RETURN_TICK_COUNT): ReturnSummary {
  if (!returns.length) {
    const paddedMin = -NAV_RETURN_MIN_PADDING;
    const paddedMax = NAV_RETURN_MIN_PADDING;
    return {
      min: 0,
      max: 0,
      paddedMin,
      paddedMax,
      span: paddedMax - paddedMin,
      ticks: Array.from({ length: tickCount }, (_, index) => paddedMin + (paddedMax - paddedMin) * (index / (tickCount - 1))),
    };
  }
  const min = Math.min(...returns);
  const max = Math.max(...returns);
  const span = max - min;
  const basePad = span > 0 ? span * 0.1 : Math.abs(max || min) * 0.1;
  const pad = Math.max(basePad, NAV_RETURN_MIN_PADDING);
  let paddedMin = min - pad;
  let paddedMax = max + pad;
  if (paddedMin === paddedMax) {
    paddedMin -= NAV_RETURN_MIN_PADDING;
    paddedMax += NAV_RETURN_MIN_PADDING;
  }
  const paddedSpan = paddedMax - paddedMin || 1;
  const ticks = Array.from({ length: tickCount }, (_, index) => paddedMin + paddedSpan * (index / (tickCount - 1)));
  return {
    min,
    max,
    paddedMin,
    paddedMax,
    span: paddedSpan,
    ticks,
  };
}

function getReturnY(
  value: number,
  summary: ReturnSummary,
  height = NAV_CHART_HEIGHT,
  paddingY = NAV_CHART_PADDING_Y,
): number {
  const usableHeight = height - paddingY * 2;
  const ratio = summary.span ? (value - summary.paddedMin) / summary.span : 0.5;
  return paddingY + (1 - ratio) * usableHeight;
}

function buildReturnPolyline(
  points: NavTrendPoint[],
  returns: number[],
  summary: ReturnSummary,
  width = NAV_CHART_WIDTH,
  height = NAV_CHART_HEIGHT,
  paddingX = NAV_CHART_PADDING_X,
  paddingY = NAV_CHART_PADDING_Y,
): string {
  if (!points.length) return "";
  const usableWidth = width - paddingX * 2;
  return points
    .map((point, index) => {
      const ratio = points.length > 1 ? index / (points.length - 1) : 0.5;
      const x = paddingX + ratio * usableWidth;
      const value = returns[index] ?? 0;
      const y = getReturnY(value, summary, height, paddingY);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function getNavIndexFromX(
  x: number,
  total: number,
  width = NAV_CHART_WIDTH,
  paddingX = NAV_CHART_PADDING_X,
): number | null {
  if (total <= 0) return null;
  if (total === 1) return 0;
  const usableWidth = width - paddingX * 2;
  if (usableWidth <= 0) return 0;
  const clamped = Math.min(Math.max(x, paddingX), paddingX + usableWidth);
  const ratio = (clamped - paddingX) / usableWidth;
  return Math.min(total - 1, Math.max(0, Math.round(ratio * (total - 1))));
}

function getReturnPointPosition(
  points: NavTrendPoint[],
  returns: number[],
  index: number,
  summary: ReturnSummary,
  width = NAV_CHART_WIDTH,
  height = NAV_CHART_HEIGHT,
  paddingX = NAV_CHART_PADDING_X,
  paddingY = NAV_CHART_PADDING_Y,
): { x: number; y: number } | null {
  const point = points[index];
  if (!point) return null;
  const usableWidth = width - paddingX * 2;
  const ratio = points.length > 1 ? index / (points.length - 1) : 0.5;
  const x = paddingX + ratio * usableWidth;
  const value = returns[index] ?? 0;
  const y = getReturnY(value, summary, height, paddingY);
  return { x, y };
}

function buildNavDateTicks(
  points: NavTrendPoint[],
  width = NAV_CHART_WIDTH,
  paddingX = NAV_CHART_PADDING_X,
): Array<{ index: number; x: number; label: string }> {
  if (!points.length) return [];
  const lastIndex = points.length - 1;
  const midIndex = Math.floor(lastIndex / 2);
  const indices = Array.from(new Set([0, midIndex, lastIndex]));
  const usableWidth = width - paddingX * 2;
  return indices
    .map((index) => {
      const ratio = points.length > 1 ? index / lastIndex : 0.5;
      const x = paddingX + ratio * usableWidth;
      const label = points[index]?.date || "--";
      return { index, x, label };
    })
    .filter((tick) => tick.label);
}

function computeIntervalReturn(points: NavTrendPoint[]): number | null {
  if (!points.length) return null;
  const first = points[0]?.nav ?? 0;
  const last = points[points.length - 1]?.nav ?? 0;
  if (!first || !last) return null;
  return last / first - 1;
}

function nowLabel(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function extractTimeHHMM(value?: string | null): string | null {
  if (!value) return null;
  const match = String(value).match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = match[1].padStart(2, "0");
  return `${hour}:${match[2]}`;
}

function isChinaTradingHours(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const getPart = (type: string) => parts.find((part) => part.type === type)?.value;
  const weekday = getPart("weekday");
  if (!weekday) return false;
  const weekdayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday);
  if (weekdayIndex < 0 || weekdayIndex >= 5) return false;
  const hour = Number(getPart("hour") ?? "0");
  const minute = Number(getPart("minute") ?? "0");
  const minutes = hour * 60 + minute;
  const morningStart = 9 * 60 + 30;
  const morningEnd = 11 * 60 + 30;
  const afternoonStart = 13 * 60;
  const afternoonEnd = 15 * 60;
  return (minutes >= morningStart && minutes <= morningEnd) || (minutes >= afternoonStart && minutes <= afternoonEnd);
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
  if (payload.per_fund?.length) {
    const summaryLine = (payload.summary || "组合层面：请结合持仓分批处理。")
      .split("\n")
      .find((line) => line.trim().length) || "组合层面：请结合持仓分批处理。";
    const lines = [summaryLine, "", "逐只参考："];
    payload.per_fund.forEach((item) => {
      const name = resolveFundName(item.name, item.name_display) || item.fund_id;
      const forecast = item.forecast;
      let directionLabel = "方向未知";
      let probabilityText = "";
      if (forecast?.direction) {
        directionLabel = forecast.direction === "up" ? "上涨" : "下跌";
        if (typeof forecast.probability_up === "number") {
          const directionProbability = forecast.direction === "up" ? forecast.probability_up : 1 - forecast.probability_up;
          probabilityText = `（概率${Math.round(directionProbability * 100)}%）`;
        }
      }
      const suggestion = item.suggestion ? `，${item.suggestion}` : "";
      lines.push(`- ${name}：${directionLabel}${probabilityText}${suggestion}`);
    });
    if (payload.risks?.length) {
      lines.push("", `风险提示：${payload.risks[0]}`);
    }
    return lines.join("\n");
  }

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

function AnnouncementCard({ title, items }: { title: string; items: AnnouncementItem[] }) {
  const countLabel = items.length ? `${items.length} 条` : "暂无";
  return (
    <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <summary className="cursor-pointer text-xs font-semibold text-slate-600">{title} · {countLabel}</summary>
      <div className="mt-3 space-y-2">
        {items.length ? (
          items.map((item, index) => {
            const titleText = item.title?.trim() || "未命名公告";
            const dateText = item.date?.trim() || "未知日期";
            const typeText = item.type?.trim();
            const url = item.url?.trim();
            const pdfUrl = item.pdf_url?.trim();
            return (
              <div key={`${title}-${titleText}-${dateText}-${index}`} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-sm font-medium text-slate-800">{titleText}</div>
                <div className="mt-1 text-xs text-slate-500">{dateText}{typeText ? ` · ${typeText}` : ""}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {url ? (
                    <a className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-100" href={url} target="_blank" rel="noreferrer">原文</a>
                  ) : (
                    <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs text-slate-400">原文</span>
                  )}
                  {pdfUrl ? (
                    <a className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-100" href={pdfUrl} target="_blank" rel="noreferrer">PDF</a>
                  ) : (
                    <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs text-slate-400">PDF</span>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <div className="text-xs text-slate-500">暂无公告。</div>
        )}
      </div>
    </details>
  );
}

function buildAssistantMessage(payload: AssistantResponse): ChatMessage {
  const hasAnnouncementEvidence = (payload.evidence || []).some((item) => item.label?.includes(ANNOUNCEMENT_EVIDENCE_LABEL));
  const announcements = hasAnnouncementEvidence ? payload.announcements ?? [] : undefined;
  const perFundAnnouncements = (payload.per_fund || [])
    .map((item) => {
      const items = item.announcements ?? [];
      if (!items.length) return null;
      const name = resolveFundName(item.name, item.name_display) || item.name || item.fund_id;
      return { fund_id: item.fund_id, name, items };
    })
    .filter(Boolean) as Array<{ fund_id: string; name: string; items: AnnouncementItem[] }>;

  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: assistantText(payload),
    announcements,
    perFundAnnouncements: perFundAnnouncements.length ? perFundAnnouncements : undefined,
  };
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
  const nameMap = new Map((snapshot.positions || []).map((item) => [item.fund_id, resolveFundName(item.name, item.name_display)]));
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
  const name = resolveFundName(position.name, position.name_display) || position.name || "";
  return `分析一下${name}今天的走势？`;
}

function buildRelatedFundLabel(item: FundCatalogItem): string {
  const name = resolveFundName(item.name, item.name_display);
  const suffix = name.slice(-1);
  if (suffix === "A" || suffix === "C") {
    return `联接${suffix} ${item.fund_id}`;
  }
  const shortName = name.length > 10 ? `${name.slice(0, 10)}...` : name;
  return shortName ? `${item.fund_id} ${shortName}` : item.fund_id;
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
  const [relatedFunds, setRelatedFunds] = useState<FundCatalogItem[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
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
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [watchlistIntraday, setWatchlistIntraday] = useState<WatchlistIntradayItem[]>([]);
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [watchlistLoaded, setWatchlistLoaded] = useState(false);
  const [watchlistNotice, setWatchlistNotice] = useState("");
  const [question, setQuestion] = useState(restoreAssistantQuestion());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [activeFundId, setActiveFundId] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailFundId, setDetailFundId] = useState("");
  const [detailRange, setDetailRange] = useState<NavRange>("6m");
  const [detailNavTrend, setDetailNavTrend] = useState<NavTrendResponse | null>(null);
  const [navHoverIndex, setNavHoverIndex] = useState<number | null>(null);
  const [detailHoldings, setDetailHoldings] = useState<TopHoldingsResponse | null>(null);
  const [detailEstimate, setDetailEstimate] = useState<IntradayEstimate | null>(null);
  const [detailIntervalReturns, setDetailIntervalReturns] = useState<Record<NavRange, number | null> | null>(null);
  const [detailIntervalLoading, setDetailIntervalLoading] = useState(false);
  const [detailNavLoading, setDetailNavLoading] = useState(false);
  const [detailHoldingsLoading, setDetailHoldingsLoading] = useState(false);
  const [detailNotice, setDetailNotice] = useState("");
  const [themeOpen, setThemeOpen] = useState(false);
  const [themeName, setThemeName] = useState("");
  const [themeFunds, setThemeFunds] = useState<FundCatalogItem[]>([]);
  const [themeLoading, setThemeLoading] = useState(false);
  const [themeNotice, setThemeNotice] = useState("");
  const [aiConfigs, setAiConfigs] = useState<AiConfig[]>(initialConfigs);
  const [estimateMode, setEstimateMode] = useState<EstimateMode>(restoreEstimateMode());
  const [configForm, setConfigForm] = useState<ConfigFormState>(() =>
    formFromConfig(initialConfigs.find((item) => item.active) || initialConfigs[0] || null),
  );
  const [configNotice, setConfigNotice] = useState("");
  const [booting, setBooting] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pageNotice, setPageNotice] = useState("");
  const relatedRequestIdRef = useRef(0);
  const navTrendRequestIdRef = useRef(0);
  const holdingsRequestIdRef = useRef(0);
  const intervalReturnsRequestIdRef = useRef(0);
  const themeRequestIdRef = useRef(0);

  const positions = snapshot?.positions ?? [];
  const summary = snapshot?.summary;
  const dataQuality = summary?.data_quality ?? snapshot?.data_quality;
  const watchlistIdSet = useMemo(() => new Set(watchlistItems.map((item) => item.fund_id)), [watchlistItems]);
  const watchlistIntradayMap = useMemo(() => {
    const map = new Map<string, WatchlistIntradayItem>();
    watchlistIntraday.forEach((item) => {
      if (item.fund_id) {
        map.set(item.fund_id, item);
      }
    });
    return map;
  }, [watchlistIntraday]);
  const latestEstimateTime = extractTimeHHMM(dataQuality?.latest_estimate_as_of);
  const estimateModeLabel = ESTIMATE_MODE_LABELS[estimateMode];
  const displayEstimateSourceLabel = (dataQuality?.display_estimate_source_label || "").trim();
  const autoFallbackNotice = estimateMode === "auto" && displayEstimateSourceLabel.includes("自动(穿透)") ? "自动回退到穿透" : "";
  const updateStatusText = isChinaTradingHours()
    ? `更新时间：${latestEstimateTime ?? "当前"}`
    : `已收盘/非交易时段，最后更新 ${latestEstimateTime ?? "15:00"}`;
  const updateStatusWithMode = `${updateStatusText}｜估值源：${estimateModeLabel}`;
  const activeConfig = useMemo(() => aiConfigs.find((item) => item.active) || aiConfigs[0] || null, [aiConfigs]);
  const topContribution = intraday?.contributions?.[0];
  const detailFund = useMemo<DetailFundInfo | null>(() => {
    const fromPositions = positions.find((item) => item.fund_id === detailFundId);
    if (fromPositions) return fromPositions;
    const fromWatchlist = watchlistItems.find((item) => item.fund_id === detailFundId);
    return fromWatchlist ?? null;
  }, [positions, watchlistItems, detailFundId]);
  const detailInWatchlist = detailFundId ? watchlistIdSet.has(detailFundId) : false;
  const detailHoldingsSorted = useMemo(() => {
    const items = detailHoldings?.items ?? [];
    return [...items].sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution));
  }, [detailHoldings]);
  const relatedIndustries = useMemo(() => {
    const items = detailHoldings?.items ?? [];
    const weights = new Map<string, number>();
    items.forEach((item) => {
      const industry = String(item.industry ?? "").trim();
      if (!industry) return;
      const weight = parseNumber(item.weight_percent);
      weights.set(industry, (weights.get(industry) ?? 0) + weight);
    });
    return [...weights.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([industry]) => industry);
  }, [detailHoldings]);
  const relatedSectorChips = useMemo(() => {
    const chips: string[] = [];
    const theme = (detailFund?.theme || "").trim();
    if (theme) chips.push(theme);
    relatedIndustries.forEach((industry) => {
      if (!chips.includes(industry)) chips.push(industry);
    });
    return chips;
  }, [detailFund?.theme, relatedIndustries]);
  const navPoints = detailNavTrend?.points ?? [];
  const navLatest = useMemo(() => (navPoints.length ? navPoints[navPoints.length - 1]?.nav ?? 0 : 0), [navPoints]);
  const navReturnSeries = useMemo(() => computeReturnSeries(navPoints), [navPoints]);
  const navReturns = navReturnSeries.returns;
  const navReturnSummary = useMemo(() => buildReturnSummary(navReturns), [navReturns]);
  const navPolyline = useMemo(
    () => buildReturnPolyline(navPoints, navReturns, navReturnSummary),
    [navPoints, navReturns, navReturnSummary],
  );
  const navDateTicks = useMemo(() => buildNavDateTicks(navPoints), [navPoints]);
  const navHoverPoint = useMemo(() => {
    if (navHoverIndex === null || !navPoints.length) return null;
    const index = Math.min(Math.max(navHoverIndex, 0), navPoints.length - 1);
    const point = navPoints[index];
    if (!point) return null;
    const position = getReturnPointPosition(navPoints, navReturns, index, navReturnSummary);
    if (!position) return null;
    return { index, point, returnValue: navReturns[index] ?? 0, ...position };
  }, [navHoverIndex, navPoints, navReturns, navReturnSummary]);
  const navHoverLabel = navHoverPoint
    ? `${navHoverPoint.point.date || "--"}｜收益率 ${formatSignedPercent(navHoverPoint.returnValue)}｜净值 ${navHoverPoint.point.nav.toFixed(4)}`
    : "移动鼠标或触摸查看单点收益率";
  const intervalReturns = detailIntervalReturns ?? {
    "1m": null,
    "3m": null,
    "6m": null,
    "1y": null,
    "all": null,
  };
  const disclosureWarning = useMemo(() => {
    const disclosureDate =
      (detailEstimate?.holdings_disclosure_date || detailHoldings?.disclosure_date || detailFund?.holdings_disclosure_date || "").trim();
    let disclosureDays: number | null = null;
    if (disclosureDate) {
      const parsed = new Date(`${disclosureDate}T00:00:00`);
      if (!Number.isNaN(parsed.getTime())) {
        const diffMs = Date.now() - parsed.getTime();
        disclosureDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      }
    }

    const disclosedWeight =
      typeof detailEstimate?.disclosed_weight_ratio === "number" ? detailEstimate.disclosed_weight_ratio : null;
    const stockPosition =
      typeof detailEstimate?.stock_position_ratio === "number" ? detailEstimate.stock_position_ratio : null;
    const coverageRatio =
      disclosedWeight !== null
        ? stockPosition && stockPosition > 0
          ? disclosedWeight / stockPosition
          : disclosedWeight
        : null;

    const warnFreshness = disclosureDays !== null && disclosureDays > 90;
    const warnCoverage = coverageRatio !== null && coverageRatio < 0.5;
    if (!warnFreshness && !warnCoverage) return null;

    const fragments: string[] = [];
    if (warnFreshness) {
      fragments.push(`披露日期已超过 90 天${disclosureDate ? `（${disclosureDate}）` : ""}`);
    }
    if (warnCoverage) {
      fragments.push(`前十大持仓覆盖率约 ${(coverageRatio * 100).toFixed(1)}%`);
    }
    return fragments.join("，") || "披露与穿透信息存在滞后或覆盖不足";
  }, [detailEstimate, detailFund?.holdings_disclosure_date, detailHoldings?.disclosure_date]);

  useEffect(() => {
    if (!navPoints.length) {
      setNavHoverIndex(null);
      return;
    }
    setNavHoverIndex((current) => (current === null ? null : Math.min(current, navPoints.length - 1)));
  }, [navPoints]);

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
    saveEstimateMode(estimateMode);
  }, [estimateMode]);

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
    if (activeTab !== "watchlist") return;
    void loadWatchlist();
  }, [activeTab, estimateMode]);

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

  const handleNavPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!navPoints.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const x = ((event.clientX - rect.left) / rect.width) * NAV_CHART_WIDTH;
    const index = getNavIndexFromX(x, navPoints.length);
    if (index === null) return;
    setNavHoverIndex(index);
  };

  const handleNavPointerLeave = () => {
    setNavHoverIndex(null);
  };

  async function syncRows(rows: ManualRow[], successMessage: string, showNotice = true) {
    const validRows = rows.filter(isValidManualRow);
    if (!validRows.length) throw new Error("请至少录入一只基金，且金额必须大于 0。");

    setModalNotice("正在反推份额与成本净值...");
    const text = await buildImportTextFromRows(validRows);
    const portfolioPayload = await requestHoldingsImport(text);
    const [latestSnapshot, intradayPayload] = await Promise.all([
      requestPortfolio(estimateMode).catch(() => portfolioPayload),
      requestPortfolioIntraday(estimateMode).catch(() => null),
    ]);
    const hydrated = hydrateRows(validRows, latestSnapshot);

    setManualRows(hydrated);
    setSnapshot(latestSnapshot);
    setIntraday(intradayPayload);
    setImportOpen(false);
    setManualEntry(createManualEntry());
    setManualSuggestions([]);
    setRelatedFunds([]);
    setRelatedLoading(false);
    setOcrRows([]);
    setOcrWarnings([]);
    setPickerStatus("");
    setModalNotice("");
    if (showNotice) setPageNotice(successMessage);
  }

  async function refreshPortfolioData(nextMode?: EstimateMode) {
    setRefreshing(true);
    setPageNotice("正在刷新盘中估算...");
    const activeMode = nextMode ?? estimateMode;
    try {
      const [portfolioPayload, intradayPayload] = await Promise.all([
        requestPortfolio(activeMode),
        requestPortfolioIntraday(activeMode).catch(() => null),
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

  function notifyWatchlist(message: string) {
    if (importOpen) {
      setModalNotice(message);
      return;
    }
    if (detailOpen) {
      setDetailNotice(message);
      return;
    }
    if (activeTab === "watchlist") {
      setWatchlistNotice(message);
      return;
    }
    setPageNotice(message);
  }

  async function loadWatchlist(showNotice = false) {
    setWatchlistLoading(true);
    setWatchlistNotice(showNotice ? "正在刷新自选..." : "");
    try {
      const [listPayload, intradayPayload] = await Promise.all([
        requestWatchlist(),
        requestWatchlistIntraday(estimateMode).catch(() => null),
      ]);
      setWatchlistItems(listPayload.items ?? []);
      setWatchlistIntraday(intradayPayload?.items ?? []);
      setWatchlistLoaded(true);
      if (showNotice) setWatchlistNotice("自选已更新。");
    } catch (error) {
      setWatchlistItems([]);
      setWatchlistIntraday([]);
      setWatchlistNotice(error instanceof Error ? error.message : "自选加载失败。");
    } finally {
      setWatchlistLoading(false);
    }
  }

  async function handleAddToWatchlist(item: { fund_id: string; name?: string; name_display?: string }) {
    const fundId = item.fund_id;
    if (!fundId) {
      notifyWatchlist("基金代码无效，无法加入自选。");
      return;
    }
    try {
      await addToWatchlist(fundId);
      const displayName = resolveFundName(item.name, item.name_display) || fundId;
      notifyWatchlist(`已加入自选：${displayName}。`);
      await loadWatchlist();
    } catch (error) {
      notifyWatchlist(error instanceof Error ? error.message : "加入自选失败，请稍后重试。");
    }
  }

  async function handleRemoveFromWatchlist(fundId: string, displayName?: string) {
    if (!fundId) return;
    try {
      await removeFromWatchlist(fundId);
      notifyWatchlist(`${displayName || fundId} 已从自选移除。`);
      await loadWatchlist();
    } catch (error) {
      notifyWatchlist(error instanceof Error ? error.message : "移除自选失败，请稍后重试。");
    }
  }

  async function searchManualSuggestions(value: string) {
    const cleanQuery = value.trim();
    if (cleanQuery.length < 2 && normalizeFundCode(cleanQuery).length < 6) {
      setManualSuggestions([]);
      return;
    }

    try {
      const items = await requestFundSearch(cleanQuery, 10);
      setManualSuggestions(items);
    } catch {
      setManualSuggestions([]);
    }
  }

  async function loadRelatedFunds(selected: FundCatalogItem) {
    const requestId = relatedRequestIdRef.current + 1;
    relatedRequestIdRef.current = requestId;
    const name = (selected.name ?? "").trim();

    if (!name.includes("ETF")) {
      setRelatedFunds([]);
      setRelatedLoading(false);
      return;
    }

    setRelatedLoading(true);
    setRelatedFunds([]);
    try {
      const items = await requestFundSearch(name, 20);
      if (relatedRequestIdRef.current !== requestId) return;
      const filtered = items.filter((item) => item.fund_id !== selected.fund_id && item.name?.includes("联接"));
      setRelatedFunds(filtered);
    } catch {
      if (relatedRequestIdRef.current !== requestId) return;
      setRelatedFunds([]);
    } finally {
      if (relatedRequestIdRef.current === requestId) {
        setRelatedLoading(false);
      }
    }
  }

  async function loadThemeFunds(theme: string) {
    const requestId = themeRequestIdRef.current + 1;
    themeRequestIdRef.current = requestId;
    setThemeLoading(true);
    setThemeNotice("");
    setThemeFunds([]);
    try {
      const items = await requestFundSearch(theme, 20);
      if (themeRequestIdRef.current !== requestId) return;
      setThemeFunds(items);
    } catch (error) {
      if (themeRequestIdRef.current !== requestId) return;
      setThemeFunds([]);
      setThemeNotice(error instanceof Error ? error.message : "板块基金加载失败。");
    } finally {
      if (themeRequestIdRef.current === requestId) {
        setThemeLoading(false);
      }
    }
  }

  async function loadNavTrend(fundId: string, range: NavRange) {
    if (!fundId) return;
    const requestId = navTrendRequestIdRef.current + 1;
    navTrendRequestIdRef.current = requestId;
    setDetailNavLoading(true);
    setDetailNotice("");
    try {
      const payload = await requestFundNavTrend(fundId, range);
      if (navTrendRequestIdRef.current !== requestId) return;
      setDetailNavTrend(payload);
    } catch (error) {
      if (navTrendRequestIdRef.current !== requestId) return;
      setDetailNavTrend(null);
      setDetailNotice(error instanceof Error ? error.message : "收益率曲线加载失败。");
    } finally {
      if (navTrendRequestIdRef.current === requestId) {
        setDetailNavLoading(false);
      }
    }
  }

  async function loadIntervalReturns(fundId: string) {
    if (!fundId) return;
    const requestId = intervalReturnsRequestIdRef.current + 1;
    intervalReturnsRequestIdRef.current = requestId;
    setDetailIntervalLoading(true);
    setDetailNotice("");
    const ranges: NavRange[] = ["1m", "3m", "6m", "1y", "all"];
    try {
      const responses = await Promise.all(
        ranges.map((range) => requestFundNavTrend(fundId, range).catch(() => null)),
      );
      if (intervalReturnsRequestIdRef.current !== requestId) return;
      const next: Record<NavRange, number | null> = {
        "1m": null,
        "3m": null,
        "6m": null,
        "1y": null,
        "all": null,
      };
      responses.forEach((response, index) => {
        if (!response) return;
        const range = ranges[index];
        next[range] = computeIntervalReturn(response.points);
      });
      setDetailIntervalReturns(next);
    } catch (error) {
      if (intervalReturnsRequestIdRef.current !== requestId) return;
      setDetailIntervalReturns(null);
      setDetailNotice(error instanceof Error ? error.message : "区间收益加载失败。");
    } finally {
      if (intervalReturnsRequestIdRef.current === requestId) {
        setDetailIntervalLoading(false);
      }
    }
  }

  async function loadFundEstimate(fundId: string) {
    if (!fundId) return;
    setDetailEstimate(null);
    try {
      const payload = await requestIntradayEstimate(fundId, estimateMode);
      setDetailEstimate(payload);
    } catch {
      setDetailEstimate(null);
    }
  }

  async function loadTopHoldings(fundId: string) {
    if (!fundId) return;
    const requestId = holdingsRequestIdRef.current + 1;
    holdingsRequestIdRef.current = requestId;
    setDetailHoldingsLoading(true);
    setDetailNotice("");
    try {
      const payload = await requestFundTopHoldings(fundId, 10);
      if (holdingsRequestIdRef.current !== requestId) return;
      setDetailHoldings(payload);
    } catch (error) {
      if (holdingsRequestIdRef.current !== requestId) return;
      setDetailHoldings(null);
      setDetailNotice(error instanceof Error ? error.message : "持仓数据加载失败。");
    } finally {
      if (holdingsRequestIdRef.current === requestId) {
        setDetailHoldingsLoading(false);
      }
    }
  }

  function openFundDetail(item: { fund_id: string }) {
    setDetailOpen(true);
    setDetailFundId(item.fund_id);
    setDetailRange("6m");
    setDetailNavTrend(null);
    setDetailHoldings(null);
    setDetailEstimate(null);
    setDetailIntervalReturns(null);
    setDetailNotice("");
    void loadNavTrend(item.fund_id, "6m");
    void loadIntervalReturns(item.fund_id);
    void loadTopHoldings(item.fund_id);
    void loadFundEstimate(item.fund_id);
  }

  function closeFundDetail() {
    setDetailOpen(false);
    setDetailNotice("");
  }

  function openThemeDrawer(theme: string) {
    const cleanTheme = theme.trim();
    if (!cleanTheme) return;
    setThemeOpen(true);
    setThemeName(cleanTheme);
    setThemeNotice("");
    setThemeFunds([]);
    void loadThemeFunds(cleanTheme);
    setDetailOpen(false);
  }

  function closeThemeDrawer() {
    setThemeOpen(false);
    setThemeNotice("");
  }

  function openImportModal() {
    setImportOpen(true);
    setImportTab("manual");
    setManualEntry(createManualEntry());
    setManualSuggestions([]);
    setRelatedFunds([]);
    setRelatedLoading(false);
    setModalNotice("");
    setPickerStatus("");
    setOcrRows([]);
    setOcrWarnings([]);
  }

  function openImportFromLibrary(item: FundCatalogItem) {
    setImportOpen(true);
    setImportTab("manual");
    const displayName = resolveFundName(item.name, item.name_display) || item.name || "";
    setManualEntry({ query: item.fund_id, fundName: displayName, amount: "", profit: "" });
    setManualSuggestions([]);
    setModalNotice(`已选中 ${displayName}，请补充持有金额和累计收益。`);
    void loadRelatedFunds(item);
  }

  function pickSuggestion(item: FundCatalogItem) {
    const displayName = resolveFundName(item.name, item.name_display) || item.name || "";
    setManualEntry((current) => ({ ...current, query: item.fund_id, fundName: displayName }));
    setManualSuggestions([]);
    void loadRelatedFunds(item);
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
    const portfolioQuestion = isPortfolioQuestion(cleanQuestion);
    const targetFundId = fundId ?? activeFundId ?? positions[0]?.fund_id ?? "";

    if (!positions.length) {
      setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", text: "请先导入持仓，再开始分析。" }]);
      return;
    }
    if (!portfolioQuestion && !targetFundId) {
      setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", text: "请先选择基金，再开始分析。" }]);
      return;
    }

    if (!cleanQuestion) return;

    setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text: cleanQuestion }]);
    setAssistantLoading(true);

    try {
      const payload = await requestAssistant({
        fundId: portfolioQuestion ? "" : targetFundId,
        question: cleanQuestion,
        estimateMode,
      });
      setChatMessages((current) => [...current, buildAssistantMessage(payload)]);
      if (!portfolioQuestion && targetFundId) {
        setActiveFundId(targetFundId);
      }
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
                {[["portfolio", "持仓"], ["watchlist", "自选"], ["library", "基金库"], ["config", "模型配置"]].map(([tab, label]) => (
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
                <Sparkles className="h-3 w-3 mr-1 text-yellow-500" /> 场内穿透实时引擎：运行中
              </span>
              <div className="ml-3 flex items-center gap-2 text-xs text-gray-500">
                <span className="hidden sm:inline">估值源</span>
                <select
                  value={estimateMode}
                  onChange={(event) => {
                    const nextMode = event.target.value as EstimateMode;
                    setEstimateMode(nextMode);
                    void refreshPortfolioData(nextMode);
                  }}
                  className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none"
                >
                  <option value="auto">自动</option>
                  <option value="official">官方</option>
                  <option value="penetration">穿透</option>
                </select>
              </div>
              <div className="h-8 w-8 rounded-full ml-4 border border-gray-200 bg-blue-600 text-white flex items-center justify-center text-xs font-bold">AI</div>
            </div>
          </div>
        </div>
      </nav>

      <main className="flex-1 overflow-y-auto p-4 sm:p-6 max-w-7xl mx-auto w-full">
        {pageNotice ? <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">{pageNotice}</div> : null}
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
                  <div className="flex flex-col">
                    <h2 className="text-lg font-bold text-gray-800">持仓明细</h2>
                    <p className="text-xs text-slate-500 mt-1">{updateStatusWithMode}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={openImportModal} className="bg-blue-50 text-blue-600 border border-blue-200 px-3 py-1.5 rounded-lg text-sm hover:bg-blue-100 transition-all font-medium inline-flex items-center">
                      <FolderPlus className="h-4 w-4 mr-1" /> 导入持仓
                    </button>
                    <div className="flex items-center gap-3">
                      <div className="text-right text-xs text-slate-500 leading-5">
                        <div>估值源：{estimateModeLabel}{displayEstimateSourceLabel ? ` · ${displayEstimateSourceLabel}` : ""}</div>
                        <div>更新时间：{latestEstimateTime ?? "当前"}</div>
                        {autoFallbackNotice ? <div className="text-amber-600">{autoFallbackNotice}</div> : null}
                      </div>
                      <button type="button" onClick={() => void refreshPortfolioData()} className="text-sm text-gray-500 hover:text-gray-800 px-2 py-1.5 inline-flex items-center" disabled={refreshing}>
                        {refreshing ? <LoaderCircle className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}刷新
                      </button>
                    </div>
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
                            <div className="text-sm font-medium text-gray-900">{resolveFundName(item.name, item.name_display) || item.name}</div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              {item.fund_id}
                              <span className={`px-1 py-0.5 rounded text-[10px] ml-1 ${item.is_real_data ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"}`}>
                                {item.is_real_data ? "真实参考" : "原型估算"}
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900 font-medium">{formatPlainAmount(item.current_value ?? item.market_value)}</td>
                          <td className={`px-6 py-4 whitespace-nowrap text-right text-sm font-bold ${toneClass(item.today_estimated_return ?? item.today_return)}`}>{formatSignedPercent(item.today_estimated_return ?? item.today_return)}</td>
                          <td className={`px-6 py-4 whitespace-nowrap text-right text-sm font-bold ${toneClass(item.today_estimated_pnl ?? item.today_profit)}`}>{formatSignedCurrency(item.today_estimated_pnl ?? item.today_profit).replace("¥", "")}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-center">
                            <div className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                className="text-gray-700 hover:text-gray-900 bg-gray-100 px-3 py-1 rounded text-sm font-medium"
                                onClick={() => openFundDetail(item)}
                              >
                                详情
                              </button>
                              <button
                                type="button"
                                className="text-blue-600 hover:text-blue-800 bg-blue-50 px-3 py-1 rounded text-sm font-medium"
                                onClick={() => void ask(buildAnalysisQuestion(item), item.fund_id)}
                              >
                                AI分析
                              </button>
                            </div>
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
                      <div className={message.role === "user" ? "bg-blue-600 text-white p-3 rounded-xl rounded-tr-sm shadow-sm text-sm max-w-[85%] whitespace-pre-line" : "bg-white border border-gray-200 text-gray-700 p-3 rounded-xl rounded-tl-sm shadow-sm text-sm max-w-[92%] leading-relaxed"}>
                        <div className="whitespace-pre-line">{message.text}</div>
                        {message.role === "assistant" && message.announcements ? (
                          <AnnouncementCard title={ANNOUNCEMENT_EVIDENCE_LABEL} items={message.announcements} />
                        ) : null}
                        {message.role === "assistant" && message.perFundAnnouncements?.length ? (
                          <div className="mt-3 space-y-2">
                            {message.perFundAnnouncements.map((item) => (
                              <AnnouncementCard key={`${item.fund_id}-announcement`} title={`${item.name} · ${ANNOUNCEMENT_EVIDENCE_LABEL}`} items={item.items} />
                            ))}
                          </div>
                        ) : null}
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
                              <div className="text-sm font-medium text-gray-900">{resolveFundName(item.name, item.name_display) || item.name}</div>
                              <div className="text-xs text-gray-500 mt-0.5">{item.fund_id}</div>
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-600">{item.theme || "--"}</td>
                            <td className="px-6 py-4 text-sm text-gray-600">{item.risk_level || "--"}</td>
                            <td className="px-6 py-4 text-right text-sm text-gray-700">{item.latest_nav ? Number(item.latest_nav).toFixed(4) : "--"}</td>
                            <td className="px-6 py-4 text-center">
                              <div className="inline-flex items-center gap-2">
                                <button type="button" onClick={() => openImportFromLibrary(item)} className="text-blue-600 hover:text-blue-800 bg-blue-50 px-3 py-1 rounded text-sm font-medium">加入持仓</button>
                                <button
                                  type="button"
                                  onClick={() => void handleAddToWatchlist(item)}
                                  className="text-gray-700 hover:text-gray-900 bg-gray-100 px-3 py-1 rounded text-sm font-medium disabled:opacity-60"
                                  disabled={watchlistIdSet.has(item.fund_id)}
                                >
                                  {watchlistIdSet.has(item.fund_id) ? "已自选" : "加入自选"}
                                </button>
                              </div>
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

        {activeTab === "watchlist" ? (
          <div className="h-full flex flex-col">
            <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 mb-6 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-gray-800">自选</h2>
                <p className="text-xs text-gray-500 mt-1">最多 50 只基金 · 估值源：{estimateModeLabel}</p>
              </div>
              <button
                type="button"
                onClick={() => void loadWatchlist(true)}
                className="text-sm text-gray-600 hover:text-gray-800 bg-gray-100 px-3 py-2 rounded-lg inline-flex items-center"
                disabled={watchlistLoading}
              >
                {watchlistLoading ? <LoaderCircle className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}刷新
              </button>
            </div>

            {watchlistNotice ? <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">{watchlistNotice}</div> : null}

            <div className="bg-white rounded-xl shadow-sm border border-gray-100 flex-1 overflow-hidden">
              {watchlistItems.length ? (
                <div className="overflow-auto h-full">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">基金</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">估值源</th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">估值涨跌</th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">最新净值</th>
                        <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-100">
                      {watchlistItems.map((item) => {
                        const intradayItem = watchlistIntradayMap.get(item.fund_id);
                        const estimatedReturn = intradayItem?.estimated_return;
                        const latestNav = intradayItem?.latest_nav;
                        const displayName = resolveFundName(item.name, item.name_display) || item.name || item.fund_id;
                        return (
                          <tr key={item.fund_id}>
                            <td className="px-6 py-4">
                              <div className="text-sm font-medium text-gray-900">{displayName}</div>
                              <div className="text-xs text-gray-500 mt-0.5">{item.fund_id}</div>
                              {item.theme ? (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <span className="px-2 py-0.5 rounded-full text-[10px] border border-blue-200 text-blue-700 bg-blue-50">{item.theme}</span>
                                </div>
                              ) : null}
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-600">{estimateModeLabel}</td>
                            <td className={`px-6 py-4 text-right text-sm font-semibold ${toneClass(estimatedReturn)}`}>
                              {typeof estimatedReturn === "number" ? formatSignedPercent(estimatedReturn) : "--"}
                            </td>
                            <td className="px-6 py-4 text-right text-sm text-gray-700">{latestNav ? Number(latestNav).toFixed(4) : "--"}</td>
                            <td className="px-6 py-4 text-center">
                              <div className="inline-flex items-center gap-2">
                                <button
                                  type="button"
                                  className="text-gray-700 hover:text-gray-900 bg-gray-100 px-3 py-1 rounded text-sm font-medium"
                                  onClick={() => openFundDetail({ fund_id: item.fund_id })}
                                >
                                  详情
                                </button>
                                <button
                                  type="button"
                                  className="text-rose-600 hover:text-rose-700 bg-rose-50 px-3 py-1 rounded text-sm font-medium"
                                  onClick={() => void handleRemoveFromWatchlist(item.fund_id, displayName)}
                                >
                                  移除
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-gray-400 text-sm">
                  {watchlistLoading ? "自选加载中..." : "暂无自选基金，去基金库或搜索结果里加入吧。"}
                </div>
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

      {detailOpen ? (
        <div className="fixed inset-0 z-40 flex">
          <button type="button" className="flex-1 bg-gray-900/40" onClick={closeFundDetail} aria-label="关闭详情遮罩" />
          <div className="w-full max-w-xl bg-white h-full shadow-2xl flex flex-col border-l border-gray-200">
            <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs text-gray-500">基金详情</p>
                  <h3 className="text-lg font-bold text-gray-900">
                    {resolveFundName(detailFund?.name, detailFund?.name_display) || detailFund?.name || detailFundId || "--"}
                    <span className="ml-2 text-sm font-medium text-gray-500">{detailFund?.fund_id || detailFundId}</span>
                  </h3>
                  <p className="text-xs text-gray-500 mt-1">收益率曲线覆盖从成立到现在，可切换不同区间。</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const displayName = resolveFundName(detailFund?.name, detailFund?.name_display) || detailFundId;
                      if (detailInWatchlist) {
                        void handleRemoveFromWatchlist(detailFundId, displayName);
                      } else {
                        void handleAddToWatchlist({ fund_id: detailFundId, name: detailFund?.name, name_display: detailFund?.name_display });
                      }
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${detailInWatchlist ? "bg-gray-100 text-gray-700 border-gray-200" : "bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100"}`}
                  >
                    {detailInWatchlist ? "移除自选" : "加入自选"}
                  </button>
                  <button type="button" onClick={closeFundDetail} className="text-gray-400 hover:text-gray-700">
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>
              {detailNotice ? <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">{detailNotice}</div> : null}
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              <section className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-gray-800">收益率曲线</h4>
                  <span className="text-xs text-gray-500">最新净值 {navLatest ? navLatest.toFixed(4) : "--"}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {NAV_RANGE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setDetailRange(option.value);
                        void loadNavTrend(detailFundId, option.value);
                      }}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border ${detailRange === option.value ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <div className="mt-4 bg-slate-50 border border-slate-200 rounded-lg px-3 py-4">
                  {detailNavLoading ? (
                    <div className="text-xs text-gray-500 flex items-center"><LoaderCircle className="h-4 w-4 mr-2 animate-spin text-blue-500" />收益率曲线加载中...</div>
                  ) : navPoints.length ? (
                    <svg
                      viewBox={`0 0 ${NAV_CHART_WIDTH} ${NAV_CHART_HEIGHT}`}
                      className="w-full h-44"
                      onPointerMove={handleNavPointerMove}
                      onPointerDown={handleNavPointerMove}
                      onPointerLeave={handleNavPointerLeave}
                      style={{ touchAction: "none" }}
                    >
                      {navReturnSummary.ticks.map((tickValue, index) => {
                        const y = getReturnY(tickValue, navReturnSummary);
                        return (
                          <g key={`nav-grid-${index}`}>
                            <line
                              x1={NAV_CHART_PADDING_X}
                              x2={NAV_CHART_WIDTH - NAV_CHART_PADDING_X}
                              y1={y}
                              y2={y}
                              stroke="rgba(148, 163, 184, 0.5)"
                              strokeWidth="1"
                            />
                            <text
                              x={NAV_CHART_PADDING_X - 6}
                              y={y + 4}
                              fontSize="10"
                              textAnchor="end"
                              fill="rgb(100 116 139)"
                            >
                              {formatSignedPercent(tickValue)}
                            </text>
                          </g>
                        );
                      })}
                      <polyline
                        fill="none"
                        stroke="rgb(37 99 235)"
                        strokeWidth="3"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        points={navPolyline}
                      />
                      {navDateTicks.map((tick) => (
                        <text
                          key={`nav-date-${tick.index}`}
                          x={tick.x}
                          y={NAV_CHART_HEIGHT - 6}
                          fontSize="10"
                          textAnchor="middle"
                          fill="rgb(100 116 139)"
                        >
                          {tick.label}
                        </text>
                      ))}
                      {navHoverPoint ? (
                        <>
                          <line
                            x1={navHoverPoint.x}
                            x2={navHoverPoint.x}
                            y1={NAV_CHART_PADDING_Y}
                            y2={NAV_CHART_HEIGHT - NAV_CHART_PADDING_Y}
                            stroke="rgba(37, 99, 235, 0.35)"
                            strokeWidth="1.5"
                          />
                          <circle
                            cx={navHoverPoint.x}
                            cy={navHoverPoint.y}
                            r="4"
                            fill="white"
                            stroke="rgb(37 99 235)"
                            strokeWidth="2"
                          />
                        </>
                      ) : null}
                    </svg>
                  ) : (
                    <div className="text-xs text-gray-500">暂无收益率曲线数据。</div>
                  )}
                </div>
                {navPoints.length ? (
                  <div className="mt-2 text-xs text-slate-600">{navHoverLabel}</div>
                ) : null}
                <div className="mt-2 text-xs text-gray-500 flex items-center justify-between">
                  <span>最低收益率 {navReturns.length ? formatSignedPercent(navReturnSummary.min) : "--"}</span>
                  <span>最高收益率 {navReturns.length ? formatSignedPercent(navReturnSummary.max) : "--"}</span>
                </div>
              </section>

              <section className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-gray-800">区间收益</h4>
                  <span className="text-xs text-gray-500">按收益率曲线首末点估算</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {NAV_RANGE_OPTIONS.map((option) => {
                    const value = intervalReturns[option.value];
                    const display = typeof value === "number" ? formatSignedPercent(value) : detailIntervalLoading ? "加载中..." : "--";
                    return (
                      <div key={option.value} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <div className="text-xs text-slate-500">{option.label}</div>
                        <div className={`mt-1 text-sm font-semibold ${toneClass(value ?? 0)}`}>{display}</div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {disclosureWarning ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
                  <div className="font-semibold text-amber-800">披露与穿透警告</div>
                  <div className="mt-1 leading-5">{disclosureWarning}</div>
                </div>
              ) : null}

              <section className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-gray-800">前10大持仓</h4>
                  <span className="text-xs text-gray-500">披露日期 {detailHoldings?.disclosure_date || "--"}</span>
                </div>
                <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
                  <table className="min-w-full divide-y divide-gray-200 text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600">公司</th>
                        <th className="px-3 py-2 text-right font-semibold text-gray-600">权重</th>
                        <th className="px-3 py-2 text-right font-semibold text-gray-600">今日涨跌</th>
                        <th className="px-3 py-2 text-right font-semibold text-gray-600">贡献</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-100">
                      {detailHoldingsLoading ? (
                        <tr>
                          <td className="px-3 py-3 text-center text-gray-500" colSpan={4}>持仓加载中...</td>
                        </tr>
                      ) : detailHoldingsSorted.length ? (
                        detailHoldingsSorted.map((item) => (
                          <tr key={`${item.code}-${item.name}`}>
                            <td className="px-3 py-2 text-gray-800 font-medium">{item.name || item.code}</td>
                            <td className="px-3 py-2 text-right text-gray-600">{formatWeightPercent(item.weight_percent)}</td>
                            <td className={`px-3 py-2 text-right font-medium ${toneClass(item.change_rate)}`}>{formatSignedPercent(item.change_rate)}</td>
                            <td className={`px-3 py-2 text-right font-medium ${toneClass(item.contribution)}`}>{formatSignedPercent(item.contribution)}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td className="px-3 py-3 text-center text-gray-500" colSpan={4}>暂无持仓数据。</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                <div>
                  <p className="text-xs text-gray-500">关联板块/行业</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {relatedSectorChips.length ? (
                      relatedSectorChips.map((chip) => (
                        <button
                          key={`related-chip-${chip}`}
                          type="button"
                          className="px-3 py-1.5 rounded-full text-xs font-medium border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100"
                          onClick={() => openThemeDrawer(chip)}
                        >
                          {chip}
                        </button>
                      ))
                    ) : (
                      <span className="text-xs text-gray-400">暂无可用板块/行业信息。</span>
                    )}
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      ) : null}

      {themeOpen ? (
        <div className="fixed inset-0 z-40 flex">
          <button type="button" className="flex-1 bg-gray-900/40" onClick={closeThemeDrawer} aria-label="关闭主题遮罩" />
          <div className="w-full max-w-lg bg-white h-full shadow-2xl flex flex-col border-l border-gray-200">
            <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs text-gray-500">板块/主题页</p>
                  <h3 className="text-lg font-bold text-gray-900">{themeName || "--"}</h3>
                  <p className="text-xs text-gray-500 mt-1">相关基金：最多展示 20 只</p>
                </div>
                <button type="button" onClick={closeThemeDrawer} className="text-gray-400 hover:text-gray-700">
                  <X className="h-5 w-5" />
                </button>
              </div>
              {themeNotice ? <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">{themeNotice}</div> : null}
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {themeLoading ? (
                <div className="text-xs text-gray-500 flex items-center"><LoaderCircle className="h-4 w-4 mr-2 animate-spin text-blue-500" />板块基金加载中...</div>
              ) : themeFunds.length ? (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="min-w-full divide-y divide-gray-200 text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600">基金</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-600">风险</th>
                        <th className="px-3 py-2 text-right font-semibold text-gray-600">净值</th>
                        <th className="px-3 py-2 text-center font-semibold text-gray-600">操作</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-100">
                      {themeFunds.map((item) => (
                        <tr key={item.fund_id}>
                          <td className="px-3 py-2">
                            <div className="text-sm font-medium text-gray-800">{resolveFundName(item.name, item.name_display) || item.name}</div>
                            <div className="text-[11px] text-gray-500 mt-0.5">{item.fund_id}</div>
                          </td>
                          <td className="px-3 py-2 text-sm text-gray-600">{item.risk_level || "--"}</td>
                          <td className="px-3 py-2 text-right text-sm text-gray-700">{item.latest_nav ? Number(item.latest_nav).toFixed(4) : "--"}</td>
                          <td className="px-3 py-2 text-center">
                            <div className="inline-flex items-center gap-2">
                              <button type="button" onClick={() => openImportFromLibrary(item)} className="text-blue-600 hover:text-blue-800 bg-blue-50 px-2.5 py-1 rounded text-xs font-medium">加入持仓</button>
                              <button
                                type="button"
                                onClick={() => void handleAddToWatchlist(item)}
                                className="text-gray-700 hover:text-gray-900 bg-gray-100 px-2.5 py-1 rounded text-xs font-medium disabled:opacity-60"
                                disabled={watchlistIdSet.has(item.fund_id)}
                              >
                                {watchlistIdSet.has(item.fund_id) ? "已自选" : "加入自选"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-xs text-gray-500">暂无可展示的板块基金。</div>
              )}
            </div>
          </div>
        </div>
      ) : null}

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
                          relatedRequestIdRef.current += 1;
                          setRelatedFunds([]);
                          setRelatedLoading(false);
                          void searchManualSuggestions(value);
                        }}
                        className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg sm:text-sm bg-gray-50 focus:bg-white focus:ring-1 focus:ring-blue-500 outline-none"
                        placeholder="输入如：易方达蓝筹精选 或 005827"
                      />
                    </div>
                    {manualSuggestions.length ? (
                      <div className="absolute z-20 w-full mt-1 bg-white shadow-lg border border-gray-200 rounded-lg max-h-40 overflow-y-auto">
                        {manualSuggestions.map((item) => (
                          <div key={item.fund_id} className="flex items-center justify-between px-4 py-3 hover:bg-blue-50 text-sm">
                            <button type="button" className="flex-1 text-left" onClick={() => pickSuggestion(item)}>
                              <span className="font-medium">{resolveFundName(item.name, item.name_display) || item.name}</span>
                              <span className="text-xs text-gray-500 ml-2">{item.fund_id}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleAddToWatchlist(item)}
                              className="ml-3 text-xs font-medium text-gray-700 bg-gray-100 px-2.5 py-1 rounded disabled:opacity-60"
                              disabled={watchlistIdSet.has(item.fund_id)}
                            >
                              {watchlistIdSet.has(item.fund_id) ? "已自选" : "加入自选"}
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {relatedFunds.length ? (
                      <div className="mt-2 text-xs text-gray-500 flex flex-wrap items-center gap-2">
                        <span className="font-medium text-gray-500">同系列联接：</span>
                        {relatedFunds.map((item) => (
                          <button
                            key={item.fund_id}
                            type="button"
                            className="px-2.5 py-1 rounded-full border border-gray-200 bg-gray-100 text-gray-600 hover:bg-gray-200"
                            onClick={() => {
                              pickSuggestion(item);
                              const displayName = resolveFundName(item.name, item.name_display) || item.name || "";
                              setModalNotice(`已切换为 ${displayName}。`);
                            }}
                          >
                            {buildRelatedFundLabel(item)}
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
