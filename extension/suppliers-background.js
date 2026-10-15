"use strict";
// Runs inside the service worker. Stage 1 snapshots are never modified here.
const SupplierStage = (() => {
  const C = globalThis.SupplierSearchCore, key = "supplier_search", cacheKey = "supplier_search_cache", alarm = "supplier-search-progress";
  let working = false, preparing = false;
  const attentionNotice = "supplier-search-attention";
  let attentionSync = Promise.resolve(), attentionVisual = null;
  const busy = () => working || preparing;
  async function read() { return (await chrome.storage.local.get(key))[key] || null; }
  const attentionToken = job => job?.status === "paused" && job.pause_reason === "challenge" ? job.attention_id || job.id + ":" + job.updated_at : null;
  function notificationCall(method, ...args) {
    return new Promise((resolve, reject) => {
      try { chrome.notifications[method](...args, result => { const error = chrome.runtime.lastError; if (error) reject(new Error(error.message)); else resolve(result); }); }
      catch (error) { reject(error); }
    });
  }
  function syncAttention() {
    // Serialize notification work and read the latest state, so an old pause
    // cannot leave a stale badge/notification after Continue, Skip or Clear.
    attentionSync = attentionSync.catch(() => {}).then(async () => {
      const job = await read(), token = attentionToken(job), visual = Boolean(token);
      if (attentionVisual !== visual) {
        await Promise.allSettled([
          chrome.action?.setBadgeText({ text: token ? "!" : "" }),
          chrome.action?.setBadgeBackgroundColor({ color: "#bf3434" }),
          chrome.action?.setTitle({ title: token ? "Этап 2 на паузе: пройдите капчу или вход" : "Supplier Viewer" })
        ]);
        if (!token && chrome.notifications?.clear) await notificationCall("clear", attentionNotice).catch(() => {});
        attentionVisual = visual;
      }
      if (!token || job.attention_notified === token) return;
      let failure = null;
      try {
        if (!chrome.notifications?.create) throw new Error("Системные уведомления недоступны. Откройте рабочую вкладку из расширения.");
        await notificationCall("create", attentionNotice, { type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"),
          title: "Этап 2: капча или вход — работа на паузе", message: "Откройте рабочую вкладку, пройдите проверку вручную и нажмите «Продолжить» на этапе 2.",
          priority: 2, requireInteraction: true, buttons: [{ title: "Открыть рабочую вкладку" }] });
      } catch (error) { failure = error.message; }
      await withStateLock(async () => {
        const latest = await read(); if (attentionToken(latest) !== token) return;
        await chrome.storage.local.set({ [key]: { ...latest, attention_notified: token, attention_notification_error: failure } });
      });
    });
    return attentionSync;
  }
  async function openAttention(id) {
    if (id !== attentionNotice || !attentionToken(await read())) return;
    try { await showTab(); } catch { await chrome.tabs.create({ url: chrome.runtime.getURL("suppliers.html") }); }
  }
  async function running(id) { const job = await read(); return job?.id === id && job.status === "running" ? job : null; }
  function note(job, stage, message) { const at = new Date().toISOString(); return { ...job, stage, message, updated_at: at, log: [...job.log, { at, stage, message }].slice(-150) }; }
  async function change(id, fn, allowPaused = false) {
    return withStateLock(async () => {
      const job = await read();
      if (job?.id !== id || (allowPaused ? job.status === "finished" : job.status !== "running")) return null;
      const next = fn(job); await chrome.storage.local.set({ [key]: next }); return next;
    });
  }
  function interval(value) {
    const seconds = Number(value ?? 5);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) throw new Error("Укажите интервал от 1 до 300 секунд.");
    return Math.round(seconds * 1000);
  }
  async function guard() {
    const { run } = await chrome.storage.local.get("run");
    if (processing || starting || run?.status === "running") throw new Error("Сначала приостановите этап 1 и дождитесь остановки.");
  }
  async function isRunning() { return (await read())?.status === "running"; }
  async function prepare(options) {
    if (busy()) throw new Error("Сначала приостановите поиск поставщиков и дождитесь остановки.");
    preparing = true;
    try {
      if (await isRunning()) throw new Error("Сначала приостановите поиск поставщиков.");
      await guard(); const intervalMs = interval(options.interval_seconds);
      return await withStateLock(async () => {
        const { tasks = [], run, collection = emptyCollection(), [cacheKey]: cache = {} } = await chrome.storage.local.get(["tasks", "run", "collection", cacheKey]);
        const ids = [...new Set(options.task_ids || [])];
        if (!ids.length || ids.some(id => typeof id !== "string")) throw new Error("Выберите хотя бы одно задание из истории.");
        const history = storedTasks(tasks, run, collection), selected = ids.map(id => history.find(task => task.id === id));
        if (selected.some(task => !task || task.kind === "details" || task.status === "running" || !task.products?.length)) throw new Error("Выберите сохранённые задания этапа 1 с карточками. Одно из заданий недоступно или ещё выполняется.");
        const products = C.rowsFromTasks(selected, cache), queue = C.queue(products), at = new Date().toISOString();
        const job = note({ id: crypto.randomUUID(), status: queue.length ? "ready" : "finished", started_at: at, finished_at: queue.length ? null : at,
          source_tasks: selected.map(task => ({ id: task.id, query: task.query, source: task.source, source_url: task.source_url, started_at: task.started_at, status: task.status, card_count: task.products.length })),
          products, queue, cursor: 0, opened_keys: [], checked_count: 0, skipped_count: 0, duration_ms: 0, interval_ms: intervalMs,
          next_open_at: null, current_key: null, tab_id: null, pause_reason: null, required_origin: null, log: [], worker_active: false
        }, "prepared", "Сохранённые данные обработаны. Для уточнения поставщиков нужно открыть карточек: " + queue.length + ".");
        await chrome.storage.local.set({ [key]: job }); return { prepared: true, needs_open: queue.length };
      });
    } finally { preparing = false; }
  }
  async function state() {
    const job = await read(), { tasks = [], run, collection = emptyCollection() } = await chrome.storage.local.get(["tasks", "run", "collection"]);
    const history = storedTasks(tasks, run, collection).filter(task => task.kind !== "details").map(taskSummary).reverse();
    if (!job) return { tasks: history, job: null, result: null, first_stage_running: run?.status === "running", busy: busy() };
    const { products, ...summary } = job;
    const origins = [...new Set(job.queue.slice(job.cursor).filter(entry => C.needsCheck(products, entry)).map(entry => S.originPattern(entry.product_url)))];
    if (job.required_origin) origins.push(job.required_origin);
    const required = [];
    for (const origin of new Set(origins)) if (!await chrome.permissions.contains({ origins: [origin] })) required.push(origin);
    return { tasks: history, job: summary, result: C.report(job), required_origins: required, first_stage_running: run?.status === "running", busy: busy() };
  }
  async function start(options = {}) {
    if (busy()) throw new Error("Дождитесь завершения текущей операции.");
    preparing = true;
    try {
      await guard(); const job = await read();
      if (!job || !["ready", "paused"].includes(job.status)) throw new Error("Нет очереди карточек для продолжения.");
      const ms = interval(options.interval_seconds ?? job.interval_ms / 1000);
      if (job.tab_id != null) {
        let tab; try { tab = await chrome.tabs.get(job.tab_id); } catch { /* recreate a closed working tab */ }
        if (tab && ["challenge", "rate-limit"].includes(job.pause_reason)) { await sendToTab(tab.id, "RESET"); await sendToTab(tab.id, "CHECK"); }
      }
      await withStateLock(async () => {
        const latest = await read(); if (latest?.id !== job.id || !["ready", "paused"].includes(latest.status)) throw new Error("Состояние задания изменилось. Обновите страницу.");
        await chrome.storage.local.set({ [key]: { ...note(latest, "waiting", "Продолжаю поиск поставщиков…"), status: "running", pause_reason: null, required_origin: null, interval_ms: ms,
          next_open_at: latest.last_completed_at ? latest.last_completed_at + ms : latest.next_open_at } });
        await chrome.alarms.create(alarm, { periodInMinutes: 1 });
      });
    } finally { preparing = false; }
    void process(); return { started: true };
  }
  async function cancelContent(job) {
    if (job?.tab_id != null) try { await chrome.tabs.sendMessage(job.tab_id, { target: "1688-content", type: "CANCEL" }); } catch { /* closed or navigating tab */ }
  }
  async function pause(reason = "manual", message = "Поиск поставщиков приостановлен. Можно продолжить с сохранённого места.") {
    const paused = await withStateLock(async () => {
      const job = await read(); if (job?.status !== "running") return null;
      const next = { ...note(job, "paused", message), status: "paused", pause_reason: reason, ...(reason === "challenge" ? { attention_id: crypto.randomUUID(), attention_notification_error: null } : {}) };
      await chrome.storage.local.set({ [key]: next }); await chrome.alarms.clear(alarm); return next;
    });
    await cancelContent(paused); await syncAttention(); return { paused: true };
  }
  async function skip() {
    const finished = await withStateLock(async () => {
      const job = await read(); if (!job || job.status === "finished") return job;
      const count = job.queue.length - job.cursor;
      const next = { ...note(job, "finished", "Проверка оставшихся карточек пропущена. Итоговая таблица готова; неопределённые продавцы отмечены как «Поставщик неизвестен»."),
        status: "finished", skipped_count: count, finished_at: new Date().toISOString(), next_open_at: null, pause_reason: null };
      await chrome.storage.local.set({ [key]: next }); await chrome.alarms.clear(alarm); return next;
    });
    await cancelContent(finished); return { skipped: true };
  }
  async function setInterval(options) {
    const ms = interval(options.interval_seconds);
    return withStateLock(async () => {
      const job = await read(); if (!job || job.status === "finished") throw new Error("Нет активного задания этапа 2.");
      await chrome.storage.local.set({ [key]: { ...job, interval_ms: ms, next_open_at: job.last_completed_at ? job.last_completed_at + ms : job.next_open_at } });
      return { saved: true };
    });
  }
  async function waitTab(tabId, jobId, expected = null) {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      if (!await running(jobId)) return false;
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete" && (!expected || tab.url === expected)) return true;
      await delay(350);
    }
    throw new Error("Карточка долго загружается. Дождитесь загрузки и нажмите «Продолжить».");
  }
  async function step(job) {
    const entry = job.queue[job.cursor];
    if (!entry) {
      await change(job.id, current => ({ ...note(current, "finished", "Поиск завершён. Таблица поставщиков готова."), status: "finished", finished_at: new Date().toISOString(), next_open_at: null })); return;
    }
    if (!C.needsCheck(job.products, entry)) { await change(job.id, current => ({ ...current, cursor: current.cursor + 1 })); return; }
    const startedAt = Date.now();
    await ensureAccess(entry.product_url);
    await change(job.id, current => note({ ...current, current_key: entry.key }, "opening", "Открываю карточку " + (job.cursor + 1) + " из " + job.queue.length + ": " + entry.title));
    let tab;
    if (job.tab_id != null) try { tab = await chrome.tabs.get(job.tab_id); } catch { /* recreate only our working tab */ }
    if (tab && S.webUrl(tab.url)) { await sendToTab(tab.id, "RESET"); await sendToTab(tab.id, "CHECK"); }
    if (!await running(job.id)) return;
    if (!tab) tab = await chrome.tabs.create({ url: entry.product_url, active: false });
    else if (S.canonicalUrl(tab.url) !== S.canonicalUrl(entry.product_url)) {
      const before = new URL(tab.url), after = new URL(entry.product_url);
      // A hash-only navigation retains the old DOM while an SPA hydrates. Use a
      // local blank document first so its previous seller cannot be attributed
      // to the new offer. This adds no request to the marketplace.
      if (before.origin === after.origin && before.pathname === after.pathname && before.search === after.search && before.hash !== after.hash) {
        tab = await chrome.tabs.update(tab.id, { url: "about:blank" });
        if (!await waitTab(tab.id, job.id, "about:blank")) return;
      }
      if (!await running(job.id)) return;
      tab = await chrome.tabs.update(tab.id, { url: entry.product_url });
    }
    const current = await change(job.id, latest => note({ ...latest, tab_id: tab.id, opened_keys: [...new Set([...latest.opened_keys, entry.key])] }, "reading", "Извлекаю данные продавца: " + entry.title), true);
    if (!current || current.status !== "running" || !await waitTab(tab.id, job.id)) return;
    if (!await running(job.id)) return;
    await sendToTab(tab.id, "RESET"); if (!await running(job.id)) return;
    await sendToTab(tab.id, "CHECK"); if (!await running(job.id)) return;
    const profile = await siteProfile(entry.product_url); if (!await running(job.id)) return;
    const result = await sendToTab(tab.id, "DETAIL", { query: entry.query, timeout: 6000, profile, supplier_only: true });
    await withStateLock(async () => {
      const latest = await running(job.id); if (!latest || latest.cursor !== job.cursor) return;
      const at = new Date().toISOString(), found = C.matchDetail(entry, latest.products, result.products || []);
      C.applyDetail(latest.products, entry, found, at);
      const { [cacheKey]: saved = {} } = await chrome.storage.local.get(cacheKey), cache = new Map(Object.entries(saved));
      for (const row of latest.products) if (!row.supplier_conflict && C.identified(row.supplier) && ["product-page", "shared-supplier-identity"].includes(row.supplier.method)) cache.set(C.offerKey(row), row.supplier);
      const done = latest.cursor + 1 === latest.queue.length, now = Date.now();
      const next = { ...note(latest, done ? "finished" : "waiting", found && C.identified(found) ? "Продавец определён: " + (found.shop_name || found.supplier_url || found.supplier_id) : "Поставщик неизвестен. Карточка сохранена в итоговой таблице."),
        cursor: latest.cursor + 1, checked_count: latest.checked_count + 1, duration_ms: latest.duration_ms + now - startedAt,
        current_key: null, last_completed_at: now, next_open_at: done ? null : now + latest.interval_ms,
        status: done ? "finished" : "running", finished_at: done ? at : null };
      await chrome.storage.local.set({ [key]: next, [cacheKey]: Object.fromEntries(cache) });
    });
  }
  async function process() {
    if (working || preparing) return;
    working = true;
    let id;
    try {
      let job = await read(); if (job?.status !== "running") return; id = job.id;
      const { run } = await chrome.storage.local.get("run");
      if (run?.status === "running") { await pause("other-stage", "Этап 1 выполняется. Приостановите его перед продолжением этапа 2."); return; }
      await change(id, current => ({ ...current, worker_active: true }));
      await chrome.alarms.create(alarm, { periodInMinutes: 1 });
      while ((job = await running(id))) {
        if (job.next_open_at && job.next_open_at > Date.now()) { await delay(Math.min(1000, job.next_open_at - Date.now())); continue; }
        await step(job);
      }
    } catch (error) {
      const job = await read();
      if (job && job.id === id && job.status === "running") {
        if (error.code === "ACCESS") await change(id, current => ({ ...current, required_origin: error.required_origin }));
        await pause(error.code === "CHALLENGE" ? "challenge" : error.code === "RATE_LIMIT" ? "rate-limit" : error.code === "ACCESS" ? "permission" : "error", error.message || "Не удалось прочитать карточку. Проверьте рабочую вкладку и продолжите.");
      }
    } finally {
      working = false;
      await withStateLock(async () => {
        const job = await read();
        if (job && job.id === id) { await chrome.storage.local.set({ [key]: { ...job, worker_active: false } }); if (job.status !== "running") await chrome.alarms.clear(alarm); }
      });
    }
  }
  async function showTab() {
    const job = await read(); if (job?.tab_id == null) throw new Error("Рабочая вкладка ещё не открыта.");
    const tab = await chrome.tabs.update(job.tab_id, { active: true });
    if (tab.windowId != null && chrome.windows?.update) await chrome.windows.update(tab.windowId, { focused: true }); return {};
  }
  async function excelSnapshot() {
    const job = await read(); if (!job) throw new Error("Сначала подготовьте результат этапа 2.");
    const result = C.report(job), occurrences = new Map();
    for (const row of result.products) { const key = C.offerKey(row); occurrences.set(key, (occurrences.get(key) || 0) + 1); }
    const convert = row => ({ ...row, stage2_offer_key: C.offerKey(row), stage2_offer_occurrences: occurrences.get(C.offerKey(row)), shop_name: row.supplier_conflict || !C.identified(row.supplier) ? C.unknown : row.supplier.shop_name || (row.supplier.supplier_url ? new URL(row.supplier.supplier_url).hostname : "Поставщик " + row.supplier.supplier_id),
      supplier_id: row.supplier_conflict ? null : row.supplier.supplier_id, supplier_url: row.supplier_conflict ? null : row.supplier.supplier_url });
    const products = result.products.map(convert);
    return { ...result, exported_at: new Date().toISOString(), total_products: products.length, total_tasks: result.source_tasks.length, products,
      suppliers: result.suppliers.filter(item => item.status !== "unknown").map(item => ({ ...item, products: item.products.map(convert) })),
      unresolved_products: result.suppliers.filter(item => item.status === "unknown").flatMap(item => item.products.map(convert)), pages: [],
      tasks: result.source_tasks.map(task => ({ ...task, products: products.filter(row => row.source_task_id === task.id), pages: [], log: [] })) };
  }
  async function exportResult(format = "json") {
    const job = await read(); if (!job) throw new Error("Сначала выберите задания и обработайте сохранённые данные.");
    const result = C.report(job);
    if (!["json", "csv"].includes(format)) throw new Error("Неизвестный формат экспорта.");
    let body;
    if (format === "json") body = JSON.stringify(result, null, 2);
    else {
      const escape = value => { let text = String(value ?? ""); if (/^[=+@-]/.test(text.trimStart())) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
      const fields = ["Поставщик", "Магазин", "Площадка", "Статус", "Товар", "Карточка", "Задание", "ID наблюдения"];
      const lines = result.suppliers.flatMap(supplier => supplier.products.map(row => [supplier.shop_name, supplier.supplier_url, row.source, supplier.status === "unknown" ? C.unknown : "Определён", row.title, row.product_url, row.source_task_name, row.observation_id]));
      body = "\uFEFF" + [fields, ...lines].map(line => line.map(escape).join(";")).join("\r\n");
    }
    await chrome.downloads.download({ url: "data:" + (format === "json" ? "application/json" : "text/csv") + ";charset=utf-8," + encodeURIComponent(body), filename: "supplier-search-" + job.id + "." + format, saveAs: true });
    return { exported: true };
  }
  async function progress(sender, detail) {
    const job = await read(); if (job?.status !== "running" || job.tab_id !== sender.tab.id) return;
    await change(job.id, current => ({ ...current, stage: "reading", message: S.text(detail.message)?.slice(0, 500) || current.message }));
  }
  async function closed(tabId) { const job = await read(); if (job?.tab_id === tabId && job.status === "running") await pause("tab-closed", "Рабочая вкладка закрыта. Нажмите «Продолжить», чтобы открыть её заново."); }
  return { busy, isRunning, prepare, state, start, pause, skip, setInterval, process, showTab, exportResult, excelSnapshot, progress, closed, syncAttention, openAttention, alarm, key, cacheKey };
})();
chrome.storage.onChanged?.addListener((changes, area) => { if (area === "local" && "supplier_search" in changes) void SupplierStage.syncAttention().catch(() => {}); });
chrome.notifications?.onClicked?.addListener(id => { void SupplierStage.openAttention(id).catch(() => {}); });
chrome.notifications?.onButtonClicked?.addListener(id => { void SupplierStage.openAttention(id).catch(() => {}); });
void SupplierStage.syncAttention().catch(() => {});
