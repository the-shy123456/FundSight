use regex::Regex;

pub fn strip_tags(input: &str) -> String {
    static TAG_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = TAG_RE.get_or_init(|| Regex::new(r"<[^>]*>").expect("tag regex"));
    re.replace_all(input, "").trim().to_string()
}

pub fn extract_apidata_content(source: &str) -> String {
    // Matches: content: "..." or content: '...'
    static RE_DQ: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static RE_SQ: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

    let re_dq = RE_DQ.get_or_init(|| {
        Regex::new(r#"content\s*:\s*\"((?:\\.|[^\"\\])*)\""#)
            .expect("content dq regex")
    });
    let re_sq = RE_SQ.get_or_init(|| {
        Regex::new(r#"content\s*:\s*'((?:\\.|[^'\\])*)'"#).expect("content sq regex")
    });

    let raw = if let Some(caps) = re_dq.captures(source) {
        caps.get(1).map(|m| m.as_str()).unwrap_or("")
    } else if let Some(caps) = re_sq.captures(source) {
        caps.get(1).map(|m| m.as_str()).unwrap_or("")
    } else {
        ""
    };

    if raw.is_empty() {
        return "".to_string();
    }

    // Decode JS string escapes by parsing as JSON string.
    let wrapped = format!("\"{}\"", raw);
    match serde_json::from_str::<String>(&wrapped) {
        Ok(value) => value,
        Err(_) => raw.replace("\\/", "/"),
    }
}
