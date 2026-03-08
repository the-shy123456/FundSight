const VIEW_META = {
  overview: {
    title: "持仓总览",
    subtitle: "像养基宝一样先看账户资产、当日总收益和每只基金的关键列。",
  },
  library: {
    title: "基金库",
    subtitle: "浏览真实基金池，按名称、代码、主题筛选可关注的基金。",
  },
  add: {
    title: "添加持仓",
    subtitle: "先选添加方式，再进入手动输入或后续的截图识别。",
  },
  manual: {
    title: "手动输入",
    subtitle: "按基金代码、持有金额、持有收益录入，系统自动换算成本和份额。",
  },
  assistant: {
    title: "金融分析助手",
    subtitle: "先把持仓看清楚，再问 AI 为什么涨跌、接下来什么时候更适合卖。",
  },
};

const STORAGE_KEYS = {
  manualRows: "warm-white-manual-rows",
  assistantQuestion: "warm-white-assistant-question",
};

const DEFAULT_BOOTSTRAP_ROWS = [
  { fundQuery: "005827", amount: "3109.64", profit: "65.62" },
  { fundQuery: "161725", amount: "1595.04", profit: "24.24" },
  { fundQuery: "002190", amount: "2416.96", profit: "-13.44" },
];

const EMPTY_ROW = () => ({ fundQuery: "", fundName: "", amount: "", profit: "" });

const state = {
  activeView: "overview",
  snapshot: null,
  manualRows: restoreManualRows(),
  manualSearch: {},
  searchTimers: {},
  fundLibrary: {
    query: "",
    page: 1,
    pageSize: 30,
    total: 0,
    items: [],
  },
};

function restoreManualRows() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.manualRows);
    if (!raw) {
      return [EMPTY_ROW()];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) {
      return [EMPTY_ROW()];
    }
    return parsed.map((item) => ({
      fundQuery: String(item.fundQuery ?? ""),
      fundName: String(item.fundName ?? ""),
      amount: String(item.amount ?? ""),
      profit: String(item.profit ?? ""),
    }));
  } catch {
    return [EMPTY_ROW()];
  }
}

function saveManualRows() {
  localStorage.setItem(STORAGE_KEYS.manualRows, JSON.stringify(state.manualRows));
}

function restoreAssistantQuestion() {
  return localStorage.getItem(STORAGE_KEYS.assistantQuestion) || "为什么最近会跌？接下来什么时候更适合卖？";
}

function saveAssistantQuestion(value) {
  localStorage.setItem(STORAGE_KEYS.assistantQuestion, value);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    let message = `请求失败: ${response.status}`;
    try {
      const payload = await response.json();
      if (payload.message) {
        message = payload.message;
      }
    } catch {
    }
    throw new Error(message);
  }
  return response.json();
}

function riskLevelLabel(value) {
  return {
    low: "低风险",
    medium: "中风险",
    high: "高风险",
  }[String(value || "").toLowerCase()] ?? (value || "--");
}

async function requestFundsCatalog({ query = "", page = 1, pageSize = 30 } = {}) {
  const search = String(query ?? "").trim();
  const url = search
    ? `/api/v1/funds?q=${encodeURIComponent(search)}`
    : `/api/v1/funds?page=${page}&page_size=${pageSize}`;
  return fetchJson(url);
}

async function requestFundSearch(keyword) {
  const query = String(keyword ?? '').trim();
  if (!query) {
    return [];
  }
  const payload = await fetchJson(`/api/v1/funds/search?q=${encodeURIComponent(query)}`);
  return Array.isArray(payload.items) ? payload.items : [];
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("截图读取失败，请重新选择图片"));
    reader.readAsDataURL(file);
  });
}

async function requestHoldingsOcr(file) {
  const imageBase64 = await fileToDataUrl(file);
  return fetchJson("/api/v1/holdings/ocr", {
    method: "POST",
    body: JSON.stringify({ image_base64: imageBase64 }),
  });
}

