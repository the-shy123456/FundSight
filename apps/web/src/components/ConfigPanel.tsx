import { CheckCircle2, PencilLine, Settings2, Trash2 } from "lucide-react";
import type { AiConfig } from "../types";

interface ConfigPanelProps {
  configs: AiConfig[];
  form: { id: string; name: string; endpoint: string; apiKey: string };
  onFormChange: (field: "name" | "endpoint" | "apiKey", value: string) => void;
  onSubmit: () => void;
  onReset: () => void;
  onActivate: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ConfigPanel(props: ConfigPanelProps) {
  return (
    <section id="config-drawer" className="grid gap-5 xl:grid-cols-[1.1fr_1fr]">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-medium text-blue-600">
          <Settings2 className="h-4 w-4" />
          AI 模型配置列表
        </div>
        <p className="mt-2 text-sm text-slate-500">当前仍是本地保存模式，方便你先切换不同模型配置草案。</p>

        <div id="model-config-list" className="mt-6 space-y-3">
          {props.configs.map((config) => (
            <article key={config.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-800">{config.name}</h3>
                  <p className="mt-1 text-sm text-slate-500">{config.endpoint || "未填写端点"}</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${config.active ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}>
                  {config.active ? "当前启用" : "未启用"}
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-sm">
                <button type="button" onClick={() => props.onActivate(config.id)} className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 font-medium text-emerald-600">
                  <CheckCircle2 className="h-4 w-4" />
                  设为当前
                </button>
                <button type="button" onClick={() => props.onEdit(config.id)} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 font-medium text-slate-600 hover:bg-white">
                  <PencilLine className="h-4 w-4" />
                  编辑
                </button>
                <button type="button" onClick={() => props.onDelete(config.id)} className="inline-flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 font-medium text-rose-600">
                  <Trash2 className="h-4 w-4" />
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-sm font-medium text-blue-600">配置编辑器</div>
        <h3 className="mt-2 text-xl font-bold text-slate-900">保存一个新的模型接入配置</h3>
        <p className="mt-2 text-sm text-slate-500">当前仅做本地持久化，方便后续接真实模型供应商时平滑扩展。</p>

        <form
          id="model-config-form"
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit();
          }}
        >
          <label className="block space-y-2 text-sm text-slate-600">
            <span>配置名称</span>
            <input id="model-config-name" value={props.form.name} onChange={(event) => props.onFormChange("name", event.target.value)} className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none ring-0 transition focus:border-blue-400" placeholder="例如：OpenAI 主配置" />
          </label>
          <label className="block space-y-2 text-sm text-slate-600">
            <span>API 端点</span>
            <input id="model-config-endpoint" value={props.form.endpoint} onChange={(event) => props.onFormChange("endpoint", event.target.value)} className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none ring-0 transition focus:border-blue-400" placeholder="https://api.example.com/v1" />
          </label>
          <label className="block space-y-2 text-sm text-slate-600">
            <span>API Key</span>
            <input id="model-config-key" value={props.form.apiKey} onChange={(event) => props.onFormChange("apiKey", event.target.value)} className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none ring-0 transition focus:border-blue-400" placeholder="sk-..." />
          </label>

          <div className="flex flex-wrap gap-3 pt-2">
            <button id="model-config-save" type="submit" className="rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-blue-700">
              保存配置
            </button>
            <button type="button" onClick={props.onReset} className="rounded-2xl border border-slate-200 px-5 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50">
              清空表单
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
