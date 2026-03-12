use directories::ProjectDirs;
use std::path::{Path, PathBuf};

pub fn storage_dir() -> PathBuf {
    if let Ok(value) = std::env::var("FUND_INSIGHT_STORAGE_DIR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    // Dev-mode compatibility: prefer a repo-level `.fund-insight/` if present.
    // We locate it relative to this crate (services/analysis_api_rs -> repo root).
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let repo_store = repo_root.join(".fund-insight");
    if repo_store.exists() {
        return repo_store;
    }

    // Fallback: if a `.fund-insight` exists in CWD, use it.
    let dev = PathBuf::from(".fund-insight");
    if dev.exists() {
        return dev;
    }

    if let Some(dirs) = ProjectDirs::from("com", "FundSight", "FundSight") {
        return dirs.data_dir().join("fund-insight");
    }

    PathBuf::from(".fund-insight")
}

pub fn holdings_path() -> PathBuf {
    if let Ok(value) = std::env::var("FUND_INSIGHT_HOLDINGS_PATH") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    storage_dir().join("holdings.json")
}

pub fn watchlist_path() -> PathBuf {
    if let Ok(value) = std::env::var("FUND_INSIGHT_WATCHLIST_PATH") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    storage_dir().join("watchlist.json")
}

pub fn ensure_parent(path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}
