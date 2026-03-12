use crate::{funds, holdings, nav, portfolio, real_data, top_holdings, watchlist};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
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
        .route("/api/v1/watchlist", get(get_watchlist).post(post_watchlist))
        .route("/api/v1/watchlist/intraday", get(get_watchlist_intraday))
        .route("/api/v1/watchlist/{fund_id}", delete(delete_watchlist_id))
        .route("/api/v1/funds", get(get_funds_catalog))
        .route("/api/v1/funds/search", get(get_funds_search))
        .route("/api/v1/funds/{fund_id}/nav-trend", get(get_nav_trend))
        .route("/api/v1/funds/{fund_id}/top-holdings", get(get_top_holdings))
        .route(
            "/api/v1/funds/{fund_id}/intraday-estimate",
            get(get_intraday_estimate),
        )
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "status": "ok", "service": "analysis_api_rs" })))
}

async fn get_portfolio(State(state): State<Arc<AppState>>, Query(_q): Query<EstimateModeQuery>) -> impl IntoResponse {
    let holdings = holdings::load_holdings();
    match portfolio::build_portfolio_snapshot(&state.http, &holdings).await {
        Ok(payload) => (StatusCode::OK, Json(payload)).into_response(),
        Err(error) => (StatusCode::BAD_GATEWAY, Json(json!({ "message": error.to_string() }))).into_response(),
    }
}

async fn get_portfolio_intraday() -> impl IntoResponse {
    // Current frontend does not depend on intraday chart yet. Return empty contract.
    (
        StatusCode::OK,
        Json(json!({
            "chart": {"labels": [], "series": []},
            "contributions": [],
            "disclaimer": "盘中贡献图暂未实现（Rust 版接口迁移中）。"
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

#[derive(Debug, Deserialize)]
struct HoldingsOcrRequest {
    #[serde(default)]
    image_base64: String,
}

async fn post_holdings_ocr(Json(_payload): Json<HoldingsOcrRequest>) -> impl IntoResponse {
    // Windows 端会用系统 OCR 实现；Rust 服务在跨平台阶段先提供不报错的占位响应，避免前端崩。
    (
        StatusCode::OK,
        Json(json!({
            "suggestions": [],
            "warnings": ["OCR 功能正在迁移到 Rust/Windows 原生实现中（当前版本暂不可用）。"],
        })),
    )
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

        items.push(json!({
            "fund_id": fund_id,
            "name": name,
            "name_display": name,
            "theme": "",
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
        Ok(_) => (StatusCode::OK, Json(json!({ "added": true, "fund_id": body.fund_id }))).into_response(),
        Err(error) => bad_request(error.to_string()).into_response(),
    }
}

async fn delete_watchlist_id(Path(fund_id): Path<String>) -> impl IntoResponse {
    match watchlist::remove_watchlist_id(&fund_id) {
        Ok(_) => (StatusCode::OK, Json(json!({ "deleted": true }))).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "message": error.to_string() }))).into_response(),
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
                items.push(json!({
                    "fund_id": fund_id,
                    "name": name,
                    "name_display": name,
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
        Ok(items) => (StatusCode::OK, Json(json!({ "items": items, "total": items.len() }))).into_response(),
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
