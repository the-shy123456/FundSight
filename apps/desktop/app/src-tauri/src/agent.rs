use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{sse::Event, IntoResponse, Response, Sse},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};
use tokio::sync::RwLock;
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    extract_six_digit_code, get_api_key, is_cancel, is_confirm, is_portfolio_question,
    load_assistant_state, now_ms, pretty_json_truncated, save_assistant_state, truncate_string_chars,
    upstream_delete_json, upstream_get_json, upstream_post_json, AppState, AssistantState,
    AssistantTurn, LlmProtocol,
};

const MAX_MESSAGES: usize = 200;
const SUMMARY_EVERY_USER_TURNS: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    Auto,
    Invest,
    Chat,
}

impl Default for AgentMode {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingActionKind {
    ClearWatchlist,
    ClearHoldings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PendingAction {
    pub kind: PendingActionKind,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct UiActionButton {
    pub label: String,
    pub message: String,
    #[serde(default)]
    pub variant: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TraceEvent {
    pub ts_ms: u64,
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(default)]
    pub args: Option<Value>,
    #[serde(default)]
    pub result: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentMessage {
    pub role: String,
    pub text: String,
    pub ts_ms: u64,

    #[serde(default)]
    pub meta: Option<Value>,
    #[serde(default)]
    pub ui_actions: Vec<UiActionButton>,
    #[serde(default)]
    pub trace: Vec<TraceEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub mode: AgentMode,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,

    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub summary_upto: usize,

    #[serde(default)]
    pub messages: Vec<AgentMessage>,

    #[serde(default)]
    pub pending_action: Option<PendingAction>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ConversationView {
    pub id: String,
    pub title: String,
    pub mode: AgentMode,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct AgentStore {
    pub conversations: Vec<ConversationView>,
}

impl AgentStore {
    pub fn index_path(root: &FsPath) -> PathBuf {
        root.join("agent").join("conversations.json")
    }

    pub fn conversation_path(root: &FsPath, id: &str) -> PathBuf {
        root.join("agent").join("conversations").join(format!("{id}.json"))
    }

    pub fn load(root: &FsPath) -> Self {
        let index_path = Self::index_path(root);
        match std::fs::read_to_string(&index_path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => AgentStore::default(),
        }
    }

    pub fn save(&self, root: &FsPath) -> Result<(), String> {
        let index_path = Self::index_path(root);
        if let Some(parent) = index_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建 agent 目录失败: {e}"))?;
        }
        let content = serde_json::to_string_pretty(self).map_err(|e| format!("序列化失败: {e}"))?;
        std::fs::write(index_path, content).map_err(|e| format!("写入失败: {e}"))?;
        Ok(())
    }

    pub fn get_view(&self, id: &str) -> Option<ConversationView> {
        self.conversations.iter().find(|c| c.id == id).cloned()
    }

    pub fn upsert_view(&mut self, view: ConversationView) {
        if let Some(idx) = self.conversations.iter().position(|c| c.id == view.id) {
            self.conversations[idx] = view;
        } else {
            self.conversations.insert(0, view);
        }

        // Keep newest first.
        self.conversations.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    }

    pub fn remove_view(&mut self, id: &str) {
        self.conversations.retain(|c| c.id != id);
    }
}

fn default_title() -> String {
    "新对话".to_string()
}

fn normalize_title(input: Option<String>) -> String {
    let t = input.unwrap_or_default();
    let clean = t.trim();
    if clean.is_empty() {
        default_title()
    } else {
        clean.to_string()
    }
}

fn normalize_mode(input: Option<AgentMode>) -> AgentMode {
    input.unwrap_or_default()
}

fn classify_mode_auto(text: &str) -> AgentMode {
    // Heuristic: fund/invest keywords => Invest, otherwise Chat.
    let clean = text.trim();
    if clean.is_empty() {
        return AgentMode::Chat;
    }

    let invest_keywords = [
        "基金", "估值", "净值", "持仓", "组合", "收益", "回撤", "波动", "仓位", "买", "卖", "加仓",
        "减仓", "止盈", "止损", "风险", "联接", "ETF", "投研",
    ];

    if invest_keywords.iter().any(|k| clean.contains(k)) {
        return AgentMode::Invest;
    }

    // If it looks like a portfolio question, treat as Invest.
    if is_portfolio_question(clean) {
        return AgentMode::Invest;
    }

    // If contains 6-digit code, likely a fund.
    if extract_six_digit_code(clean).is_some() {
        return AgentMode::Invest;
    }

    AgentMode::Chat
}

fn cap_messages(mut messages: Vec<AgentMessage>) -> Vec<AgentMessage> {
    if messages.len() <= MAX_MESSAGES {
        return messages;
    }
    messages.split_off(messages.len().saturating_sub(MAX_MESSAGES))
}

fn count_user_turns(messages: &[AgentMessage]) -> usize {
    messages.iter().filter(|m| m.role == "user").count()
}

async fn load_conversation(root: &FsPath, id: &str) -> Result<Conversation, String> {
    let path = AgentStore::conversation_path(root, id);
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取会话失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("解析会话失败: {e}"))
}

async fn save_conversation(root: &FsPath, convo: &Conversation) -> Result<(), String> {
    let path = AgentStore::conversation_path(root, &convo.id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建会话目录失败: {e}"))?;
    }
    let content = serde_json::to_string_pretty(convo).map_err(|e| format!("序列化会话失败: {e}"))?;
    std::fs::write(path, content).map_err(|e| format!("写入会话失败: {e}"))?;
    Ok(())
}

fn new_conversation(id: String, title: String, mode: AgentMode) -> Conversation {
    let now = now_ms();
    Conversation {
        id,
        title,
        mode,
        created_at_ms: now,
        updated_at_ms: now,
        summary: String::new(),
        summary_upto: 0,
        messages: vec![],
        pending_action: None,
    }
}

fn view_from_conversation(convo: &Conversation) -> ConversationView {
    ConversationView {
        id: convo.id.clone(),
        title: convo.title.clone(),
        mode: convo.mode.clone(),
        created_at_ms: convo.created_at_ms,
        updated_at_ms: convo.updated_at_ms,
    }
}

fn gen_id() -> String {
    // Avoid new deps; use timestamp + random-ish counter.
    format!("c{}", now_ms())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CreateConversationBody {
    pub title: Option<String>,
    pub mode: Option<AgentMode>,
}

pub async fn list_conversations(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let store = state.agent_store.read().await.clone();
    (StatusCode::OK, Json(json!({ "items": store.conversations, "total": store.conversations.len() })))
}

pub async fn create_conversation(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateConversationBody>,
) -> impl IntoResponse {
    let id = gen_id();
    let title = normalize_title(body.title);
    let mode = normalize_mode(body.mode);
    let mut convo = new_conversation(id.clone(), title, mode);

    // Seed with a friendly assistant greeting (not finance-only).
    convo.messages.push(AgentMessage {
        role: "assistant".to_string(),
        text: "我是 FundSight Agent。你可以聊基金/组合，也可以随便聊天。\n\n提示：在右上角可以切换模式（自动/投研/闲聊）。".to_string(),
        ts_ms: now_ms(),
        meta: None,
        ui_actions: vec![],
        trace: vec![],
    });

    if let Err(message) = save_conversation(&state.agent_root, &convo).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": message })),
        )
            .into_response();
    }

    let view = view_from_conversation(&convo);
    {
        let mut store = state.agent_store.write().await;
        store.upsert_view(view.clone());
        if let Err(message) = store.save(&state.agent_root) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "message": message })),
            )
                .into_response();
        }
    }

    (StatusCode::OK, Json(view)).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RenameConversationBody {
    pub title: String,
}

