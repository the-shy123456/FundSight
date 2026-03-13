use serde_json::Value;

#[derive(Debug, Clone, Copy, Default)]
pub struct NavMetrics {
    pub momentum: f64,
    pub volatility: f64,
    pub max_drawdown: f64,
}

fn safe_div(n: f64, d: f64) -> f64 {
    if d.abs() < 1e-12 {
        0.0
    } else {
        n / d
    }
}

/// Compute basic NAV metrics from nav-trend points.
///
/// Expected point format: { x, date, nav } (see nav.rs).
pub fn compute_nav_metrics(points: &[Value]) -> NavMetrics {
    let mut navs: Vec<f64> = points
        .iter()
        .filter_map(|p| p.get("nav").and_then(|v| v.as_f64()))
        .filter(|v| *v > 0.0)
        .collect();

    if navs.len() < 3 {
        return NavMetrics::default();
    }

    // Keep a recent window to reduce noise/latency.
    let window = 90usize;
    if navs.len() > window {
        navs = navs[navs.len() - window..].to_vec();
    }

    let first = navs.first().copied().unwrap_or(0.0);
    let last = navs.last().copied().unwrap_or(0.0);
    let momentum = safe_div(last - first, first);

    // Daily returns volatility.
    let mut rets: Vec<f64> = Vec::with_capacity(navs.len().saturating_sub(1));
    for pair in navs.windows(2) {
        let a = pair[0];
        let b = pair[1];
        if a > 0.0 {
            rets.push((b - a) / a);
        }
    }

    let mean = if rets.is_empty() {
        0.0
    } else {
        rets.iter().sum::<f64>() / rets.len() as f64
    };

    let var = if rets.len() < 2 {
        0.0
    } else {
        rets.iter()
            .map(|r| {
                let d = r - mean;
                d * d
            })
            .sum::<f64>()
            / (rets.len() as f64 - 1.0)
    };
    let volatility = var.sqrt();

    // Max drawdown.
    let mut peak = navs[0];
    let mut max_drawdown = 0.0;
    for &nav in &navs {
        if nav > peak {
            peak = nav;
        }
        if peak > 0.0 {
            let dd = (peak - nav) / peak;
            if dd > max_drawdown {
                max_drawdown = dd;
            }
        }
    }

    NavMetrics {
        momentum,
        volatility,
        max_drawdown,
    }
}
