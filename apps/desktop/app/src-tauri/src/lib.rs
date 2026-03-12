use axum::{
    body::{to_bytes, Body},
    extract::{Path, State},
    http::{header, HeaderMap, Method, Request, StatusCode, Uri},
    response::{sse::Event, IntoResponse, Response, Sse},
    routing::{any, get, post},
    Json, Router,
};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    convert::Infallible,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::RwLock;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::{Any, CorsLayer};

const API_BIND: &str = "127.0.0.1:18080";
const UPSTREAM_BASE: &str = "http://127.0.0.1:18081";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LlmProtocol {
    Openai_compatible,
    Anthropic_messages,
}

impl Default for LlmProtocol {
    fn default() -> Self {
        Self::Openai_compatible
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LlmConfig {
    #[serde(default)]
    pub protocol: LlmProtocol,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LlmConfigView {
    pub protocol: LlmProtocol,
    pub base_url: String,
    pub model: String,
    pub has_api_key: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LlmConfigUpdate {
    pub protocol: LlmProtocol,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Clone)]
struct AppState {
    config_path: PathBuf,
    llm: Arc<RwLock<LlmConfig>>,
    http: reqwest::Client,
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "service": "fundsight-desktop-api" }))
}

fn normalize_base_url(input: &str) -> String {
    input.trim().trim_end_matches('/').to_string()
}

fn config_dir_for_dev() -> PathBuf {
    // dev fallback on non-Windows hosts; real Windows build should use app config dir.
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".fund-insight")
}

fn load_llm_config(path: &FsPath) -> LlmConfig {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => LlmConfig::default(),
    }
}

fn save_llm_config(path: &FsPath, config: &LlmConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let content =
        serde_json::to_string_pretty(config).map_err(|e| format!("序列化配置失败: {e}"))?;
    std::fs::write(path, content).map_err(|e| format!("写入配置失败: {e}"))?;
    Ok(())
}

fn keyring_entry() -> keyring::Entry {
    // service + username
    keyring::Entry::new("FundSight", "llm_api_key").expect("keyring entry")
}

fn has_api_key() -> bool {
    keyring_entry().get_password().is_ok()
}

fn set_api_key(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    keyring_entry()
        .set_password(trimmed)
        .map_err(|e| format!("保存 API Key 失败: {e}"))
}

fn get_api_key() -> Result<String, String> {
    keyring_entry()
        .get_password()
        .map_err(|e| format!("读取 API Key 失败: {e}"))
}

async fn get_llm_config(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let cfg = state.llm.read().await.clone();
    Json(LlmConfigView {
        protocol: cfg.protocol,
        base_url: cfg.base_url,
        model: cfg.model,
        has_api_key: has_api_key(),
    })
}

