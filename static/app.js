// AI Expense Tracker frontend - talks to the Flask REST API with fetch().

const form = document.getElementById("expense-form");
const formError = document.getElementById("form-error");
const rowsEl = document.getElementById("expense-rows");
const filterEl = document.getElementById("filter");
const submitBtn = document.getElementById("submit-btn");
const cancelBtn = document.getElementById("cancel-btn");

const COLORS = ["#2f6fdb", "#e8833a", "#2e9e6b", "#c94f7c", "#8b5cf6", "#d4a72c", "#6b7280"];
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" });

let expenses = [];
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

// ---------- Table ----------

async function loadExpenses() {
  const category = filterEl.value;
  const query = category ? `?category=${encodeURIComponent(category)}` : "";
  expenses = await api(`/api/expenses${query}`);
  renderTable();
}

let shownIds = new Set();

function renderTable() {
  const rows = expenses.map(rowFor);
  rowsEl.replaceChildren(...rows);
  document.getElementById("empty").hidden = expenses.length > 0;

  // Only rows that weren't on screen before fade in, so saving one expense doesn't replay the whole table.
  if (motion) {
    const fresh = rows.filter((_, i) => !shownIds.has(expenses[i].id)).slice(0, 25);
    if (fresh.length) gsap.from(fresh, { opacity: 0, y: 8, duration: 0.35, stagger: 0.03, ease: "power2.out" });
  }
  shownIds = new Set(expenses.map((e) => e.id));
}

function rowFor(expense) {
  const tr = document.createElement("tr");
  // textContent (not innerHTML) so user input can never inject HTML.
  const cells = [expense.spent_on, expense.description, expense.category, money.format(expense.amount)];
  cells.forEach((text, i) => {
    const td = document.createElement("td");
    td.textContent = text;
    if (i === 2) td.className = "tag";
    if (i === 3) td.className = "num";
    tr.append(td);
  });

  const actions = document.createElement("td");
  actions.className = "actions";
  actions.append(
    button("Edit", "link", () => startEdit(expense)),
    button("Delete", "link danger", () => deleteExpense(expense, tr)),
  );
  tr.append(actions);
  return tr;
}

function button(label, className, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.className = className;
  b.addEventListener("click", onClick);
  return b;
}

// ---------- Form (add / edit) ----------

function resetForm() {
  form.reset();
  form.expense_id.value = "";
  form.spent_on.value = new Date().toISOString().slice(0, 10);
  document.getElementById("form-title").textContent = "Add expense";
  submitBtn.textContent = "Add";
  cancelBtn.hidden = true;
  formError.textContent = "";
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
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  if (motion) {
    gsap.fromTo(form.closest(".panel"),
      { boxShadow: "0 0 0 3px rgba(47, 111, 219, 0.35)" },
      { boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)", duration: 1.2, delay: 0.3, ease: "power1.out" });
  }
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
  try {
    await api(id ? `/api/expenses/${id}` : "/api/expenses", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    resetForm();
    await refresh();
  } catch (err) {
    formError.textContent = err.message;
    if (motion) gsap.fromTo(formError, { x: -6 }, { x: 0, duration: 0.5, ease: "elastic.out(1, 0.3)" });
  }
});

cancelBtn.addEventListener("click", resetForm);

async function deleteExpense(expense, row) {
  if (!confirm(`Delete "${expense.description}"?`)) return;
  await api(`/api/expenses/${expense.id}`, { method: "DELETE" });
  if (motion) await gsap.to(row, { opacity: 0, x: 24, duration: 0.25, ease: "power1.in" });
  await refresh();
}

// ---------- Dashboard ----------

const counters = new Map(); // stat element -> { value } currently on screen

// Counts a stat card from the value it shows now to the new one.
function countTo(el, value, format) {
  if (!motion) { el.textContent = format(value); return; }
  const state = counters.get(el) || { value: 0 };
  counters.set(el, state);
  gsap.killTweensOf(state);
  gsap.to(state, { value, duration: 0.9, ease: "power2.out", onUpdate: () => { el.textContent = format(state.value); } });
}

async function loadStats() {
  const stats = await api("/api/stats");
  countTo(document.getElementById("stat-month"), stats.this_month, money.format);
  countTo(document.getElementById("stat-total"), stats.total, money.format);
  countTo(document.getElementById("stat-count"), stats.count, Math.round);

  if (typeof Chart === "undefined") return; // Chart.js CDN not reachable
  categoryChart?.destroy();
  monthChart?.destroy();

  categoryChart = new Chart(document.getElementById("category-chart"), {
    type: "doughnut",
    data: {
      labels: stats.by_category.map((r) => r.category),
      datasets: [{ data: stats.by_category.map((r) => r.total), backgroundColor: COLORS }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "right" },
        tooltip: { callbacks: { label: (c) => `${c.label}: ${money.format(c.raw)}` } },
      },
    },
  });

  monthChart = new Chart(document.getElementById("month-chart"), {
    type: "bar",
    data: {
      labels: stats.by_month.map((r) => r.month),
      datasets: [{ label: "Spent", data: stats.by_month.map((r) => r.total), backgroundColor: COLORS[0], borderRadius: 4 }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => money.format(c.raw) } },
      },
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => money.format(v) } } },
    },
  });
}