pub async fn rename_conversation(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<RenameConversationBody>,
) -> impl IntoResponse {
    let mut convo = match load_conversation(&state.agent_root, &id).await {
        Ok(v) => v,
        Err(message) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "message": message })),
            )
                .into_response();
        }
    };

    convo.title = normalize_title(Some(body.title));
    convo.updated_at_ms = now_ms();

    if let Err(message) = save_conversation(&state.agent_root, &convo).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": message })),
        )
            .into_response();
    }

    let view = view_from_conversation(&convo);
    {
        let mut store = state.agent_store.write().await;
        store.upsert_view(view.clone());
        let _ = store.save(&state.agent_root);
    }

    (StatusCode::OK, Json(view)).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SetModeBody {
    pub mode: AgentMode,
}

pub async fn set_conversation_mode(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<SetModeBody>,
) -> impl IntoResponse {
    let mut convo = match load_conversation(&state.agent_root, &id).await {
        Ok(v) => v,
        Err(message) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "message": message })),
            )
                .into_response();
        }
    };

    convo.mode = body.mode;
    convo.updated_at_ms = now_ms();

    if let Err(message) = save_conversation(&state.agent_root, &convo).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": message })),
        )
            .into_response();
    }

    let view = view_from_conversation(&convo);
    {
        let mut store = state.agent_store.write().await;
        store.upsert_view(view.clone());
        let _ = store.save(&state.agent_root);
    }

    (StatusCode::OK, Json(view)).into_response()
}

pub async fn delete_conversation(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let path = AgentStore::conversation_path(&state.agent_root, &id);
    let _ = std::fs::remove_file(&path);

    {
        let mut store = state.agent_store.write().await;
        store.remove_view(&id);
        let _ = store.save(&state.agent_root);
    }

    (StatusCode::OK, Json(json!({ "deleted": true }))).into_response()
}

