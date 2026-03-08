const CHART_COLORS = ["#38bdf8", "#f59e0b", "#22c55e"];

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!response.ok) {
    throw new Error(`请求失败: ${response.status}`);
  }

  return response.json();
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function actionLabel(action) {
  return {
    buy: "建议买入",
    hold: "建议持有",
    watch: "建议观察",
  }[action] ?? action;
}

function getFundId() {
  const params = new URLSearchParams(window.location.search);
  return params.get("id") || "F001";
}

function buildLinePath(values, width, height, padding, minimum, maximum) {
  const xStep = (width - padding * 2) / Math.max(values.length - 1, 1);
  const usableHeight = height - padding * 2;
  const range = Math.max(maximum - minimum, 0.0001);

  return values
    .map((value, index) => {
      const x = padding + xStep * index;
      const y = padding + ((maximum - value) / range) * usableHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function renderChart(chart) {
  const width = 920;
  const height = 300;
  const padding = 28;
  const allValues = chart.series.flatMap((item) => item.values);
  const minimum = Math.min(...allValues);
  const maximum = Math.max(...allValues);
  const gridLines = Array.from({ length: 4 }, (_value, index) => {
    const y = padding + ((height - padding * 2) / 3) * index;
    return `<line x1="${padding}" y1="${y}" x2="${width - padding}" y2="${y}" stroke="rgba(148, 163, 184, 0.18)" stroke-width="1" />`;
  }).join("");
  const xLabels = chart.labels
    .map((label, index) => {
      const x = padding + ((width - padding * 2) / Math.max(chart.labels.length - 1, 1)) * index;
      return `<text x="${x}" y="${height - 8}" fill="rgba(147, 166, 191, 0.8)" font-size="11" text-anchor="middle">${label}</text>`;
    })
    .join("");
  const paths = chart.series
    .map((series, index) => {
      const color = CHART_COLORS[index % CHART_COLORS.length];
      return `<path d="${buildLinePath(series.values, width, height, padding, minimum, maximum)}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />`;
    })
    .join("");

  return `
    <div class="chart-frame">
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="基金净值走势图">
        ${gridLines}
        ${paths}
        ${xLabels}
      </svg>
      <div class="legend-row">
        ${chart.series
          .map((series, index) => {
            const color = CHART_COLORS[index % CHART_COLORS.length];
            const latest = series.values[series.values.length - 1];
            return `
              <span class="legend-pill">
                <span class="legend-dot" style="background:${color}"></span>
                ${series.name} · ${latest.toFixed(3)}
              </span>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderSnapshot(snapshot) {
  const fund = snapshot.fund;
  document.title = `Fund Insight Hub · ${fund.name}`;
  document.querySelector("#detail-time").textContent = `本地时间 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  document.querySelector("#fund-name").textContent = fund.name;
  document.querySelector("#fund-meta").textContent = `${fund.category} · ${fund.theme} · ${fund.risk_label} · 经理 ${fund.manager}`;
  document.querySelector("#fund-summary").textContent = snapshot.overview.summary;
  document.querySelector("#fund-tags").innerHTML = `
    <span class="tag">质量分 ${fund.quality_score}</span>
    <span class="tag">最新净值 ${snapshot.overview.latest_nav.toFixed(3)}</span>
    <span class="tag">任期 ${snapshot.overview.manager_tenure_years.toFixed(1)} 年</span>
    <span class="tag">费率 ${snapshot.overview.fee_rate_display}</span>
  `;

  document.querySelector("#hero-action").innerHTML = `
    <p class="section-kicker">Operation</p>
    <h3>${actionLabel(snapshot.operation.action)}</h3>
    <p>建议时机：${snapshot.operation.timing}</p>
    <p>建议金额：¥${snapshot.operation.amount.toFixed(0)}</p>
    <p>${snapshot.operation.detail}</p>
    <p>默认画像：${snapshot.default_investor_profile.risk_level} 风险，预算 ¥${snapshot.default_investor_profile.monthly_budget.toFixed(0)}</p>
    <p>置信度 ${(snapshot.operation.confidence * 100).toFixed(0)}%</p>
  `;

  const metricCards = [
    ...snapshot.score_breakdown,
    { label: "观察点", display: `${fund.observation_points} 期` },
    { label: "起始净值", display: fund.initial_nav.toFixed(3) },
  ];

  document.querySelector("#metric-grid").innerHTML = metricCards
    .map(
      (item) => `
        <article class="metric-card">
          <span>${item.label}</span>
          <strong>${item.display}</strong>
          <p>用于辅助判断基金当前节奏与配置价值。</p>
        </article>
      `,
    )
    .join("");

  document.querySelector("#watch-points").innerHTML = snapshot.cautions
    .map((item) => `<li>${item}</li>`)
    .join("");

  document.querySelector("#research-highlights").innerHTML = snapshot.strengths
    .map((item) => `<li>${item}</li>`)
    .join("");

  document.querySelector("#nav-chart").innerHTML = renderChart(snapshot.chart);

  document.querySelector("#peer-list").innerHTML = snapshot.peer_recommendations
    .map(
      (peer) => `
        <article class="peer-card">
          <div class="tag-row">
            <span class="badge">${peer.risk_label}</span>
            <span class="badge">质量分 ${peer.quality_score}</span>
          </div>
          <h3>${peer.name}</h3>
          <p>${peer.theme}</p>
          <p>阶段收益 ${formatPercent(peer.metrics.period_return)}</p>
          <p>${peer.reason}</p>
          <a class="peer-link" href="/fund.html?id=${encodeURIComponent(peer.fund_id)}">查看这只基金</a>
        </article>
      `,
    )
    .join("");
}

function renderError(message) {
  document.querySelector(".page-shell").innerHTML = `
    <section class="error-box">
      <h1>详情加载失败</h1>
      <p>${message}</p>
      <a class="back-link" href="/">回到首页</a>
    </section>
  `;
  document.querySelector("#detail-time").textContent = "加载失败";
}

async function bootstrap() {
  const fundId = getFundId();
  const snapshot = await fetchJson(`/api/v1/funds/${encodeURIComponent(fundId)}/snapshot`);
  renderSnapshot(snapshot);
}

bootstrap().catch((error) => {
  renderError(error.message);
});