async function refresh() {
  await Promise.all([loadExpenses(), loadStats()]);
}

// ---------- AI: scan a receipt ----------

const receiptInput = document.getElementById("receipt-input");
const scanResult = document.getElementById("scan-result");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent: AI output can never inject HTML
  return node;
}

receiptInput.addEventListener("change", async () => {
  const file = receiptInput.files[0];
  receiptInput.value = "";
  if (!file) return;

  resetForm();
  scanResult.hidden = false;
  scanResult.className = "scan-result loading";
  scanResult.replaceChildren(el("span", "", `Reading ${file.name}…`));
  if (motion) gsap.from(scanResult, { opacity: 0, y: -6, duration: 0.3, ease: "power2.out" });

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

    scanResult.className = "scan-result";
    const title = el("strong", "", "Receipt read. Check the fields below, then click Add.");
    const parts = [title];
    if (data.currency && data.currency !== "EUR") {
      parts.push(el("p", "warn", `The receipt is in ${data.currency}. This app tracks EUR, so convert the amount if needed.`));
    }
    if (data.items?.length) {
      const list = el("ul", "items");
      data.items.slice(0, 8).forEach((item) => {
        list.append(el("li", "", item.price != null ? `${item.name}: ${item.price}` : item.name));
      });
      if (data.items.length > 8) list.append(el("li", "muted", `…and ${data.items.length - 8} more`));
      parts.push(list);
    }
    if (data.notes) parts.push(el("p", "muted", data.notes));
    scanResult.replaceChildren(...parts);
    form.amount.focus();
    if (motion) {
      // Show which fields the AI filled in.
      gsap.from(scanResult.children, { opacity: 0, y: 6, duration: 0.35, stagger: 0.06, ease: "power2.out" });
      gsap.fromTo([form.description, form.amount, form.category, form.spent_on],
        { backgroundColor: "#e3ecff" },
        { backgroundColor: "#ffffff", duration: 1.4, stagger: 0.08, ease: "power1.out", clearProps: "backgroundColor" });
    }
  } catch (err) {
    scanResult.className = "scan-result error-box";
    scanResult.replaceChildren(el("span", "", err.message));
  }
});

// ---------- AI: spending insights ----------

const insightsBtn = document.getElementById("insights-btn");
const insightsEl = document.getElementById("insights");

insightsBtn.addEventListener("click", async () => {
  insightsBtn.disabled = true;
  insightsEl.replaceChildren(el("p", "muted", "Analyzing your spending…"));
  try {
    const data = await api("/api/insights", { method: "POST" });
    const insights = el("ul", "insight-list");
    data.insights.forEach((text) => insights.append(el("li", "", text)));
    const tips = el("ul", "tip-list");
    data.tips.forEach((text) => tips.append(el("li", "", text)));
    insightsEl.replaceChildren(
      el("p", "summary", data.summary),
      el("h3", "", "What stands out"), insights,
      el("h3", "", "Tips"), tips,
    );
    if (motion) {
      gsap.from(insightsEl.querySelectorAll(".summary, h3, li"),
        { opacity: 0, y: 10, duration: 0.45, stagger: 0.07, ease: "power2.out" });
    }
  } catch (err) {
    insightsEl.replaceChildren(el("p", "error", err.message));
  } finally {
    insightsBtn.disabled = false;
  }
});

function intro() {
  if (!motion) return;
  gsap.timeline({ defaults: { ease: "power3.out" } })
    .from("header h1, .subtitle", { y: 16, opacity: 0, duration: 0.6, stagger: 0.1 })
    .from(".banner, .cards .card, .charts .panel, main > section.panel", { y: 24, opacity: 0, duration: 0.6, stagger: 0.08 }, "-=0.3");
}

filterEl.addEventListener("change", loadExpenses);
resetForm();
intro();
refresh();
