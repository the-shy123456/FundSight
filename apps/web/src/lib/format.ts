import type { HoldingFilter, HoldingSortKey, ManualRow, PortfolioPosition } from "../types";

export function parseNumber(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

export function formatCurrency(value: unknown): string {
  return `¥${parseNumber(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatSignedCurrency(value: unknown): string {
  const amount = parseNumber(value);
  return `${amount > 0 ? "+" : ""}${formatCurrency(amount)}`;
}

export function formatSignedPercent(value: unknown): string {
  const amount = parseNumber(value);
  return `${amount > 0 ? "+" : ""}${(amount * 100).toFixed(2)}%`;
}

export function numberTone(value: unknown): "up" | "down" | "flat" {
  const amount = parseNumber(value);
  if (amount > 0) return "up";
  if (amount < 0) return "down";
  return "flat";
}

export function toneClass(value: unknown): string {
  return {
    up: "text-rose-500",
    down: "text-emerald-500",
    flat: "text-slate-500",
  }[numberTone(value)];
}

export function normalizeFundCode(value: unknown): string {
  const matched = String(value ?? "").match(/(\d{6})/);
  return matched ? matched[1] : "";
}

export function riskLevelLabel(value: unknown): string {
  return (
    {
      low: "低风险",
      medium: "中风险",
      high: "高风险",
    }[String(value ?? "").toLowerCase()] ?? String(value || "--")
  );
}

export function isValidManualRow(row: ManualRow): boolean {
  return Boolean(normalizeFundCode(row.fundQuery)) && parseNumber(row.amount) > 0;
}

export function compareHoldingRows(left: PortfolioPosition, right: PortfolioPosition, sortKey: HoldingSortKey): number {
  if (sortKey === "todayProfit") {
    return parseNumber(right.today_estimated_pnl ?? right.today_profit) - parseNumber(left.today_estimated_pnl ?? left.today_profit);
  }
  if (sortKey === "totalProfit") {
    return parseNumber(right.total_pnl ?? right.total_profit) - parseNumber(left.total_pnl ?? left.total_profit);
  }
  return String(left.name || "").localeCompare(String(right.name || ""), "zh-CN");
}

export function filterAndSortHoldings(
  positions: PortfolioPosition[],
  query: string,
  filter: HoldingFilter,
  sortKey: HoldingSortKey,
): PortfolioPosition[] {
  const cleanQuery = query.trim().toLowerCase();
  return [...positions]
    .filter((item) => {
      const totalProfit = parseNumber(item.total_pnl ?? item.total_profit);
      if (filter === "profit" && totalProfit <= 0) return false;
      if (filter === "loss" && totalProfit >= 0) return false;
      if (!cleanQuery) return true;
      const proxyName = typeof item.proxy === "object" ? item.proxy?.name : item.proxy;
      return [item.fund_id, item.name, item.theme, proxyName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(cleanQuery));
    })
    .sort((left, right) => compareHoldingRows(left, right, sortKey));
}
