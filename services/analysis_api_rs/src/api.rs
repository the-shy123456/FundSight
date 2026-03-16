use crate::{announcements, assistant, funds, holdings, nav, portfolio, real_data, theme, top_holdings, watchlist};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
pub struct EstimateModeQuery {
    pub estimate_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AnnouncementsQuery {
    pub page_index: Option<usize>,
    pub page_size: Option<usize>,

    #[serde(rename = "type")]
    pub notice_type: Option<String>,
}

fn bad_request(message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({ "message": message.into() })))
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/portfolio", get(get_portfolio))
        .route("/api/v1/portfolio/intraday", get(get_portfolio_intraday))
        .route("/api/v1/holdings/import", post(post_holdings_import))
        .route("/api/v1/holdings/ocr", post(post_holdings_ocr))
        .route("/api/v1/holdings", delete(delete_holdings_all))
        .route("/api/v1/holdings/{fund_id}", delete(delete_holding_id))
        .route("/api/v1/assistant/ask", post(post_assistant_ask))
        .route(
            "/api/v1/watchlist",
            get(get_watchlist)
                .post(post_watchlist)
                .delete(delete_watchlist_all),
        )
        .route("/api/v1/watchlist/intraday", get(get_watchlist_intraday))
        .route("/api/v1/watchlist/{fund_id}", delete(delete_watchlist_id))
        .route("/api/v1/funds", get(get_funds_catalog))
        .route("/api/v1/funds/search", get(get_funds_search))
        .route("/api/v1/funds/{fund_id}/nav-trend", get(get_nav_trend))
        .route("/api/v1/funds/{fund_id}/top-holdings", get(get_top_holdings))
        .route("/api/v1/funds/{fund_id}/announcements", get(get_fund_announcements))
        .route(
            "/api/v1/funds/{fund_id}/intraday-estimate",
            get(get_intraday_estimate),
        )
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "status": "ok", "service": "analysis_api_rs" })))
}

async fn get_portfolio(
    State(state): State<Arc<AppState>>,
    Query(_q): Query<EstimateModeQuery>,
) -> impl IntoResponse {
    let holdings = holdings::load_holdings();
    match portfolio::build_portfolio_snapshot(&state.http, &holdings).await {
        Ok(payload) => (StatusCode::OK, Json(payload)).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response(),
    }
}

