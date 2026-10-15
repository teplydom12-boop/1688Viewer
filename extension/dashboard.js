"use strict";
const $ = id => document.getElementById(id);
const S = globalThis.SupplierCollector;
let state = null, initialized = false, refreshing = false, pendingRefresh = false, pendingData = false;
let tabs = [];
let taskView = null;
const expanded = new Set();
const stages = { loading: "Загрузка", scrolling: "Догрузка выдачи", saved: "Сохранение", waiting: "Пауза между переходами", search: "Сбор выдачи", navigate: "Переход", details: "Проверка карточек", detail: "Данные поставщика", "detail-saved": "Карточка сохранена", paused: "Работа приостановлена", stopped: "Работа остановлена", finished: "Завершено" };
async function send(type, options) { const response = await chrome.runtime.sendMessage({ target: "1688-background", type, options }); if (!response?.ok) throw new Error(response?.error || "Расширение не ответило."); return response.result; }
function error(error) { $("error").textContent = error?.message || String(error); $("error").hidden = false; }
async function action(operation) { $("error").hidden = true; try { await operation(); await refresh(true); } catch (e) { error(e); } }
function element(tag, content, className) { const node = document.createElement(tag); if (content != null) node.textContent = content; if (className) node.className = className; return node; }
function safeLink(url, label) { if (!S.webUrl(url)) { const node = element("span", label === "Открыть ↗" ? "Нет ссылки" : label, "muted"); node.title = "Ссылка недоступна"; return node; } const node = element("a", label); node.href = url; node.target = "_blank"; node.rel = "noopener noreferrer"; return node; }
function productTable(products) {
  const table = element("table", null, "product-tree");
  const head = element("thead"); const row = element("tr"); ["Товар", "Цена", "Минимальный заказ", "Карточка"].forEach(label => row.append(element("th", label))); head.append(row);
  const body = element("tbody");
  for (const product of products) {
    const row = element("tr"); const title = element("td", product.title || "Название не получено", "title-cell");
    title.append(element("small", `ID: ${product.product_id}${product.query ? " · " + product.query : ""}${product.page_index ? ` · Страница ${product.page_index}` : ""}${product.card_index ? ` · Позиция ${product.card_index}` : ""}`));
    if (product.extraction_confidence) title.append(element("small", `Оценка извлечения: ${product.extraction_confidence}/100 · ${product.identity_type === "card-fingerprint" ? "без официального ID" : product.identity_type || "ID товара"}`, "confidence"));
    const price = element("td", product.price || "—"); if (product.data_conflicts?.length) { price.append(element("small", "Источники расходятся", "confidence")); price.title = product.data_conflicts.flatMap(conflict => conflict.observations.map(item => `${item.value} (${item.method})`)).join("; "); } const moq = element("td", product.minimum_order || "—");
    const link = element("td"); link.append(safeLink(product.product_url, "Открыть ↗"));
    row.append(title, price, moq, link); body.append(row);
  }
  table.append(head, body); return table;
}
function renderTable() {
  if (!state) return;
  const filter = $("filter").value.trim().toLowerCase(), source = $("source-filter").value;
  const match = product => (!source || product.source === source) && (!filter || [product.title, product.shop_name, product.supplier_id, product.product_id].some(value => String(value || "").toLowerCase().includes(filter)));
  const displayed = taskView ? S.supplierGroups(taskView.products) : { suppliers: state.suppliers, unresolved: state.unresolved };
  const groups = displayed.suppliers.map(group => ({ ...group, products: group.products.filter(match) })).filter(group => group.products.length);
  const body = $("suppliers"); body.replaceChildren();
  for (const group of groups) {
    const row = element("tr");
    const name = element("td"); const toggle = element("button", `${expanded.has(group.key) ? "▾" : "▸"} ${group.shop_name || "Имя магазина не получено"}`, "supplier-name");
    toggle.setAttribute("aria-expanded", String(expanded.has(group.key)));
    toggle.addEventListener("click", () => { if (expanded.has(group.key)) expanded.delete(group.key); else expanded.add(group.key); renderTable(); });
    name.append(toggle, element("small", group.supplier_id || group.supplier_url || "", "supplier-id"));
    const sourceCell = element("td"); sourceCell.append(element("span", group.source, "pill"));
    const shop = element("td"); shop.append(group.supplier_url ? safeLink(group.supplier_url, "Магазин ↗") : element("span", "Ссылка не получена", "muted"));
    const quality = element("td"); quality.append(element("span", group.shop_name && group.supplier_url ? "Магазин получен" : "Нужна проверка", `pill ${group.shop_name && group.supplier_url ? "good" : "pending"}`));
    row.append(name, sourceCell, element("td", group.products.length), shop, quality); body.append(row);
    const tree = element("tr", null, "tree-row"); tree.hidden = !expanded.has(group.key); const cell = element("td"); cell.colSpan = 5; cell.append(productTable(group.products)); tree.append(cell); body.append(tree);
  }
  const unresolved = displayed.unresolved.filter(match);
  $("unresolved").replaceChildren(...unresolved.map(product => {
    const node = element("div", null, "unresolved-product"); node.append(safeLink(product.product_url, product.title || `Товар ${product.product_id}`), element("small", `${product.source} · ${product.price || "Цена не указана"}${product.shop_name ? " · " + product.shop_name : ""}`)); return node;
  }));
  $("unresolved-section").hidden = !unresolved.length;
  $("empty").hidden = Boolean(groups.length || unresolved.length);
  $("filtered-count").textContent = `${groups.length} поставщиков · ${groups.reduce((count, group) => count + group.products.length, 0) + unresolved.length} карточек`;
}
async function renderTasks() {
  const tasks = state.tasks || [], selected = $("task-filter").value;
  const labels = { running: "В работе", paused: "Пауза", stopped: "Остановлено", finished: "Завершено" };
  $("task-count").textContent = `Заданий в памяти: ${tasks.length}`;
  $("tasks-empty").hidden = Boolean(tasks.length);
  $("tasks").replaceChildren(...tasks.map(task => {
    const row = element("tr"), name = element("td", task.query || (task.kind === "details" ? "Проверка карточек" : "Поиск без метки"));
    name.append(element("small", new Date(task.started_at).toLocaleString("ru-RU"), "supplier-id"));
    const status = element("td"); status.append(element("span", labels[task.status] || task.status, "pill"));
    status.title = task.message || "";
    const progressCell = element("td"), progress = element("progress"); progress.max = 100;
    progress.value = task.status === "finished" ? 100 : task.phase === "details" ? 100 * task.detail_index / Math.max(1, task.detail_total) : 100 * task.completed_pages / Math.max(1, task.max_pages);
    progress.setAttribute("aria-label", `Прогресс задания ${task.query || task.id}`);
    progressCell.append(progress, element("small", `${task.completed_pages}/${task.max_pages} стр.${task.partial_page_count ? " · есть сохранённая часть страницы" : ""}${task.phase === "details" ? ` · ${task.detail_index}/${task.detail_total} карточек` : ""}`, "confidence"));
    row.append(name, element("td", task.source || "—"), status, progressCell, element("td", task.product_count)); return row;
  }));
  const all = element("option", "Вся память — карточки с повторами"); all.value = "";
  $("task-filter").replaceChildren(all, ...tasks.map(task => { const option = element("option", `${task.query || "Без метки"} · ${task.source || "Проверка"} · ${new Date(task.started_at).toLocaleString("ru-RU")}`); option.value = task.id; return option; }));
  $("task-filter").value = tasks.some(task => task.id === selected) ? selected : "";
  taskView = $("task-filter").value ? await send("TASK", { id: $("task-filter").value }) : null;
  $("task-view-note").textContent = taskView ? "Снимок результатов выбранного задания. Экспорт сохраняет всю память, включая остальные задания." : "Все сохранённые карточки, включая повторы. Отбор и удаление дублей будут отдельным этапом.";
  renderTable();
}
async function refreshTabs() {
  tabs = await send("TABS"); const previous = $("tab").value;
  $("tab").replaceChildren(...tabs.map(tab => { const option = element("option", `${tab.source}: ${tab.title}`); option.value = tab.id; return option; }));
  if (!tabs.length) { const option = element("option", "Откройте вкладку с поисковой выдачей"); option.value = ""; $("tab").append(option); }
  else if (tabs.some(tab => String(tab.id) === previous)) $("tab").value = previous;
}
function grant(pattern) { return chrome.permissions ? chrome.permissions.request({ origins: [pattern] }).then(allowed => { if (!allowed) throw new Error("Доступ к сайту не разрешён. Выберите другой сайт или разрешите доступ позже."); }) : Promise.resolve(); }
function authorizeSelected() { const tab = tabs.find(tab => String(tab.id) === $("tab").value); if (!tab) return Promise.reject(new Error("Выберите открытую вкладку.")); return grant(S.originPattern(tab.url)); }
function renderNavigation() {
  const navigation = state?.navigation;
  $("nav-summary").textContent = !navigation ? "Алгоритм проверяет подписи, стрелки, номера страниц и ссылки." : navigation.decision === "automatic" ? `Автоматический выбор: «${navigation.chosen.label}», оценка ${navigation.chosen.confidence}/100.` : navigation.decision === "exhausted" ? "Контрол следующей страницы отключён: вероятно, выдача закончилась." : "Автоматический выбор неоднозначен. Выберите вариант или укажите кнопку прямо на странице.";
  $("navigation-options").replaceChildren(...(navigation?.candidates || []).map(candidate => {
    const row = element("div", null, "nav-option"), description = element("div");
    description.append(element("strong", `${candidate.label} · ${candidate.confidence}/100${candidate.target_blank ? " · новая вкладка" : ""}`), element("small", candidate.reasons.join(" · ")));
    const choose = element("button", "Использовать"); choose.disabled = state.run?.status === "running";
    choose.addEventListener("click", () => { const access = authorizeSelected(); void action(async () => { await access; await send("NAV_CHOOSE", { tab_id: Number($("tab").value), candidate_id: candidate.id }); }); });
    row.append(description, choose); return row;
  }));
}
async function refresh(dataUpdated = false) {
  if (refreshing) { pendingRefresh = true; pendingData ||= dataUpdated; return; }
  refreshing = true;
  try {
    const full = !state || dataUpdated;
    const next = await send(full ? "DATA" : "STATE");
    if (!initialized) {
      if (next.preferences) { $("query").value = next.preferences.query || ""; $("pages").value = next.preferences.max_pages || 1; $("interval").value = next.preferences.interval_seconds || 3; $("scroll").checked = next.preferences.scroll !== false; $("raw").checked = next.preferences.raw !== false; $("responses").checked = next.preferences.observe_responses === true; }
      if (next.suppliers[0]) expanded.add(next.suppliers[0].key);
      initialized = true;
    }
    const dataChanged = full;
    state = { ...state, ...next };
    for (const [id, value] of [["supplier-count", state.supplier_count], ["count", state.count], ["unresolved-count", state.unresolved_count], ["missing-names", state.missing_names]]) $(id).textContent = value;
    const running = state.run?.status === "running", paused = ["paused", "stopped"].includes(state.run?.status);
    $("collect").disabled = running || state.stage2_busy; $("pause").disabled = !running; $("resume").disabled = !paused || state.stage2_busy; $("show-tab").disabled = !state.run;
    $("enrich-all").disabled = false; $("clear").disabled = running || state.stage2_busy || !state.can_clear; $("import").disabled = running || state.stage2_busy;
    $("reparse").disabled = running || !state.raw_count;
    for (const id of ["pick-card", "pick-next", "reset-profile", "scan-nav"]) $(id).disabled = running;
    $("resume-tab").disabled = !paused || state.run?.phase === "details";
    $("finish-search").disabled = !paused || state.run?.phase === "details";
    $("grant-required").hidden = !state.run?.required_origin || !paused;
    $("grant-required").textContent = state.run?.required_origin ? `Разрешить ${state.run.required_origin.replace(/^[^:]+:\/\//, "").replace(/\/\*$/, "")} и продолжить` : "Разрешить доступ";
    for (const id of ["export-json", "export-csv", "export-raw", "export-xlsx"]) $(id).disabled = !state.count && !state.task_count;
    $("badge").dataset.state = state.run?.status || "idle";
    $("badge").textContent = running ? "Работаю" : paused ? "Пауза" : state.run?.status === "finished" ? "Завершено" : "Готов к сбору";
    $("stage").textContent = stages[state.run?.stage] || "Задание не запущено";
    $("status").textContent = state.run?.message || "Данные появятся после сбора или импорта JSON.";
    const run = state.run;
    const detailPhase = run?.phase === "details";
    $("progress").value = !run ? 0 : run.status === "finished" ? 100 : detailPhase ? 100 * run.detail_index / Math.max(1, run.detail_total) : 100 * run.completed_pages / Math.max(1, run.max_pages);
    $("progress-label").textContent = run ? `Страницы: ${run.completed_pages}/${run.max_pages} · Карточек сохранено: ${state.tasks.find(task => task.id === run.id)?.product_count || 0}${detailPhase ? ` · Карточки: ${run.detail_index}/${run.detail_total}` : ""}${run.current_count ? ` · На текущей странице: ${run.current_count}` : ""}` : "";
    $("warnings").replaceChildren(...state.warnings.map(warning => element("li", warning))); $("warnings").hidden = !state.warnings.length;
    if (dataChanged) {
      const selectedSource = $("source-filter").value;
      const sources = [...new Set(state.products.map(product => product.source))];
      $("source-filter").replaceChildren(element("option", "Все сайты"), ...sources.map(source => { const option = element("option", source.replace(/^web:/, "")); option.value = source; return option; }));
      $("source-filter").firstChild.value = ""; $("source-filter").value = sources.includes(selectedSource) ? selectedSource : "";
      renderTable();
    }
    await renderTasks();
    const log = taskView?.log || run?.log || [];
    $("log-title").textContent = taskView ? "Журнал выбранного задания" : "Журнал текущего задания";
    $("log").replaceChildren(...log.slice().reverse().map(entry => { const item = element("li"), time = element("time", new Date(entry.at).toLocaleTimeString("ru-RU")); time.dateTime = entry.at; item.append(time, element("span", entry.message)); return item; }));
    if (!log.length) $("log").append(element("li", "Работа ещё не запущена.", "muted"));
    renderNavigation();
  } finally { refreshing = false; if (pendingRefresh) { const full = pendingData; pendingRefresh = false; pendingData = false; void refresh(full).catch(error); } }
}
function options() { return { tab_id: Number($("tab").value) || undefined, max_pages: Number($("pages").value), interval_seconds: Number($("interval").value), query: $("query").value, scroll: $("scroll").checked, enrich: false, raw: $("raw").checked, observe_responses: $("responses").checked }; }
$("collect-form").addEventListener("submit", event => { event.preventDefault(); const access = authorizeSelected(); void action(async () => { await access; await send("START", options()); }); });
$("enrich-all").addEventListener("click", () => { void action(() => send("OPEN_SUPPLIERS")); });
$("pause").addEventListener("click", () => { void action(() => send("PAUSE")); });
$("resume").addEventListener("click", () => { void action(() => send("RESUME", { interval_seconds: Number($("interval").value) })); });
$("show-tab").addEventListener("click", () => { void action(() => send("SHOW_TAB")); });
$("refresh-tabs").addEventListener("click", () => { void action(refreshTabs); });
$("scan-nav").addEventListener("click", () => { const access = authorizeSelected(); void action(async () => { await access; await send("NAV_SCAN", { tab_id: Number($("tab").value) }); }); });
for (const [id, mode] of [["pick-card", "card"], ["pick-next", "next"]]) $(id).addEventListener("click", () => { const access = authorizeSelected(); void action(async () => { await access; await send("PICK", { tab_id: Number($("tab").value), mode }); }); });
$("reset-profile").addEventListener("click", () => { void action(() => send("RESET_PROFILE", { tab_id: Number($("tab").value) })); });
$("resume-tab").addEventListener("click", () => { const access = authorizeSelected(); void action(async () => { await access; await send("RESUME", { tab_id: Number($("tab").value), interval_seconds: Number($("interval").value) }); }); });
$("grant-required").addEventListener("click", () => { const access = grant(state.run.required_origin); void action(async () => { await access; await send("RESUME", { interval_seconds: Number($("interval").value) }); }); });
$("finish-search").addEventListener("click", () => { void action(() => send("FINISH_SEARCH")); });
for (const [id, format] of [["export-json", "json"], ["export-csv", "csv"], ["export-raw", "raw"], ["export-xlsx", "xlsx"]]) $(id).addEventListener("click", () => { void action(() => send(format === "xlsx" ? "OPEN_EXCEL" : "EXPORT", { format })); });
$("filter").addEventListener("input", renderTable); $("source-filter").addEventListener("change", renderTable);
$("task-filter").addEventListener("change", () => { void action(() => Promise.resolve()); });
$("import").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", () => { void action(async () => {
  const file = $("import-file").files[0]; if (!file) return;
  if (file.size > 30000000) throw new Error("Файл больше 30 МБ. Разделите его на несколько сборов.");
  const data = JSON.parse(await file.text()); await send("IMPORT", { data }); $("import-file").value = "";
}); });
$("reparse").addEventListener("click", () => { void action(async () => { const cards = await send("RAW"); const products = SupplierCollectorEngine.reparse(cards); await send("IMPORT", { data: { products } }); }); });
$("clear").addEventListener("click", () => { if (confirm("Обнулить всю память приложения: товары, исходные карточки, задания, журнал, настройки и образцы сайтов? Действие необратимо. Сначала сохраните JSON или Excel.")) void action(async () => { await send("CLEAR"); $("collect-form").reset(); $("filter").value = ""; $("source-filter").value = ""; initialized = false; }); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes.supplier_search || changes.collection || changes.run || changes.tasks || changes.preferences || changes.last_navigation || changes.profiles)) void refresh(Boolean(changes.collection)).catch(error); });
void action(async () => { await refreshTabs(); await refresh(); });