pub async fn get_messages(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match load_conversation(&state.agent_root, &id).await {
        Ok(convo) => (StatusCode::OK, Json(json!({ "items": convo.messages, "total": convo.messages.len(), "summary": convo.summary, "mode": convo.mode }))).into_response(),
        Err(message) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "message": message })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChatStreamBody {
    pub conversation_id: Option<String>,
    pub message: String,
    pub mode: Option<AgentMode>,

    // Optional invest hints (from UI):
    #[serde(default)]
    pub fund_id: String,
    #[serde(default)]
    pub estimate_mode: String,
    #[serde(default)]
    pub cash_available: f64,
}

fn sse_simple(text: String) -> Response {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(8);
    tauri::async_runtime::spawn(async move {
        let _ = tx.send(Ok(Event::default().event("delta").data(text))).await;
        let _ = tx
            .send(Ok(Event::default().event("done").data("done")))
            .await;
    });

    Sse::new(ReceiverStream::new(rx))
        .keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(std::time::Duration::from_secs(15))
                .text("ping"),
        )
        .into_response()
}

fn sse_action_prompt(text: String, action: Value) -> Response {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(16);
    tauri::async_runtime::spawn(async move {
        let _ = tx
            .send(Ok(Event::default().event("delta").data(text)))
            .await;
        let _ = tx
            .send(Ok(
                Event::default()
                    .event("action")
                    .data(action.to_string()),
            ))
            .await;
        let _ = tx
            .send(Ok(Event::default().event("done").data("done")))
            .await;
    });

    Sse::new(ReceiverStream::new(rx))
        .keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(std::time::Duration::from_secs(15))
                .text("ping"),
        )
        .into_response()
}

async fn ensure_default_conversation(state: &Arc<AppState>) -> Result<String, String> {
    // If no conversation exists, create one.
    let existing = { state.agent_store.read().await.conversations.first().cloned() };
    if let Some(c) = existing {
        return Ok(c.id);
    }

    // Migration: if legacy assistant_state.json exists and has history, seed it.
    let legacy: AssistantState = load_assistant_state(&state.assistant_state_path);
    let id = "default".to_string();
    let mut convo = new_conversation(id.clone(), "默认对话".to_string(), AgentMode::Auto);

    if !legacy.history.is_empty() {
        for turn in legacy.history {
            convo.messages.push(AgentMessage {
                role: turn.role,
                text: turn.text,
                ts_ms: turn.ts_ms,
                meta: None,
                ui_actions: vec![],
                trace: vec![],
            });
        }
    }

    if convo.messages.is_empty() {
        convo.messages.push(AgentMessage {
            role: "assistant".to_string(),
            text: "我是 FundSight Agent。你可以聊基金/组合，也可以随便聊天。".to_string(),
            ts_ms: now_ms(),
            meta: None,
            ui_actions: vec![],
            trace: vec![],
        });
    }

    save_conversation(&state.agent_root, &convo).await?;

    let view = view_from_conversation(&convo);
    {
        let mut store = state.agent_store.write().await;
        store.upsert_view(view);
        let _ = store.save(&state.agent_root);
    }

    Ok(id)
}

async fn maybe_summarize_conversation(state: Arc<AppState>, convo: &mut Conversation) {
    // Summarize older history every N user turns.
    let user_turns = count_user_turns(&convo.messages);
    if user_turns == 0 {
        return;
    }
    if user_turns % SUMMARY_EVERY_USER_TURNS != 0 {
        return;
    }

    // Already summarized up to near the tail? then skip.
    if convo.summary_upto >= convo.messages.len().saturating_sub(12) {
        return;
    }

    let to_summarize = convo
        .messages
        .iter()
        .take(convo.messages.len().saturating_sub(8))
        .cloned()
        .collect::<Vec<_>>();

    if to_summarize.len() < 10 {
        return;
    }

    let mut lines: Vec<String> = vec![];
    for m in &to_summarize {
        let who = if m.role == "assistant" { "助手" } else { "用户" };
        lines.push(format!("{who}: {}", truncate_string_chars(&m.text, 200)));
    }

    let prompt = format!(
        "请把下面的对话总结成一段简短中文摘要（<=200字），并列出用户偏好/目标（最多5条）。\n\n对话：\n{}\n\n输出格式：\n摘要：...\n偏好：- ...",
        lines.join("\n")
    );

    let cfg = state.llm.read().await.clone();
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return;
    }

    let api_key = match get_api_key() {
        Ok(v) => v,
        Err(_) => return,
    };

    let client = state.http.clone();

    let result = match cfg.protocol {
        LlmProtocol::Openai_compatible => {
            crate::openai_stream(client, cfg.base_url, cfg.model, api_key, prompt).await
        }
        LlmProtocol::Openai_responses => {
            crate::openai_responses_stream(client, cfg.base_url, cfg.model, api_key, prompt).await
        }
        LlmProtocol::Anthropic_messages => {
            crate::anthropic_stream(client, cfg.base_url, cfg.model, api_key, prompt).await
        }
    };

    let mut summary_text = String::new();
    if let Ok(mut stream) = result {
        while let Some(item) = futures::StreamExt::next(&mut stream).await {
            if let Ok(delta) = item {
                summary_text.push_str(&delta);
            }
        }
    }

    let summary_text = summary_text.trim();
    if summary_text.is_empty() {
        return;
    }

    convo.summary = truncate_string_chars(summary_text, 800);
    convo.summary_upto = to_summarize.len();
}

