// AI Expense Tracker frontend - talks to the Flask REST API with fetch().

const form = document.getElementById("expense-form");
const formPanel = document.getElementById("form-panel");
const formError = document.getElementById("form-error");
const rowsEl = document.getElementById("expense-rows");
const filterEl = document.getElementById("filter");
const submitBtn = document.getElementById("submit-btn");
const cancelBtn = document.getElementById("cancel-btn");
const themeToggle = document.getElementById("theme-toggle");

const THEME_KEY = "ai-expense-tracker-theme";
const CATEGORIES = [...form.category.options].map((o) => o.value);
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" });
const moneyCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR", notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

let expenses = [];
let lastStats = null;
let categoryChart, monthChart;

// GSAP is optional: without the CDN (or with reduced motion) the UI simply appears without animation.
const motion = typeof gsap !== "undefined" && !matchMedia("(prefers-reduced-motion: reduce)").matches;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ---------- Helpers ----------

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// "#4f7cff" -> "rgba(79, 124, 255, a)"; other colour strings are returned unchanged.
function alpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Categories are coloured by spending rank (biggest = accent), the same in the chart and the table pills.
let categoryOrder = [...CATEGORIES];

function categoryVar(category) {
  const i = categoryOrder.indexOf(category);
  return `--c${(i < 0 ? categoryOrder.length - 1 : i) % 7 + 1}`;
}

function setCategoryOrder(byCategory) {
  const ranked = byCategory.map((r) => r.category);
  categoryOrder = [...ranked, ...CATEGORIES.filter((c) => !ranked.includes(c))];
  document.querySelectorAll(".cat").forEach((pill) => pill.style.setProperty("--dot", `var(${categoryVar(pill.textContent)})`));
}

function monthLabel(key, long = false) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", long ? { month: "long", year: "numeric" } : { month: "short" });
}

function monthKey(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ---------- Theme ----------

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function syncThemeButton() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  themeToggle.setAttribute("aria-label", `Switch to ${next} theme`);
}

themeToggle.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* storage blocked: theme just isn't remembered */ }
  syncThemeButton();
  if (motion) gsap.fromTo(themeToggle, { rotate: -30 }, { rotate: 0, duration: 0.5, ease: "back.out(2)", clearProps: "rotate" });
  if (lastStats) renderCharts(lastStats, { animate: false }); // charts read colours from CSS variables
});
syncThemeButton();

// ---------- Table ----------

async function loadExpenses() {
  const category = filterEl.value;
  const query = category ? `?category=${encodeURIComponent(category)}` : "";
  expenses = await api(`/api/expenses${query}`);
  renderTable();
}

let shownIds = null; // ids on screen; null until the first render
let filterChanged = false; // a filter change swaps the whole table: animate, but don't tint rows as new

function renderTable() {
  const rows = expenses.map(rowFor);
  rowsEl.replaceChildren(...rows);
  document.getElementById("empty").hidden = expenses.length > 0;

  const n = expenses.length;
  const where = filterEl.value ? ` in ${filterEl.value}` : "";
  document.getElementById("row-count").textContent =
    n === 0 ? `No expenses${where}` : `${n === 200 ? "Latest 200" : n} expense${n === 1 ? "" : "s"}${where}`;

  // Only rows that weren't on screen before animate in, so saving one expense doesn't replay the whole table.
  const fresh = rows.filter((_, i) => !shownIds || !shownIds.has(expenses[i].id));
  if (shownIds && fresh.length && fresh.length < rows.length && !filterChanged) {
    fresh.forEach((tr) => tr.classList.add("is-new"));       // tint the new/edited row, then let it fade
    setTimeout(() => fresh.forEach((tr) => tr.classList.remove("is-new")), 900);
  }
  if (motion && fresh.length) {
    gsap.from(fresh.slice(0, 25), { opacity: 0, y: 8, duration: 0.35, stagger: 0.03, ease: "power2.out", clearProps: "opacity,transform" });
  }
  shownIds = new Set(expenses.map((e) => e.id));
  filterChanged = false;
}