function applyOcrSuggestions(payload) {
  const suggestions = Array.isArray(payload.suggestions) ? payload.suggestions : [];
  if (!suggestions.length) {
    throw new Error(payload.warnings?.[0] || "没有从截图里稳定识别出持仓，请改用手动输入");
  }

  state.manualRows = suggestions.map((item) => ({
    fundQuery: String(item.fundQuery || item.fundName || ""),
    fundName: String(item.fundName || ""),
    amount: String(item.amount || ""),
    profit: String(item.profit || ""),
  }));
  state.manualSearch = {};
  saveManualRows();
  renderManualRows();
  setView("manual");
  const hint = payload.warnings?.[0] || `已从截图识别出 ${suggestions.length} 只基金，请检查后完成导入。`;
  document.querySelector("#manual-status").textContent = hint;
  document.querySelector("#picker-status").textContent = hint;
}

function closeSearchDropdown(index) {
  delete state.manualSearch[index];
}

async function queueFundSearch(index, keyword) {
  const query = String(keyword ?? '').trim();
  if (state.searchTimers[index]) {
    clearTimeout(state.searchTimers[index]);
  }
  if (query.length < 2 && !normalizeFundCode(query)) {
    closeSearchDropdown(index);
    renderManualRows();
    return;
  }
  state.searchTimers[index] = setTimeout(async () => {
    try {
      const items = await requestFundSearch(query);
      if (String(state.manualRows[index]?.fundQuery ?? '').trim() !== query) {
        return;
      }
      state.manualSearch[index] = items.slice(0, 5);
      renderManualRows();
    } catch {
      closeSearchDropdown(index);
      renderManualRows();
    }
  }, 220);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatCurrency(value) {
  return `¥${parseNumber(value).toFixed(2)}`;
}

function formatSignedCurrency(value) {
  const number = parseNumber(value);
  const sign = number > 0 ? "+" : "";
  return `${sign}${formatCurrency(number)}`;
}

function formatSignedPercent(value) {
  const number = parseNumber(value);
  const sign = number > 0 ? "+" : "";
  return `${sign}${(number * 100).toFixed(2)}%`;
}

function numberClass(value) {
  const number = parseNumber(value);
  if (number > 0) return "number-up";
  if (number < 0) return "number-down";
  return "number-flat";
}

function truncateText(value, maxLength = 12) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function normalizeFundCode(value) {
  const match = String(value ?? "").match(/(\d{6})/);
  return match ? match[1] : "";
}

function validManualRowCount() {
  return state.manualRows.filter((item) => normalizeFundCode(item.fundQuery) && parseNumber(item.amount) > 0).length;
}

function setView(viewName) {
  state.activeView = viewName;
  const meta = VIEW_META[viewName] || VIEW_META.overview;
  document.querySelector("#page-title").textContent = meta.title;
  document.querySelector("#page-subtitle").textContent = meta.subtitle;
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === viewName);
  });
  document.querySelectorAll(".view-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === viewName);
  });
}

