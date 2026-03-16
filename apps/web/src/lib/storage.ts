import type { AiConfig, AppSettings, AssistantSession, ManualRow } from "../types";

export const STORAGE_KEYS = {
  manualRows: "fund-workbench-manual-rows",
  assistantQuestion: "fund-workbench-assistant-question",
  assistantSession: "fund-workbench-assistant-session",
  aiConfigs: "fund-workbench-ai-configs",
  estimateMode: "estimate_mode",
  holdingFirstSeenAt: "fund-workbench-holding-first-seen-at",
  appSettings: "fundsight-app-settings",
  lastActiveTab: "fundsight-last-active-tab",
  fundThemeOverrides: "fundsight-fund-theme-overrides-v1",
} as const;

export const DEFAULT_ROWS: ManualRow[] = [
  { fundQuery: "005827", fundName: "易方达蓝筹精选混合", amount: "3109.64", profit: "65.62", status: "confirmed", source: "manual" },
  { fundQuery: "161725", fundName: "招商中证白酒指数(LOF)A", amount: "1595.04", profit: "24.24", status: "confirmed", source: "manual" },
  { fundQuery: "002190", fundName: "农银新能源主题A", amount: "2416.96", profit: "-13.44", status: "confirmed", source: "manual" },
];

export const EMPTY_ROW = (): ManualRow => ({
  fundQuery: "",
  fundName: "",
  amount: "",
  profit: "",
  status: "draft",
  source: "manual",
});

function createDefaultConfig(): AiConfig {
  return {
    id: crypto.randomUUID(),
    name: "默认模型",
    endpoint: "https://api.example.com/v1",
    apiKey: "",
    active: true,
  };
}

export function restoreManualRows(): ManualRow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.manualRows);
    if (!raw) return [EMPTY_ROW()];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [EMPTY_ROW()];
    return parsed.map((row) => ({
      fundQuery: String(row.fundQuery ?? ""),
      fundName: String(row.fundName ?? ""),
      amount: String(row.amount ?? ""),
      profit: String(row.profit ?? ""),
      status: row.status === "confirmed" || row.status === "pending" ? row.status : "draft",
      source: row.source === "ocr" || row.source === "library" ? row.source : "manual",
    }));
  } catch {
    return [EMPTY_ROW()];
  }
}

export function saveManualRows(rows: ManualRow[]): void {
  localStorage.setItem(STORAGE_KEYS.manualRows, JSON.stringify(rows));
}

export function restoreAssistantQuestion(): string {
  return localStorage.getItem(STORAGE_KEYS.assistantQuestion) || "为什么最近会跌？接下来什么时候更适合卖？";
}

export function saveAssistantQuestion(value: string): void {
  localStorage.setItem(STORAGE_KEYS.assistantQuestion, value);
}

export function restoreAssistantSession(): AssistantSession {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.assistantSession);
    if (!raw) {
      return { fundId: "", fundName: "", currentQuestion: "", previousQuestion: "", summary: "", timestamp: "" };
    }
    return JSON.parse(raw) as AssistantSession;
  } catch {
    return { fundId: "", fundName: "", currentQuestion: "", previousQuestion: "", summary: "", timestamp: "" };
  }
}

export function saveAssistantSession(value: AssistantSession): void {
  localStorage.setItem(STORAGE_KEYS.assistantSession, JSON.stringify(value));
}

export function restoreAiConfigs(): AiConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.aiConfigs);
    if (!raw) return [createDefaultConfig()];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [createDefaultConfig()];
    const normalized = parsed.map((item) => ({
      id: String(item.id ?? crypto.randomUUID()),
      name: String(item.name ?? "未命名配置"),
      endpoint: String(item.endpoint ?? ""),
      apiKey: String(item.apiKey ?? ""),
      active: Boolean(item.active),
    }));
    if (!normalized.some((item) => item.active)) normalized[0].active = true;
    return normalized;
  } catch {
    return [createDefaultConfig()];
  }
}