async fn apply_tool_shortcuts(state: &Arc<AppState>, convo: &mut Conversation, message: &str) -> Option<Response> {
    // Confirmation flow.
    if let Some(pending) = convo.pending_action.clone() {
        if is_cancel(message) {
            convo.pending_action = None;
            convo.updated_at_ms = now_ms();
            let _ = save_conversation(&state.agent_root, convo).await;
            return Some(sse_simple("已取消。".to_string()));
        }
        if is_confirm(message) {
            convo.pending_action = None;
            convo.updated_at_ms = now_ms();
            let _ = save_conversation(&state.agent_root, convo).await;

            let result_text = match pending.kind {
                PendingActionKind::ClearWatchlist => match upstream_delete_json(&state.http, "/api/v1/watchlist").await {
                    Ok(_) => "已清空自选。".to_string(),
                    Err(m) => format!("清空自选失败：{m}"),
                },
                PendingActionKind::ClearHoldings => match upstream_delete_json(&state.http, "/api/v1/holdings").await {
                    Ok(_) => "已清空持仓。".to_string(),
                    Err(m) => format!("清空持仓失败：{m}"),
                },
            };

            convo.messages.push(AgentMessage {
                role: "assistant".to_string(),
                text: result_text.clone(),
                ts_ms: now_ms(),
                meta: Some(json!({"mode": "invest"})),
                ui_actions: vec![],
                trace: vec![],
            });
            convo.messages = cap_messages(convo.messages.clone());
            convo.updated_at_ms = now_ms();
            let _ = save_conversation(&state.agent_root, convo).await;

            return Some(sse_simple(result_text));
        }
    }

    // Clear watchlist/holdings (destructive)
    if message.contains("清空自选") {
        convo.pending_action = Some(PendingAction {
            kind: PendingActionKind::ClearWatchlist,
            created_at_ms: now_ms(),
        });
        convo.updated_at_ms = now_ms();

        let ui_buttons = vec![
            UiActionButton {
                label: "确认".to_string(),
                message: "确认".to_string(),
                variant: "primary".to_string(),
            },
            UiActionButton {
                label: "取消".to_string(),
                message: "取消".to_string(),
                variant: "secondary".to_string(),
            },
        ];

        convo.messages.push(AgentMessage {
            role: "assistant".to_string(),
            text: "将清空【自选】列表。回复「确认」执行，回复「取消」撤销。".to_string(),
            ts_ms: now_ms(),
            meta: Some(json!({"mode": "invest"})),
            ui_actions: ui_buttons.clone(),
            trace: vec![],
        });
        convo.messages = cap_messages(convo.messages.clone());

        let _ = save_conversation(&state.agent_root, convo).await;
        return Some(sse_action_prompt(
            "将清空【自选】列表。回复「确认」执行，回复「取消」撤销。".to_string(),
            json!({
                "type": "confirm",
                "pending": "clear_watchlist",
                "buttons": ui_buttons,
            }),
        ));
    }

    if message.contains("清空持仓") || message.contains("清空组合") {
        convo.pending_action = Some(PendingAction {
            kind: PendingActionKind::ClearHoldings,
            created_at_ms: now_ms(),
        });
        convo.updated_at_ms = now_ms();

        let ui_buttons = vec![
            UiActionButton {
                label: "确认".to_string(),
                message: "确认".to_string(),
                variant: "primary".to_string(),
            },
            UiActionButton {
                label: "取消".to_string(),
                message: "取消".to_string(),
                variant: "secondary".to_string(),
            },
        ];

        convo.messages.push(AgentMessage {
            role: "assistant".to_string(),
            text: "将清空【持仓】数据。回复「确认」执行，回复「取消」撤销。".to_string(),
            ts_ms: now_ms(),
            meta: Some(json!({"mode": "invest"})),
            ui_actions: ui_buttons.clone(),
            trace: vec![],
        });
        convo.messages = cap_messages(convo.messages.clone());

        let _ = save_conversation(&state.agent_root, convo).await;
        return Some(sse_action_prompt(
            "将清空【持仓】数据。回复「确认」执行，回复「取消」撤销。".to_string(),
            json!({
                "type": "confirm",
                "pending": "clear_holdings",
                "buttons": ui_buttons,
            }),
        ));
    }

    if message.contains("加入自选") || message.contains("添加自选") {
        if let Some(code) = extract_six_digit_code(message) {
            let body = json!({ "fund_id": code });
            let result = upstream_post_json(&state.http, "/api/v1/watchlist", body).await;
            let text = match result {
                Ok(v) => {
                    let fund_id = v.get("fund_id").and_then(|x| x.as_str()).unwrap_or("--");
                    format!("已加入自选：{fund_id}。")
                }
                Err(m) => format!("加入自选失败：{m}"),
            };
            convo.messages.push(AgentMessage {
                role: "assistant".to_string(),
                text: text.clone(),
                ts_ms: now_ms(),
                meta: Some(json!({"mode": "invest"})),
                ui_actions: vec![],
                trace: vec![],
            });
            convo.updated_at_ms = now_ms();
            convo.messages = cap_messages(convo.messages.clone());
            let _ = save_conversation(&state.agent_root, convo).await;
            return Some(sse_simple(text));
        }
    }

    if message.contains("移除自选") || message.contains("取消自选") {
        if let Some(code) = extract_six_digit_code(message) {
            let path = format!("/api/v1/watchlist/{code}");
            let result = upstream_delete_json(&state.http, &path).await;
            let text = match result {
                Ok(_) => format!("已从自选移除：{code}。"),
                Err(m) => format!("移除自选失败：{m}"),
            };
            convo.messages.push(AgentMessage {
                role: "assistant".to_string(),
                text: text.clone(),
                ts_ms: now_ms(),
                meta: Some(json!({"mode": "invest"})),
                ui_actions: vec![],
                trace: vec![],
            });
            convo.updated_at_ms = now_ms();
            convo.messages = cap_messages(convo.messages.clone());
            let _ = save_conversation(&state.agent_root, convo).await;
            return Some(sse_simple(text));
        }
    }

    None
}

