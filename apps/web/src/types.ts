export type ViewTab = "portfolio" | "library" | "config";
export type ImportTab = "manual" | "ocr";
export type HoldingSortKey = "name" | "todayProfit" | "totalProfit";
export type HoldingFilter = "all" | "profit" | "loss";

export interface ManualRow {
  fundQuery: string;
  fundName: string;
  amount: string;
  profit: string;
  status: "draft" | "pending" | "confirmed";
  source: "manual" | "ocr" | "library";
}

export interface AiConfig {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  active: boolean;
}

export interface AssistantSession {
  fundId: string;
  fundName: string;
  currentQuestion: string;
  previousQuestion: string;
  summary: string;
  timestamp: string;
}

export interface ConfidenceValue {
  score?: number;
  label?: string;
  reason?: string;
}

export interface DataQualitySummary {
  holding_count?: number;
  real_data_holding_count?: number;
  proxy_holding_count?: number;
  latest_estimate_as_of?: string;
  display_estimate_source_label?: string;
}

export interface PortfolioPosition {
  fund_id: string;
  name: string;
  name_display?: string;
  category?: string;
  theme?: string;
  risk_level?: string;
  current_value?: number;
  market_value?: number;
  total_pnl?: number;
  total_profit?: number;
  total_return?: number;
  today_estimated_pnl?: number;
  today_profit?: number;
  today_estimated_return?: number;
  today_return?: number;
  confidence?: ConfidenceValue;
  confidence_label?: string;
  proxy?: string | { name?: string };
  proxy_note?: string;
  signal?: { label?: string; reason?: string };
  estimate_source?: string;
  estimate_source_label?: string;
  display_estimate_source_label?: string;
  estimate_scope_label?: string;
  estimate_as_of?: string;
  holdings_disclosure_date?: string;
  is_real_data?: boolean;
  estimate_disclaimer?: string;
  official_estimated_nav?: number;
  official_estimated_return?: number;
}

export interface PortfolioSnapshot {
  as_of?: string;
  summary?: {
    holding_count?: number;
    current_value?: number;
    market_value?: number;
    today_estimated_pnl?: number;
    today_profit?: number;
    today_return?: number;
    today_estimated_return?: number;
    total_pnl?: number;
    total_profit?: number;
    total_return?: number;
    highest_exposure?: {
      name?: string;
      weight?: number;
    };
    data_quality?: DataQualitySummary;
  };
  positions?: PortfolioPosition[];
  signals?: string[];
  disclaimer?: string;
  data_quality?: DataQualitySummary;
}

export interface IntradayContribution {
  fund_id: string;
  name: string;
  name_display?: string;
  theme?: string;
  today_estimated_pnl?: number;
  confidence_label?: string;
  weight?: number;
  estimate_source_label?: string;
  estimate_as_of?: string;
  is_real_data?: boolean;
}

export interface PortfolioIntraday {
  chart?: {
    labels?: string[];
    series?: Array<{ name: string; values: number[] }>;
  };
  contributions?: IntradayContribution[];
  disclaimer?: string;
}

export interface IntradayEstimate {
  estimated_nav?: number;
  latest_nav?: number;
  estimate_mode?: string;
  display_estimate_source_label?: string;
  estimate_as_of?: string;
  holdings_disclosure_date?: string;
  disclosed_weight_ratio?: number;
  stock_position_ratio?: number;
}

export interface FundCatalogItem {
  fund_id: string;
  name: string;
  name_display?: string;
  category?: string;
  theme?: string;
  risk_level?: string;
  latest_nav?: number;
}

export interface FundCatalogResponse {
  items: FundCatalogItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface NavTrendPoint {
  x: number;
  date: string;
  nav: number;
}

export interface NavTrendResponse {
  fund_id: string;
  range: "1m" | "3m" | "6m" | "1y" | "all";
  points: NavTrendPoint[];
}

export interface HoldingCompanyItem {
  code: string;
  name: string;
  industry?: string;
  weight_percent: number;
  price: number;
  change_rate: number;
  contribution: number;
}

export interface TopHoldingsResponse {
  disclosure_date: string;
  items: HoldingCompanyItem[];
}

export interface Forecast {
  horizon_trading_days?: number;
  direction?: "up" | "down";
  probability_up?: number;
  rationale?: string[];
  evidence_refs?: string[];
}

export interface AssistantHolding {
  current_value?: number;
  total_pnl?: number;
  today_estimated_pnl?: number;
}

export interface AnnouncementItem {
  date?: string;
  title?: string;
  type?: string;
  url?: string;
  pdf_url?: string;
}

export interface AssistantPerFund {
  fund_id: string;
  name?: string;
  name_display?: string;
  holding?: AssistantHolding;
  forecast?: Forecast;
  suggestion?: string;
  evidence?: Array<{ label: string; value: string; detail: string }>;
  announcement_evidence?: { label?: string; value?: string; detail?: string };
  announcements?: AnnouncementItem[];
}

export interface AssistantPortfolioMeta {
  holding_count?: number;
  horizon_trading_days?: number;
  estimate_mode?: string;
}

export interface AssistantResponse {
  fund?: { fund_id?: string; name?: string; theme?: string; risk_label?: string };
  summary?: string;
  evidence?: Array<{ label: string; value: string; detail: string }>;
  actions?: Array<{ title: string; fit: string; detail: string }>;
  scenarios?: Array<{ name: string; condition: string; impact: string }>;
  risks?: string[];
  forecast?: Forecast;
  confidence?: { score?: number; label?: string; reason?: string };
  disclaimer?: string;
  portfolio?: AssistantPortfolioMeta;
  per_fund?: AssistantPerFund[];
  portfolio_actions?: string[];
  announcements?: AnnouncementItem[];
}

export interface OcrResponse {
  suggestions?: Array<{
    fundQuery?: string;
    fundName?: string;
    amount?: string;
    profit?: string;
  }>;
  warnings?: string[];
}