async fn get_portfolio_intraday(
    State(state): State<Arc<AppState>>,
    Query(_q): Query<EstimateModeQuery>,
) -> impl IntoResponse {
    let active = holdings::load_holdings();
    if active.is_empty() {
        return (
            StatusCode::OK,
            Json(json!({
                "chart": {"labels": [], "series": []},
                "contributions": [],
                "disclaimer": "暂无持仓，无法生成盘中贡献图。"
            })),
        );
    }

    let labels = vec!["昨收", "当前"];

    let mut contributions: Vec<Value> = vec![];
    let mut previous_total = 0.0f64;
    let mut today_total_pnl = 0.0f64;

    // First pass: compute totals.
    let mut rows: Vec<(holdings::HoldingLot, Value)> = vec![];
    for lot in active.iter().cloned() {
        match real_data::fetch_fund_estimate(&state.http, &lot.fund_id).await {
            Ok(estimate) => {
                let latest_nav = estimate
                    .get("latest_nav")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                let estimated_nav = estimate
                    .get("estimated_nav")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(latest_nav);
                let previous_value = lot.shares * latest_nav;
                let current_value = lot.shares * estimated_nav;
                previous_total += previous_value;
                today_total_pnl += current_value - previous_value;
                rows.push((lot, estimate));
            }
            Err(_) => continue,
        }
    }

    if previous_total <= 0.0 {
        return (
            StatusCode::OK,
            Json(json!({
                "chart": {"labels": labels, "series": []},
                "contributions": [],
                "disclaimer": "持仓数据异常，无法生成盘中贡献图。"
            })),
        );
    }

    // Second pass: build contributions.
    for (lot, estimate) in rows {
        let name = estimate
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(lot.fund_id.as_str())
            .to_string();
        let latest_nav = estimate
            .get("latest_nav")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let estimated_nav = estimate
            .get("estimated_nav")
            .and_then(|v| v.as_f64())
            .unwrap_or(latest_nav);
        let estimate_as_of = estimate
            .get("estimate_as_of")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let estimated_return = estimate
            .get("estimated_return")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);

        let previous_value = lot.shares * latest_nav;
        let current_value = lot.shares * estimated_nav;
        let today_estimated_pnl = current_value - previous_value;
        let weight = previous_value / previous_total;

        let confidence_label = if estimated_return.abs() >= 0.012 {
            "高"
        } else if estimated_return.abs() >= 0.006 {
            "中"
        } else {
            "低"
        };

        let inferred = theme::infer_themes(&state.http, &lot.fund_id, &name).await;
        contributions.push(json!({
            "fund_id": lot.fund_id,
            "name": name,
            "name_display": name,
            "theme": inferred.theme,
            "themes": inferred.themes,
            "today_estimated_pnl": (today_estimated_pnl * 100.0).round() / 100.0,
            "confidence_label": confidence_label,
            "weight": (weight * 10000.0).round() / 10000.0,
            "estimate_source_label": "官方估值",
            "estimate_as_of": estimate_as_of,
            "is_real_data": true,
        }));
    }

    contributions.sort_by(|a, b| {
        let av = a
            .get("today_estimated_pnl")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .abs();
        let bv = b
            .get("today_estimated_pnl")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .abs();
        bv.partial_cmp(&av)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let portfolio_return = today_total_pnl / previous_total;
    let return_series = vec![0.0, (portfolio_return * 10000.0).round() / 10000.0];
    let pnl_series = vec![0.0, (today_total_pnl * 100.0).round() / 100.0];

    let chart = json!({
        "labels": labels,
        "series": [
            {"name": "组合盘中估算收益率", "values": return_series},
            {"name": "昨日净值基准", "values": vec![0.0, 0.0]},
        ],
        "unit": "return"
    });

    (
        StatusCode::OK,
        Json(json!({
            "estimate_mode": "official",
            "chart": chart,
            "contributions": contributions,
            "estimated_pnl_series": pnl_series,
            "estimated_return_series": return_series,
            "disclaimer": "组合盘中曲线基于官方实时估值聚合生成，适合观察盘中节奏，不替代基金公司最终净值。",
        })),
    )
}

async fn post_holdings_import(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    match holdings::parse_holdings_payload(&payload) {
        Ok(next) => {
            if let Err(error) = holdings::save_holdings(&next) {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "message": error.to_string() })),
                )
                    .into_response();
            }
            match portfolio::build_portfolio_snapshot(&state.http, &next).await {
                Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
                Err(error) => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "message": error.to_string() })),
                )
                    .into_response(),
            }
        }
        Err(error) => bad_request(error.to_string()).into_response(),
    }
}

async fn delete_holdings_all(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let next: Vec<holdings::HoldingLot> = vec![];
    if let Err(error) = holdings::save_holdings(&next) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response();
    }

    match portfolio::build_portfolio_snapshot(&state.http, &next).await {
        Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response(),
    }
}