async fn build_invest_context(state: &Arc<AppState>, body: &ChatStreamBody) -> (Value, Vec<TraceEvent>) {
    let estimate_mode = if body.estimate_mode.trim().is_empty() {
        "auto".to_string()
    } else {
        body.estimate_mode.trim().to_string()
    };

    let mut ctx = json!({
        "estimate_mode": estimate_mode,
        "fund_id": body.fund_id.trim(),
        "cash_available": body.cash_available,
    });

    let mut trace: Vec<TraceEvent> = vec![];

    match upstream_get_json(
        &state.http,
        &format!("/api/v1/portfolio?estimate_mode={}", ctx["estimate_mode"].as_str().unwrap_or("auto")),
    )
    .await
    {
        Ok(portfolio) => {
            let summary = portfolio.get("summary").cloned().unwrap_or(json!({}));
            let mut positions: Vec<Value> = portfolio
                .get("positions")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            if positions.len() > 10 {
                positions.truncate(10);
            }

            ctx["portfolio"] = json!({
                "as_of": portfolio.get("as_of").cloned().unwrap_or(json!("")),
                "summary": summary.clone(),
                "positions_top": positions,
                "disclaimer": portfolio.get("disclaimer").cloned().unwrap_or(json!("")),
            });

            trace.push(TraceEvent {
                ts_ms: now_ms(),
                kind: "tool".to_string(),
                name: "fetch_portfolio".to_string(),
                ok: Some(true),
                args: Some(json!({"estimate_mode": ctx["estimate_mode"]})),
                result: Some(json!({
                    "holding_count": summary.get("holding_count").cloned().unwrap_or(json!(null)),
                    "current_value": summary.get("current_value").cloned().unwrap_or(json!(null)),
                    "today_estimated_pnl": summary.get("today_estimated_pnl").cloned().unwrap_or(json!(null)),
                })),
            });
        }
        Err(message) => {
            trace.push(TraceEvent {
                ts_ms: now_ms(),
                kind: "tool".to_string(),
                name: "fetch_portfolio".to_string(),
                ok: Some(false),
                args: Some(json!({"estimate_mode": ctx["estimate_mode"]})),
                result: Some(json!({"message": message})),
            });
        }
    }

    let mut fund_code = body.fund_id.trim().to_string();
    if fund_code.is_empty() {
        if let Some(code) = extract_six_digit_code(&body.message) {
            fund_code = code;
        }
    }

    if !fund_code.is_empty() {
        match upstream_get_json(
            &state.http,
            &format!("/api/v1/funds/{}/intraday-estimate?estimate_mode={}", fund_code, ctx["estimate_mode"].as_str().unwrap_or("auto")),
        )
        .await
        {
            Ok(estimate) => {
                ctx["fund_estimate"] = estimate.clone();
                trace.push(TraceEvent {
                    ts_ms: now_ms(),
                    kind: "tool".to_string(),
                    name: "fetch_intraday_estimate".to_string(),
                    ok: Some(true),
                    args: Some(json!({"fund_id": fund_code, "estimate_mode": ctx["estimate_mode"]})),
                    result: Some(json!({
                        "estimated_return": estimate.get("estimated_return").cloned().unwrap_or(json!(null)),
                        "estimate_as_of": estimate.get("estimate_as_of").cloned().unwrap_or(json!(null)),
                        "display_estimate_source_label": estimate.get("display_estimate_source_label").cloned().unwrap_or(json!(null)),
                    })),
                });
            }
            Err(message) => {
                trace.push(TraceEvent {
                    ts_ms: now_ms(),
                    kind: "tool".to_string(),
                    name: "fetch_intraday_estimate".to_string(),
                    ok: Some(false),
                    args: Some(json!({"fund_id": fund_code, "estimate_mode": ctx["estimate_mode"]})),
                    result: Some(json!({"message": message})),
                });
            }
        }

        match upstream_get_json(
            &state.http,
            &format!("/api/v1/funds/{}/top-holdings?limit=10", fund_code),
        )
        .await
        {
            Ok(top_holdings) => {
                let count = top_holdings
                    .get("items")
                    .and_then(|v| v.as_array())
                    .map(|v| v.len())
                    .unwrap_or(0);
                ctx["fund_top_holdings"] = top_holdings;
                trace.push(TraceEvent {
                    ts_ms: now_ms(),
                    kind: "tool".to_string(),
                    name: "fetch_top_holdings".to_string(),
                    ok: Some(true),
                    args: Some(json!({"fund_id": fund_code, "limit": 10})),
                    result: Some(json!({"items": count})),
                });
            }
            Err(message) => {
                trace.push(TraceEvent {
                    ts_ms: now_ms(),
                    kind: "tool".to_string(),
                    name: "fetch_top_holdings".to_string(),
                    ok: Some(false),
                    args: Some(json!({"fund_id": fund_code, "limit": 10})),
                    result: Some(json!({"message": message})),
                });
            }
        }

        match upstream_get_json(
            &state.http,
            &format!("/api/v1/funds/{}/nav-trend?range=6m", fund_code),
        )
        .await
        {
            Ok(nav_trend) => {
                let mut points: Vec<Value> = nav_trend
                    .get("points")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let total_points = points.len();
                if points.len() > 60 {
                    points = points[points.len() - 60..].to_vec();
                }
                ctx["fund_nav_trend_tail"] = json!({
                    "fund_id": nav_trend.get("fund_id").cloned().unwrap_or(json!(fund_code)),
                    "range": nav_trend.get("range").cloned().unwrap_or(json!("6m")),
                    "points": points,
                });

                trace.push(TraceEvent {
                    ts_ms: now_ms(),
                    kind: "tool".to_string(),
                    name: "fetch_nav_trend".to_string(),
                    ok: Some(true),
                    args: Some(json!({"fund_id": fund_code, "range": "6m"})),
                    result: Some(json!({"points": total_points})),
                });
            }
            Err(message) => {
                trace.push(TraceEvent {
                    ts_ms: now_ms(),
                    kind: "tool".to_string(),
                    name: "fetch_nav_trend".to_string(),
                    ok: Some(false),
                    args: Some(json!({"fund_id": fund_code, "range": "6m"})),
                    result: Some(json!({"message": message})),
                });
            }
        }

        match upstream_get_json(
            &state.http,
            &format!("/api/v1/funds/{}/announcements?page_index=1&page_size=6&type=0", fund_code),
        )
        .await
        {
            Ok(ann) => {
                let count = ann
                    .get("items")
                    .and_then(|v| v.as_array())
                    .map(|v| v.len())
                    .unwrap_or(0);
                ctx["fund_announcements"] = ann;
                trace.push(TraceEvent {
                    ts_ms: now_ms(),
                    kind: "tool".to_string(),
                    name: "fetch_announcements".to_string(),
                    ok: Some(true),
                    args: Some(json!({"fund_id": fund_code, "page_size": 6, "type": 0})),
                    result: Some(json!({"items": count})),
                });
            }
            Err(message) => {
                trace.push(TraceEvent {
                    ts_ms: now_ms(),
                    kind: "tool".to_string(),
                    name: "fetch_announcements".to_string(),
                    ok: Some(false),
                    args: Some(json!({"fund_id": fund_code, "page_size": 6, "type": 0})),
                    result: Some(json!({"message": message})),
                });
            }
        }
    }

    (ctx, trace)
}

