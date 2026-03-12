use std::{net::SocketAddr, sync::Arc};

use tower_http::cors::{Any, CorsLayer};

use analysis_api_rs::api::{self, AppState};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let host = std::env::var("FUND_INSIGHT_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = std::env::var("FUND_INSIGHT_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8080);

    let addr: SocketAddr = format!("{host}:{port}").parse().expect("valid bind addr");

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let state = Arc::new(AppState {
        http: reqwest::Client::new(),
    });

    let app = api::router(state).layer(cors);

    tracing::info!("analysis_api_rs listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}