function renderManualRows() {
  const container = document.querySelector("#manual-rows");
  container.innerHTML = state.manualRows
    .map((row, index) => {
      const suggestions = state.manualSearch[index] || [];
      const selectedLabel = row.fundName
        ? `<div class="selected-fund-label">已选择：${escapeHtml(row.fundName)}（${escapeHtml(normalizeFundCode(row.fundQuery))}）</div>`
        : `<div class="search-hint">支持输入 6 位基金代码，或直接输入基金名称搜索。</div>`;
      const dropdown = suggestions.length
        ? `
          <div class="search-dropdown">
            ${suggestions
              .map(
                (item) => `
                  <button
                    type="button"
                    class="search-option"
                    data-pick-fund="${index}"
                    data-fund-id="${escapeHtml(item.fund_id)}"
                    data-fund-name="${escapeHtml(item.name)}"
                  >
                    <strong>${escapeHtml(item.name)}</strong>
                    <span>${escapeHtml(item.fund_id)} · ${escapeHtml(item.category)} · ${escapeHtml(item.theme)}</span>
                  </button>
                `,
              )
              .join("")}
          </div>
        `
        : "";
      return `
        <div class="manual-row" data-row-index="${index}">
          <label class="manual-field fund-field">
            <span>持有基金</span>
            <input type="text" data-field="fundQuery" value="${escapeHtml(row.fundQuery)}" placeholder="请选择基金代码或名称" autocomplete="off" />
            ${selectedLabel}
            ${dropdown}
          </label>
          <label class="manual-field">
            <span>持有金额</span>
            <input type="number" data-field="amount" value="${escapeHtml(row.amount)}" placeholder="请输入该基金的持有金额" min="0" step="0.01" />
          </label>
          <label class="manual-field">
            <span>持有收益</span>
            <input type="number" data-field="profit" value="${escapeHtml(row.profit)}" placeholder="请输入该基金的持有收益" step="0.01" />
          </label>
          ${state.manualRows.length > 1 ? `<button type="button" class="delete-row" data-delete-row="${index}">删除</button>` : `<span></span>`}
        </div>
      `;
    })
    .join("");
  const completeButton = document.querySelector("#complete-manual");
  completeButton.textContent = `完成(${validManualRowCount()})`;
  completeButton.disabled = validManualRowCount() === 0;
}

function renderFundLibrary(payload, query = state.fundLibrary.query) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  state.fundLibrary = {
    query,
    page: Number(payload.page || 1),
    pageSize: Number(payload.page_size || state.fundLibrary.pageSize || items.length || 30),
    total: Number(payload.total || items.length),
    items,
  };

  document.querySelector("#catalog-count").textContent = `${state.fundLibrary.total} 只基金`;
  document.querySelector("#catalog-hint").textContent = query
    ? `当前显示“${query}”的搜索结果。`
    : "当前显示真实基金池分页列表，可直接搜索基金名称、代码或主题。";
  document.querySelector("#catalog-page").textContent = `第 ${state.fundLibrary.page} 页`;
  document.querySelector("#catalog-prev").disabled = state.fundLibrary.page <= 1;
  document.querySelector("#catalog-next").disabled = state.fundLibrary.items.length < state.fundLibrary.pageSize && !query;

  const container = document.querySelector("#catalog-list");
  if (!items.length) {
    container.innerHTML = `
      <div class="catalog-row catalog-empty-row">
        <div class="catalog-name-block">
          <strong>没有找到基金</strong>
          <p class="holding-meta">可以换个关键词试试，例如“白酒”“医药”“易方达”。</p>
        </div>
        <div></div><div></div><div></div><div></div>
      </div>
    `;
    return;
  }

  container.innerHTML = items
    .map((item) => {
      const nav = item.latest_nav ?? item.latestNav;
      const statusText = nav ? `最新净值 ${Number(nav).toFixed(4)}` : (item.manager ? `经理 ${item.manager}` : "支持进一步查看");
      return `
        <div class="catalog-row">
          <div class="catalog-name-block">
            <strong>${escapeHtml(item.name)}</strong>
            <p class="holding-meta">${escapeHtml(item.fund_id)}${item.manager ? ` · 经理 ${escapeHtml(item.manager)}` : ""}</p>
          </div>
          <div>${escapeHtml(item.category || "--")}</div>
          <div>${escapeHtml(item.theme || "--")}</div>
          <div><span class="risk-pill risk-${escapeHtml(String(item.risk_level || "medium"))}">${escapeHtml(riskLevelLabel(item.risk_level))}</span></div>
          <div class="catalog-status">${escapeHtml(statusText)}</div>
        </div>
      `;
    })
    .join("");
}

async function loadFundLibrary({ query = state.fundLibrary.query, page = state.fundLibrary.page, pageSize = state.fundLibrary.pageSize } = {}) {
  document.querySelector("#catalog-count").textContent = "加载中";
  const payload = await requestFundsCatalog({ query, page, pageSize });
  renderFundLibrary(payload, query);
}