fn build_prompt(mode: AgentMode, convo: &Conversation, user_message: &str, invest_ctx: Option<Value>) -> String {
    let mut history_lines: Vec<String> = vec![];
    // Use last 18 messages.
    let tail = convo
        .messages
        .iter()
        .rev()
        .take(18)
        .cloned()
        .collect::<Vec<_>>();
    for m in tail.into_iter().rev() {
        let who = if m.role == "assistant" { "助手" } else { "用户" };
        history_lines.push(format!("{who}: {}", m.text));
    }

    let summary = convo.summary.trim();
    let summary_block = if summary.is_empty() {
        "".to_string()
    } else {
        format!("【对话摘要】\n{}\n\n", summary)
    };

    match mode {
        AgentMode::Chat => format!(
            "你是 FundSight 桌面端里的通用助手。你可以闲聊、写作、给建议、做规划。\n\n规则：\n- 不要编造你不知道的事实；必要时先问澄清问题。\n- 回答尽量简洁直接。\n\n{summary_block}【最近对话】\n{}\n\n【用户消息】\n{}\n\n请回答：",
            history_lines.join("\n"),
            user_message
        ),
        _ => {
            let ctx = invest_ctx.unwrap_or(json!({}));
            let ctx_text = pretty_json_truncated(&ctx, 6000);
            format!(
                "你是 FundSight 的【投资助理】（桌面端）。你也可以正常聊天，但当问题涉及基金/组合时，必须结合给定本地数据回答。\n\n规则：\n- 不要编造数据；不确定就说不确定，并告诉我需要什么信息。\n- 输出结构：①结论（1-3 条）②依据（引用下方数据点/时间）③行动建议（分批/止盈止损/观察条件）④风险提示。\n- 组合问题：先给组合层面结论，并点名贡献最大的 1-3 只基金。\n- 单基金问题：结合估值、净值趋势、前十大持仓给建议。\n- 不要输出 JSON。\n\n重要：盘中估值为参考，不构成投资建议。\n\n{summary_block}【最近对话】\n{}\n\n【用户消息】\n{}\n\n【已知数据（JSON，仅供参考）】\n{}\n\n请回答：",
                history_lines.join("\n"),
                user_message,
                ctx_text
            )
        }
    }
}

