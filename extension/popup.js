"use strict";
const $ = id => document.getElementById(id);
let initialized = false;
let activeTab = null;

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
  const state = await send("STATE");
  if (!initialized) {
    if (state.preferences) {
      $("query").value = state.preferences.query || "";
      $("pages").value = state.preferences.max_pages || 1;
      $("scroll").checked = state.preferences.scroll !== false;
      $("interval").value = state.preferences.interval_seconds || 3;
      $("enrich").checked = state.preferences.enrich !== false;
      $("raw").checked = state.preferences.raw !== false;
    }
    initialized = true;
  }
  const running = state.run?.status === "running";
  $("count").textContent = state.count;
  $("page-count").textContent = state.page_count;
  $("supplier-count").textContent = state.supplier_count;
  $("collect").disabled = running;
  $("stop").disabled = !running;
  $("resume").disabled = !["paused", "stopped"].includes(state.run?.status);
  $("clear").disabled = running || !state.count;
  $("export").disabled = !state.count;
  $("badge").textContent = running ? "Идёт сбор" : state.run?.status === "paused" ? "Пауза" : "Готов к сбору";
  $("badge").dataset.running = String(running);
  $("status").textContent = state.run?.message || "Результаты сохраняются между запусками.";
  $("warnings").replaceChildren(...state.warnings.map(warning => {
    const item = document.createElement("li"); item.textContent = warning; return item;
  }));
  $("warnings").hidden = !state.warnings.length;
  $("preview").replaceChildren(...state.preview.map(product => {
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
    enrich: $("enrich").checked,
    raw: $("raw").checked
  }); });
});
$("stop").addEventListener("click", () => { void action(() => send("PAUSE")); });
$("resume").addEventListener("click", () => { void action(() => send("RESUME", { interval_seconds: Number($("interval").value) })); });
$("dashboard").addEventListener("click", () => { void action(() => send("OPEN_DASHBOARD")); });
$("export").addEventListener("click", () => { void action(() => send("EXPORT")); });
$("clear").addEventListener("click", () => {
  if (confirm("Удалить все собранные товары из браузера? Сначала скачайте JSON, если данные нужны.")) void action(() => send("CLEAR"));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.collection || changes.run)) void refresh().catch(showError);
});
void refresh().catch(showError);
if (chrome.tabs?.query) void chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => { activeTab = tabs[0]; });
