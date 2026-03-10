import { Camera, FileUp, Plus, Search, Trash2, UploadCloud, WandSparkles, X } from "lucide-react";
import type { FundCatalogItem, ImportTab, ManualRow } from "../types";
import { formatCurrency, formatSignedCurrency, normalizeFundCode, parseNumber } from "../lib/format";

interface ImportModalProps {
  open: boolean;
  importTab: ImportTab;
  rows: ManualRow[];
  suggestions: Record<number, FundCatalogItem[]>;
  focusedCode: string;
  status: string;
  pickerStatus: string;
  warnings: string[];
  onClose: () => void;
  onTabChange: (tab: ImportTab) => void;
  onRowChange: (index: number, field: keyof ManualRow, value: string) => void;
  onRowSearch: (index: number, query: string) => void;
  onAddRow: () => void;
  onResetRows: () => void;
  onDeleteRow: (index: number) => void;
  onPickSuggestion: (index: number, item: FundCatalogItem) => void;
  onConfirm: () => void;
  onUploadFile: (file: File) => void;
}

export function ImportModal(props: ImportModalProps) {
  if (!props.open) return null;

  const pendingRows = props.rows.filter((row) => row.status === "pending");
  const pendingAmount = pendingRows.reduce((sum, row) => sum + parseNumber(row.amount), 0);
  const pendingProfit = pendingRows.reduce((sum, row) => sum + parseNumber(row.profit), 0);
  const confirmCount = props.rows.filter((row) => normalizeFundCode(row.fundQuery) && parseNumber(row.amount) > 0).length;

  return (
    <div id="import-drawer" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm">
      <div className="w-full max-w-5xl overflow-hidden rounded-[28px] border border-white/20 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <div className="text-sm font-medium text-blue-600">导入我的持仓</div>
            <h3 className="mt-1 text-xl font-bold text-slate-900">按你的原型重做为双 Tab 工作流</h3>
          </div>
          <button type="button" onClick={props.onClose} className="rounded-2xl border border-slate-200 p-2 text-slate-500 hover:bg-slate-50">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex border-b border-slate-100 bg-slate-50 px-4 pt-4">
          {[
            ["manual", "手动搜索添加"],
            ["ocr", "截图智能识别"],
          ].map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              onClick={() => props.onTabChange(tab as ImportTab)}
              className={`rounded-t-2xl px-5 py-3 text-sm font-semibold transition ${props.importTab === tab ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              {label}
              {tab === "ocr" ? <span className="ml-2 rounded-full bg-gradient-to-r from-rose-500 to-fuchsia-500 px-2 py-0.5 text-[10px] text-white">AI</span> : null}
            </button>
          ))}
        </div>

        <div className="grid gap-0 lg:grid-cols-[1.6fr_0.9fr]">
          <div className="max-h-[70vh] overflow-y-auto p-6">
            {props.importTab === "manual" ? (
              <div className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-slate-500">所有导入来源都会先汇总到统一录入区，再集中确认。</div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={props.onAddRow} className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
                      <Plus className="h-4 w-4" />
                      新增一行
                    </button>
                    <button type="button" onClick={props.onResetRows} className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
                      重置
                    </button>
                  </div>
                </div>

                <div className="space-y-4">
                  {props.rows.map((row, index) => {
                    const code = normalizeFundCode(row.fundQuery);
                    const focused = props.focusedCode && props.focusedCode === code;
                    const currentSuggestions = props.suggestions[index] || [];
                    return (
                      <div key={`${index}-${code || row.fundQuery || "row"}`} className={`rounded-3xl border p-4 transition ${row.status === "pending" ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-slate-50"} ${focused ? "ring-2 ring-blue-200" : ""}`}>
                        <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr_1fr_auto]">
                          <label className="space-y-2 text-sm text-slate-600">
                            <span>基金代码或名称</span>
                            <div className="relative">
                              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
                              <input
                                value={row.fundQuery}
                                onChange={(event) => {
                                  props.onRowChange(index, "fundQuery", event.target.value);
                                  props.onRowSearch(index, event.target.value);
                                }}
                                className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-4 outline-none transition focus:border-blue-400"
                                placeholder="例如 005827 或 易方达蓝筹精选"
                              />
                              {currentSuggestions.length ? (
                                <div className="absolute z-10 mt-2 w-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">
                                  {currentSuggestions.map((item) => (
                                    <button key={item.fund_id} type="button" onClick={() => props.onPickSuggestion(index, item)} className="flex w-full items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-left text-sm first:border-t-0 hover:bg-blue-50">
                                      <span className="font-medium text-slate-800">{item.name}</span>
                                      <span className="text-xs text-slate-400">{item.fund_id}</span>
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                            <div className="text-xs text-slate-400">{row.fundName ? `${row.fundName}（${code || "待识别"}）` : "输入 2 个字符以上可自动搜索"}</div>
                          </label>

                          <label className="space-y-2 text-sm text-slate-600">
                            <span>持有金额</span>
                            <input value={row.amount} onChange={(event) => props.onRowChange(index, "amount", event.target.value)} type="number" step="0.01" className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-blue-400" placeholder="10000.00" />
                          </label>

                          <label className="space-y-2 text-sm text-slate-600">
                            <span>累计收益</span>
                            <input value={row.profit} onChange={(event) => props.onRowChange(index, "profit", event.target.value)} type="number" step="0.01" className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-blue-400" placeholder="+0.00 / -0.00" />
                          </label>

                          <div className="flex items-end">
                            <button type="button" onClick={() => props.onDeleteRow(index)} disabled={props.rows.length <= 1} className="inline-flex h-12 items-center gap-2 rounded-2xl border border-rose-200 bg-white px-4 text-sm font-medium text-rose-600 disabled:cursor-not-allowed disabled:opacity-50">
                              <Trash2 className="h-4 w-4" />
                              删除
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-[28px] border-2 border-dashed border-blue-300 bg-blue-50/70 px-8 py-16 text-center transition hover:bg-blue-50">
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) props.onUploadFile(file);
                      event.currentTarget.value = "";
                    }}
                  />
                  <div className="rounded-full border border-white bg-white p-4 shadow-sm">
                    <UploadCloud className="h-8 w-8 text-blue-500" />
                  </div>
                  <h4 className="mt-5 text-lg font-bold text-slate-800">点击上传或拖拽截图到此处</h4>
                  <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">支持支付宝、天天基金、同花顺等 App 持仓截图。识别完成后会自动回填到手动录入区。</p>
                  <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-medium text-blue-600 shadow-sm">
                    <Camera className="h-4 w-4" />
                    OCR 智能识别
                  </div>
                </label>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
                  <div className="flex items-center gap-2 font-medium text-slate-800">
                    <FileUp className="h-4 w-4 text-blue-500" />
                    识别状态
                  </div>
                  <p className="mt-3 leading-6">{props.pickerStatus || "上传截图后，这里会显示识别进度与结果摘要。"}</p>
                  {props.warnings.length ? (
                    <ul className="mt-3 space-y-2 text-xs text-amber-600">
                      {props.warnings.map((warning) => (
                        <li key={warning} className="rounded-2xl bg-amber-50 px-3 py-2">{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          <aside className="border-t border-slate-100 bg-slate-50 p-6 lg:border-l lg:border-t-0">
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-medium text-fuchsia-600">
                <WandSparkles className="h-4 w-4" />
                导入预览
              </div>
              <div className="mt-4 space-y-3 text-sm text-slate-600">
                <div className="rounded-2xl bg-slate-50 p-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-400">待确认基金</div>
                  <div className="mt-2 text-2xl font-bold text-slate-900">{pendingRows.length}</div>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-400">待确认金额</div>
                  <div className="mt-2 text-lg font-semibold text-slate-900">{formatCurrency(pendingAmount)}</div>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-400">待确认收益</div>
                  <div className="mt-2 text-lg font-semibold text-slate-900">{formatSignedCurrency(pendingProfit)}</div>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-500">
                {props.status || "确认导入后，会自动反推份额与成本净值，再同步到持仓总览。"}
              </div>

              <button type="button" onClick={props.onConfirm} className="mt-5 w-full rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-blue-700">
                确认导入（{confirmCount}）
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
