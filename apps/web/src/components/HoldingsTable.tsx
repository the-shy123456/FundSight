import { AlertCircle, ArrowDownWideNarrow, ArrowUpDown, Bot, Search, Trash2 } from "lucide-react";
import type { HoldingFilter, HoldingSortKey, PortfolioPosition } from "../types";
import { formatCurrency, formatSignedCurrency, formatSignedPercent, parseNumber, toneClass } from "../lib/format";

interface HoldingsTableProps {
  items: PortfolioPosition[];
  totalCount: number;
  page: number;
  pageCount: number;
  pageSize: number;
  query: string;
  sortKey: HoldingSortKey;
  filter: HoldingFilter;
  selectedCodes: string[];
  highlightedCodes: string[];
  onQueryChange: (value: string) => void;
  onSortChange: (value: HoldingSortKey) => void;
  onFilterChange: (value: HoldingFilter) => void;
  onPageSizeChange: (value: number) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onToggleSelect: (code: string, checked: boolean) => void;
  onToggleSelectAll: (checked: boolean) => void;
  onAnalyzeSelected: () => void;
  onRemoveSelected: () => void;
}

export function HoldingsTable(props: HoldingsTableProps) {
  const allSelected = props.items.length > 0 && props.items.every((item) => props.selectedCodes.includes(item.fund_id));
  const selectedRows = props.items.filter((item) => props.selectedCodes.includes(item.fund_id));
  const selectedAmount = selectedRows.reduce((sum, item) => sum + parseNumber(item.current_value ?? item.market_value), 0);
  const selectedProfit = selectedRows.reduce((sum, item) => sum + parseNumber(item.total_pnl ?? item.total_profit), 0);

  return (
    <section id="overview-section" className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 border-b border-slate-100 pb-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-blue-600">
            <ArrowDownWideNarrow className="h-4 w-4" />
            持仓明细（实时）
          </div>
          <p className="mt-2 text-sm text-slate-500">支持搜索、筛选、分页和多选联动，导入后的基金会优先高亮。</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-w-64 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
            <Search className="h-4 w-4" />
            <input
              value={props.query}
              onChange={(event) => props.onQueryChange(event.target.value)}
              className="w-full border-none bg-transparent text-slate-800 outline-none"
              placeholder="搜索基金、代码或主题"
            />
          </label>
          <label className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
            <span className="mr-2">排序</span>
            <select
              value={props.sortKey}
              onChange={(event) => props.onSortChange(event.target.value as HoldingSortKey)}
              className="border-none bg-transparent outline-none"
            >
              <option value="name">基金名称</option>
              <option value="todayProfit">当日收益</option>
              <option value="totalProfit">累计收益</option>
            </select>
          </label>
          <label className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
            <span className="mr-2">每页</span>
            <select
              id="holding-page-size"
              value={props.pageSize}
              onChange={(event) => props.onPageSizeChange(Number(event.target.value))}
              className="border-none bg-transparent outline-none"
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={20}>20</option>
            </select>
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {[
            ["all", "全部"],
            ["profit", "盈利"],
            ["loss", "亏损"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => props.onFilterChange(value as HoldingFilter)}
              className={`rounded-full px-3 py-1.5 transition ${props.filter === value ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
            >
              {label}
            </button>
          ))}
          <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-500">共 {props.totalCount} 条</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-slate-500">
          <span>{selectedRows.length ? `已选 ${selectedRows.length} 项` : "未选择基金"}</span>
          {selectedRows.length ? <span>资产 {formatCurrency(selectedAmount)} · 收益 {formatSignedCurrency(selectedProfit)}</span> : null}
          <button
            type="button"
            onClick={props.onAnalyzeSelected}
            disabled={selectedRows.length === 0}
            className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 font-medium text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Bot className="h-4 w-4" />
            批量分析
          </button>
          <button
            type="button"
            onClick={props.onRemoveSelected}
            disabled={selectedRows.length === 0}
            className="inline-flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 font-medium text-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            移出持仓
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200">
        <div className="grid grid-cols-[52px_2fr_1.2fr_1.2fr_1.2fr_1fr_1fr] items-center bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
          <label className="flex items-center justify-center">
            <input type="checkbox" checked={allSelected} onChange={(event) => props.onToggleSelectAll(event.target.checked)} />
          </label>
          <span>基金</span>
          <span>持仓市值</span>
          <span>今日估算</span>
          <span>累计收益</span>
          <span>代理主题</span>
          <span>置信度</span>
        </div>

        {props.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center text-slate-500">
            <AlertCircle className="h-8 w-8 text-slate-300" />
            <div>
              <p className="font-semibold text-slate-700">没有匹配的持仓</p>
              <p className="mt-1 text-sm">你可以调整筛选条件，或先导入新的基金。</p>
            </div>
          </div>
        ) : (
          props.items.map((item) => {
            const currentValue = parseNumber(item.current_value ?? item.market_value);
            const todayProfit = parseNumber(item.today_estimated_pnl ?? item.today_profit);
            const totalProfit = parseNumber(item.total_pnl ?? item.total_profit);
            const selected = props.selectedCodes.includes(item.fund_id);
            const highlighted = props.highlightedCodes.includes(item.fund_id);
            const proxyName = typeof item.proxy === "object" ? item.proxy?.name : item.proxy || item.theme || "—";

            return (
              <div
                key={item.fund_id}
                className={`grid grid-cols-[52px_2fr_1.2fr_1.2fr_1.2fr_1fr_1fr] items-center border-t border-slate-100 px-4 py-4 text-sm transition ${selected ? "bg-blue-50/80" : "bg-white"} ${highlighted ? "ring-1 ring-inset ring-blue-200" : ""}`}
              >
                <label className="flex items-center justify-center">
                  <input type="checkbox" checked={selected} onChange={(event) => props.onToggleSelect(item.fund_id, event.target.checked)} />
                </label>
                <div>
                  <div className="font-semibold text-slate-800">{item.name}</div>
                  <div className="mt-1 text-xs text-slate-400">{item.fund_id}</div>
                </div>
                <div className="font-medium text-slate-700">{formatCurrency(currentValue)}</div>
                <div className="space-y-1">
                  <div className={`font-semibold ${toneClass(todayProfit)}`}>{formatSignedCurrency(todayProfit)}</div>
                  <div className={`text-xs ${toneClass(todayProfit)}`}>{formatSignedPercent(item.today_estimated_return ?? item.today_return)}</div>
                </div>
                <div className="space-y-1">
                  <div className={`font-semibold ${toneClass(totalProfit)}`}>{formatSignedCurrency(totalProfit)}</div>
                  <div className={`text-xs ${toneClass(totalProfit)}`}>{formatSignedPercent(item.total_return)}</div>
                </div>
                <div className="text-slate-500">{proxyName}</div>
                <div className="flex items-center gap-2 text-slate-500">
                  <ArrowUpDown className="h-4 w-4 text-slate-300" />
                  {item.confidence_label || "—"}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">第 {props.page} / {props.pageCount} 页</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={props.onPrevPage}
            disabled={props.page <= 1}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            上一页
          </button>
          <button
            type="button"
            onClick={props.onNextPage}
            disabled={props.page >= props.pageCount}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            下一页
          </button>
        </div>
      </div>
    </section>
  );
}