function renderOverview(snapshot) {
  state.snapshot = snapshot;
  const summary = snapshot?.summary ?? {};
  const currentValue = summary.current_value ?? summary.market_value ?? 0;
  const todayProfit = summary.today_profit ?? summary.today_estimated_pnl ?? summary.estimated_today_pnl ?? 0;
  const todayReturn = summary.today_return ?? summary.today_estimated_return ?? summary.estimated_today_return ?? 0;

  document.querySelector("#account-asset").textContent = formatCurrency(currentValue);
  document.querySelector("#today-profit").textContent = formatSignedCurrency(todayProfit);
  document.querySelector("#today-profit").className = numberClass(todayProfit);
  document.querySelector("#asset-note").textContent = `共 ${summary.holding_count ?? 0} 只基金 · ${snapshot?.as_of ?? "已同步"}`;
  document.querySelector("#profit-note").textContent = formatSignedPercent(todayReturn);
  document.querySelector("#profit-note").className = numberClass(todayProfit);
  document.querySelector("#sidebar-time").textContent = snapshot?.as_of ?? new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  document.querySelector("#sidebar-note").textContent = snapshot?.disclaimer ?? "真实基金估值优先";

  const list = document.querySelector("#holding-list");
  const positions = snapshot?.positions ?? [];
  if (!positions.length) {
    list.innerHTML = `<div class="holding-row"><div class="holding-main"><strong>还没有持仓</strong><p class="holding-meta">先去“添加持仓”或“手动输入”页录一只基金。</p></div><div></div><div></div><div></div></div>`;
    renderAssistantFundOptions([]);
    return;
  }

  list.innerHTML = positions
    .map((item) => {
      const todayProfitValue = item.today_estimated_pnl ?? item.estimated_today_pnl ?? item.today_profit ?? item.valuation?.today_profit ?? 0;
      const todayReturnValue = item.today_estimated_return ?? item.estimated_today_return ?? item.today_return ?? item.valuation?.today_return ?? 0;
      const totalProfitValue = item.total_pnl ?? item.total_profit ?? item.valuation?.total_profit ?? 0;
      const totalReturnValue = item.total_return ?? item.valuation?.total_return ?? 0;
      const currentValueDisplay = item.current_value ?? item.market_value ?? item.valuation?.current_value ?? item.valuation?.market_value ?? 0;
      const proxyName = typeof item.proxy === "string" ? item.proxy : item.proxy?.name || item.theme || "--";
      const proxyRate = typeof item.proxy === "object" ? item.proxy?.change_rate ?? 0 : todayReturnValue;
      return `
        <div class="holding-row">
          <div class="holding-main">
            <div class="holding-title-row">
              <strong>${escapeHtml(truncateText(item.name, 12))}</strong>
            </div>
            <div class="holding-subline"><span class="update-chip">已更新</span> ${formatCurrency(currentValueDisplay)}</div>
          </div>
          <div class="metric-block ${numberClass(todayProfitValue)}">
            <div class="metric-value ${numberClass(todayProfitValue)}">${formatSignedCurrency(todayProfitValue)}</div>
            <div class="metric-subline ${numberClass(todayProfitValue)}">${formatSignedPercent(todayReturnValue)}</div>
          </div>
          <div class="metric-block align-left ${numberClass(proxyRate)}">
            <div class="metric-value ${numberClass(proxyRate)}">${formatSignedPercent(proxyRate)}</div>
            <div class="metric-subline">${escapeHtml(proxyName)}</div>
          </div>
          <div class="metric-block ${numberClass(totalProfitValue)}">
            <div class="metric-value ${numberClass(totalProfitValue)}">${formatSignedCurrency(totalProfitValue)}</div>
            <div class="metric-subline ${numberClass(totalProfitValue)}">${formatSignedPercent(totalReturnValue)}</div>
          </div>
        </div>
      `;
    })
    .join("");

  renderAssistantFundOptions(positions);
}

