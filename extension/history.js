"use strict";
const $ = id => document.getElementById(id);
const labels = { running: "В работе", paused: "Пауза", stopped: "Остановлено", finished: "Завершено" };
let state = null, selectedId = location.hash.slice(1), selected = null, refreshing = false, pending = false, busy = false;
let draftImageSize = null, sizeRevision = 0;
const P = globalThis.SupplierPrices, expandedSuppliers = new Set(), draftPreferences = {}, preferenceRevisions = {};
const preference = (key, fallback) => draftPreferences[key] ?? state?.view_preferences?.[key] ?? fallback;
function savePreference(key, value) {
  const revision = (preferenceRevisions[key] || 0) + 1; preferenceRevisions[key] = revision; draftPreferences[key] = value; renderMemory();
  void send("SET_VIEW", { [key]: value }).then(async () => { if (preferenceRevisions[key] === revision) { delete draftPreferences[key]; await refresh(); } }).catch(error => { if (preferenceRevisions[key] === revision) delete draftPreferences[key]; showError(error); });
}
function applyImageSize(size) {
  $("image-size").value = size; $("image-size-value").textContent = `${size} px`;
  for (const img of $("task-memory").querySelectorAll(".history-thumbnail")) { img.width = size; img.height = size; }
}
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
  $("history-count").textContent = `Проверок: ${tasks.length} из ${state.task_count} · Карточек в общей памяти: ${state.count}`;
  $("history-empty").hidden = Boolean(tasks.length);
  $("history-empty").textContent = state.task_count ? "Проверки по этому запросу не найдены." : "Проверок пока нет. Запустите задание в окне сбора.";
  $("history-tasks").replaceChildren(...tasks.map(task => {
    const row = element("tr"); row.dataset.taskId = task.id; row.dataset.selected = String(task.id === selectedId);
    const name = element("td", task.query || (task.kind === "details" ? "Проверка карточек" : "Поиск без метки")); name.append(element("small", date(task.started_at), "supplier-id"));
    const actions = element("td"), buttons = element("div", null, "row-actions");
    const open = element("button", "Открыть память"); open.dataset.action = "open"; open.setAttribute("aria-expanded", String(task.id === selectedId));
    open.addEventListener("click", () => { void action(async () => { selectedId = task.id; history.replaceState(null, "", `#${task.id}`); await refresh(); $("task-memory").scrollIntoView({ block: "start" }); }); });
    const remove = element("button", "Удалить", "danger"); remove.dataset.action = "delete"; remove.disabled = (state.run?.status === "running" || state.stage2_busy);
    remove.addEventListener("click", () => requestDelete(task.id)); buttons.append(open, remove); actions.append(buttons);
    row.append(name, element("td", task.source || "—"), element("td", labels[task.status] || task.status), element("td", `${task.completed_pages}/${task.max_pages}${task.partial_page_count ? " · есть часть страницы" : ""}`), element("td", task.product_count), actions); return row;
  }));
}
function renderMemory() {
  $("task-memory").hidden = !selected;
  if (!selected) {
    $("memory-products").replaceChildren(); $("memory-suppliers").replaceChildren(); $("memory-pages").replaceChildren(); $("memory-log").replaceChildren();
    $("memory-title").textContent = ""; $("memory-meta").textContent = ""; $("memory-status").textContent = ""; $("memory-counts").textContent = ""; return;
  }
  $("memory-title").textContent = selected.query || "Проверка без метки";
  $("memory-meta").textContent = `${selected.source || "Проверка карточек"} · Начало: ${date(selected.started_at)} · ${labels[selected.status] || selected.status} · ID: ${selected.id}`;
  $("memory-status").textContent = selected.message || "";
  $("memory-progress").value = selected.status === "finished" ? 100 : selected.phase === "details" ? 100 * selected.detail_index / Math.max(1, selected.detail_total) : 100 * selected.completed_pages / Math.max(1, selected.max_pages);
  $("memory-counts").textContent = `Карточек (с повторами): ${selected.products.length} · Страниц: ${selected.completed_pages}/${selected.max_pages} · Исходных карточек: ${selected.raw_count || 0}`;
  $("memory-empty").hidden = Boolean(selected.products.length);
  $("delete-task").disabled = (state.run?.status === "running" || state.stage2_busy);
  const showImages = state.view_preferences?.history_images === true;
  const imageSize = draftImageSize ?? state.view_preferences?.history_image_size ?? 48;
  applyImageSize(imageSize);
  $("toggle-images").textContent = showImages ? "Скрыть картинки" : "Показать картинки";
  $("toggle-images").setAttribute("aria-pressed", String(showImages));
  const view = preference("history_view", "cards"), order = preference("history_price_order", "original");
  $("memory-view").value = view; $("price-order").value = order;
  const currencyLabel = currency => currency === "unspecified" ? "Без указанной валюты" : currency;
  const currencies = [...new Set(selected.products.map(product => P.parse(product)?.currency).filter(Boolean))].sort();
  const oldCurrency = $("price-currency").value;
  $("price-currency").replaceChildren(...["", ...currencies].map(currency => { const option = element("option", currency ? currencyLabel(currency) : "Все валюты"); option.value = currency; return option; }));
  $("price-currency").value = currencies.includes(oldCurrency) ? oldCurrency : "";
  const currency = $("price-currency").value;
  const products = P.sort(selected.products.filter(product => !currency || P.parse(product)?.currency === currency), order);
  $("memory-visible").textContent = `Показано карточек: ${products.length} из ${selected.products.length}. Сортировка и выбор валюты не меняют память и выгрузку.`;
  $("memory-empty").hidden = Boolean(products.length);
  $("memory-cards-wrap").hidden = view !== "cards"; $("memory-suppliers-wrap").hidden = view !== "suppliers";
  const thumbnails = new Map([...$("task-memory").querySelectorAll("[data-image-key]")].map(node => [node.dataset.imageKey, node]));
  const productRow = product => {
    const row = element("tr"), name = element("td"); name.append(link(product.product_url, product.title || "Название не получено"), element("small", `ID: ${product.product_id}${product.page_index ? ` · Страница ${product.page_index}` : ""}${product.card_index ? ` · Позиция ${product.card_index}` : ""}`, "supplier-id"));
    const supplier = element("td"); supplier.append(link(product.supplier_url, product.shop_name || "Имя магазина не получено"), element("small", product.supplier_id || "", "supplier-id"));
    const image = element("td");
    if (showImages && SupplierCollector.webUrl(product.image_url)) {
      const key = `${product.observation_id || product.product_id}:${product.image_url}`;
      let thumbnail = thumbnails.get(key);
      if (!thumbnail) {
        thumbnail = link(product.image_url, ""); thumbnail.dataset.imageKey = key;
        const img = element("img", null, "history-thumbnail"); img.width = imageSize; img.height = imageSize; img.alt = product.title || "Изображение товара";
        img.loading = "lazy"; img.decoding = "async"; img.referrerPolicy = "no-referrer";
        const sources = SupplierImages.candidates(product.image_url); let source = 0;
        img.addEventListener("error", () => { if (++source < sources.length) img.src = sources[source]; else { img.remove(); thumbnail.append(element("span", "Картинка недоступна ↗", "image-unavailable")); } });
        img.src = sources[0] || product.image_url; thumbnail.replaceChildren(img);
      }
      image.append(thumbnail);
    } else image.append(product.image_url ? link(product.image_url, "Открыть изображение ↗") : element("span", "—"));
    row.append(name, element("td", product.price || "—"), element("td", product.minimum_order || "—"), supplier, image, element("td", date(product.last_seen_at || product.collected_at))); return row;
  };
  if (view === "cards") { $("memory-suppliers").replaceChildren(); $("memory-products").replaceChildren(...products.map(productRow)); }
  else {
    $("memory-products").replaceChildren();
    const grouped = SupplierCollector.supplierGroups(products), groups = grouped.suppliers.map(group => ({ ...group, minimum: P.minimum(group.products) }));
    if (order !== "original") groups.sort((a, b) => P.compare(a.minimum, b.minimum, order));
    if (grouped.unresolved.length) groups.push({ key: "unknown", shop_name: "Поставщик неизвестен", products: grouped.unresolved, unknown: true });
    const rows = [];
    for (const group of groups) {
      const key = selected.id + ":" + group.key, open = expandedSuppliers.has(key), row = element("tr"), name = element("td");
      const button = element("button", `${open ? "▾" : "▸"} ${group.shop_name || (group.supplier_url ? new URL(group.supplier_url).hostname : "Поставщик " + group.supplier_id)}`, "supplier-name");
      button.setAttribute("aria-expanded", String(open)); button.addEventListener("click", () => { if (expandedSuppliers.has(key)) expandedSuppliers.delete(key); else expandedSuppliers.add(key); renderMemory(); }); name.append(button);
      const store = element("td"); store.append(link(group.supplier_url, group.supplier_url ? "Открыть магазин ↗" : "—"));
      const minimum = element("td", group.minimum ? `${currencyLabel(group.minimum.currency)} ${new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 12 }).format(group.minimum.amount)}` : group.unknown ? "—" : group.products.some(product => P.parse(product)) ? "Несколько валют — выберите валюту" : "Цена не определена");
      row.dataset.supplierKey = group.key; if (group.minimum) { row.dataset.price = group.minimum.amount; row.dataset.currency = group.minimum.currency; }
      row.append(name, store, element("td", group.products.length), minimum); rows.push(row);
      if (open) { const child = element("tr", null, "tree-row"), cell = element("td"), table = element("table", null, "supplier-table memory-products"), body = element("tbody"); cell.colSpan = 4; table.append($("memory-cards-wrap").querySelector("thead").cloneNode(true)); body.append(...P.sort(group.products, order).map(productRow)); table.append(body); cell.append(table); child.append(cell); rows.push(child); }
    }
    $("memory-suppliers").replaceChildren(...rows);
  }
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
    $("running-note").hidden = !(state.run?.status === "running" || state.stage2_busy);
    $("clear-all").disabled = (state.run?.status === "running" || state.stage2_busy) || !state.can_clear;
    for (const id of ["export-all-json", "export-all-xlsx"]) $(id).disabled = !state.count && !state.task_count;
    renderList(); renderMemory();
  } catch (error) { if (selectedId && !pending) { selected = null; renderMemory(); } throw error; }
  finally { refreshing = false; if (pending) { pending = false; void refresh().catch(showError); } }
}
function requestDelete(id) {
  if (busy || (state?.run?.status === "running" || state?.stage2_busy)) return;
  const task = state.tasks.find(task => task.id === id); if (!task) return;
  if (confirm(`Удалить память проверки «${task.query || "Без метки"}»? Её результаты, исходные карточки и журнал будут удалены. Если результат этапа 2 основан на этой проверке, он также будет удалён. Общая память будет пересчитана по оставшимся проверкам; импортированные данные сохранятся. Действие необратимо.`)) void action(async () => {
    await send("DELETE_TASK", { id }); if (selectedId === id) { selectedId = ""; history.replaceState(null, "", location.pathname); }
    $("notice").textContent = "Память проверки удалена. Данные остальных проверок сохранены.";
  });
}
$("history-filter").addEventListener("input", renderList);
$("memory-view").addEventListener("change", () => savePreference("history_view", $("memory-view").value));
$("price-order").addEventListener("change", () => savePreference("history_price_order", $("price-order").value));
$("price-currency").addEventListener("change", renderMemory);
$("refresh").addEventListener("click", () => { void action(() => Promise.resolve()); });
$("delete-task").addEventListener("click", () => requestDelete(selectedId));
$("toggle-images").addEventListener("click", () => { void action(() => send("SET_VIEW", { history_images: state.view_preferences?.history_images !== true })); });
$("image-size").addEventListener("input", () => { draftImageSize = Number($("image-size").value); applyImageSize(draftImageSize); });
$("image-size").addEventListener("change", () => {
  const size = Number($("image-size").value), revision = ++sizeRevision; draftImageSize = size;
  void send("SET_VIEW", { history_image_size: size }).then(async () => { if (revision === sizeRevision) { draftImageSize = null; await refresh(); } }).catch(cause => { if (revision === sizeRevision) { draftImageSize = null; void refresh().catch(showError); } showError(cause); });
});
for (const [id, format, scoped] of [["export-all-json", "json", false], ["export-all-xlsx", "xlsx", false], ["export-task-json", "json", true], ["export-task-xlsx", "xlsx", true], ["export-task-raw", "raw", true]]) $(id).addEventListener("click", () => { void action(() => send(format === "xlsx" ? "OPEN_EXCEL" : "EXPORT", { format, ...(scoped ? { task_id: selectedId } : {}) })); });
$("clear-all").addEventListener("click", () => {
  if (confirm("Удалить всю память приложения: все проверки, товары, исходные карточки, журналы, настройки и образцы сайтов? Действие необратимо. Сначала сохраните JSON или Excel.")) void action(async () => {
    await send("CLEAR"); selectedId = ""; $("history-filter").value = ""; history.replaceState(null, "", location.pathname); $("notice").textContent = "Вся память приложения удалена.";
  });
});
window.addEventListener("hashchange", () => { selectedId = location.hash.slice(1); void refresh().catch(showError); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && ["tasks", "run", "collection", "preferences", "profiles", "view_preferences", "supplier_search"].some(key => changes[key])) void refresh().catch(showError); });
void refresh().catch(showError);
