import type {
  AssistantResponse,
  FundCatalogItem,
  FundCatalogResponse,
  ManualRow,
  OcrResponse,
  PortfolioIntraday,
  PortfolioSnapshot,
} from "../types";
import { normalizeFundCode, parseNumber } from "./format";

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
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
    const payload = await fetchJson<{ items?: FundCatalogItem[]; total?: number }>(`/api/v1/funds/search?q=${encodeURIComponent(cleanQuery)}`);
    return {
      items: payload.items ?? [],
      total: payload.total ?? payload.items?.length ?? 0,
      page: 1,
      page_size: pageSize,
    };
  }

  return fetchJson<FundCatalogResponse>(`/api/v1/funds?page=${page}&page_size=${pageSize}`);
}

export async function requestFundSearch(keyword: string): Promise<FundCatalogItem[]> {
  const cleanQuery = keyword.trim();
  if (!cleanQuery) return [];
  const payload = await fetchJson<{ items?: FundCatalogItem[] }>(`/api/v1/funds/search?q=${encodeURIComponent(cleanQuery)}`);
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

export async function requestIntradayEstimate(code: string): Promise<{ estimated_nav?: number; latest_nav?: number }> {
  return fetchJson<{ estimated_nav?: number; latest_nav?: number }>(`/api/v1/funds/${encodeURIComponent(code)}/intraday-estimate`);
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

export async function requestPortfolio(): Promise<PortfolioSnapshot> {
  return fetchJson<PortfolioSnapshot>("/api/v1/portfolio");
}

export async function requestPortfolioIntraday(): Promise<PortfolioIntraday> {
  return fetchJson<PortfolioIntraday>("/api/v1/portfolio/intraday");
}

export async function requestAssistant(payload: { fundId: string; question: string }): Promise<AssistantResponse> {
  return fetchJson<AssistantResponse>("/api/v1/assistant/ask", {
    method: "POST",
    body: JSON.stringify({
      fund_id: payload.fundId,
      cash_available: 0,
      question: payload.question,
    }),
  });
}