function renderAssistantFundOptions(positions) {
  const select = document.querySelector("#assistant-fund");
  const currentValue = select.value;
  if (!positions.length) {
    select.innerHTML = `<option value="">暂无持仓</option>`;
    return;
  }
  select.innerHTML = positions
    .map((item) => `<option value="${escapeHtml(item.fund_id)}">${escapeHtml(item.name)}</option>`)
    .join("");
  const matched = positions.find((item) => item.fund_id === currentValue);
  select.value = matched ? currentValue : positions[0].fund_id;
}

function renderAssistantPlaceholder(message) {
  document.querySelector("#assistant-result").innerHTML = `<p class="empty-copy">${escapeHtml(message)}</p>`;
}

function renderAssistantResult(payload) {
  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  const scenarios = Array.isArray(payload.scenarios) ? payload.scenarios : [];
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const risks = Array.isArray(payload.risks) ? payload.risks : [];

  document.querySelector("#assistant-result").innerHTML = `
    <div class="result-title">
      <div>
        <p class="card-kicker">AI Conclusion</p>
        <h3>${escapeHtml(payload.fund?.name ?? "持仓基金")}</h3>
        <p class="result-meta">${escapeHtml(payload.summary ?? "")}</p>
      </div>
      <span class="result-chip">置信度 ${Math.round((payload.confidence?.score ?? 0) * 100)}%</span>
    </div>
    <div class="result-section">
      <h4>为什么会这样</h4>
      <ul>${evidence.map((item) => `<li>${escapeHtml(`${item.label}：${item.value}，${item.detail}`)}</li>`).join("")}</ul>
    </div>
    <div class="result-section">
      <h4>接下来怎么做</h4>
      <ul>${actions.map((item) => `<li>${escapeHtml(`${item.title}（匹配度 ${item.fit}）：${item.detail}`)}</li>`).join("")}</ul>
    </div>
    <div class="result-section">
      <h4>情景预测</h4>
      <div class="scenario-grid">
        ${scenarios
          .map(
            (item) => `
              <article class="scenario-card">
                <h4>${escapeHtml(item.name)}</h4>
                <p>${escapeHtml(item.condition)}</p>
                <p>${escapeHtml(item.impact)}</p>
              </article>
            `,
          )
          .join("")}
      </div>
    </div>
    <div class="result-section">
      <h4>风险提示</h4>
      <ul>${risks.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </div>
  `;
}

async function buildImportTextFromRows(rows) {
  const validRows = rows.filter((item) => normalizeFundCode(item.fundQuery) && parseNumber(item.amount) > 0);
  if (!validRows.length) {
    throw new Error("请至少填写一只基金的代码和持有金额");
  }

  const lines = await Promise.all(
    validRows.map(async (row) => {
      const code = normalizeFundCode(row.fundQuery);
      if (!code) {
        throw new Error("当前先支持输入 6 位基金代码");
      }
      const amount = parseNumber(row.amount);
      const profit = parseNumber(row.profit);
      if (amount <= 0) {
        throw new Error(`基金 ${code} 的持有金额必须大于 0`);
      }
      const estimate = await fetchJson(`/api/v1/funds/${encodeURIComponent(code)}/intraday-estimate`);
      const nav = parseNumber(estimate.estimated_nav || estimate.latest_nav);
      if (nav <= 0) {
        throw new Error(`基金 ${code} 的估值数据异常`);
      }
      const costBasis = amount - profit;
      if (costBasis <= 0) {
        throw new Error(`基金 ${code} 的持有收益不能大于持有金额`);
      }
      const shares = amount / nav;
      const costNav = costBasis / shares;
      return `${code},${shares.toFixed(4)},${costNav.toFixed(4)}`;
    }),
  );

  return lines.join("\n");
}