async fn update_llm_config(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LlmConfigUpdate>,
) -> impl IntoResponse {
    if payload.base_url.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "message": "接入地址不能为空" })),
        )
            .into_response();
    }
    if payload.model.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "message": "模型不能为空" })),
        )
            .into_response();
    }

    // API Key: allow empty to keep existing stored key.
    if !payload.api_key.trim().is_empty() {
        if let Err(message) = set_api_key(&payload.api_key) {
            return (StatusCode::BAD_REQUEST, Json(json!({ "message": message }))).into_response();
        }
    } else if !has_api_key() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "message": "API Key 不能为空" })),
        )
            .into_response();
    }

    let next = LlmConfig {
        protocol: payload.protocol,
        base_url: normalize_base_url(&payload.base_url),
        model: payload.model.trim().to_string(),
    };

    if let Err(message) = save_llm_config(&state.config_path, &next) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": message })),
        )
            .into_response();
    }

    *state.llm.write().await = next.clone();

    (
        StatusCode::OK,
        Json(json!({
            "protocol": next.protocol,
            "base_url": next.base_url,
            "model": next.model,
            "has_api_key": has_api_key(),
        })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
struct AssistantAskPayload {
    #[serde(default)]
    fund_id: String,
    question: String,
    #[serde(default)]
    estimate_mode: String,
    #[serde(default)]
    cash_available: f64,
}

fn openai_endpoint(base_url: &str) -> String {
    let root = normalize_base_url(base_url);
    if root.ends_with("/v1") {
        format!("{root}/chat/completions")
    } else {
        format!("{root}/v1/chat/completions")
    }
}

fn anthropic_endpoint(base_url: &str) -> String {
    let root = normalize_base_url(base_url);
    if root.ends_with("/v1") {
        format!("{root}/messages")
    } else {
        format!("{root}/v1/messages")
    }
}

async fn openai_stream(
    client: reqwest::Client,
    base_url: String,
    model: String,
    api_key: String,
    prompt: String,
) -> Result<impl Stream<Item = Result<String, String>>, String> {
    let url = openai_endpoint(&base_url);
    let body = json!({
        "model": model,
        "stream": true,
        "messages": [
            {"role": "system", "content": "你是一个简洁直接的基金投资助手。只输出可读文本，不要输出JSON。"},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.6
    });

    let resp = client
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 LLM 失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("LLM 返回错误: {status} {text}"));
    }

    let stream = resp.bytes_stream();

    // Parse SSE: lines start with "data: ", blank line separates events.
    let parsed = async_stream::try_stream! {
        let mut buffer = String::new();
        futures::pin_mut!(stream);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("读取流失败: {e}"))?;
            let part = String::from_utf8_lossy(&chunk);
            buffer.push_str(&part);

            while let Some(idx) = buffer.find("\n\n") {
                let event = buffer[..idx].to_string();
                buffer = buffer[idx + 2..].to_string();

                for line in event.lines() {
                    let line = line.trim();
                    if !line.starts_with("data:") {
                        continue;
                    }
                    let data = line.trim_start_matches("data:").trim();
                    if data == "[DONE]" {
                        return;
                    }
                    let value: serde_json::Value = serde_json::from_str(data).unwrap_or(json!({}));
                    let delta = value
                        .get("choices")
                        .and_then(|v| v.get(0))
                        .and_then(|v| v.get("delta"))
                        .and_then(|v| v.get("content"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !delta.is_empty() {
                        yield delta.to_string();
                    }
                }
            }
        }
    };

    Ok(parsed)
}

async fn anthropic_stream(
    client: reqwest::Client,
    base_url: String,
    model: String,
    api_key: String,
    prompt: String,
) -> Result<impl Stream<Item = Result<String, String>>, String> {
    let url = anthropic_endpoint(&base_url);
    let body = json!({
        "model": model,
        "stream": true,
        "max_tokens": 1024,
        "system": "你是一个简洁直接的基金投资助手。只输出可读文本，不要输出JSON。",
        "messages": [
            {"role": "user", "content": prompt}
        ]
    });

    let resp = client
        .post(url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header(header::CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 LLM 失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("LLM 返回错误: {status} {text}"));
    }

    let stream = resp.bytes_stream();

    let parsed = async_stream::try_stream! {
        let mut buffer = String::new();
        futures::pin_mut!(stream);

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("读取流失败: {e}"))?;
            let part = String::from_utf8_lossy(&chunk);
            buffer.push_str(&part);

            while let Some(idx) = buffer.find("\n\n") {
                let raw = buffer[..idx].to_string();
                buffer = buffer[idx + 2..].to_string();

                let mut event_name = String::new();
                let mut data_lines: Vec<String> = vec![];

                for line in raw.lines() {
                    let line = line.trim();
                    if line.starts_with("event:") {
                        event_name = line.trim_start_matches("event:").trim().to_string();
                    } else if line.starts_with("data:") {
                        data_lines.push(line.trim_start_matches("data:").trim().to_string());
                    }
                }

                let data = data_lines.join("\n");
                if event_name == "content_block_delta" {
                    let value: serde_json::Value = serde_json::from_str(&data).unwrap_or(json!({}));
                    let text = value
                        .get("delta")
                        .and_then(|v| v.get("text"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !text.is_empty() {
                        yield text.to_string();
                    }
                } else if event_name == "message_stop" {
                    return;
                } else if event_name == "error" {
                    let value: serde_json::Value = serde_json::from_str(&data).unwrap_or(json!({}));
                    let message = value
                        .get("error")
                        .and_then(|v| v.get("message"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(data.as_str());
                    Err::<(), _>(message.to_string())?;
                }
            }
        }
    };

    Ok(parsed)
}

async fn assistant_ask_stream(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AssistantAskPayload>,
) -> impl IntoResponse {
    let cfg = state.llm.read().await.clone();
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "message": "请先在【模型配置】里填写协议/地址/模型并保存" })),
        )
            .into_response();
    }

    let api_key = match get_api_key() {
        Ok(value) => value,
        Err(message) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "message": message }))).into_response();
        }
    };

    let prompt = format!(
        "问题：{}\n\n补充：estimate_mode={} fund_id={} cash_available={}\n\n请给出简洁可执行的建议。",
        payload.question.trim(),
        payload.estimate_mode,
        payload.fund_id,
        payload.cash_available
    );

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(64);
    let client = state.http.clone();

    tauri::async_runtime::spawn(async move {
        let result = match cfg.protocol {
            LlmProtocol::Openai_compatible => {
                openai_stream(client, cfg.base_url, cfg.model, api_key, prompt).await
            }
            LlmProtocol::Anthropic_messages => {
                anthropic_stream(client, cfg.base_url, cfg.model, api_key, prompt).await
            }
        };

        match result {
            Ok(mut stream) => {
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(delta) => {
                            let _ = tx
                                .send(Ok(Event::default().event("delta").data(delta)))
                                .await;
                        }
                        Err(message) => {
                            let _ = tx
                                .send(Ok(Event::default().event("error").data(message)))
                                .await;
                            break;
                        }
                    }
                }
                let _ = tx
                    .send(Ok(Event::default().event("done").data("done")))
                    .await;
            }
            Err(message) => {
                let _ = tx
                    .send(Ok(Event::default().event("error").data(message)))
                    .await;
                let _ = tx
                    .send(Ok(Event::default().event("done").data("done")))
                    .await;
            }
        }
    });

    Sse::new(ReceiverStream::new(rx))
        .keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("ping"),
        )
        .into_response()
}