function rowFor(expense) {
  const tr = document.createElement("tr");
  // textContent (not innerHTML) so user input can never inject HTML.
  const date = document.createElement("td");
  date.className = "date";
  date.textContent = expense.spent_on;

  const desc = document.createElement("td");
  desc.className = "desc";
  desc.textContent = expense.description;
  desc.title = expense.description;
  const meta = document.createElement("span"); // phone layout: date and category under the description
  meta.className = "row-meta";
  meta.textContent = `${expense.spent_on} · ${expense.category}`;
  desc.append(meta);

  const cat = document.createElement("td");
  cat.className = "cat-cell";
  const pill = document.createElement("span");
  pill.className = "cat";
  pill.style.setProperty("--dot", `var(${categoryVar(expense.category)})`);
  pill.textContent = expense.category;
  cat.append(pill);

  const amount = document.createElement("td");
  amount.className = "num";
  amount.textContent = money.format(expense.amount);

  const actions = document.createElement("td");
  actions.className = "actions";
  actions.append(
    rowButton("pencil", "Edit", "row-btn", () => startEdit(expense, tr)),
    rowButton("trash", "Delete", "row-btn danger", () => deleteExpense(expense, tr)),
  );
  tr.append(date, desc, cat, amount, actions);
  return tr;
}

function rowButton(iconName, label, className, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(iconName));
  b.addEventListener("click", onClick);
  return b;
}

filterEl.addEventListener("change", () => { filterChanged = true; loadExpenses(); });

// ---------- Form (add / edit) ----------

function showError(message) {
  formError.replaceChildren(icon("alert"), document.createTextNode(message));
  if (motion) {
    gsap.fromTo(formError, { x: -6 }, { x: 0, duration: 0.5, ease: "elastic.out(1, 0.3)" });
    gsap.fromTo(submitBtn, { x: 6 }, { x: 0, duration: 0.5, ease: "elastic.out(1, 0.3)", clearProps: "transform" });
  }
}

function glow(target, strength = 0.35) {
  if (!motion) return;
  const accent = cssVar("--accent");
  gsap.fromTo(target,
    { boxShadow: `0 0 0 3px ${alpha(accent, strength)}, 0 12px 32px -12px ${alpha(accent, 0.5)}` },
    { boxShadow: `0 0 0 0px ${alpha(accent, 0)}, 0 12px 32px -12px ${alpha(accent, 0)}`, duration: 1.2, ease: "power2.out", clearProps: "boxShadow" });
}

function resetForm() {
  form.reset();
  form.expense_id.value = "";
  form.spent_on.value = new Date().toISOString().slice(0, 10);
  document.getElementById("form-title").textContent = "Add expense";
  submitBtn.textContent = "Add";
  cancelBtn.hidden = true;
  formError.textContent = "";
  formPanel.classList.remove("is-editing");
  clearAiFilled();
  const scan = document.getElementById("scan-result");
  if (scan) scan.hidden = true;
}

