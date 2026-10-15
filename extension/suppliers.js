"use strict";
const $ = id => document.getElementById(id), S = globalThis.SupplierCollector;
const selected = new Set(), expanded = new Set();
const R = globalThis.SupplierRelevance;
let criteriaDirty = false, batchSizeDirty = false, relevanceId = null;
const criteriaMismatch = () => Boolean(state?.job?.relevance && S.text($("relevance-criteria").value) !== state.job.relevance.criteria);
const labels = { ready: "Готово к проверке", running: "В работе", paused: "Пауза", stopped: "Остановлено", finished: "Завершено" };
let state = null, preferences = {}, initialized = false, refreshing = false, pending = false, acting = false, taskSignature = "", jobId = null, imageSize = 48, draftImageSize = null, sizeRevision = 0, intervalDirty = false;
const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("ru-RU") : "—";
function link(url, text) { if (!S.webUrl(url)) return el("span", text || "—"); const node = el("a", text || url); node.href = url; node.target = "_blank"; node.rel = "noopener noreferrer"; return node; }
function site(source) { return ({ "1688": "1688.com", alibaba: "alibaba.com", "made-in-china": "made-in-china.com" })[source] || String(source || "Разные сайты").replace(/^web:/, ""); }
async function send(type, options) { const response = await chrome.runtime.sendMessage({ target: "1688-background", type, options }); if (!response?.ok) throw new Error(response?.error || "Расширение не ответило."); return response.result; }
function error(cause) { $("error").textContent = cause.message || String(cause); $("error").hidden = false; }
async function action(operation) { if (acting) return; acting = true; $("error").hidden = true; controls(); try { await operation(); await refresh(); } catch (cause) { error(cause); } finally { acting = false; controls(); } }
function availableTasks() { return (state?.tasks || []).filter(task => task.product_count && task.status !== "running"); }
function visibleTasks() { const term = $("task-filter").value.trim().toLowerCase(); return availableTasks().filter(task => [task.query, task.source, site(task.source)].some(value => String(value || "").toLowerCase().includes(term))); }
function controls() {
  if (!state) return;
  const job = state.job, blocked = acting || state.busy || job?.status === "running" || state.first_stage_running;
  $("prepare").disabled = blocked || !selected.size;
  for (const input of $("tasks").querySelectorAll("input")) input.disabled = blocked;
  $("select-all").disabled = blocked; $("select-none").disabled = blocked;
  $("selection-count").textContent = "Выбрано заданий: " + selected.size;
  $("start").disabled = blocked || criteriaMismatch() || !["ready", "paused"].includes(job?.status);
  $("start").textContent = job?.status === "paused" ? "Продолжить" : "Проверить поставщиков";
  $("pause").disabled = acting || job?.status !== "running";
  $("skip").disabled = acting || !job || job.status === "finished";
  $("show-tab").disabled = acting || job?.tab_id == null;
  $("save-interval").disabled = acting || !job || job.status === "finished";
  for (const id of ["export-json", "export-xlsx", "export-csv", "result-export-xlsx"]) $(id).disabled = acting || !state.result;
  $("first-stage-note").hidden = !state.first_stage_running;
  for (const id of ["claude-json", "claude-instructions"]) $(id).disabled = blocked || !job || !S.text($("relevance-criteria").value);
  $("relevance-criteria").disabled = blocked;
  $("claude-batch-size").disabled = blocked;
  $("claude-batch").disabled = blocked || Number($("claude-batch-size").value) !== (job?.relevance?.batch_size ?? 0);
  $("import-relevance").disabled = blocked || !job?.relevance || criteriaMismatch();
  $("reset-relevance").disabled = blocked || !job?.relevance;
  $("relevance-draft").hidden = !criteriaMismatch();
  for (const input of $("suppliers").querySelectorAll(".relevance-choice")) input.disabled = blocked;
}
function renderRelevance() {
  const meta = state.job?.relevance;
  if (!criteriaDirty && meta && document.activeElement !== $("relevance-criteria")) $("relevance-criteria").value = meta.criteria;
  if (!batchSizeDirty) $("claude-batch-size").value = meta?.batch_size ?? 0;
  const old = meta?.request_id === relevanceId ? $("claude-batch").value : "0"; relevanceId = meta?.request_id || null;
  $("claude-batch").replaceChildren(...(meta?.batches || [{ index: 0 }]).map(batch => { const option = el("option", "Часть " + (batch.index + 1) + (batch.total ? " · оценено " + batch.reviewed + "/" + batch.total : "")); option.value = batch.index; return option; }));
  $("claude-batch").value = [...$("claude-batch").options].some(option => option.value === old) ? old : "0";
  const total = meta?.total_unique || 0, counts = meta?.counts, unreviewed = counts?.unreviewed || 0;
  $("relevance-progress").max = total || 1; $("relevance-progress").value = total - unreviewed;
  $("relevance-summary").textContent = !meta ? "Без загруженных решений проверяются все карточки." : "Описание задания: «" + meta.criteria + "». " + (meta.analysis_unit === "exact-title" ? "Уникальных названий" : "Уникальных карточек (старое задание)") + " оценено " + (total - unreviewed) + " из " + total + ". Подходят: " + counts.relevant + "; уточнить: " + counts.uncertain + "; не подходят: " + counts.excluded + "; без решения: " + unreviewed + ".";
}
function renderTasks(force = false) {
  const signature = JSON.stringify(state.tasks);
  if (!force && signature === taskSignature) return;
  taskSignature = signature;
  const tasks = visibleTasks(), validIds = new Set(availableTasks().map(task => task.id));
  for (const id of selected) if (!validIds.has(id)) selected.delete(id);
  $("tasks").replaceChildren(...tasks.map(task => {
    const row = el("tr"), cell = el("td"), input = el("input"); input.type = "checkbox"; input.value = task.id; input.checked = selected.has(task.id); input.setAttribute("aria-label", "Выбрать задание " + (task.query || task.id));
    input.addEventListener("change", () => { if (input.checked) selected.add(task.id); else selected.delete(task.id); controls(); }); cell.append(input);
    const name = el("td", task.query || "Поиск без метки"); name.append(el("small", date(task.started_at), "supplier-id"));
    row.append(cell, name, el("td", site(task.source)), el("td", labels[task.status] || task.status), el("td", task.product_count)); return row;
  }));
  $("tasks-empty").hidden = Boolean(tasks.length); controls();
}
function tick() {
  const job = state?.job;
  if (!job) { $("eta").textContent = "—"; return; }
  if (job.status === "finished") { $("eta").textContent = "Готово"; return; }
  if (job.status === "paused") { $("eta").textContent = "Пауза"; return; }
  const left = Math.max(0, job.queue.length - job.cursor), average = job.checked_count ? job.duration_ms / job.checked_count : 6000;
  const ms = left * average + Math.max(0, left - 1) * job.interval_ms + Math.max(0, (job.next_open_at || 0) - Date.now());
  const seconds = Math.max(1, Math.ceil(ms / 1000)); $("eta").textContent = seconds < 60 ? "≈ " + seconds + " сек." : "≈ " + Math.ceil(seconds / 60) + " мин.";
  if (job.status === "running" && job.next_open_at > Date.now()) $("progress-label").textContent = "До следующей карточки: " + Math.ceil((job.next_open_at - Date.now()) / 1000) + " сек. · Обработано " + job.cursor + " / " + job.queue.length;
}
function applySize(size) { imageSize = size; $("image-size").value = size; $("image-size-value").textContent = size + " px"; for (const img of $("suppliers").querySelectorAll(".stage-thumbnail")) { img.width = size; img.height = size; } }
function productTree(products, images) {
  const table = el("table", null, "product-tree"), head = el("thead"), titles = el("tr"), body = el("tbody");
  for (const title of ["Найденная карточка", "Площадка", "Задание", "Изображение", "Проверка продавца", "Релевантность"]) titles.append(el("th", title)); head.append(titles);
  for (const product of products) {
    const row = el("tr"), title = el("td", null, "title-cell"); title.append(link(product.product_url, product.title || product.product_id || "Карточка без названия"));
    title.append(el("small", "ID: " + (product.product_id || "—") + " · " + date(product.collected_at)));
    const task = el("td"), taskLink = el("a", product.source_task_name); taskLink.href = "history.html#" + encodeURIComponent(product.source_task_id); taskLink.target = "_blank"; taskLink.rel = "noopener"; task.append(taskLink);
    const photo = el("td");
    if (preferences.history_images && S.webUrl(product.image_url)) {
      const key = product.stage2_row_id + ":" + product.image_url;
      let node = images.get(key);
      images.delete(key);
      if (!node) {
        node = link(product.image_url, ""); node.dataset.imageKey = key;
        const img = el("img", null, "stage-thumbnail"), sources = SupplierImages.candidates(product.image_url); let index = 0;
        img.alt = product.title || "Товар"; img.loading = "lazy"; img.decoding = "async"; img.referrerPolicy = "no-referrer";
        img.addEventListener("error", () => { if (++index < sources.length) img.src = sources[index]; else node.replaceChildren(el("span", "Картинка недоступна ↗")); });
        img.src = sources[0]; node.append(img);
      }
      const img = node.querySelector("img"); if (img) { img.width = imageSize; img.height = imageSize; } photo.append(node);
    } else photo.append(product.image_url ? link(product.image_url, "Фото ↗") : el("span", "—"));
    const status = product.supplier_conflict ? "Противоречивые сведения" : product.supplier_check === "unknown" ? "Поставщик неизвестен после проверки" : product.supplier_check === "identified" ? "Продавец проверен в карточке" : product.supplier.supplier_id || product.supplier.supplier_url ? "Из сохранённых данных / по идентификатору" : "Поставщик неизвестен";
    const category = el("td", null, "relevance-cell"), decision = product.relevance;
    if (decision?.card_id) {
      const select = el("select", null, "relevance-choice"); select.dataset.cardId = decision.card_id; select.setAttribute("aria-label", "Категория: " + (product.title || product.product_id));
      for (const [value, label] of Object.entries(R.labels)) { const option = el("option", label); option.value = value; select.append(option); } select.value = decision.status;
      select.disabled = acting || state.busy || state.job?.status === "running" || state.first_stage_running;
      select.addEventListener("change", () => { void action(() => send("RELEVANCE_OVERRIDE", { card_id: decision.card_id, status: select.value })).finally(renderResult); }); category.append(select);
      if (decision.reason) category.append(el("small", decision.reason)); if (decision.evidence) category.append(el("small", "Цитата: «" + decision.evidence + "»"));
    } else category.append(el("span", R.labels.unreviewed));
    row.append(title, el("td", site(product.source)), task, photo, el("td", SupplierSearchCore.excluded(product) ? "Проверка пропущена: не подходит" : status), category); body.append(row);
  }
  table.append(head, body); return table;
}
function renderResult() {
  const result = state.result, term = $("filter").value.trim().toLowerCase(), category = $("category-filter").value, images = new Map([...$("suppliers").querySelectorAll("[data-image-key]")].map(node => [node.dataset.imageKey, node]));
  const matchesCategory = product => !category || (product.relevance?.status || "unreviewed") === category;
  const matchesProduct = product => [product.title, product.product_id, product.source_task_name, site(product.source), product.supplier?.shop_name, product.supplier?.supplier_id, product.supplier?.supplier_url].some(value => String(value || "").toLowerCase().includes(term));
  const rows = [];
  for (const supplier of result?.suppliers || []) {
    const supplierMatches = [supplier.shop_name, supplier.supplier_id, supplier.supplier_url, site(supplier.source)].some(value => String(value || "").toLowerCase().includes(term));
    const products = supplier.products.filter(product => matchesCategory(product) && (supplierMatches || matchesProduct(product)));
    if (!products.length) continue;
    const open = expanded.has(supplier.key), row = el("tr"), title = el("td"), button = el("button", (open ? "▾ " : "▸ ") + supplier.shop_name, "supplier-name");
    button.setAttribute("aria-expanded", String(open)); button.addEventListener("click", () => { if (expanded.has(supplier.key)) expanded.delete(supplier.key); else expanded.add(supplier.key); renderResult(); }); title.append(button);
    if (supplier.supplier_id) title.append(el("small", "ID: " + supplier.supplier_id, "supplier-id"));
    const store = el("td"); store.append(link(supplier.supplier_url, supplier.supplier_url ? "Открыть магазин ↗" : "—"));
    row.append(title, el("td", site(supplier.source)), el("td", products.length), el("td", new Set(products.map(SupplierSearchCore.offerKey)).size), store, el("td", supplier.status === "unknown" ? "Поставщик неизвестен" : "По ID / ссылке магазина")); rows.push(row);
    if (open) { const child = el("tr", null, "tree-row"), cell = el("td"); cell.colSpan = 6; cell.append(productTree(products, images)); child.append(cell); rows.push(child); }
  }
  const excluded = (result?.excluded_products || []).filter(product => matchesCategory(product) && matchesProduct(product));
  if (excluded.length) {
    const open = expanded.has("__excluded__"), row = el("tr", null, "excluded-category"), cell = el("td"), button = el("button", (open ? "▾ " : "▸ ") + "Не подходят — проверка пропущена · " + excluded.length + " карточек"); cell.colSpan = 6;
    button.addEventListener("click", () => { if (expanded.has("__excluded__")) expanded.delete("__excluded__"); else expanded.add("__excluded__"); renderResult(); }); cell.append(button); row.append(cell); rows.push(row);
    if (open) {
      const child = el("tr", null, "tree-row excluded-category"), inner = el("td"); inner.colSpan = 6;
      const visible = new Set(excluded.map(product => product.stage2_row_id));
      const groups = [...(result.excluded_suppliers || []).map(supplier => ({ ...supplier, excludedOnly: true })), ...result.suppliers.filter(supplier => supplier.excluded_products?.length).map(supplier => ({ ...supplier, products: supplier.excluded_products, excludedOnly: false }))];
      for (const supplier of groups) {
        const products = supplier.products.filter(product => visible.has(product.stage2_row_id)); if (!products.length) continue;
        const group = el("section", null, "excluded-supplier-group"); group.dataset.supplierKey = supplier.key; group.dataset.excludedOnly = String(supplier.excludedOnly);
        group.append(el("h3", supplier.shop_name), el("p", supplier.status === "unknown" ? "Продавцы этих неподходящих карточек не определены. Группа не считается одной компанией." : supplier.excludedOnly ? "Только неподходящие карточки — поставщик исключён из основного списка." : "У поставщика есть включённые карточки в основном списке; здесь сохранены его неподходящие товары.", "muted"));
        if (supplier.supplier_url) group.append(link(supplier.supplier_url, "Открыть магазин ↗"));
        group.append(productTree(products, images)); inner.append(group);
      }
      child.append(inner); rows.push(child);
    }
  }
  $("suppliers").replaceChildren(...rows); $("empty").hidden = Boolean(rows.length);
  $("supplier-count").textContent = result?.total_suppliers || 0; $("card-count").textContent = result?.total_cards || 0; $("unknown-count").textContent = result?.unknown_cards || 0; $("task-count").textContent = result?.source_tasks.length || 0;
  $("unique-count").textContent = result?.unique_offers || 0; $("repeat-count").textContent = result?.duplicate_cards || 0;
  $("excluded-supplier-note").hidden = !result?.relevance.request_id;
  $("excluded-supplier-note").textContent = `Поставщиков только с неподходящими карточками: ${result?.total_excluded_suppliers || 0}. Они сохранены отдельно в категории «Не подходят» и не входят в основной счётчик поставщиков. Сомнительные и неоценённые карточки остаются включёнными.`;
  $("unique-note").textContent = `Уникальность определяется по площадке и ID предложения, при отсутствии ID — по ссылке; на обычных сайтах — по полной ссылке с вариантом товара. Без ID и ссылки строки считаются отдельными. Все появления сохраняются.${result ? ` В проверку включено ${result.included_cards} карточек; не подходят: ${result.excluded_products.length}. Среди включённых карточек без поставщика уникальных: ${result.unknown_unique_offers}.` : ""}`;
  $("result-state").textContent = !result ? "Результат ещё не подготовлен" : state.job.status === "finished" ? "Итоговый результат" : "Предварительный результат · уточнение ещё не завершено";
}
async function refresh() {
  if (refreshing) { pending = true; return; } refreshing = true;
  try {
    const next = await send("SUPPLIERS_STATE"), view = await send("STATE"); state = next; preferences = view.view_preferences;
    if (!initialized) { for (const task of state.job?.source_tasks || []) selected.add(task.id); initialized = true; }
    const job = state.job;
    const changedJob = (job?.id || null) !== jobId;
    if (changedJob) { jobId = job?.id || null; expanded.clear(); intervalDirty = false; batchSizeDirty = false; if (job) { selected.clear(); for (const task of job.source_tasks) selected.add(task.id); } }
    if (job && !intervalDirty && document.activeElement !== $("interval")) $("interval").value = job.interval_ms / 1000;
    renderRelevance(); renderTasks(changedJob); controls();
    $("badge").textContent = labels[job?.status] || "Задание не выбрано"; $("badge").dataset.state = job?.status || "";
    $("status").textContent = job?.message || "Выберите задания и обработайте сохранённые результаты.";
    $("challenge-alert").hidden = !(job?.status === "paused" && job.pause_reason === "challenge");
    $("notification-error").hidden = $("challenge-alert").hidden || !job?.attention_notification_error;
    $("notification-error").textContent = job?.attention_notification_error ? "Системное уведомление недоступно. Состояние проверки показано здесь и в окне расширения." : "";
    $("challenge-tab").disabled = acting || job?.tab_id == null;
    const current = job?.current_key && job.queue.find(entry => entry.key === job.current_key);
    $("current-card").hidden = !current || job.status === "finished";
    $("current-card").replaceChildren(...(current ? [document.createTextNode("Текущая карточка: "), link(current.product_url, current.title)] : []));
    $("progress").value = !job ? 0 : job.status === "finished" ? 100 : 100 * job.cursor / Math.max(1, job.queue.length);
    $("progress-label").textContent = job ? "Обработано " + job.cursor + " / " + job.queue.length + (job.skipped_count ? " · Пропущено: " + job.skipped_count : "") : "";
    $("planned").textContent = job?.queue.length || 0; $("opened").textContent = job?.opened_keys.length || 0; $("checked").textContent = job?.checked_count || 0;
    $("remaining").textContent = !job || job.status === "finished" ? 0 : job.queue.length - job.cursor;
    applySize(draftImageSize ?? preferences.history_image_size ?? 48); $("toggle-images").textContent = preferences.history_images ? "Скрыть картинки" : "Показать картинки"; $("toggle-images").setAttribute("aria-pressed", String(Boolean(preferences.history_images)));
    renderResult(); tick();
    $("log").replaceChildren(...(job?.log || []).slice().reverse().map(entry => { const item = el("li"); item.append(el("time", date(entry.at)), el("span", entry.message)); return item; }));
  } finally { refreshing = false; if (pending) { pending = false; void refresh().catch(error); } }
}
$("task-filter").addEventListener("input", () => renderTasks(true));
$("select-all").addEventListener("click", () => { visibleTasks().forEach(task => selected.add(task.id)); renderTasks(true); });
$("select-none").addEventListener("click", () => { selected.clear(); renderTasks(true); });
$("refresh").addEventListener("click", () => { void action(() => Promise.resolve()); });
$("relevance-criteria").addEventListener("input", () => { criteriaDirty = true; controls(); });
$("claude-batch-size").addEventListener("change", () => { batchSizeDirty = true; controls(); });
for (const [id, format] of [["claude-json", "json"], ["claude-instructions", "instructions"]]) $(id).addEventListener("click", () => { void action(async () => { await send("RELEVANCE_EXPORT", { format, criteria: $("relevance-criteria").value, batch_size: Number($("claude-batch-size").value), batch_index: criteriaMismatch() ? 0 : Number($("claude-batch").value) }); criteriaDirty = false; batchSizeDirty = false; }); });
$("import-relevance").addEventListener("click", () => $("relevance-file").click());
$("relevance-file").addEventListener("change", () => {
  const files = [...$("relevance-file").files]; if (!files.length) return;
  void action(async () => {
    if (files.length > 100 || files.some(file => file.size > 16 * 1024 * 1024) || files.reduce((n, file) => n + file.size, 0) > 32 * 1024 * 1024) throw new Error("Выберите до 100 файлов, каждый до 16 МиБ, суммарно до 32 МиБ.");
    await send("RELEVANCE_IMPORT", { criteria: $("relevance-criteria").value, files: await Promise.all(files.map(file => file.text())) });
  }).finally(() => { $("relevance-file").value = ""; });
});
$("reset-relevance").addEventListener("click", () => { void action(async () => { await send("RELEVANCE_RESET"); $("relevance-criteria").value = state.job?.relevance?.criteria || ""; criteriaDirty = false; }); });
$("interval").addEventListener("input", () => { intervalDirty = true; });
$("prepare-form").addEventListener("submit", event => { event.preventDefault(); void action(async () => { await send("SUPPLIERS_PREPARE", { task_ids: [...selected], interval_seconds: Number($("interval").value) }); intervalDirty = false; }); });
$("start").addEventListener("click", () => {
  const origins = state?.required_origins || [], seconds = Number($("interval").value);
  const permission = origins.length ? chrome.permissions.request({ origins }) : Promise.resolve(true);
  void action(async () => { if (!await permission) throw new Error("Доступ не предоставлен. Можно пропустить открытие карточек и получить имеющийся результат."); await send("SUPPLIERS_START", { interval_seconds: seconds }); intervalDirty = false; });
});
$("pause").addEventListener("click", () => { void action(() => send("SUPPLIERS_PAUSE")); });
$("skip").addEventListener("click", () => { void action(() => send("SUPPLIERS_SKIP")); });
$("show-tab").addEventListener("click", () => { void action(() => send("SUPPLIERS_TAB")); });
$("challenge-tab").addEventListener("click", () => { void action(() => send("SUPPLIERS_TAB")); });
$("save-interval").addEventListener("click", () => { void action(async () => { await send("SUPPLIERS_INTERVAL", { interval_seconds: Number($("interval").value) }); intervalDirty = false; }); });
for (const format of ["json", "csv"]) $("export-" + format).addEventListener("click", () => { void action(() => send("SUPPLIERS_EXPORT", { format })); });
for (const id of ["export-xlsx", "result-export-xlsx"]) $(id).addEventListener("click", () => { void action(() => send("OPEN_EXCEL", { stage: 2 })); });
$("filter").addEventListener("input", renderResult);
$("category-filter").addEventListener("change", () => { if ($("category-filter").value === "excluded") expanded.add("__excluded__"); renderResult(); });
$("expand-all").addEventListener("click", () => { for (const supplier of state?.result?.suppliers || []) expanded.add(supplier.key); expanded.add("__excluded__"); renderResult(); });
$("collapse-all").addEventListener("click", () => { expanded.clear(); renderResult(); });
$("toggle-images").addEventListener("click", () => { void action(() => send("SET_VIEW", { history_images: !preferences.history_images })); });
$("image-size").addEventListener("input", () => { draftImageSize = Number($("image-size").value); applySize(draftImageSize); });
$("image-size").addEventListener("change", () => {
  const size = Number($("image-size").value), revision = ++sizeRevision; draftImageSize = size;
  void send("SET_VIEW", { history_image_size: size }).then(async () => { if (revision === sizeRevision) { draftImageSize = null; await refresh(); } }).catch(cause => { if (revision === sizeRevision) draftImageSize = null; error(cause); });
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && ["supplier_search", "tasks", "run", "view_preferences"].some(key => key in changes)) void refresh().catch(error); });
setInterval(tick, 1000);
void refresh().catch(error);
