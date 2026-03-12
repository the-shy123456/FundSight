use crate::storage;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

const MAX_WATCHLIST_ITEMS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchlistStore {
    pub items: Vec<String>,
    pub updated_at: String,
}

impl Default for WatchlistStore {
    fn default() -> Self {
        Self {
            items: vec![],
            updated_at: "".to_string(),
        }
    }
}

fn now_iso() -> String {
    // We keep it simple here; exact TZ formatting isn't critical.
    chrono::Local::now()
        .naive_local()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string()
}

pub fn load_watchlist() -> WatchlistStore {
    let path = storage::watchlist_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(v) => v,
        Err(_) => return WatchlistStore::default(),
    };
    serde_json::from_str::<WatchlistStore>(&raw).unwrap_or_default()
}

pub fn save_watchlist(items: &[String]) -> Result<()> {
    let path = storage::watchlist_path();
    storage::ensure_parent(&path).context("ensure watchlist dir")?;
    let payload = WatchlistStore {
        items: items.to_vec(),
        updated_at: now_iso(),
    };
    let content = serde_json::to_string_pretty(&payload)?;
    std::fs::write(&path, content).context("write watchlist")?;
    Ok(())
}

pub fn normalized_items(value: &[String]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut seen = std::collections::HashSet::new();
    for raw in value {
        let fund_id = raw.trim().to_uppercase();
        if fund_id.is_empty() || seen.contains(&fund_id) {
            continue;
        }
        seen.insert(fund_id.clone());
        out.push(fund_id);
        if out.len() >= MAX_WATCHLIST_ITEMS {
            break;
        }
    }
    out
}

pub fn add_watchlist_id(fund_id: &str) -> Result<()> {
    let cleaned = fund_id.trim().to_uppercase();
    if cleaned.is_empty() {
        return Err(anyhow!("fund_id 不能为空"));
    }

    let store = load_watchlist();
    let mut items = normalized_items(&store.items);
    if items.contains(&cleaned) {
        return Ok(());
    }
    if items.len() >= MAX_WATCHLIST_ITEMS {
        return Err(anyhow!("自选最多支持 50 只基金"));
    }
    items.push(cleaned);
    save_watchlist(&items)
}

pub fn remove_watchlist_id(fund_id: &str) -> Result<()> {
    let cleaned = fund_id.trim().to_uppercase();
    if cleaned.is_empty() {
        return Ok(());
    }

    let store = load_watchlist();
    let items = normalized_items(&store.items)
        .into_iter()
        .filter(|item| item != &cleaned)
        .collect::<Vec<_>>();
    save_watchlist(&items)
}
