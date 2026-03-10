import { Bot, BrainCircuit, MessageSquareMore, Sparkles } from "lucide-react";
import type { AssistantResponse, PortfolioPosition } from "../types";

interface AssistantPanelProps {
  positions: PortfolioPosition[];
  selectedFundId: string;
  question: string;
  followupQuestion: string;
  loading: boolean;
  response: AssistantResponse | null;
  lastQuestion: string;
  previousQuestion: string;
  timestamp: string;
  onFundChange: (value: string) => void;
  onQuestionChange: (value: string) => void;
  onFollowupChange: (value: string) => void;
  onQuickQuestion: (value: string) => void;
  onSubmit: () => void;
  onFollowupSubmit: () => void;
}

const QUICK_QUESTIONS = [
  "为什么最近会跌？接下来什么时候更适合卖？",
  "如果我下周继续拿着，这只基金更像震荡还是趋势延续？",
  "结合当前成本和收益，我是继续持有还是分批止盈？",
];

const FOLLOWUP_TEMPLATES = [
  "结合刚才的判断，这只基金更适合继续持有还是分批止盈？",
  "如果我下周继续拿着，这只基金更像震荡还是趋势延续？",
  "结合刚才的风险提示，我应该怎么控制仓位？",
];

export function AssistantPanel(props: AssistantPanelProps) {
  return (
    <section id="assistant-section" className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-blue-600">
            <BrainCircuit className="h-4 w-4" />
            AI 持仓助手
          </div>
          <p className="mt-2 text-sm text-slate-500">根据持仓状态、盘中估算、主题风险和上下文追问生成建议。</p>
        </div>
        <div className="rounded-2xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-600">支持连续追问</div>
      </div>

      <div className="space-y-3">
        <label className="block space-y-2 text-sm text-slate-600">
          <span>选择基金</span>
          <select value={props.selectedFundId} onChange={(event) => props.onFundChange(event.target.value)} className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-blue-400">
            {props.positions.length === 0 ? <option value="">暂无持仓</option> : null}
            {props.positions.map((item) => (
              <option key={item.fund_id} value={item.fund_id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-2 text-sm text-slate-600">
          <span>当前问题</span>
          <textarea value={props.question} onChange={(event) => props.onQuestionChange(event.target.value)} rows={4} className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-blue-400" placeholder="例如：这只基金接下来一周适合继续持有吗？" />
        </label>
        <div className="flex flex-wrap gap-2">
          {QUICK_QUESTIONS.map((question) => (
            <button key={question} type="button" onClick={() => props.onQuickQuestion(question)} className="rounded-full border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600">
              {question}
            </button>
          ))}
        </div>
        <button type="button" onClick={props.onSubmit} disabled={props.loading} className="inline-flex items-center gap-2 rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60">
          <Bot className="h-4 w-4" />
          {props.loading ? "AI 分析中..." : "开始分析"}
        </button>
      </div>

      {props.response ? (
        <div id="assistant-result" className="space-y-4 rounded-3xl border border-slate-200 bg-slate-50 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-medium text-blue-600">当前结论</p>
              <h3 className="mt-2 text-2xl font-bold text-slate-900">{props.response.fund?.name || "持仓基金"}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{props.response.summary || "暂无结论"}</p>
            </div>
            <div className="rounded-2xl border border-white bg-white px-4 py-3 text-right shadow-sm">
              <div className="text-xs text-slate-400">置信度</div>
              <div className="mt-1 text-lg font-semibold text-slate-900">{Math.round((props.response.confidence?.score || 0) * 100)}%</div>
              <div className="text-xs text-slate-500">{props.response.confidence?.label || "样例推理"}</div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="text-xs uppercase tracking-[0.16em] text-slate-400">当前问题</div>
              <div className="mt-2 text-sm font-medium text-slate-700">{props.lastQuestion || "—"}</div>
            </div>
            <div className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="text-xs uppercase tracking-[0.16em] text-slate-400">上一次问题</div>
              <div className="mt-2 text-sm font-medium text-slate-700">{props.previousQuestion || "—"}</div>
            </div>
            <div className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="text-xs uppercase tracking-[0.16em] text-slate-400">更新时间</div>
              <div className="mt-2 text-sm font-medium text-slate-700">{props.timestamp || "—"}</div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <article className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
                <Sparkles className="h-4 w-4 text-blue-500" />
                为什么会这样
              </div>
              <ul className="mt-4 space-y-3 text-sm text-slate-600">
                {(props.response.evidence || []).map((item) => (
                  <li key={`${item.label}-${item.value}`} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                    <div className="font-medium text-slate-800">{item.label} · {item.value}</div>
                    <div className="mt-1 leading-6">{item.detail}</div>
                  </li>
                ))}
              </ul>
            </article>

            <article className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
                <MessageSquareMore className="h-4 w-4 text-blue-500" />
                建议动作
              </div>
              <ul className="mt-4 space-y-3 text-sm text-slate-600">
                {(props.response.actions || []).map((item) => (
                  <li key={`${item.title}-${item.fit}`} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                    <div className="font-medium text-slate-800">{item.title} · 匹配度 {item.fit}</div>
                    <div className="mt-1 leading-6">{item.detail}</div>
                  </li>
                ))}
              </ul>
            </article>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <article className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="text-sm font-medium text-slate-800">情景预测</div>
              <ul className="mt-4 space-y-3 text-sm text-slate-600">
                {(props.response.scenarios || []).map((item) => (
                  <li key={item.name} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                    <div className="font-medium text-slate-800">{item.name}</div>
                    <div className="mt-1">条件：{item.condition}</div>
                    <div className="mt-1">影响：{item.impact}</div>
                  </li>
                ))}
              </ul>
            </article>

            <article className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="text-sm font-medium text-slate-800">风险提示</div>
              <ul className="mt-4 space-y-3 text-sm text-slate-600">
                {(props.response.risks || []).map((risk) => (
                  <li key={risk} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                    {risk}
                  </li>
                ))}
              </ul>
            </article>
          </div>

          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="text-sm font-medium text-slate-800">继续追问</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {FOLLOWUP_TEMPLATES.map((question) => (
                <button key={question} type="button" onClick={() => props.onFollowupChange(question)} className="rounded-full border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600">
                  {question}
                </button>
              ))}
            </div>
            <textarea value={props.followupQuestion} onChange={(event) => props.onFollowupChange(event.target.value)} rows={3} className="mt-4 w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-blue-400" placeholder="继续追问：例如，我应该分几次卖出？" />
            <button type="button" onClick={props.onFollowupSubmit} disabled={props.loading} className="mt-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-600 disabled:cursor-not-allowed disabled:opacity-60">
              继续追问
            </button>
            {props.response.disclaimer ? <p className="mt-3 text-xs leading-5 text-slate-400">{props.response.disclaimer}</p> : null}
          </div>
        </div>
      ) : (
        <div id="assistant-result" className="rounded-3xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center text-sm text-slate-500">
          {props.loading ? "AI 正在分析当前持仓和问题上下文..." : "先导入持仓，再开始分析。"}
        </div>
      )}
    </section>
  );
}