async function importRows(rows, { switchToOverview = true, statusText = "正在同步持仓..." } = {}) {
  document.querySelector("#manual-status").textContent = statusText;
  const importText = await buildImportTextFromRows(rows);
  const snapshot = await fetchJson("/api/v1/holdings/import", {
    method: "POST",
    body: JSON.stringify({ text: importText }),
  });
  const nameMap = new Map((snapshot.positions || []).map((item) => [item.fund_id, item.name]));
  state.manualRows = rows.map((item) => {
    const code = normalizeFundCode(item.fundQuery);
    return {
      ...item,
      fundQuery: code || item.fundQuery,
      fundName: nameMap.get(code) || item.fundName || "",
    };
  });
  state.manualSearch = {};
  saveManualRows();
  renderManualRows();
  renderOverview(snapshot);
  if (switchToOverview) {
    setView("overview");
  }
  document.querySelector("#manual-status").textContent = "持仓已同步，当前总览已刷新。";
  return snapshot;
}

async function submitAssistant() {
  const fundId = document.querySelector("#assistant-fund").value;
  const question = document.querySelector("#assistant-question").value.trim();
  const cash = parseNumber(document.querySelector("#assistant-cash").value);
  if (!fundId) {
    throw new Error("请先导入持仓后再提问");
  }
  if (!question) {
    throw new Error("请输入你想提问的问题");
  }
  saveAssistantQuestion(question);
  renderAssistantPlaceholder("AI 正在结合你的持仓、收益和市场节奏生成建议...");
  const payload = await fetchJson("/api/v1/assistant/ask", {
    method: "POST",
    body: JSON.stringify({ fund_id: fundId, cash_available: cash, question }),
  });
  renderAssistantResult(payload);
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      const nextView = viewButton.dataset.view;
      setView(nextView);
      if (nextView === "library" && !state.fundLibrary.items.length) {
        loadFundLibrary().catch((error) => {
          document.querySelector("#catalog-hint").textContent = error.message;
          document.querySelector("#catalog-count").textContent = "加载失败";
        });
      }
      return;
    }

    const jumpButton = event.target.closest("[data-view-jump]");
    if (jumpButton) {
      const nextView = jumpButton.dataset.viewJump;
      setView(nextView);
      if (nextView === "library" && !state.fundLibrary.items.length) {
        loadFundLibrary().catch((error) => {
          document.querySelector("#catalog-hint").textContent = error.message;
          document.querySelector("#catalog-count").textContent = "加载失败";
        });
      }
      return;
    }

    if (event.target.closest("#pick-screenshot")) {
      document.querySelector("#screenshot-input").click();
      return;
    }

    if (event.target.closest("#go-manual")) {
      setView("manual");
      return;
    }

    if (event.target.closest("#add-row")) {
      state.manualRows.push(EMPTY_ROW());
      renderManualRows();
      saveManualRows();
      return;
    }

    const pickFundButton = event.target.closest("[data-pick-fund]");
    if (pickFundButton) {
      const index = Number(pickFundButton.dataset.pickFund);
      state.manualRows[index].fundQuery = String(pickFundButton.dataset.fundId || "");
      state.manualRows[index].fundName = String(pickFundButton.dataset.fundName || "");
      closeSearchDropdown(index);
      renderManualRows();
      saveManualRows();
      return;
    }

    const deleteButton = event.target.closest("[data-delete-row]");
    if (deleteButton) {
      const index = Number(deleteButton.dataset.deleteRow);
      state.manualRows.splice(index, 1);
      if (!state.manualRows.length) {
        state.manualRows.push(EMPTY_ROW());
      }
      renderManualRows();
      saveManualRows();
      return;
    }

    if (event.target.closest("#manual-reset")) {
      state.manualRows = [EMPTY_ROW()];
      state.manualSearch = {};
      renderManualRows();
      saveManualRows();
      document.querySelector("#manual-status").textContent = "已清空，你可以重新录入新的持仓。";
      return;
    }

    if (!event.target.closest(".fund-field") && Object.keys(state.manualSearch).length) {
      state.manualSearch = {};
      renderManualRows();
    }
  });

  document.querySelector("#manual-rows").addEventListener("input", (event) => {
    const row = event.target.closest("[data-row-index]");
    if (!row) {
      return;
    }
    const index = Number(row.dataset.rowIndex);
    const field = event.target.dataset.field;
    if (!field) {
      return;
    }
    state.manualRows[index][field] = event.target.value;
    if (field === "fundQuery") {
      state.manualRows[index].fundName = "";
      queueFundSearch(index, event.target.value);
    }
    saveManualRows();
    const completeButton = document.querySelector("#complete-manual");
    completeButton.textContent = `完成(${validManualRowCount()})`;
    completeButton.disabled = validManualRowCount() === 0;
  });

  document.querySelector("#manual-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await importRows(state.manualRows);
    } catch (error) {
      document.querySelector("#manual-status").textContent = error.message;
    }
  });

  document.querySelector("#catalog-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = document.querySelector("#catalog-query").value.trim();
    try {
      await loadFundLibrary({ query, page: 1, pageSize: state.fundLibrary.pageSize });
    } catch (error) {
      document.querySelector("#catalog-hint").textContent = error.message;
      document.querySelector("#catalog-count").textContent = "搜索失败";
    }
  });

  document.querySelector("#catalog-refresh").addEventListener("click", async () => {
    document.querySelector("#catalog-query").value = "";
    try {
      await loadFundLibrary({ query: "", page: 1, pageSize: state.fundLibrary.pageSize });
    } catch (error) {
      document.querySelector("#catalog-hint").textContent = error.message;
      document.querySelector("#catalog-count").textContent = "刷新失败";
    }
  });

  document.querySelector("#catalog-prev").addEventListener("click", async () => {
    if (state.fundLibrary.query || state.fundLibrary.page <= 1) {
      return;
    }
    await loadFundLibrary({ page: state.fundLibrary.page - 1, pageSize: state.fundLibrary.pageSize });
  });

  document.querySelector("#catalog-next").addEventListener("click", async () => {
    if (state.fundLibrary.query) {
      return;
    }
    await loadFundLibrary({ page: state.fundLibrary.page + 1, pageSize: state.fundLibrary.pageSize });
  });

  document.querySelector("#assistant-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await submitAssistant();
    } catch (error) {
      renderAssistantPlaceholder(error.message);
    }
  });

  document.querySelector("#screenshot-input").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      document.querySelector("#picker-status").textContent = "截图 OCR 已接入，你也可以继续使用手动输入。";
      return;
    }

    document.querySelector("#picker-status").textContent = `正在识别截图：${file.name} ...`;
    try {
      const payload = await requestHoldingsOcr(file);
      applyOcrSuggestions(payload);
    } catch (error) {
      document.querySelector("#picker-status").textContent = error.message;
    } finally {
      event.currentTarget.value = "";
    }
  });
}

