"use strict";
const $ = id => document.getElementById(id);
const labels = { running: "В работе", paused: "Пауза", stopped: "Остановлено", finished: "Завершено" };
let state = null, selectedId = location.hash.slice(1), selected = null, refreshing = false, pending = false, busy = false;
function element(tag, text, className) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; }
function link(url, text) {
  if (!SupplierCollector.webUrl(url)) return element("span", text || "—");
  const node = element("a", text || url); node.href = url; node.target = "_blank"; node.rel = "noopener noreferrer"; return node;
}
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("ru-RU") : "—";
async function send(type, options) { const response = await chrome.runtime.sendMessage({ target: "1688-background", type, options }); if (!response?.ok) throw new Error(response?.error || "Расширение не ответило."); return response.result; }
function showError(error) { $("error").textContent = error.message || String(error); $("error").hidden = false; }
async function action(operation) {
  if (busy) return; busy = true; $("error").hidden = true; $("notice").textContent = "";
  try { await operation(); await refresh(); } catch (error) { showError(error); } finally { busy = false; }
}
function renderList() {
  if (!state) return;
  const filter = $("history-filter").value.trim().toLowerCase();
  const tasks = state.tasks.filter(task => [task.query, task.source, labels[task.status], date(task.started_at)].some(value => String(value || "").toLowerCase().includes(filter)));
  $("history-count").textContent = `Проверок: ${tasks.length} из ${state.task_count} · Товаров в общей памяти: ${state.count}`;
  $("history-empty").hidden = Boolean(tasks.length);
  $("history-empty").textContent = state.task_count ? "Проверки по этому запросу не найдены." : "Проверок пока нет. Запустите задание в окне сбора.";
  $("history-tasks").replaceChildren(...tasks.map(task => {
    const row = element("tr"); row.dataset.taskId = task.id; row.dataset.selected = String(task.id === selectedId);
    const name = element("td", task.query || (task.kind === "details" ? "Проверка карточек" : "Поиск без метки")); name.append(element("small", date(task.started_at), "supplier-id"));
    const actions = element("td"), buttons = element("div", null, "row-actions");
    const open = element("button", "Открыть память"); open.dataset.action = "open"; open.setAttribute("aria-expanded", String(task.id === selectedId));
    open.addEventListener("click", () => { void action(async () => { selectedId = task.id; history.replaceState(null, "", `#${task.id}`); await refresh(); $("task-memory").scrollIntoView({ block: "start" }); }); });
    const remove = element("button", "Удалить", "danger"); remove.dataset.action = "delete"; remove.disabled = state.run?.status === "running";
    remove.addEventListener("click", () => requestDelete(task.id)); buttons.append(open, remove); actions.append(buttons);
    row.append(name, element("td", task.source || "—"), element("td", labels[task.status] || task.status), element("td", `${task.completed_pages}/${task.max_pages}${task.partial_page_count ? " · есть часть страницы" : ""}`), element("td", task.product_count), actions); return row;
  }));
}
function renderMemory() {
  $("task-memory").hidden = !selected;
  if (!selected) {
    $("memory-products").replaceChildren(); $("memory-pages").replaceChildren(); $("memory-log").replaceChildren();
    $("memory-title").textContent = ""; $("memory-meta").textContent = ""; $("memory-status").textContent = ""; $("memory-counts").textContent = ""; return;
  }
  $("memory-title").textContent = selected.query || "Проверка без метки";
  $("memory-meta").textContent = `${selected.source || "Проверка карточек"} · Начало: ${date(selected.started_at)} · ${labels[selected.status] || selected.status} · ID: ${selected.id}`;
  $("memory-status").textContent = selected.message || "";
  $("memory-progress").value = selected.status === "finished" ? 100 : selected.phase === "details" ? 100 * selected.detail_index / Math.max(1, selected.detail_total) : 100 * selected.completed_pages / Math.max(1, selected.max_pages);
  $("memory-counts").textContent = `Товаров: ${selected.products.length} · Страниц: ${selected.completed_pages}/${selected.max_pages} · Исходных карточек: ${selected.raw_count || 0}`;
  $("memory-empty").hidden = Boolean(selected.products.length);
  $("delete-task").disabled = state.run?.status === "running";
  $("memory-products").replaceChildren(...selected.products.map(product => {
    const row = element("tr"), name = element("td"); name.append(link(product.product_url, product.title || "Название не получено"), element("small", `ID: ${product.product_id}`, "supplier-id"));
    const supplier = element("td"); supplier.append(link(product.supplier_url, product.shop_name || "Имя магазина не получено"), element("small", product.supplier_id || "", "supplier-id"));
    const image = element("td"); image.append(product.image_url ? link(product.image_url, "Открыть изображение ↗") : element("span", "—"));
    row.append(name, element("td", product.price || "—"), element("td", product.minimum_order || "—"), supplier, image, element("td", date(product.last_seen_at || product.collected_at))); return row;
  }));
  $("memory-pages").replaceChildren(...selected.pages.map(page => { const item = element("li"); item.append(link(page.page_url, `${page.query || "Выдача"}${page.partial ? " · частично сохранена" : ""}`)); return item; }));
  $("memory-log").replaceChildren(...(selected.log || []).slice().reverse().map(entry => { const item = element("li"); item.append(element("time", date(entry.at)), element("span", entry.message)); return item; }));
}
async function refresh() {
  if (refreshing) { pending = true; return; } refreshing = true;
  try {
    state = await send("STATE");
    if (selectedId && !state.tasks.some(task => task.id === selectedId)) { selectedId = ""; history.replaceState(null, "", location.pathname); }
    selected = null;
    if (selectedId) {
      try { selected = await send("TASK", { id: selectedId }); }
      catch (error) {
        // Another extension tab can delete this task between STATE and TASK.
        state = await send("STATE");
        if (state.tasks.some(task => task.id === selectedId)) throw error;
        selectedId = ""; history.replaceState(null, "", location.pathname);
      }
    }
    $("running-note").hidden = state.run?.status !== "running";
    $("clear-all").disabled = state.run?.status === "running" || !state.can_clear;
    for (const id of ["export-all-json", "export-all-xlsx"]) $(id).disabled = !state.count && !state.task_count;
    renderList(); renderMemory();
  } catch (error) { if (selectedId && !pending) { selected = null; renderMemory(); } throw error; }
  finally { refreshing = false; if (pending) { pending = false; void refresh().catch(showError); } }
}
function requestDelete(id) {
  if (busy || state?.run?.status === "running") return;
  const task = state.tasks.find(task => task.id === id); if (!task) return;
  if (confirm(`Удалить память проверки «${task.query || "Без метки"}»? Её результаты, исходные карточки и журнал будут удалены. Общая память будет пересчитана по оставшимся проверкам; импортированные данные сохранятся. Действие необратимо.`)) void action(async () => {
    await send("DELETE_TASK", { id }); if (selectedId === id) { selectedId = ""; history.replaceState(null, "", location.pathname); }
    $("notice").textContent = "Память проверки удалена. Данные остальных проверок сохранены.";
  });
}
$("history-filter").addEventListener("input", renderList);
$("refresh").addEventListener("click", () => { void action(() => Promise.resolve()); });
$("delete-task").addEventListener("click", () => requestDelete(selectedId));
for (const [id, format, scoped] of [["export-all-json", "json", false], ["export-all-xlsx", "xlsx", false], ["export-task-json", "json", true], ["export-task-xlsx", "xlsx", true], ["export-task-raw", "raw", true]]) $(id).addEventListener("click", () => { void action(() => send("EXPORT", { format, ...(scoped ? { task_id: selectedId } : {}) })); });
$("clear-all").addEventListener("click", () => {
  if (confirm("Удалить всю память приложения: все проверки, товары, исходные карточки, журналы, настройки и образцы сайтов? Действие необратимо. Сначала сохраните JSON или Excel.")) void action(async () => {
    await send("CLEAR"); selectedId = ""; $("history-filter").value = ""; history.replaceState(null, "", location.pathname); $("notice").textContent = "Вся память приложения удалена.";
  });
});
window.addEventListener("hashchange", () => { selectedId = location.hash.slice(1); void refresh().catch(showError); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && ["tasks", "run", "collection", "preferences", "profiles"].some(key => changes[key])) void refresh().catch(showError); });
void refresh().catch(showError);