pub async fn chat_stream(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatStreamBody>,
) -> impl IntoResponse {
    let message = body.message.trim().to_string();
    if message.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "message": "message 不能为空" })),
        )
            .into_response();
    }

    let convo_id = match body.conversation_id.clone() {
        Some(id) if !id.trim().is_empty() => id,
        _ => match ensure_default_conversation(&state).await {
            Ok(id) => id,
            Err(message) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "message": message })),
                )
                    .into_response();
            }
        },
    };

    let mut convo = match load_conversation(&state.agent_root, &convo_id).await {
        Ok(v) => v,
        Err(_) => new_conversation(convo_id.clone(), "新对话".to_string(), AgentMode::Auto),
    };

    // Mode resolution.
    let mut effective_mode = body.mode.clone().unwrap_or(convo.mode.clone());
    if matches!(effective_mode, AgentMode::Auto) {
        effective_mode = classify_mode_auto(&message);
    }

    // Tool shortcuts (invest/auto only; chat still allowed to use but won’t include finance context).
    if !matches!(effective_mode, AgentMode::Chat) {
        if let Some(resp) = apply_tool_shortcuts(&state, &mut convo, &message).await {
            return resp;
        }
    }

    // Record user message.
    convo.messages.push(AgentMessage {
        role: "user".to_string(),
        text: message.clone(),
        ts_ms: now_ms(),
        meta: None,
        ui_actions: vec![],
        trace: vec![],
    });
    convo.messages = cap_messages(convo.messages.clone());
    convo.updated_at_ms = now_ms();

    // Summarize (async but awaited before generation).
    maybe_summarize_conversation(state.clone(), &mut convo).await;

    // Save user turn.
    let _ = save_conversation(&state.agent_root, &convo).await;

    let view = view_from_conversation(&convo);
    {
        let mut store = state.agent_store.write().await;
        store.upsert_view(view);
        let _ = store.save(&state.agent_root);
    }

    // LLM config.
    let cfg = state.llm.read().await.clone();
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return sse_simple("请先在【设置 → AI】里配置协议/地址/模型。".to_string());
    }

    let api_key = match get_api_key() {
        Ok(v) => v,
        Err(message) => return sse_simple(format!("{message}")),
    };

    let (invest_ctx, mut tool_trace) = if matches!(effective_mode, AgentMode::Invest) {
        let (ctx, trace) = build_invest_context(&state, &body).await;
        (Some(ctx), trace)
    } else {
        (None, vec![])
    };

    // Planner (lightweight): emit a plan trace event.
    let steps = if matches!(effective_mode, AgentMode::Invest) {
        vec![
            "fetch_portfolio",
            "fetch_intraday_estimate (optional)",
            "fetch_top_holdings (optional)",
            "fetch_nav_trend (optional)",
            "fetch_announcements (optional)",
            "llm_answer",
        ]
    } else {
        vec!["llm_answer"]
    };

    let plan_event = TraceEvent {
        ts_ms: now_ms(),
        kind: "plan".to_string(),
        name: "plan".to_string(),
        ok: None,
        args: Some(json!({ "mode": match effective_mode { AgentMode::Chat => "chat", AgentMode::Invest => "invest", AgentMode::Auto => "auto" }, "steps": steps })),
        result: None,
    };

    // Prepend plan into trace.
    tool_trace.insert(0, plan_event.clone());

    let prompt = build_prompt(effective_mode.clone(), &convo, &message, invest_ctx);

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(64);
    let client = state.http.clone();
    let llm_cfg = cfg.clone();
    let convo_id_clone = convo_id.clone();
    let agent_root = state.agent_root.clone();
    let agent_store = state.agent_store.clone();
    let mode_label = match effective_mode {
        AgentMode::Chat => "chat",
        AgentMode::Invest => "invest",
        AgentMode::Auto => "auto",
    }
    .to_string();
    let trace_to_persist = tool_trace.clone();
    let first_user_message = message.clone();

    tauri::async_runtime::spawn(async move {
        // Let UI know which mode was used.
        let _ = tx
            .send(Ok(Event::default().event("meta").data(
                json!({"mode": mode_label}).to_string(),
            )))
            .await;

        // Emit plan/tool traces.
        for ev in trace_to_persist.iter() {
            let event_name = if ev.kind == "plan" { "plan" } else { "tool" };
            let payload = serde_json::to_string(ev).unwrap_or_else(|_| "{}".to_string());
            let _ = tx
                .send(Ok(Event::default().event(event_name).data(payload)))
                .await;
        }

        let system = if mode_label == "chat" {
            "你是 FundSight 的通用助手。可以闲聊、写作、做规划。回答简洁直接。".to_string()
        } else {
            "你是 FundSight 的基金投资助手。只输出可读文本，不要输出JSON。".to_string()
        };

        let result = match llm_cfg.protocol {
            LlmProtocol::Openai_compatible => {
                crate::openai_stream_with_system(
                    client,
                    llm_cfg.base_url,
                    llm_cfg.model,
                    api_key,
                    system.clone(),
                    prompt,
                )
                .await
            }
            LlmProtocol::Openai_responses => {
                crate::openai_responses_stream_with_system(
                    client,
                    llm_cfg.base_url,
                    llm_cfg.model,
                    api_key,
                    system.clone(),
                    prompt,
                )
                .await
            }
            LlmProtocol::Anthropic_messages => {
                crate::anthropic_stream_with_system(
                    client,
                    llm_cfg.base_url,
                    llm_cfg.model,
                    api_key,
                    system.clone(),
                    prompt,
                )
                .await
            }
        };

        match result {
            Ok(mut stream) => {
                let mut full = String::new();
                while let Some(item) = futures::StreamExt::next(&mut stream).await {
                    match item {
                        Ok(delta) => {
                            full.push_str(&delta);
                            let _ = tx.send(Ok(Event::default().event("delta").data(delta))).await;
                        }
                        Err(message) => {
                            let _ = tx
                                .send(Ok(Event::default().event("error").data(message)))
                                .await;
                            break;
                        }
                    }
                }

                // Persist assistant message.
                if !full.trim().is_empty() {
                    if let Ok(mut convo) = load_conversation(&agent_root, &convo_id_clone).await {
                        convo.messages.push(AgentMessage {
                            role: "assistant".to_string(),
                            text: truncate_string_chars(full.trim(), 4000),
                            ts_ms: now_ms(),
                            meta: Some(json!({"mode": mode_label})),
                            ui_actions: vec![],
                            trace: vec![],
                        });
                        convo.messages = cap_messages(convo.messages.clone());
                        convo.updated_at_ms = now_ms();
                        let _ = save_conversation(&agent_root, &convo).await;
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
                .interval(std::time::Duration::from_secs(15))
                .text("ping"),
        )
        .into_response()
}

pub async fn reset_conversation(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let mut convo = match load_conversation(&state.agent_root, &id).await {
        Ok(v) => v,
        Err(message) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "message": message })),
            )
                .into_response();
        }
    };

    convo.messages.clear();
    convo.summary.clear();
    convo.summary_upto = 0;
    convo.pending_action = None;
    convo.updated_at_ms = now_ms();

    if let Err(message) = save_conversation(&state.agent_root, &convo).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": message })),
        )
            .into_response();
    }

    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

// Back-compat helper: allow /assistant memory reset to also reset default conversation.
pub async fn migrate_legacy_assistant_state_if_needed(state: &Arc<AppState>) {
    let has_any = { !state.agent_store.read().await.conversations.is_empty() };
    if has_any {
        return;
    }
    let _ = ensure_default_conversation(state).await;
}