async function bootstrap() {
  bindEvents();
  renderManualRows();
  document.querySelector("#assistant-question").value = restoreAssistantQuestion();
  renderAssistantPlaceholder("先选择一只持仓基金，再让 AI 解释为什么涨跌、什么时候更适合卖。");
  setView("overview");

  const bootstrapRows = validManualRowCount() ? state.manualRows : DEFAULT_BOOTSTRAP_ROWS;
  try {
    await Promise.all([
      importRows(bootstrapRows, {
        switchToOverview: false,
        statusText: "正在同步默认持仓...",
      }),
      loadFundLibrary({ page: 1, pageSize: state.fundLibrary.pageSize }),
    ]);
    document.querySelector("#catalog-query").value = "";

    document.querySelector("#picker-status").textContent = "你现在看到的是一版更完整的桌面基金工作台。";
  } catch (error) {
    document.querySelector("#asset-note").textContent = error.message;
    document.querySelector("#profit-note").textContent = "请先去“手动输入”页录入持仓。";
    document.querySelector("#holding-list").innerHTML = `<div class="holding-row"><div class="holding-main"><strong>持仓加载失败</strong><p class="holding-meta">${escapeHtml(error.message)}</p></div><div></div><div></div><div></div></div>`;
    renderAssistantPlaceholder("先完成持仓录入，再打开 AI 助手。");
  }
}

bootstrap().catch((error) => {
  document.querySelector("#asset-note").textContent = error.message;
});