function startEdit(expense) {
  form.expense_id.value = expense.id;
  form.description.value = expense.description;
  form.amount.value = expense.amount;
  form.category.value = expense.category;
  form.spent_on.value = expense.spent_on;
  document.getElementById("form-title").textContent = "Edit expense";
  submitBtn.textContent = "Save";
  cancelBtn.hidden = false;
  formError.textContent = "";
  clearAiFilled();
  document.getElementById("scan-result").hidden = true;
  formPanel.classList.add("is-editing");
  form.scrollIntoView({ behavior: motion ? "smooth" : "auto", block: "center" });
  if (motion) gsap.delayedCall(0.3, () => glow(formPanel));
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    description: form.description.value,
    amount: form.amount.value,
    category: form.category.value,
    spent_on: form.spent_on.value,
  };
  const id = form.expense_id.value;
  submitBtn.disabled = true;
  try {
    await api(id ? `/api/expenses/${id}` : "/api/expenses", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    resetForm();
    glow(formPanel, 0.3); // success pulse
    await refresh();
  } catch (err) {
    showError(err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

cancelBtn.addEventListener("click", resetForm);

document.getElementById("new-expense-link").addEventListener("click", (event) => {
  event.preventDefault();
  resetForm();
  formPanel.scrollIntoView({ behavior: motion ? "smooth" : "auto", block: "center" });
  form.description.focus({ preventScroll: true });
  if (motion) gsap.delayedCall(0.25, () => glow(formPanel));
});

async function deleteExpense(expense, row) {
  if (!confirm(`Delete "${expense.description}"?`)) return;
  await api(`/api/expenses/${expense.id}`, { method: "DELETE" });
  if (motion) await gsap.to(row, { opacity: 0, x: 24, duration: 0.25, ease: "power1.in" });
  await refresh();
}

// ---------- Dashboard ----------

const counters = new Map(); // stat element -> { value } currently on screen

// Counts a stat from the value it shows now to the new one.
function countTo(el, value, format) {
  if (!motion) { el.textContent = format(value); return; }
  const state = counters.get(el) || { value: 0 };
  counters.set(el, state);
  gsap.killTweensOf(state);
  gsap.to(state, { value, duration: 0.9, ease: "power2.out", onUpdate: () => { el.textContent = format(state.value); } });
}

function setSub(id, ...parts) {
  document.getElementById(id).replaceChildren(...parts.map((p) => (typeof p === "string" ? document.createTextNode(p) : p)));
}

function deltaPill(now, before) {
  const span = document.createElement("span");
  if (!before) { span.className = "pill pill-flat"; span.textContent = "new"; return span; }
  const change = (now - before) / before;
  span.className = `pill ${Math.abs(change) < 0.005 ? "pill-flat" : change > 0 ? "pill-up" : "pill-down"}`;
  span.textContent = `${change > 0 ? "▲" : change < 0 ? "▼" : ""} ${percent.format(Math.abs(change))}`.trim();
  return span;
}

function renderSparkline(values) {
  const svg = document.getElementById("sparkline");
  if (!svg) return;
  svg.replaceChildren();
  if (values.length < 2) return;
  const max = Math.max(...values), min = Math.min(...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 26 - ((v - min) / (max - min || 1)) * 22]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  const defs = document.createElementNS(SVG_NS, "defs");
  const grad = document.createElementNS(SVG_NS, "linearGradient");
  grad.id = "spark-fill";
  grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0"); grad.setAttribute("x2", "0"); grad.setAttribute("y2", "1");
  [["0%", 0.35], ["100%", 0]].forEach(([offset, opacity]) => {
    const stop = document.createElementNS(SVG_NS, "stop");
    stop.setAttribute("offset", offset);
    stop.setAttribute("style", `stop-color: var(--accent); stop-opacity: ${opacity}`);
    grad.append(stop);
  });
  defs.append(grad);

  const area = document.createElementNS(SVG_NS, "path");
  area.setAttribute("class", "area");
  area.setAttribute("d", `${d} L100,28 L0,28 Z`);
  area.setAttribute("fill", "url(#spark-fill)");
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("class", "line");
  line.setAttribute("d", d);
  svg.append(defs, area, line);

  if (motion) {
    const len = line.getTotalLength();
    gsap.fromTo(line, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.1, ease: "power2.out", clearProps: "strokeDasharray,strokeDashoffset" });
    gsap.from(area, { opacity: 0, duration: 0.8, delay: 0.3 });
  }
}

function renderKpis(stats) {
  countTo(document.getElementById("stat-month"), stats.this_month, money.format);
  countTo(document.getElementById("stat-total"), stats.total, money.format);
  countTo(document.getElementById("stat-count"), stats.count, Math.round);

  const byMonth = Object.fromEntries(stats.by_month.map((r) => [r.month, r.total]));
  const lastMonth = byMonth[monthKey(-1)] || 0;
  if (stats.count) setSub("stat-month-sub", deltaPill(stats.this_month, lastMonth), `vs ${money.format(lastMonth)} last month`);
  else setSub("stat-month-sub", "No spending yet");

  const months = stats.by_month.length;
  setSub("stat-total-sub", months ? `Avg ${money.format(stats.by_month.reduce((s, r) => s + r.total, 0) / months)} / month` : "All time");
  renderSparkline(stats.by_month.map((r) => r.total));

  setSub("stat-count-sub", stats.count ? `Avg ${money.format(stats.total / stats.count)} each` : "Nothing logged yet");

  const top = stats.by_category[0];
  const topEl = document.getElementById("stat-top");
  topEl.textContent = top ? top.category : "–";
  setSub("stat-top-sub", top ? `${money.format(top.total)} · ${percent.format(top.total / (stats.total || 1))} of total` : "No data yet");

  document.querySelectorAll(".kpi.is-loading").forEach((k) => k.classList.remove("is-loading"));
}

// Draws the grand total in the middle of the doughnut.
const centerText = {
  id: "centerText",
  afterDraw(chart, _args, opts) {
    const meta = chart.getDatasetMeta(0);
    if (!meta.data.length) return;
    const { x, y } = meta.data[0];
    const { ctx } = chart;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = opts.muted;
    ctx.font = `500 11px ${opts.font}`;
    ctx.fillText("TOTAL", x, y - 11);
    ctx.fillStyle = opts.color;
    ctx.font = `600 17px ${opts.font}`;
    ctx.fillText(moneyCompact.format(opts.total), x, y + 9);
    ctx.restore();
  },
};

function renderCharts(stats, { animate = true } = {}) {
  const boxes = document.querySelectorAll(".chart-box");
  if (typeof Chart === "undefined") { // Chart.js CDN not reachable: say so instead of a blank box
    boxes.forEach((b) => { b.classList.remove("is-loading"); b.classList.add("unavailable"); });
    return;
  }
  boxes.forEach((b) => b.classList.remove("is-loading"));
  categoryChart?.destroy();
  monthChart?.destroy();

  const text = cssVar("--text"), text2 = cssVar("--text-2"), text3 = cssVar("--text-3");
  const border = cssVar("--border"), surface = cssVar("--surface-strong"), borderStrong = cssVar("--border-strong");
  const accent = cssVar("--accent"), accent2 = cssVar("--accent-2");
  const font = cssVar("--font") || "system-ui";

  Chart.defaults.font.family = font;
  Chart.defaults.font.size = 12;
  Chart.defaults.color = text2;
  Chart.defaults.borderColor = border;

  const animation = motion && animate ? { duration: 900, easing: "easeOutQuart" } : false;
  const tooltip = {
    backgroundColor: surface, borderColor: borderStrong, borderWidth: 1,
    titleColor: text, bodyColor: text2, padding: 10, cornerRadius: 10, boxPadding: 4,
    titleFont: { weight: "600" }, usePointStyle: true,
  };
  const narrow = (chart) => chart.width < 440;

  categoryChart = new Chart(document.getElementById("category-chart"), {
    type: "doughnut",
    data: {
      labels: stats.by_category.map((r) => r.category),
      datasets: [{
        data: stats.by_category.map((r) => r.total),
        backgroundColor: stats.by_category.map((r) => cssVar(categoryVar(r.category))),
        borderColor: surface, borderWidth: 2, borderRadius: 4, hoverOffset: 6, spacing: 1,
      }],
    },
    options: {
      maintainAspectRatio: false,
      cutout: "70%",
      animation,
      layout: { padding: 6 },
      onResize: (chart) => {
        const pos = narrow(chart) ? "bottom" : "right";
        if (chart.options.plugins.legend.position !== pos) { chart.options.plugins.legend.position = pos; chart.update("none"); }
      },
      plugins: {
        legend: {
          position: window.innerWidth < 640 ? "bottom" : "right",
          labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, boxHeight: 8, padding: 12, color: text2 },
        },
        tooltip: { ...tooltip, callbacks: { label: (c) => ` ${c.label}: ${money.format(c.raw)}` } },
        centerText: { total: stats.total, color: text, muted: text3, font },
      },
    },
    plugins: [centerText],
  });

  monthChart = new Chart(document.getElementById("month-chart"), {
    type: "bar",
    data: {
      labels: stats.by_month.map((r) => monthLabel(r.month)),
      datasets: [{
        label: "Spent",
        data: stats.by_month.map((r) => r.total),
        backgroundColor: (ctx) => {
          const { chart } = ctx;
          if (!chart.chartArea) return accent;
          const g = chart.ctx.createLinearGradient(0, chart.chartArea.bottom, 0, chart.chartArea.top);
          g.addColorStop(0, alpha(accent2, 0.55));
          g.addColorStop(1, accent);
          return g;
        },
        hoverBackgroundColor: accent,
        borderRadius: 8, borderSkipped: false, maxBarThickness: 38, categoryPercentage: 0.7,
      }],
    },
    options: {
      maintainAspectRatio: false,
      animation,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltip,
          callbacks: {
            title: (items) => monthLabel(stats.by_month[items[0].dataIndex].month, true),
            label: (c) => ` ${money.format(c.raw)}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: text3 } },
        y: {
          beginAtZero: true,
          border: { display: false },
          grid: { color: border, drawTicks: false },
          ticks: { color: text3, padding: 8, maxTicksLimit: 5, callback: (v) => moneyCompact.format(v) },
        },
      },
    },
  });
}

async function loadStats() {
  const stats = await api("/api/stats");
  lastStats = stats;
  setCategoryOrder(stats.by_category);
  renderKpis(stats);
  renderCharts(stats);
}

async function refresh() {
  await Promise.all([loadExpenses(), loadStats()]);
}

// ---------- AI: shared helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent: AI output can never inject HTML
  return node;
}

// Animated gradient placeholder shown while the AI is working.
function thinking(label, lines = 4) {
  const box = el("div", "thinking");
  const title = el("span", "thinking-label");
  title.append(icon("sparkles"), document.createTextNode(label));
  box.append(title);
  for (let i = 0; i < lines; i++) box.append(el("div", "ai-line"));
  return box;
}

function panelIn(target) {
  if (motion) gsap.fromTo(target, { opacity: 0, scale: 0.98 }, { opacity: 1, scale: 1, duration: 0.25, ease: "power2.out", clearProps: "opacity,transform" });
}

const AI_FIELDS = ["description", "amount", "category", "spent_on"];

function clearAiFilled() {
  AI_FIELDS.forEach((name) => form[name].classList.remove("ai-filled"));
}
AI_FIELDS.forEach((name) => form[name].addEventListener("input", () => form[name].classList.remove("ai-filled")));

// ---------- AI: scan a receipt ----------

const receiptInput = document.getElementById("receipt-input");
const scanResult = document.getElementById("scan-result");

function scanHead(iconName, title, sub) {
  const head = el("div", "scan-head");
  const textBox = el("div");
  textBox.append(el("strong", "", title));
  if (sub) textBox.append(el("span", "muted", sub));
  head.append(icon(iconName), textBox);
  return head;
}

function scanField(label, value) {
  const box = el("div", "scan-field");
  box.append(el("span", "", label), el("strong", "", value));
  box.title = value;
  return box;
}

receiptInput.addEventListener("change", async () => {
  const file = receiptInput.files[0];
  receiptInput.value = "";
  if (!file) return;

  resetForm();
  scanResult.hidden = false;
  scanResult.className = "scan-result is-loading";
  scanResult.replaceChildren(
    scanHead("scan", `Reading ${file.name}…`, "AI is extracting the shop, total, date and items."),
    thinking("Scanning receipt", 3),
  );
  panelIn(scanResult);

  const body = new FormData();
  body.append("receipt", file);
  try {
    const response = await fetch("/api/receipts/scan", { method: "POST", body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not read the receipt.");

    // Fill the form; nothing is saved until the user checks it and clicks Add.
    form.description.value = data.description || "";
    if (data.amount != null) form.amount.value = data.amount;
    form.category.value = data.category;
    if (data.spent_on) form.spent_on.value = data.spent_on;
    const filled = ["description", "category"];
    if (data.amount != null) filled.push("amount");
    if (data.spent_on) filled.push("spent_on");
    filled.forEach((name) => form[name].classList.add("ai-filled"));

    scanResult.className = "scan-result is-ok";
    const parts = [scanHead("check", "Receipt read", "Check the highlighted fields below, then click Add.")];
    const fields = el("div", "scan-fields");
    fields.append(
      scanField("Merchant", data.description || "–"),
      scanField("Total", data.amount != null ? `${Number(data.amount).toFixed(2)} ${data.currency || ""}`.trim() : "–"),
      scanField("Date", data.spent_on || "–"),
      scanField("Category", data.category),
    );
    parts.push(fields);
    if (data.currency && data.currency !== "EUR") {
      const warn = el("p", "warn");
      warn.append(icon("warn"), document.createTextNode(`The receipt is in ${data.currency}. This app tracks EUR, so convert the amount if needed.`));
      parts.push(warn);
    }
    if (data.items?.length) {
      const list = el("ul", "items");
      data.items.slice(0, 8).forEach((item) => {
        const li = el("li");
        li.append(el("span", "", item.name), el("span", "", item.price != null ? Number(item.price).toFixed(2) : ""));
        list.append(li);
      });
      if (data.items.length > 8) list.append(el("li", "muted", `…and ${data.items.length - 8} more`));
      parts.push(list);
    }
    if (data.notes) parts.push(el("p", "notes muted", data.notes));
    scanResult.replaceChildren(...parts);
    form.amount.focus({ preventScroll: true });
    if (motion) {
      // Staggered reveal, then a pulse on the fields the AI filled in.
      gsap.from(scanResult.querySelectorAll(".scan-head, .scan-field, .warn, .items li, .notes"),
        { opacity: 0, y: 6, duration: 0.35, stagger: 0.04, ease: "power2.out", clearProps: "opacity,transform" });
      const accent = cssVar("--accent");
      gsap.fromTo(filled.map((name) => form[name]),
        { boxShadow: `0 0 0 4px ${alpha(accent, 0.35)}` },
        { boxShadow: `0 0 0 0px ${alpha(accent, 0)}`, duration: 1.2, stagger: 0.08, delay: 0.2, ease: "power2.out", clearProps: "boxShadow" });
    }
  } catch (err) {
    scanResult.className = "scan-result error-box";
    scanResult.replaceChildren(scanHead("alert", err.message));
    if (motion) gsap.fromTo(scanResult, { x: -6 }, { x: 0, duration: 0.5, ease: "elastic.out(1, 0.3)", clearProps: "transform" });
  }
});

// ---------- AI: spending insights ----------

const insightsBtn = document.getElementById("insights-btn");
const insightsEl = document.getElementById("insights");
const insightsLabel = insightsBtn.querySelector(".btn-label");

insightsBtn.addEventListener("click", async () => {
  insightsBtn.disabled = true;
  insightsLabel.textContent = "Analyzing…";
  insightsEl.replaceChildren(thinking("Analyzing your spending…", 5));
  panelIn(insightsEl.firstChild);
  try {
    const data = await api("/api/insights", { method: "POST" });
    const insights = el("ul", "insight-list");
    data.insights.forEach((text) => insights.append(el("li", "", text)));
    const tips = el("ul", "tip-list");
    data.tips.forEach((text) => {
      const li = el("li");
      li.append(icon("bulb"), el("span", "", text));
      tips.append(li);
    });
    insightsEl.replaceChildren(
      el("p", "summary", data.summary),
      el("h3", "", "What stands out"), insights,
      el("h3", "", "Tips"), tips,
    );
    insightsLabel.textContent = "Analyze again";
    if (motion) {
      gsap.from(insightsEl.querySelectorAll(".summary, h3, li"),
        { opacity: 0, y: 10, duration: 0.45, stagger: 0.07, ease: "power2.out", clearProps: "opacity,transform" });
    }
  } catch (err) {
    const p = el("p", "error");
    p.append(icon("alert"), document.createTextNode(err.message));
    insightsEl.replaceChildren(p);
    insightsLabel.textContent = "Analyze my spending";
    if (motion) gsap.fromTo(p, { x: -6 }, { x: 0, duration: 0.5, ease: "elastic.out(1, 0.3)" });
  } finally {
    insightsBtn.disabled = false;
  }
});

// ---------- Motion ----------

function intro() {
  if (!motion) return;
  gsap.timeline({ defaults: { ease: "power3.out", clearProps: "opacity,transform" } })
    .from(".topbar", { y: -12, opacity: 0, duration: 0.5 })
    .from(".hero > *", { y: 16, opacity: 0, duration: 0.5, stagger: 0.06 }, "-=0.3")
    .from(".kpi", { y: 16, opacity: 0, duration: 0.5, stagger: 0.06 }, "-=0.35")
    .from(".banner, .charts .card, .split .card, .table-panel", { y: 16, opacity: 0, duration: 0.5, stagger: 0.06 }, "-=0.35");

  // Very slow background drift.
  gsap.to(".glow-a", { x: 90, y: 40, duration: 26, ease: "sine.inOut", yoyo: true, repeat: -1 });
  gsap.to(".glow-b", { x: -80, y: 60, duration: 22, ease: "sine.inOut", yoyo: true, repeat: -1 });
}

resetForm();
intro();
refresh();