async fn delete_holding_id(
    State(state): State<Arc<AppState>>,
    Path(fund_id): Path<String>,
) -> impl IntoResponse {
    let clean_id = fund_id.trim();
    if clean_id.is_empty() {
        return bad_request("fund_id 不能为空").into_response();
    }

    let current = holdings::load_holdings();
    let next: Vec<holdings::HoldingLot> = current
        .into_iter()
        .filter(|item| item.fund_id.trim() != clean_id)
        .collect();

    if let Err(error) = holdings::save_holdings(&next) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response();
    }

    match portfolio::build_portfolio_snapshot(&state.http, &next).await {
        Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct HoldingsOcrRequest {
    #[serde(default)]
    image_base64: String,
}

async fn post_holdings_ocr(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<HoldingsOcrRequest>,
) -> impl IntoResponse {
    let raw = payload.image_base64.trim();
    if raw.is_empty() {
        return bad_request("image_base64 不能为空").into_response();
    }

    let b64 = if raw.starts_with("data:") {
        raw.split_once("base64,").map(|(_, b)| b).unwrap_or("")
    } else {
        raw
    };

    let bytes = match BASE64.decode(b64) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::OK,
                Json(json!({
                    "suggestions": [],
                    "warnings": ["图片解码失败：请重新截图或换一张更清晰的图片。"],
                })),
            )
                .into_response();
        }
    };

    // Experimental: allow feeding plain-text CSV as "image" for fast iteration.
    let text = match String::from_utf8(bytes) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::OK,
                Json(json!({
                    "suggestions": [],
                    "warnings": ["当前版本 OCR 仍在迁移中（Windows 原生 OCR 待接入）。"],
                })),
            )
                .into_response();
        }
    };

    if !text.contains(',') {
        return (
            StatusCode::OK,
            Json(json!({
                "suggestions": [],
                "warnings": ["当前版本 OCR 仍在迁移中（Windows 原生 OCR 待接入）。"],
            })),
        )
            .into_response();
    }

    let lots = match holdings::parse_holdings_text(&text) {
        Ok(v) => v,
        Err(error) => {
            return (
                StatusCode::OK,
                Json(json!({
                    "suggestions": [],
                    "warnings": [format!("OCR 解析失败：{error}")],
                })),
            )
                .into_response();
        }
    };

    let mut suggestions: Vec<Value> = vec![];

    for lot in lots {
        let estimate = match real_data::fetch_fund_estimate(&state.http, &lot.fund_id).await {
            Ok(v) => v,
            Err(_) => json!({"name": lot.fund_id, "estimated_nav": 0.0, "latest_nav": 0.0}),
        };

        let name = estimate
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(lot.fund_id.as_str());
        let nav = estimate
            .get("estimated_nav")
            .and_then(|v| v.as_f64())
            .or_else(|| estimate.get("latest_nav").and_then(|v| v.as_f64()))
            .unwrap_or(0.0);

        if nav <= 0.0 {
            continue;
        }

        let amount = lot.shares * nav;
        let cost_basis = lot.shares * lot.unit_cost;
        let profit = amount - cost_basis;

        suggestions.push(json!({
            "fundQuery": lot.fund_id,
            "fundName": name,
            "amount": format!("{:.2}", amount),
            "profit": format!("{:.2}", profit),
        }));
    }

    (
        StatusCode::OK,
        Json(json!({
            "suggestions": suggestions,
            "warnings": if suggestions.is_empty() {
                vec!["未能解析到有效基金行（请检查格式 fund_id,shares,unit_cost）。".to_string()]
            } else {
                Vec::<String>::new()
            },
        })),
    )
        .into_response()
}

async fn post_assistant_ask(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    match assistant::ask(&state.http, &payload).await {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => {
            let message = error.to_string();
            let status = if message.contains("不能为空")
                || message.contains("格式")
                || message.contains("请先")
                || message.contains("不支持")
            {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::BAD_GATEWAY
            };
            (status, Json(json!({ "message": message }))).into_response()
        }
    }
}

async fn get_watchlist(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let store = watchlist::load_watchlist();
    let ids = watchlist::normalized_items(&store.items);

    let mut items: Vec<Value> = vec![];
    for fund_id in ids {
        // Use official estimate endpoint to resolve name.
        let name = match real_data::fetch_fund_estimate(&state.http, &fund_id).await {
            Ok(estimate) => estimate
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&fund_id)
                .to_string(),
            Err(_) => fund_id.clone(),
        };

        let inferred = theme::infer_themes(&state.http, &fund_id, &name).await;
        items.push(json!({
            "fund_id": fund_id,
            "name": name,
            "name_display": name,
            "theme": inferred.theme,
            "themes": inferred.themes,
            "risk_level": "",
        }));
    }

    (StatusCode::OK, Json(json!({ "items": items, "total": items.len() })))
}

#[derive(Debug, Deserialize)]
struct WatchlistAddBody {
    fund_id: String,
}

async fn post_watchlist(Json(body): Json<WatchlistAddBody>) -> impl IntoResponse {
    match watchlist::add_watchlist_id(&body.fund_id) {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({ "added": true, "fund_id": body.fund_id })),
        )
            .into_response(),
        Err(error) => bad_request(error.to_string()).into_response(),
    }
}

