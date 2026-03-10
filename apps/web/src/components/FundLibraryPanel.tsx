import { LibraryBig, Plus, RefreshCcw, Search } from "lucide-react";
import type { FundCatalogItem } from "../types";
import { riskLevelLabel } from "../lib/format";

interface FundLibraryPanelProps {
  items: FundCatalogItem[];
  total: number;
  page: number;
  pageSize: number;
  query: string;
  loading: boolean;
  linkedCodes: string[];
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
  onPageSizeChange: (value: number) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onAddFund: (item: FundCatalogItem) => void;
}

export function FundLibraryPanel(props: FundLibraryPanelProps) {
  return (
    <section id="library-drawer" className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-blue-600">
            <LibraryBig className="h-4 w-4" />
            全市场基金库
          </div>
          <p className="mt-2 text-sm text-slate-500">支持检索真实基金池，并把基金直接加入导入清单。</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-w-72 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
            <Search className="h-4 w-4" />
            <input
              value={props.query}
              onChange={(event) => props.onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  props.onSearch();
                }
              }}
              className="w-full border-none bg-transparent text-slate-800 outline-none"
              placeholder="输入基金名称、代码或主题，如白酒 / 易方达"
            />
          </label>
          <button type="button" onClick={props.onSearch} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700">
            搜索
          </button>
          <button type="button" onClick={props.onRefresh} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            <RefreshCcw className="h-4 w-4" />
            重置
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
        <span id="catalog-count">共 {props.total} 只基金</span>
        <label className="rounded-xl border border-slate-200 bg-white px-3 py-2">
          <span className="mr-2">每页</span>
          <select
            id="catalog-page-size"
            value={props.pageSize}
            onChange={(event) => props.onPageSizeChange(Number(event.target.value))}
            className="border-none bg-transparent outline-none"
          >
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={30}>30</option>
          </select>
        </label>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200">
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_0.8fr_0.9fr] bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
          <span>基金</span>
          <span>分类</span>
          <span>主题</span>
          <span>风险</span>
          <span>净值</span>
          <span>操作</span>
        </div>

        {props.items.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-slate-500">{props.loading ? "正在加载基金库..." : "没有找到匹配的基金。"}</div>
        ) : (
          props.items.map((item) => {
            const linked = props.linkedCodes.includes(item.fund_id);
            return (
              <div key={item.fund_id} className={`grid grid-cols-[2fr_1fr_1fr_1fr_0.8fr_0.9fr] items-center border-t border-slate-100 px-4 py-4 text-sm ${linked ? "bg-blue-50/60" : "bg-white"}`}>
                <div>
                  <div className="font-semibold text-slate-800">{item.name}</div>
                  <div className="mt-1 text-xs text-slate-400">{item.fund_id}</div>
                </div>
                <span className="text-slate-600">{item.category || "—"}</span>
                <span className="text-slate-600">{item.theme || "—"}</span>
                <span className="text-slate-600">{riskLevelLabel(item.risk_level)}</span>
                <span className="text-slate-600">{item.latest_nav ? Number(item.latest_nav).toFixed(4) : "—"}</span>
                <div>
                  <button
                    type="button"
                    onClick={() => props.onAddFund(item)}
                    className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium ${linked ? "border border-blue-200 bg-blue-50 text-blue-600" : "border border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                  >
                    <Plus className="h-4 w-4" />
                    {linked ? "已在录入区" : "加入持仓"}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between text-sm text-slate-500">
        <span id="catalog-page">第 {props.page} 页</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={props.onPrevPage} disabled={props.page <= 1 || Boolean(props.query)} className="rounded-xl border border-slate-200 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50">
            上一页
          </button>
          <button type="button" onClick={props.onNextPage} disabled={Boolean(props.query) || props.items.length < props.pageSize} className="rounded-xl border border-slate-200 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50">
            下一页
          </button>
        </div>
      </div>
    </section>
  );
}
