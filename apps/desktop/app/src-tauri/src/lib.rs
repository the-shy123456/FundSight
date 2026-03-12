use axum::{routing::get, Json, Router};
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};

const API_BIND: &str = "127.0.0.1:18080";

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "service": "fundsight-desktop-api" }))
}

fn spawn_api_server() {
    tauri::async_runtime::spawn(async move {
        let cors = CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any);

        let app = Router::new()
            .route("/api/v1/health", get(health))
            .layer(cors);

        let listener = match tokio::net::TcpListener::bind(API_BIND).await {
            Ok(value) => value,
            Err(error) => {
                tracing::error!("failed to bind API server on {API_BIND}: {error}");
                return;
            }
        };

        tracing::info!("desktop API server listening on http://{API_BIND}");
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!("API server error: {error}");
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .setup(|_| {
            spawn_api_server();
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
