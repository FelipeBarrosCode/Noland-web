use std::{
    collections::HashMap,
    convert::Infallible,
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    extract::{Query, State as AxumState},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{sse::Event, IntoResponse, Response, Sse},
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{broadcast, oneshot, Mutex, RwLock};
use tokio_stream::wrappers::BroadcastStream;
use tracing::{info, warn};
use uuid::Uuid;

const HELPER_ADDRESS: &str = "127.0.0.1:43127";
static WEB_CLIENT_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn web_client_active() -> bool {
    WEB_CLIENT_ACTIVE.load(Ordering::SeqCst)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperRpcRequest {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperEvent {
    pub event: String,
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserRpcRequest {
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserRpcResponse {
    result: Option<Value>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    token: String,
}

#[derive(Clone)]
pub struct HelperBridge {
    app: AppHandle,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<BrowserRpcResponse>>>>,
    sessions: Arc<RwLock<HashMap<String, Instant>>>,
    events: broadcast::Sender<HelperEvent>,
    ready: Arc<AtomicBool>,
}

impl HelperBridge {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            events: broadcast::channel(256).0,
            ready: Arc::new(AtomicBool::new(false)),
        }
    }

    async fn session_valid(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        self.sessions
            .read()
            .await
            .get(token)
            .is_some_and(|expires_at| *expires_at > Instant::now())
    }
}

fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get("origin").and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let configured = std::env::var("NOLAND_WEB_ORIGIN").ok();
    configured.as_deref() == Some(origin)
        || matches!(
            origin,
            "https://noland-web-api.felipe-ba-moura.workers.dev"
                | "http://localhost:1420"
                | "http://127.0.0.1:1420"
        )
}

async fn cors(request: axum::extract::Request, next: Next) -> Response {
    let origin = request.headers().get("origin").cloned();
    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        apply_cors_headers(response.headers_mut(), origin.as_ref());
        return response;
    }
    let mut response = next.run(request).await;
    apply_cors_headers(response.headers_mut(), origin.as_ref());
    response
}

fn apply_cors_headers(headers: &mut HeaderMap, origin: Option<&HeaderValue>) {
    if let Some(origin) = origin {
        headers.insert("access-control-allow-origin", origin.clone());
    }
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET,POST,OPTIONS"),
    );
    headers.insert(
        "access-control-allow-headers",
        HeaderValue::from_static("authorization,content-type"),
    );
    headers.insert(
        "access-control-allow-private-network",
        HeaderValue::from_static("true"),
    );
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    headers.insert("vary", HeaderValue::from_static("Origin"));
}

async fn health(AxumState(bridge): AxumState<HelperBridge>) -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "ready": bridge.ready.load(Ordering::SeqCst),
        "service": "noland-helper",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn create_session(
    AxumState(bridge): AxumState<HelperBridge>,
    headers: HeaderMap,
) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "Origin is not allowed").into_response();
    }
    let token = Uuid::new_v4().to_string();
    WEB_CLIENT_ACTIVE.store(true, Ordering::SeqCst);
    if let Some(window) = bridge.app.get_webview_window("main") {
        let _ = window.hide();
    }
    bridge
        .sessions
        .write()
        .await
        .insert(token.clone(), Instant::now() + Duration::from_secs(43_200));
    Json(serde_json::json!({ "token": token, "expiresInSeconds": 43200 })).into_response()
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

async fn rpc(
    AxumState(bridge): AxumState<HelperBridge>,
    headers: HeaderMap,
    Json(request): Json<BrowserRpcRequest>,
) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "Origin is not allowed").into_response();
    }
    let Some(token) = bearer(&headers) else {
        return (StatusCode::UNAUTHORIZED, "Missing helper session").into_response();
    };
    if !bridge.session_valid(token).await {
        return (StatusCode::UNAUTHORIZED, "Invalid helper session").into_response();
    }
    if request.command.len() > 128
        || !request
            .command
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        return (StatusCode::BAD_REQUEST, "Invalid command name").into_response();
    }

    let id = Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    bridge.pending.lock().await.insert(id.clone(), sender);
    let bridge_request = HelperRpcRequest {
        id: id.clone(),
        command: request.command,
        args: request.args,
    };
    if let Err(error) = bridge.app.emit("helper:rpc-request", bridge_request) {
        bridge.pending.lock().await.remove(&id);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Native command bridge unavailable: {error}"),
        )
            .into_response();
    }

    match tokio::time::timeout(Duration::from_secs(300), receiver).await {
        Ok(Ok(response)) => Json(response).into_response(),
        Ok(Err(_)) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Native command bridge closed",
        )
            .into_response(),
        Err(_) => {
            bridge.pending.lock().await.remove(&id);
            (StatusCode::GATEWAY_TIMEOUT, "Native command timed out").into_response()
        }
    }
}

async fn events(
    AxumState(bridge): AxumState<HelperBridge>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
) -> Response {
    if !origin_allowed(&headers) || !bridge.session_valid(&query.token).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let stream = BroadcastStream::new(bridge.events.subscribe()).filter_map(|item| async move {
        match item {
            Ok(event) => Some(Ok::<Event, Infallible>(
                Event::default()
                    .event(event.event)
                    .json_data(event.payload)
                    .unwrap_or_default(),
            )),
            Err(_) => None,
        }
    });
    Sse::new(stream).into_response()
}

pub async fn run(bridge: HelperBridge) {
    let router = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/session", post(create_session))
        .route("/v1/rpc", post(rpc))
        .route("/v1/events", get(events))
        .layer(middleware::from_fn(cors))
        .with_state(bridge);
    let listener = match tokio::net::TcpListener::bind(HELPER_ADDRESS).await {
        Ok(listener) => listener,
        Err(error) => {
            warn!(%error, address = HELPER_ADDRESS, "failed to bind Noland helper server");
            return;
        }
    };
    info!(address = HELPER_ADDRESS, "Noland helper server listening");
    if let Err(error) = axum::serve(listener, router).await {
        warn!(%error, "Noland helper server stopped");
    }
}

#[tauri::command]
pub async fn helper_rpc_respond(
    id: String,
    result: Option<Value>,
    error: Option<String>,
    bridge: State<'_, HelperBridge>,
) -> Result<(), String> {
    let sender = bridge
        .pending
        .lock()
        .await
        .remove(&id)
        .ok_or_else(|| "Unknown helper request".to_string())?;
    let _ = sender.send(BrowserRpcResponse { result, error });
    Ok(())
}

#[tauri::command]
pub fn helper_bridge_ready(bridge: State<'_, HelperBridge>) {
    bridge.ready.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn helper_pick_upload_paths(
    app: AppHandle,
    directory: bool,
) -> Result<Vec<String>, String> {
    let selection = if directory {
        app.dialog().file().blocking_pick_folders()
    } else {
        app.dialog().file().blocking_pick_files()
    };
    Ok(selection
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .map(|path| path.display().to_string())
        .collect())
}

#[tauri::command]
pub fn helper_publish_event(
    event: String,
    payload: Value,
    bridge: State<'_, HelperBridge>,
) -> Result<(), String> {
    bridge
        .events
        .send(HelperEvent { event, payload })
        .map(|_| ())
        .map_err(|error| error.to_string())
}
