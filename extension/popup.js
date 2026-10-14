"use strict";
const $ = id => document.getElementById(id);
let initialized = false;

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
    }
    initialized = true;
  }
  const running = state.run?.status === "running";
  $("count").textContent = state.count;
  $("page-count").textContent = state.page_count;
  $("collect").disabled = running;
  $("stop").disabled = !running;
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
    const link = document.createElement("a");
    link.href = product.product_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
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
  void action(() => send("START", {
    query: $("query").value,
    max_pages: Number($("pages").value),
    scroll: $("scroll").checked
  }));
});
$("stop").addEventListener("click", () => { void action(() => send("STOP")); });
$("export").addEventListener("click", () => { void action(() => send("EXPORT")); });
$("clear").addEventListener("click", () => {
  if (confirm("Удалить все собранные товары из браузера? Сначала скачайте JSON, если данные нужны.")) void action(() => send("CLEAR"));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.collection || changes.run)) void refresh().catch(showError);
});
void refresh().catch(showError);