export function saveAiConfigs(configs: AiConfig[]): void {
  localStorage.setItem(STORAGE_KEYS.aiConfigs, JSON.stringify(configs));
}

export function restoreEstimateMode(): "auto" | "official" | "penetration" {
  const raw = localStorage.getItem(STORAGE_KEYS.estimateMode);
  if (raw === "official" || raw === "penetration" || raw === "auto") {
    return raw;
  }
  return "auto";
}

export function saveEstimateMode(value: "auto" | "official" | "penetration"): void {
  localStorage.setItem(STORAGE_KEYS.estimateMode, value);
}

export function restoreHoldingFirstSeenAt(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.holdingFirstSeenAt);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};

    const result: Record<string, number> = {};
    for (const [fundId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const timestamp = Number(value);
      if (!fundId) continue;
      if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
      result[fundId] = timestamp;
    }
    return result;
  } catch {
    return {};
  }
}

export function saveHoldingFirstSeenAt(value: Record<string, number>): void {
  localStorage.setItem(STORAGE_KEYS.holdingFirstSeenAt, JSON.stringify(value));
}

export function restoreAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.appSettings);
    if (!raw) {
      return {
        accent: "blue",
        theme_mode: "system",
        font_scale: 1,
        startup_tab: "last",
        check_updates_on_startup: true,
      };
    }

    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const accent = parsed.accent === "purple" || parsed.accent === "emerald" || parsed.accent === "blue" ? parsed.accent : "blue";
    const theme_mode = parsed.theme_mode === "light" || parsed.theme_mode === "dark" || parsed.theme_mode === "system" ? parsed.theme_mode : "system";
    const font_scale = parsed.font_scale === 0.9 || parsed.font_scale === 1 || parsed.font_scale === 1.1 ? parsed.font_scale : 1;
    const startup_tab = parsed.startup_tab === "portfolio" || parsed.startup_tab === "watchlist" || parsed.startup_tab === "library" || parsed.startup_tab === "config" || parsed.startup_tab === "last" ? parsed.startup_tab : "last";

    return {
      accent,
      theme_mode,
      font_scale,
      startup_tab,
      check_updates_on_startup: Boolean(parsed.check_updates_on_startup ?? true),
    };
  } catch {
    return {
      accent: "blue",
      theme_mode: "system",
      font_scale: 1,
      startup_tab: "last",
      check_updates_on_startup: true,
    };
  }
}

export function saveAppSettings(value: AppSettings): void {
  localStorage.setItem(STORAGE_KEYS.appSettings, JSON.stringify(value));
}

export function restoreLastActiveTab(): "portfolio" | "watchlist" | "library" | "config" {
  const raw = (localStorage.getItem(STORAGE_KEYS.lastActiveTab) || "").trim();
  if (raw === "portfolio" || raw === "watchlist" || raw === "library" || raw === "config") return raw;
  return "portfolio";
}

export function saveLastActiveTab(value: "portfolio" | "watchlist" | "library" | "config"): void {
  localStorage.setItem(STORAGE_KEYS.lastActiveTab, value);
}

export function restoreFundThemeOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.fundThemeOverrides);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};

    const out: Record<string, string> = {};
    for (const [fundId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const cleanId = String(fundId || "").trim();
      if (!/^\d{6}$/.test(cleanId)) continue;
      const cleanTheme = String(value ?? "").trim();
      if (!cleanTheme) continue;
      out[cleanId] = cleanTheme;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveFundThemeOverrides(value: Record<string, string>): void {
  // Store only non-empty overrides.
  const out: Record<string, string> = {};
  for (const [fundId, theme] of Object.entries(value || {})) {
    const cleanId = String(fundId || "").trim();
    if (!/^\d{6}$/.test(cleanId)) continue;
    const cleanTheme = String(theme ?? "").trim();
    if (!cleanTheme) continue;
    out[cleanId] = cleanTheme;
  }
  localStorage.setItem(STORAGE_KEYS.fundThemeOverrides, JSON.stringify(out));
}