async fn assistant_ask(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AssistantAskPayload>,
) -> impl IntoResponse {
    // Compatibility: keep the existing structured assistant available via the Python upstream.
    let url = format!("{UPSTREAM_BASE}/api/v1/assistant/ask");
    let resp = state
        .http
        .post(url)
        .json(&json!({
            "fund_id": payload.fund_id,
            "cash_available": payload.cash_available,
            "question": payload.question,
            "estimate_mode": payload.estimate_mode,
        }))
        .send()
        .await;

    let resp = match resp {
        Ok(v) => v,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "message": format!("上游服务不可用: {error}") })),
            )
                .into_response();
        }
    };

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    (
        status,
        [(
            header::CONTENT_TYPE,
            "application/json; charset=utf-8".to_string(),
        )],
        text,
    )
        .into_response()
}

async fn proxy_to_upstream(State(state): State<Arc<AppState>>, mut req: Request<Body>) -> Response {
    // Only proxy /api/v1/*
    let uri = req.uri().clone();
    let path_and_query = uri.path_and_query().map(|v| v.as_str()).unwrap_or("/");

    if !path_and_query.starts_with("/api/") {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }

    let upstream_url = format!("{UPSTREAM_BASE}{path_and_query}");

    let method = req.method().clone();
    let headers = req.headers().clone();
    let body = to_bytes(req.body_mut(), 8 * 1024 * 1024)
        .await
        .unwrap_or_else(|_| Bytes::new());

    let mut builder = state.http.request(method, upstream_url);

    // Copy headers excluding Host.
    for (name, value) in headers.iter() {
        if name == header::HOST {
            continue;
        }
        builder = builder.header(name, value);
    }

    let upstream_resp = match builder.body(body).send().await {
        Ok(value) => value,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "message": format!("上游服务不可用: {error}") })),
            )
                .into_response();
        }
    };

    let status = upstream_resp.status();
    let mut resp_headers = HeaderMap::new();
    for (name, value) in upstream_resp.headers().iter() {
        // skip hop-by-hop
        if name == header::CONNECTION
            || name == header::TRANSFER_ENCODING
            || name == header::CONTENT_LENGTH
        {
            continue;
        }
        resp_headers.insert(name, value.clone());
    }

    let bytes = upstream_resp.bytes().await.unwrap_or_default();
    (status, resp_headers, bytes).into_response()
}

