import type {
  AssistantResponse,
  FundCatalogItem,
  FundCatalogResponse,
  IntradayEstimate,
  ManualRow,
  NavTrendResponse,
  OcrResponse,
  PortfolioIntraday,
  PortfolioSnapshot,
  TopHoldingsResponse,
  WatchlistIntradayResponse,
  WatchlistResponse,
} from "../types";
import { normalizeFundCode, parseNumber } from "./format";

const API_BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");

function withApiBase(url: string): string {
  if (!API_BASE) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${API_BASE}${url}`;
  return `${API_BASE}/${url}`;
}

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(withApiBase(url), {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!response.ok) {
    let message = `请求失败：${response.status}`;
    try {
      const payload = (await response.json()) as { message?: string };
      if (payload.message) message = payload.message;
    } catch {
      return Promise.reject(new Error(message));
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export async function requestFundsCatalog({
  query = "",
  page = 1,
  pageSize = 10,
}: {
  query?: string;
  page?: number;
  pageSize?: number;
}): Promise<FundCatalogResponse> {
  const cleanQuery = query.trim();
  if (cleanQuery) {
    const payload = await fetchJson<{ items?: FundCatalogItem[]; total?: number }>(
      `/api/v1/funds/search?q=${encodeURIComponent(cleanQuery)}&limit=${pageSize}`,
    );
    return {
      items: payload.items ?? [],
      total: payload.total ?? payload.items?.length ?? 0,
      page: 1,
      page_size: pageSize,
    };
  }

  return fetchJson<FundCatalogResponse>(`/api/v1/funds?page=${page}&page_size=${pageSize}`);
}

export async function requestFundNavTrend(fundId: string, range: "1m" | "3m" | "6m" | "1y" | "all" = "6m"): Promise<NavTrendResponse> {
  return fetchJson<NavTrendResponse>(
    `/api/v1/funds/${encodeURIComponent(fundId)}/nav-trend?range=${encodeURIComponent(range)}`,
  );
}

export async function requestFundTopHoldings(fundId: string, limit = 10): Promise<TopHoldingsResponse> {
  return fetchJson<TopHoldingsResponse>(
    `/api/v1/funds/${encodeURIComponent(fundId)}/top-holdings?limit=${encodeURIComponent(limit)}`,
  );
}

export async function requestFundSearch(keyword: string, limit = 10): Promise<FundCatalogItem[]> {
  const cleanQuery = keyword.trim();
  if (!cleanQuery) return [];
  const payload = await fetchJson<{ items?: FundCatalogItem[] }>(
    `/api/v1/funds/search?q=${encodeURIComponent(cleanQuery)}&limit=${limit}`,
  );
  return payload.items ?? [];
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("截图读取失败，请重试。"));
    reader.readAsDataURL(file);
  });
}

export async function requestHoldingsOcr(file: File): Promise<OcrResponse> {
  const imageBase64 = await fileToDataUrl(file);
  return fetchJson<OcrResponse>("/api/v1/holdings/ocr", {
    method: "POST",
    body: JSON.stringify({ image_base64: imageBase64 }),
  });
}

export async function requestIntradayEstimate(code: string, estimateMode?: "auto" | "official" | "penetration"): Promise<IntradayEstimate> {
  const query = estimateMode ? `?estimate_mode=${encodeURIComponent(estimateMode)}` : "";
  return fetchJson<IntradayEstimate>(`/api/v1/funds/${encodeURIComponent(code)}/intraday-estimate${query}`);
}

export async function buildImportTextFromRows(rows: ManualRow[]): Promise<string> {
  const validRows = rows.filter((row) => normalizeFundCode(row.fundQuery) && parseNumber(row.amount) > 0);
  if (validRows.length === 0) throw new Error("请至少录入一只基金");

  const lines = await Promise.all(
    validRows.map(async (row) => {
      const code = normalizeFundCode(row.fundQuery);
      const amount = parseNumber(row.amount);
      const profit = parseNumber(row.profit);
      if (!code) throw new Error("当前先支持输入 6 位基金代码");
      if (amount <= 0) throw new Error(`基金 ${code} 的持有金额必须大于 0`);
      const estimate = await requestIntradayEstimate(code);
      const nav = parseNumber(estimate.estimated_nav ?? estimate.latest_nav);
      if (nav <= 0) throw new Error(`基金 ${code} 的估值数据异常`);
      const costBasis = amount - profit;
      if (costBasis <= 0) throw new Error(`基金 ${code} 的持有收益不能大于持有金额`);
      const shares = amount / nav;
      const costNav = costBasis / shares;
      return `${code},${shares.toFixed(4)},${costNav.toFixed(4)}`;
    }),
  );

  return lines.join("\n");
}

export async function requestHoldingsImport(text: string): Promise<PortfolioSnapshot> {
  return fetchJson<PortfolioSnapshot>("/api/v1/holdings/import", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export async function requestHoldingsRemove(fundId: string): Promise<PortfolioSnapshot> {
  return fetchJson<PortfolioSnapshot>(`/api/v1/holdings/${encodeURIComponent(fundId)}`, {
    method: "DELETE",
  });
}

export async function requestHoldingsClear(): Promise<PortfolioSnapshot> {
  return fetchJson<PortfolioSnapshot>("/api/v1/holdings", {
    method: "DELETE",
  });
}

export async function requestPortfolio(estimateMode?: "auto" | "official" | "penetration"): Promise<PortfolioSnapshot> {
  const query = estimateMode ? `?estimate_mode=${encodeURIComponent(estimateMode)}` : "";
  return fetchJson<PortfolioSnapshot>(`/api/v1/portfolio${query}`);
}

export async function requestPortfolioIntraday(estimateMode?: "auto" | "official" | "penetration"): Promise<PortfolioIntraday> {
  const query = estimateMode ? `?estimate_mode=${encodeURIComponent(estimateMode)}` : "";
  return fetchJson<PortfolioIntraday>(`/api/v1/portfolio/intraday${query}`);
}

export async function requestWatchlist(): Promise<WatchlistResponse> {
  return fetchJson<WatchlistResponse>("/api/v1/watchlist");
}

export async function addToWatchlist(fundId: string): Promise<{ added: boolean; fund_id: string }> {
  return fetchJson<{ added: boolean; fund_id: string }>("/api/v1/watchlist", {
    method: "POST",
    body: JSON.stringify({ fund_id: fundId }),
  });
}

export async function removeFromWatchlist(fundId: string): Promise<{ deleted: boolean }> {
  return fetchJson<{ deleted: boolean }>(`/api/v1/watchlist/${encodeURIComponent(fundId)}`, {
    method: "DELETE",
  });
}

export async function requestWatchlistIntraday(estimateMode?: "auto" | "official" | "penetration"): Promise<WatchlistIntradayResponse> {
  const query = estimateMode ? `?estimate_mode=${encodeURIComponent(estimateMode)}` : "";
  return fetchJson<WatchlistIntradayResponse>(`/api/v1/watchlist/intraday${query}`);
}

export async function requestAssistant(payload: {
  fundId?: string;
  question: string;
  estimateMode?: "auto" | "official" | "penetration";
}): Promise<AssistantResponse> {
  return fetchJson<AssistantResponse>("/api/v1/assistant/ask", {
    method: "POST",
    body: JSON.stringify({
      fund_id: payload.fundId ?? "",
      cash_available: 0,
      question: payload.question,
      estimate_mode: payload.estimateMode,
    }),
  });
}

export type LlmProtocol = "openai_compatible" | "openai_responses" | "anthropic_messages";

export type LlmConfigView = {
  protocol: LlmProtocol;
  base_url: string;
  model: string;
  has_api_key: boolean;
};

export async function requestLlmConfig(): Promise<LlmConfigView> {
  return fetchJson<LlmConfigView>("/api/v1/llm/config");
}

export async function saveLlmConfig(payload: {
  protocol: LlmProtocol;
  base_url: string;
  model: string;
  api_key?: string;
}): Promise<LlmConfigView> {
  return fetchJson<LlmConfigView>("/api/v1/llm/config", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function requestAssistantStream(
  payload: {
    fundId?: string;
    question: string;
    estimateMode?: "auto" | "official" | "penetration";
  },
  options: {
    onDelta: (text: string) => void;
    onEvent?: (event: string, data: string) => void;
  },
): Promise<void> {
  const response = await fetch(withApiBase("/api/v1/assistant/ask/stream"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fund_id: payload.fundId ?? "",
      cash_available: 0,
      question: payload.question,
      estimate_mode: payload.estimateMode,
    }),
  });

  if (!response.ok) {
    let message = `请求失败：${response.status}`;
    try {
      const json = (await response.json()) as { message?: string };
      if (json?.message) message = json.message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error("流式响应不可用");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const emit = (event: string, data: string) => {
    options.onEvent?.(event, data);
    if (event === "error") {
      throw new Error(data || "AI 流式接口返回错误");
    }
    if (event === "delta") {
      options.onDelta(data);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex = buffer.indexOf("\n\n");
    while (sepIndex >= 0) {
      const raw = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      sepIndex = buffer.indexOf("\n\n");

      const lines = raw.split("\n");
      let event = "message";
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }
      const data = dataLines.join("\n");
      if (data) emit(event, data);
    }
  }
}