async fn delete_watchlist_id(Path(fund_id): Path<String>) -> impl IntoResponse {
    match watchlist::remove_watchlist_id(&fund_id) {
        Ok(_) => (StatusCode::OK, Json(json!({ "deleted": true }))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response(),
    }
}

async fn delete_watchlist_all() -> impl IntoResponse {
    match watchlist::save_watchlist(&[]) {
        Ok(_) => (StatusCode::OK, Json(json!({ "deleted": true, "total": 0 }))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response(),
    }
}

async fn get_watchlist_intraday(
    State(state): State<Arc<AppState>>,
    Query(_q): Query<EstimateModeQuery>,
) -> impl IntoResponse {
    let store = watchlist::load_watchlist();
    let ids = watchlist::normalized_items(&store.items);

    let mut items: Vec<Value> = vec![];
    for fund_id in ids {
        match real_data::fetch_fund_estimate(&state.http, &fund_id).await {
            Ok(estimate) => {
                let name = estimate
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&fund_id);
                let estimated_return = estimate
                    .get("estimated_return")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                let latest_nav = estimate
                    .get("latest_nav")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                let inferred = theme::infer_themes(&state.http, &fund_id, name).await;
                items.push(json!({
                    "fund_id": fund_id,
                    "name": name,
                    "name_display": name,
                    "theme": inferred.theme,
                    "themes": inferred.themes,
                    "estimated_return": estimated_return,
                    "latest_nav": latest_nav,
                    "estimate_mode": "official",
                    "display_estimate_source_label": "自动(官方)",
                    "estimate_as_of": estimate.get("estimate_as_of").cloned().unwrap_or(json!("")),
                }));
            }
            Err(_) => continue,
        }
    }

    (StatusCode::OK, Json(json!({ "items": items, "total": items.len() })))
}

#[derive(Debug, Deserialize)]
struct FundsSearchQuery {
    q: Option<String>,
    limit: Option<usize>,
}

async fn get_funds_search(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FundsSearchQuery>,
) -> impl IntoResponse {
    let q = query.q.unwrap_or_default();
    if q.trim().is_empty() {
        return bad_request("q 不能为空").into_response();
    }
    let limit = query.limit.unwrap_or(10).clamp(1, 50);

    match funds::search_funds(&state.http, &q, limit).await {
        Ok(items) => (
            StatusCode::OK,
            Json(json!({ "items": items, "total": items.len() })),
        )
            .into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct FundsCatalogQuery {
    page: Option<usize>,
    page_size: Option<usize>,
}

async fn get_funds_catalog(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FundsCatalogQuery>,
) -> impl IntoResponse {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(30).clamp(1, 100);

    match funds::fetch_catalog(&state.http, page, page_size).await {
        Ok(payload) => (StatusCode::OK, Json(payload)).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response(),
    }
}

async fn get_intraday_estimate(
    State(state): State<Arc<AppState>>,
    Path(fund_id): Path<String>,
    Query(_q): Query<EstimateModeQuery>,
) -> impl IntoResponse {
    match real_data::fetch_fund_estimate(&state.http, &fund_id).await {
        Ok(estimate) => {
            let estimated_nav = estimate
                .get("estimated_nav")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let latest_nav = estimate
                .get("latest_nav")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let payload = json!({
                "estimated_nav": estimated_nav,
                "latest_nav": latest_nav,
                "estimate_mode": "official",
                "display_estimate_source_label": "自动(官方)",
                "estimate_as_of": estimate.get("estimate_as_of").cloned().unwrap_or(json!("")),
            });
            (StatusCode::OK, Json(payload)).into_response()
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct NavTrendQuery {
    range: Option<String>,
}

async fn get_nav_trend(
    State(state): State<Arc<AppState>>,
    Path(fund_id): Path<String>,
    Query(query): Query<NavTrendQuery>,
) -> impl IntoResponse {
    let range = nav::NavRange::from_str(query.range.as_deref().unwrap_or("6m"));

    match nav::fetch_nav_trend_points(&state.http, &fund_id).await {
        Ok(points) => {
            let points = nav::filter_points_by_range(points, range);
            (
                StatusCode::OK,
                Json(json!({
                    "fund_id": fund_id,
                    "range": range.as_str(),
                    "points": points,
                })),
            )
                .into_response()
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response(),
    }
}

async fn get_fund_announcements(
    State(state): State<Arc<AppState>>,
    Path(fund_id): Path<String>,
    Query(query): Query<AnnouncementsQuery>,
) -> impl IntoResponse {
    let page_index = query.page_index.unwrap_or(1);
    let page_size = query.page_size.unwrap_or(8);
    let notice_type = query.notice_type.as_deref().unwrap_or("0");

    match announcements::fetch_announcements(&state.http, &fund_id, page_index, page_size, notice_type).await {
        Ok(payload) => (StatusCode::OK, Json(payload)).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct TopHoldingsQuery {
    limit: Option<usize>,
}

async fn get_top_holdings(
    State(state): State<Arc<AppState>>,
    Path(fund_id): Path<String>,
    Query(query): Query<TopHoldingsQuery>,
) -> impl IntoResponse {
    let limit = query.limit.unwrap_or(10).clamp(1, 50);
    match top_holdings::fetch_top_holdings_with_quotes(&state.http, &fund_id, limit).await {
        Ok(payload) => (StatusCode::OK, Json(payload)).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "message": error.to_string() })),
        )
            .into_response(),
    }
}