fn spawn_upstream() {
    // Dev-mode: prefer the Rust upstream (services/analysis_api_rs). Can be forced to python via FUNDSIGHT_UPSTREAM=python.
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let upstream = std::env::var("FUNDSIGHT_UPSTREAM").unwrap_or_else(|_| "rust".to_string());

    if upstream.trim().eq_ignore_ascii_case("python") {
        let python = std::env::var("FUNDSIGHT_PYTHON_BIN").unwrap_or_else(|_| "python".to_string());
        let mut cmd = std::process::Command::new(python);
        cmd.current_dir(&repo_root)
            .env("FUND_INSIGHT_HOST", "127.0.0.1")
            .env("FUND_INSIGHT_PORT", "18081")
            .args(["-m", "services.analysis_api.server"]);

        match cmd.spawn() {
            Ok(_child) => {
                tracing::info!("spawned python upstream on http://127.0.0.1:18081");
            }
            Err(error) => {
                tracing::error!("failed to spawn python upstream: {error}");
            }
        }
        return;
    }

    // Rust upstream
    let bin_path = repo_root.join("services/analysis_api_rs/target/debug/analysis_api_rs");
    if bin_path.exists() {
        let mut cmd = std::process::Command::new(bin_path);
        cmd.current_dir(&repo_root)
            .env("FUND_INSIGHT_HOST", "127.0.0.1")
            .env("FUND_INSIGHT_PORT", "18081");
        match cmd.spawn() {
            Ok(_child) => {
                tracing::info!("spawned rust upstream on http://127.0.0.1:18081");
            }
            Err(error) => {
                tracing::error!("failed to spawn rust upstream: {error}");
            }
        }
        return;
    }

    // Fallback: cargo run (slower)
    let mut cmd = std::process::Command::new("cargo");
    cmd.current_dir(&repo_root)
        .env("FUND_INSIGHT_HOST", "127.0.0.1")
        .env("FUND_INSIGHT_PORT", "18081")
        .args([
            "run",
            "--quiet",
            "--manifest-path",
            "services/analysis_api_rs/Cargo.toml",
        ]);

    match cmd.spawn() {
        Ok(_child) => {
            tracing::info!("spawned rust upstream via cargo on http://127.0.0.1:18081");
        }
        Err(error) => {
            tracing::error!("failed to spawn rust upstream via cargo: {error}");
        }
    }
}

fn spawn_api_server() {
    let config_dir = config_dir_for_dev();
    let config_path = config_dir.join("llm_config.json");
    let initial = load_llm_config(&config_path);

    let state = Arc::new(AppState {
        config_path,
        llm: Arc::new(RwLock::new(initial)),
        http: reqwest::Client::new(),
    });

    tauri::async_runtime::spawn(async move {
        let cors = CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any);

        let app = Router::new()
            .route("/api/v1/health", get(health))
            .route(
                "/api/v1/llm/config",
                get(get_llm_config).post(update_llm_config),
            )
            .route("/api/v1/assistant/ask", post(assistant_ask))
            .route("/api/v1/assistant/ask/stream", post(assistant_ask_stream))
            .route("/api/v1/{*path}", any(proxy_to_upstream))
            .layer(cors)
            .with_state(state);

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
            spawn_upstream();
            spawn_api_server();
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
