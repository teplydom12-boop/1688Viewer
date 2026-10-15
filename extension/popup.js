"use strict";
const $ = id => document.getElementById(id);
let initialized = false;
let activeTab = null;
let refreshVersion = 0;

async function send(type, options) {
  const response = await chrome.runtime.sendMessage({ target: "1688-background", type, options });
  if (!response?.ok) throw new Error(response?.error || "Расширение не ответило. Откройте его снова.");
  return response.result;
}

function showError(error) {
  $("error").textContent = error?.message || String(error);
  $("error").hidden = false;
}

async function refresh() {
  const version = ++refreshVersion;
  const state = await send("STATE");
  if (version !== refreshVersion) return;
  if (!initialized) {
    if (state.preferences) {
      $("query").value = state.preferences.query || "";
      $("pages").value = state.preferences.max_pages || 1;
      $("scroll").checked = state.preferences.scroll !== false;
      $("interval").value = state.preferences.interval_seconds || 3;
      $("raw").checked = state.preferences.raw !== false;
      $("responses").checked = state.preferences.observe_responses === true;
    }
    initialized = true;
  }
  const running = state.run?.status === "running";
  const current = state.current_task;
  $("count").textContent = current?.product_count ?? state.count;
  $("page-count").textContent = current?.page_count ?? state.page_count;
  $("supplier-count").textContent = current?.supplier_count ?? state.supplier_count;
  $("count-label").textContent = current ? "сохранено в задании" : "товаров в памяти";
  $("collect").disabled = running;
  $("stop").disabled = !running;
  $("resume").disabled = !["paused", "stopped"].includes(state.run?.status);
  $("show-tab").hidden = !state.run || state.run.status !== "paused";
  $("clear").disabled = running || !state.can_clear;
  $("export").disabled = !state.count && !state.task_count;
  $("export-xlsx").disabled = !state.count && !state.task_count;
  $("task-count").textContent = `Заданий в памяти: ${state.task_count} · Всего товаров в памяти: ${state.count}`;
  const run = state.run;
  $("progress").value = !run ? 0 : run.status === "finished" ? 100 : run.phase === "details" ? 100 * run.detail_index / Math.max(1, run.detail_total) : 100 * run.completed_pages / Math.max(1, run.max_pages);
  $("progress-label").textContent = run ? `${run.query || "Текущее задание"} · Страницы: ${run.completed_pages}/${run.max_pages}${run.phase === "details" ? ` · Карточки: ${run.detail_index}/${run.detail_total}` : ""} · Товаров сохранено: ${state.tasks.find(task => task.id === run.id)?.product_count || 0}` : "";
  $("badge").textContent = running ? "Идёт сбор" : state.run?.status === "paused" ? "Пауза" : "Готов к сбору";
  $("badge").dataset.running = String(running);
  $("status").textContent = state.run?.message || "Результаты сохраняются между запусками.";
  $("warnings").replaceChildren(...state.warnings.map(warning => {
    const item = document.createElement("li"); item.textContent = warning; return item;
  }));
  $("warnings").hidden = !state.warnings.length;
  $("preview").replaceChildren(...(current?.preview || state.preview).map(product => {
    const item = document.createElement("li");
    const hasLink = SupplierCollector.webUrl(product.product_url);
    const link = document.createElement(hasLink ? "a" : "span");
    if (hasLink) { link.href = product.product_url; link.target = "_blank"; link.rel = "noopener noreferrer"; }
    link.textContent = product.title || `Товар ${product.product_id}`;
    const description = document.createElement("small");
    description.textContent = [product.price || "Цена не указана", product.shop_name || "Магазин не указан"].join(" · ");
    item.append(link, description);
    return item;
  }));
}

async function action(operation) {
  $("error").hidden = true;
  try { await operation(); await refresh(); } catch (error) { showError(error); }
}

$("collect-form").addEventListener("submit", event => {
  event.preventDefault();
  const access = activeTab && SupplierCollector.webUrl(activeTab.url) && chrome.permissions ? chrome.permissions.request({ origins: [SupplierCollector.originPattern(activeTab.url)] }) : Promise.resolve(true);
  void action(async () => { if (!await access) throw new Error("Доступ к сайту не разрешён."); return send("START", {
    query: $("query").value,
    max_pages: Number($("pages").value),
    interval_seconds: Number($("interval").value),
    scroll: $("scroll").checked,
    enrich: false,
    raw: $("raw").checked,
    observe_responses: $("responses").checked
  }); });
});
$("stop").addEventListener("click", () => { void action(() => send("PAUSE")); });
$("show-tab").addEventListener("click", () => { void action(() => send("SHOW_TAB")); });
$("resume").addEventListener("click", () => { void action(() => send("RESUME", { interval_seconds: Number($("interval").value) })); });
$("dashboard").addEventListener("click", () => { void action(() => send("OPEN_DASHBOARD")); });
$("history").addEventListener("click", () => { void action(() => send("OPEN_HISTORY")); });
$("export").addEventListener("click", () => { void action(() => send("EXPORT")); });
$("export-xlsx").addEventListener("click", () => { void action(() => send("OPEN_EXCEL")); });
$("clear").addEventListener("click", () => {
  if (confirm("Обнулить всю память приложения: товары, исходные карточки, задания, журнал, настройки и образцы сайтов? Действие необратимо. Сначала сохраните JSON или Excel.")) void action(async () => { await send("CLEAR"); $("collect-form").reset(); initialized = false; });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.collection || changes.run || changes.tasks || changes.preferences)) void refresh().catch(showError);
});
void refresh().catch(showError);
if (chrome.tabs?.query) void chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => { activeTab = tabs[0]; });
