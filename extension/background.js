"use strict";
importScripts("shared.js");
const S = globalThis.SupplierCollector;
const ALARM = "1688-collector-progress";
let processing = false, starting = false, stateQueue = Promise.resolve();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emptyCollection = () => ({ products: [], pages: [], raw_cards: [] });
const productKey = item => `${item.source}:${item.product_id}`;
function detailQueue(products) {
  const candidates = products.filter(item => !item.shop_name || !item.supplier_url).sort((a, b) => Boolean(a.detail_checked_at) - Boolean(b.detail_checked_at));
  const groups = new Map();
  for (const item of candidates) {
    const key = item.supplier_id ? `${item.source}:supplier:${item.supplier_id}` : item.supplier_url ? `${item.source}:store:${item.supplier_url}` : productKey(item);
    if (!groups.has(key)) groups.set(key, productKey(item));
  }
  return [...groups.values()];
}
function withStateLock(operation) { const result = stateQueue.then(operation); stateQueue = result.catch(() => {}); return result; }
async function activeRun(id) { const { run } = await chrome.storage.local.get("run"); return run?.id === id && run.status === "running" ? run : null; }
function logEntry(run, stage, message) {
  return { ...run, stage, message, updated_at: new Date().toISOString(), log: [...(run.log || []), { at: new Date().toISOString(), stage, message }].slice(-100) };
}
async function updateRun(id, change) {
  return withStateLock(async () => { const run = await activeRun(id); if (!run) return null; const next = change(run); await chrome.storage.local.set({ run: next }); return next; });
}
async function sendToTab(tabId, type, options) {
  const tab = await chrome.tabs.get(tabId);
  if (!S.isMarketplaceUrl(tab.url || "")) throw new Error("Откройте страницу на 1688, Alibaba или Made-in-China.");
  const message = { target: "1688-content", type, options };
  let response;
  try { response = await chrome.tabs.sendMessage(tabId, message); }
  catch (error) {
    if (!/receiving end|establish connection/i.test(error.message)) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "engine.js", "content.js"] });
    response = await chrome.tabs.sendMessage(tabId, message);
  }
  if (!response?.ok) { const error = new Error(response?.error || "Страница не ответила. Обновите её и повторите сбор."); error.code = response?.code; error.partial = response?.partial; throw error; }
  return response.result;
}
async function finish(id, status, message, reason = null) {
  await withStateLock(async () => {
    const run = await activeRun(id); if (!run) return;
    await chrome.storage.local.set({ run: { ...logEntry(run, status, message), status, pause_reason: reason } });
    await chrome.alarms.clear(ALARM);
  });
}
async function waitForTab(tabId, id) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!await activeRun(id)) { const error = new Error("Работа приостановлена."); error.code = "CANCELLED"; throw error; }
    const tab = await chrome.tabs.get(tabId); if (tab.status === "complete") return;
    await delay(350);
  }
  throw new Error("Страница долго загружается. Дождитесь загрузки и продолжите работу.");
}
function mergeResult(collection, result, partial, checkpoint) {
  const products = S.mergeProducts(collection.products, result.products);
  const raw = new Map((collection.raw_cards || []).map(card => [`${card.source}:${card.product_id}:${card.source_page_url}`, card]));
  for (const card of result.raw_cards || []) raw.set(`${card.source}:${card.product_id}:${card.source_page_url}`, card);
  let pages = collection.pages || [];
  if (result.page) {
    pages = pages.filter(page => page.checkpoint !== checkpoint && !(page.page_url === result.page.page_url && page.query === result.page.query && page.fingerprint === result.page.fingerprint));
    pages.push({ ...result.page, partial, checkpoint });
  }
  return { products, pages, raw_cards: [...raw.values()] };
}
async function saveSearch(id, result, partial = false) {
  return withStateLock(async () => {
    const { run, collection = emptyCollection() } = await chrome.storage.local.get(["run", "collection"]);
    if (run?.id !== id || (!partial && run.status !== "running")) return null;
    if (!partial && run.seen_fingerprints.includes(result.page.fingerprint)) throw new Error("Повторилась уже собранная выдача. Проверьте страницу и продолжите сбор.");
    const merged = mergeResult(collection, result, partial, `${id}:${run.completed_pages}`);
    const keys = [...new Set([...(run.product_keys || []), ...result.products.map(productKey)])];
    let next = { ...run, product_keys: keys };
    if (!partial) next = logEntry({ ...next, completed_pages: run.completed_pages + 1, previous_fingerprint: result.page.fingerprint, seen_fingerprints: [...run.seen_fingerprints, result.page.fingerprint], phase: "navigate" }, "saved", `Сохранена страница ${run.completed_pages + 1}: ${result.products.length} товаров. Всего: ${merged.products.length}.`);
    await chrome.storage.local.set({ collection: merged, run: next });
    return { run: next, count: merged.products.length };
  });
}
async function beginDetails(id, note = "Выдача собрана.") {
  const { collection = emptyCollection() } = await chrome.storage.local.get("collection");
  const run = await activeRun(id); if (!run) return;
  const keys = new Set(run.product_keys || []);
  const queue = detailQueue(collection.products.filter(item => keys.has(productKey(item))));
  if (!run.enrich || !queue.length) { await finish(id, "finished", `${note} Данные доступны в таблице поставщиков.`); return; }
  await updateRun(id, current => logEntry({ ...current, phase: "details", detail_queue: queue, detail_index: 0, detail_total: queue.length }, "details", `${note} Проверю ${queue.length} карточек товаров для получения данных магазина.`));
}
async function detailStep(run) {
  if (run.detail_index >= run.detail_queue.length) { await finish(run.id, "finished", "Проверка карточек завершена. Неподтверждённые поля оставлены пустыми."); return; }
  const { collection = emptyCollection() } = await chrome.storage.local.get("collection");
  const key = run.detail_queue[run.detail_index];
  const item = collection.products.find(product => productKey(product) === key);
  if (!item) { await updateRun(run.id, current => ({ ...current, detail_index: current.detail_index + 1 })); return; }
  await updateRun(run.id, current => logEntry(current, "detail", `Карточка ${run.detail_index + 1}/${run.detail_total}: ${item.source}, товар ${item.product_id}.`));
  let tab;
  if (run.detail_tab_id != null) { try { tab = await chrome.tabs.get(run.detail_tab_id); } catch { /* user closed the working tab */ } }
  if (!tab) {
    tab = await chrome.tabs.create({ url: item.product_url, active: false });
    await updateRun(run.id, current => ({ ...current, detail_tab_id: tab.id }));
  } else if (S.productUrl(tab.url)?.url !== item.product_url) tab = await chrome.tabs.update(tab.id, { url: item.product_url });
  if (!await activeRun(run.id)) return;
  await waitForTab(tab.id, run.id);
  const result = await sendToTab(tab.id, "DETAIL", { query: item.query, timeout: 6000 });
  await withStateLock(async () => {
    const current = await activeRun(run.id); if (!current) return;
    const { collection: latest = emptyCollection() } = await chrome.storage.local.get("collection");
    const matched = result.products.filter(product => productKey(product) === key);
    let products = S.mergeProducts(latest.products, matched);
    const found = products.find(product => productKey(product) === key);
    if (found && (found.shop_name || found.supplier_url)) products = products.map(product => {
      const related = product.source === item.source && ((item.supplier_id && product.supplier_id === item.supplier_id) || (item.supplier_url && product.supplier_url === item.supplier_url));
      if (!related) return product;
      const copy = { ...product, field_sources: { ...(product.field_sources || {}) } };
      for (const field of ["shop_name", "supplier_url"]) if (!copy[field] && found[field]) { copy[field] = found[field]; copy.field_sources[field] = "verified-card:shared-supplier-identity"; }
      return copy;
    });
    const message = found?.shop_name ? `Получен магазин: ${found.shop_name}.` : `У товара ${item.product_id} имя магазина не найдено; данные не выдумываются.`;
    await chrome.storage.local.set({ collection: { ...latest, products }, run: logEntry({ ...current, detail_index: current.detail_index + 1 }, "detail-saved", message) });
  });
  await delay(run.interval_ms);
}
async function processRun() {
  if (processing) return;
  processing = true;
  let id;
  try {
    let { run } = await chrome.storage.local.get("run"); if (!run || run.status !== "running") return;
    id = run.id;
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    if (run.phase === "details") { await detailStep(run); return; }
    if (run.phase === "navigate") {
      if (run.completed_pages >= run.max_pages) { await beginDetails(id); return; }
      await waitForTab(run.tab_id, id);
      await sendToTab(run.tab_id, "RESET");
      const peek = await sendToTab(run.tab_id, "PEEK");
      const previous = new Set(run.previous_fingerprint.split(","));
      const alreadyMoved = peek.products.some(item => !previous.has(productKey(item)));
      if (!alreadyMoved) {
        await updateRun(id, current => logEntry(current, "waiting", `Пауза ${current.interval_ms / 1000} сек. перед следующей страницей.`));
        await delay(run.interval_ms);
        if (!await activeRun(id)) return;
        const next = await sendToTab(run.tab_id, "NEXT");
        if (!next.moved) { await beginDetails(id, "Доступная кнопка следующей страницы не найдена. Можно продолжить вручную."); return; }
        await delay(1200);
      }
      await updateRun(id, current => logEntry({ ...current, phase: "search" }, "loading", "Ожидаю следующую страницу…"));
      return;
    }
    await waitForTab(run.tab_id, id);
    const result = await sendToTab(run.tab_id, "COLLECT", { query: run.query, scroll: run.scroll, raw: run.raw, previousFingerprint: run.previous_fingerprint, scroll_delay: run.interval_ms >= 5000 ? 1000 : 650 });
    const saved = await saveSearch(id, result); if (!saved) return;
    if (saved.run.completed_pages >= saved.run.max_pages) await beginDetails(id);
  } catch (error) {
    if (id && error.partial) await saveSearch(id, error.partial, true);
    if (id) await finish(id, "paused", error.message, error.code === "CHALLENGE" ? "challenge" : error.code === "RATE_LIMIT" ? "rate-limit" : "error");
  } finally {
    processing = false;
    const { run } = await chrome.storage.local.get("run");
    if (run?.status === "running") setTimeout(processRun, 100);
  }
}
async function startRun(options, detailsOnly = false) {
  if (starting || processing) throw new Error("Работа уже идёт или приостанавливается. Дождитесь остановки.");
  starting = true;
  try {
    const { run: old, collection = emptyCollection() } = await chrome.storage.local.get(["run", "collection"]);
    if (old?.status === "running") throw new Error("Работа уже идёт. Сначала поставьте её на паузу.");
    let tab;
    if (!detailsOnly) {
      tab = options.tab_id ? await chrome.tabs.get(Number(options.tab_id)) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab || !S.isMarketplaceUrl(tab.url || "")) throw new Error("Сначала откройте выдачу 1688, Alibaba или Made-in-China.");
      if (S.productUrl(tab.url)) throw new Error("Откройте поисковую выдачу, а не карточку товара.");
    }
    const maxPages = Number(options.max_pages || 1);
    const interval = Number(options.interval_seconds ?? 3);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error("Укажите число страниц от 1 до 20.");
    if (!Number.isFinite(interval) || interval < 1 || interval > 30) throw new Error("Укажите паузу от 1 до 30 секунд.");
    const queue = detailQueue(collection.products);
    if (detailsOnly && !queue.length) throw new Error("Нет товаров с недостающими данными магазина. Сначала соберите или импортируйте выдачу.");
    const run = logEntry({
      id: crypto.randomUUID(), status: "running", phase: detailsOnly ? "details" : "search", tab_id: tab?.id || null,
      max_pages: maxPages, completed_pages: 0, query: S.text(options.query), scroll: options.scroll !== false,
      raw: options.raw !== false, enrich: options.enrich === true, interval_ms: interval * 1000,
      previous_fingerprint: null, seen_fingerprints: [], product_keys: [],
      detail_queue: detailsOnly ? queue : [], detail_index: 0, detail_total: detailsOnly ? queue.length : 0,
      started_at: new Date().toISOString(), pause_reason: null, log: []
    }, detailsOnly ? "details" : "loading", detailsOnly ? `Проверю ${queue.length} карточек товаров.` : "Ожидаю товары и собираю выдачу…");
    await withStateLock(async () => { await chrome.storage.local.set({ run, preferences: { max_pages: maxPages, query: run.query || "", scroll: run.scroll, raw: run.raw, enrich: run.enrich, interval_seconds: interval } }); await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); });
    void processRun();
    return { started: true };
  } finally { starting = false; }
}
async function pauseRun(status = "paused") {
  const paused = await withStateLock(async () => {
    const { run } = await chrome.storage.local.get("run"); if (run?.status !== "running") return null;
    await chrome.storage.local.set({ run: { ...logEntry(run, status, "Работа приостановлена. Данные сохранены; можно продолжить с текущего этапа."), status, pause_reason: "manual" } });
    await chrome.alarms.clear(ALARM); return run;
  });
  if (paused) for (const tabId of [paused.tab_id, paused.detail_tab_id].filter(id => id != null)) {
    try { await chrome.tabs.sendMessage(tabId, { target: "1688-content", type: "CANCEL" }); } catch { /* navigation can replace the page */ }
  }
  return { paused: true, stopped: true };
}
async function resumeRun(options = {}) {
  if (processing || starting) throw new Error("Дождитесь завершения приостановки.");
  const { run } = await chrome.storage.local.get("run");
  if (!run || !["paused", "stopped"].includes(run.status)) throw new Error("Нет приостановленного задания.");
  const interval = Number(options.interval_seconds ?? run.interval_ms / 1000);
  if (!Number.isFinite(interval) || interval < 1 || interval > 30) throw new Error("Укажите паузу от 1 до 30 секунд.");
  const tabId = run.phase === "details" ? run.detail_tab_id : run.tab_id;
  if (tabId != null) { await chrome.tabs.get(tabId); await sendToTab(tabId, "RESET"); }
  await withStateLock(async () => { await chrome.storage.local.set({ run: { ...logEntry(run, run.phase, "Продолжаю с сохранённого этапа…"), status: "running", pause_reason: null, interval_ms: interval * 1000 } }); });
  void processRun(); return { resumed: true };
}
async function getState(full = false) {
  const { collection = emptyCollection(), run = null, preferences = null } = await chrome.storage.local.get(["collection", "run", "preferences"]);
  const groups = S.supplierGroups(collection.products);
  return { count: collection.products.length, page_count: collection.pages.filter(page => !page.partial).length,
    supplier_count: groups.suppliers.length, unresolved_count: groups.unresolved.length, missing_names: collection.products.filter(item => !item.shop_name).length,
    raw_count: (collection.raw_cards || []).length, preview: collection.products.slice(-4).reverse(),
    warnings: collection.pages.at(-1)?.warnings || [], run, preferences,
    ...(full ? { products: collection.products, suppliers: groups.suppliers, unresolved: groups.unresolved } : {}) };
}
async function exportCollection(format = "json") {
  const { collection = emptyCollection() } = await chrome.storage.local.get("collection");
  if (!collection.products.length) throw new Error("Сначала соберите или импортируйте товары.");
  const groups = S.supplierGroups(collection.products);
  const output = { schema_version: 2, sources: [...new Set(collection.products.map(item => item.source))], exported_at: new Date().toISOString(), total_products: collection.products.length, total_suppliers: groups.suppliers.length,
    pages: collection.pages, suppliers: groups.suppliers, unresolved_products: groups.unresolved, products: collection.products,
    ...(format === "raw" ? { raw_cards: collection.raw_cards || [] } : {}) };
  const csv = format === "csv";
  const url = `data:${csv ? "text/csv" : "application/json"};charset=utf-8,` + encodeURIComponent(csv ? S.csv(collection.products) : JSON.stringify(output, null, 2));
  const downloadId = await chrome.downloads.download({ url, filename: `suppliers-${format}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${csv ? "csv" : "json"}`, saveAs: true });
  return { download_id: downloadId };
}
async function importCollection(input) {
  return withStateLock(async () => {
    const { collection = emptyCollection(), run } = await chrome.storage.local.get(["collection", "run"]);
    if (processing || starting || run?.status === "running") throw new Error("Приостановите работу перед импортом.");
    const imported = S.importProducts(input);
    const products = S.mergeProducts(collection.products, imported);
    const raw = new Map((collection.raw_cards || []).map(card => [`${card.source}:${card.product_id}:${card.source_page_url}`, card]));
    const keys = new Set(imported.map(productKey));
    if (Array.isArray(input.raw_cards) && input.raw_cards.length <= 10000) for (const card of input.raw_cards) {
      const source = S.marketplace(card?.source_page_url);
      if (source && keys.has(`${source}:${card.product_id}`) && typeof card.html === "string" && card.html.length <= 20000) {
        const safe = { source, product_id: String(card.product_id), source_page_url: card.source_page_url, html: card.html, collected_at: new Date().toISOString() };
        raw.set(`${safe.source}:${safe.product_id}:${safe.source_page_url}`, safe);
      }
    }
    await chrome.storage.local.set({ collection: { ...collection, products, raw_cards: [...raw.values()] } });
    return { imported: imported.length, total: products.length };
  });
}
async function clearCollection() {
  return withStateLock(async () => {
    const { run } = await chrome.storage.local.get("run");
    if (run?.status === "running" || processing || starting) throw new Error("Приостановите работу и дождитесь остановки перед очисткой.");
    await chrome.storage.local.remove(["collection", "run"]); return { cleared: true };
  });
}
async function listTabs() { return (await chrome.tabs.query({})).filter(tab => S.isMarketplaceUrl(tab.url || "") && !S.productUrl(tab.url)).map(tab => ({ id: tab.id, title: tab.title || S.marketplace(tab.url), source: S.marketplace(tab.url) })); }
async function openWorkingTab() { const { run } = await chrome.storage.local.get("run"); const id = run?.phase === "details" ? run.detail_tab_id : run?.tab_id; if (id == null) throw new Error("Нет рабочей вкладки."); await chrome.tabs.update(id, { active: true }); return {}; }
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "1688-background" || sender.id !== chrome.runtime.id) return;
  if (message.type === "PROGRESS" && sender.tab) {
    void withStateLock(async () => {
      const { run } = await chrome.storage.local.get("run");
      if (run?.status !== "running" || ![run.tab_id, run.detail_tab_id].includes(sender.tab.id)) return;
      const detail = message.detail || {};
      await chrome.storage.local.set({ run: logEntry({ ...run, current_count: Math.max(0, Number(detail.count) || 0) }, S.text(detail.stage)?.slice(0, 40) || "loading", S.text(detail.message)?.slice(0, 500) || "Обрабатываю страницу…") });
    }); respond({ ok: true }); return;
  }
  if (![chrome.runtime.getURL("popup.html"), chrome.runtime.getURL("dashboard.html")].includes(sender.url)) return;
  const operations = {
    STATE: () => getState(false), DATA: () => getState(true), TABS: listTabs,
    START: () => startRun(message.options || {}), ENRICH: () => startRun(message.options || {}, true),
    PAUSE: () => pauseRun(), STOP: () => pauseRun("stopped"), RESUME: () => resumeRun(message.options || {}),
    EXPORT: () => exportCollection(message.options?.format || "json"), IMPORT: () => importCollection(message.options?.data),
    RAW: async () => (await chrome.storage.local.get("collection")).collection?.raw_cards || [],
    OPEN_DASHBOARD: async () => { await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }); return {}; },
    SHOW_TAB: openWorkingTab, CLEAR: clearCollection
  };
  const operation = operations[message.type]; if (!operation) return;
  Promise.resolve().then(operation).then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, error: error.message })); return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void processRun(); });
chrome.runtime.onStartup.addListener(() => { void processRun(); });
chrome.tabs.onRemoved.addListener(async tabId => { const { run } = await chrome.storage.local.get("run"); if (run?.status === "running" && [run.tab_id, run.detail_tab_id].includes(tabId)) await finish(run.id, "paused", "Рабочая вкладка закрыта. Откройте выдачу и начните новое задание.", "tab-closed"); });
