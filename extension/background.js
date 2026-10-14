"use strict";
importScripts("shared.js");
const S = globalThis.SupplierCollector;
const ALARM = "1688-collector-progress";
let processing = false, starting = false, stateQueue = Promise.resolve();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emptyCollection = () => ({ products: [], pages: [], raw_cards: [] });
const productKey = item => `${item.source}:${item.product_id}`;
function detailQueue(products) {
  const candidates = products.filter(item => item.product_url && (!item.shop_name || !item.supplier_url)).sort((a, b) => Boolean(a.detail_checked_at) - Boolean(b.detail_checked_at));
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
  await ensureAccess(tab.url);
  const message = { target: "1688-content", type, options };
  let response;
  try { response = await chrome.tabs.sendMessage(tabId, message); }
  catch (error) {
    if (!/receiving end|establish connection/i.test(error.message)) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "navigation.js", "generic.js", "engine.js", "content.js"] });
    response = await chrome.tabs.sendMessage(tabId, message);
  }
  if (!response?.ok) { const error = new Error(response?.error || "Страница не ответила. Обновите её и повторите сбор."); error.code = response?.code; error.partial = response?.partial; throw error; }
  return response.result;
}
async function hasAccess(url) {
  if (!S.webUrl(url)) return false;
  return chrome.permissions ? chrome.permissions.contains({ origins: [S.originPattern(url)] }) : S.isMarketplaceUrl(url);
}
async function ensureAccess(url) {
  if (!S.webUrl(url)) throw new Error("Откройте обычный сайт HTTP или HTTPS.");
  if (!await hasAccess(url)) { const error = new Error(`Разрешите расширению доступ к сайту ${new URL(url).hostname}.`); error.code = "ACCESS"; error.required_origin = S.originPattern(url); throw error; }
}
async function siteProfile(url) { const { profiles = {} } = await chrome.storage.local.get("profiles"); return profiles[new URL(url).origin] || {}; }
async function storeProfile(url, patch) {
  return withStateLock(async () => { const { profiles = {} } = await chrome.storage.local.get("profiles"); const origin = new URL(url).origin; profiles[origin] = { ...(profiles[origin] || {}), ...patch, updated_at: new Date().toISOString() }; await chrome.storage.local.set({ profiles }); return profiles[origin]; });
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
  } else if (S.productUrl(tab.url, undefined, String(item.source).startsWith("web:"))?.url !== item.product_url) tab = await chrome.tabs.update(tab.id, { url: item.product_url });
  if (!await activeRun(run.id)) return;
  await waitForTab(tab.id, run.id);
  const result = await sendToTab(tab.id, "DETAIL", { query: item.query, timeout: 6000, profile: await siteProfile(item.product_url) });
  await withStateLock(async () => {
    const current = await activeRun(run.id); if (!current) return;
    const { collection: latest = emptyCollection() } = await chrome.storage.local.get("collection");
    const matched = result.products.filter(product => productKey(product) === key);
    if (!matched.length && String(item.source).startsWith("web:") && result.products.length === 1) matched.push({ ...result.products[0], canonical_detail_url: result.products[0].product_url, source: item.source, product_id: item.product_id, product_url: item.product_url });
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
async function pauseAccess(id, error, tabId) {
  await updateRun(id, current => ({ ...current, required_origin: error.required_origin, ...(current.phase !== "details" && tabId != null ? { tab_id: tabId, phase: "search", pending_navigation: null } : {}) }));
  await finish(id, "paused", error.message, "permission");
}
async function awaitNavigation(run) {
  const previous = new Set(run.previous_fingerprint.split(","));
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    const current = await activeRun(run.id); if (!current) return;
    const pending = current.pending_navigation; if (!pending) return;
    const targetIds = pending.exact_tab_id != null ? [pending.exact_tab_id] : [...new Set([pending.source_tab_id, ...(pending.opened_ids || [])])];
    const matches = [], inaccessible = [];
    for (const tabId of targetIds.slice(0, 8)) {
      let tab; try { tab = await chrome.tabs.get(tabId); } catch { continue; }
      if (tab.status !== "complete" || !S.webUrl(tab.url)) continue;
      if (!await hasAccess(tab.url)) { inaccessible.push(tab); continue; }
      try {
        const peek = await sendToTab(tabId, "PEEK", { query: current.query, profile: await siteProfile(tab.url) });
        if (peek.products.some(item => !previous.has(productKey(item)))) matches.push(tab);
      } catch (error) {
        if (["CHALLENGE", "RATE_LIMIT"].includes(error.code)) {
          await updateRun(run.id, task => ({ ...task, tab_id: tabId, phase: "search", pending_navigation: null })); throw error;
        }
      }
    }
    if (matches.length === 1 && !inaccessible.length && (pending.exact_tab_id != null || Date.now() - pending.started_at >= 800)) {
      const target = matches[0];
      await updateRun(run.id, task => logEntry({ ...task, tab_id: target.id, phase: "search", pending_navigation: null, navigation: null }, "loading", target.id !== pending.source_tab_id ? "Следующая выдача открылась в новой вкладке. Переключаю сбор на неё." : "Переход подтверждён: появились новые товары.")); return;
    }
    if (matches.length > 1 || inaccessible.length && targetIds.length > 1 && pending.exact_tab_id == null) {
      await updateRun(run.id, task => ({ ...task, navigation_tabs: targetIds }));
      await finish(run.id, "paused", "Открылись несколько возможных вкладок. Выберите нужную в списке и нажмите «Продолжить в выбранной вкладке».", "new-tabs"); return;
    }
    if (inaccessible.length === 1) {
      const error = new Error(`Для продолжения разрешите доступ к ${new URL(inaccessible[0].url).hostname}.`); error.required_origin = S.originPattern(inaccessible[0].url);
      await pauseAccess(run.id, error, inaccessible[0].id); return;
    }
    await delay(350);
  }
  await finish(run.id, "paused", "После нажатия новые товары не появились. Проверьте страницу; если открылась вкладка без связи с исходной, выберите её вручную.", "navigation-unchanged");
}
async function navigateStep(run) {
  if (run.completed_pages >= run.max_pages) { await beginDetails(run.id); return; }
  if (run.pending_navigation) { await awaitNavigation(run); return; }
  await waitForTab(run.tab_id, run.id); await sendToTab(run.tab_id, "RESET");
  const tab = await chrome.tabs.get(run.tab_id), profile = await siteProfile(tab.url);
  const peek = await sendToTab(run.tab_id, "PEEK", { profile, query: run.query });
  const previous = new Set(run.previous_fingerprint.split(","));
  if (peek.products.some(item => !previous.has(productKey(item)))) { await updateRun(run.id, current => ({ ...current, phase: "search" })); return; }
  const navigation = await sendToTab(run.tab_id, "NAVIGATE_OPTIONS", { profile });
  const selected = run.chosen_navigation ? navigation.candidates.find(item => item.id === run.chosen_navigation) : navigation.chosen;
  await updateRun(run.id, current => ({ ...current, navigation }));
  if (!selected) {
    if (navigation.decision === "exhausted") { await beginDetails(run.id, "Кнопка следующей страницы отключена: доступная выдача закончилась."); return; }
    await finish(run.id, "paused", navigation.candidates.length ? "Есть несколько вариантов перелистывания. Проверьте варианты навигации или укажите кнопку на странице." : "Кнопка перелистывания не найдена уверенно. Укажите её на странице или продолжите в другой вкладке.", "navigation-choice"); return;
  }
  if (selected.href) await ensureAccess(selected.href);
  await updateRun(run.id, current => logEntry(current, "waiting", `Найден переход «${selected.label}» (оценка ${selected.confidence}/100). Пауза ${current.interval_ms / 1000} сек.`));
  await delay(run.interval_ms); if (!await activeRun(run.id)) return;
  await updateRun(run.id, current => ({ ...current, chosen_navigation: null, pending_navigation: { source_tab_id: run.tab_id, source_url: tab.url, candidate: selected, started_at: Date.now(), opened_ids: [] } }));
  if (selected.target_blank && selected.href) {
    const created = await chrome.tabs.create({ url: selected.href, active: false });
    await updateRun(run.id, current => ({ ...current, pending_navigation: { ...current.pending_navigation, exact_tab_id: created.id, opened_ids: [created.id] } }));
  } else if (selected.selector.startsWith("link[rel")) await chrome.tabs.update(run.tab_id, { url: selected.href });
  else {
    const clicked = await sendToTab(run.tab_id, "NEXT", { candidate_id: selected.id, profile });
    if (!clicked.moved) { await updateRun(run.id, current => ({ ...current, pending_navigation: null })); throw new Error("Элемент изменился перед нажатием. Повторите определение навигации."); }
  }
  const updated = await activeRun(run.id); if (updated) await awaitNavigation(updated);
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
      await navigateStep(run);
      return;
    }
    await waitForTab(run.tab_id, id);
    const tab = await chrome.tabs.get(run.tab_id);
    const result = await sendToTab(run.tab_id, "COLLECT", { query: run.query, scroll: run.scroll, raw: run.raw, profile: await siteProfile(tab.url), previousFingerprint: run.previous_fingerprint, scroll_delay: run.interval_ms >= 5000 ? 1000 : 650 });
    const saved = await saveSearch(id, result); if (!saved) return;
    if (saved.run.completed_pages >= saved.run.max_pages) await beginDetails(id);
  } catch (error) {
    if (id && error.partial) await saveSearch(id, error.partial, true);
    if (id && error.code === "ACCESS") { await pauseAccess(id, error); return; }
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
      if (!tab || !S.webUrl(tab.url || "")) throw new Error("Сначала откройте сайт с товарами.");
      await ensureAccess(tab.url);
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
    await withStateLock(async () => { await chrome.storage.local.set({ run, last_navigation: null, preferences: { max_pages: maxPages, query: run.query || "", scroll: run.scroll, raw: run.raw, enrich: run.enrich, interval_seconds: interval } }); await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); });
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
  if (options.tab_id != null && run.phase !== "details") { const selected = await chrome.tabs.get(Number(options.tab_id)); await ensureAccess(selected.url); run.tab_id = selected.id; run.phase = "search"; run.pending_navigation = null; run.navigation = null; }
  const tabId = run.phase === "details" ? run.detail_tab_id : run.tab_id;
  if (tabId != null) { await chrome.tabs.get(tabId); await sendToTab(tabId, "RESET"); }
  await withStateLock(async () => { await chrome.storage.local.set({ run: { ...logEntry(run, run.phase, "Продолжаю с сохранённого этапа…"), status: "running", pause_reason: null, required_origin: null, interval_ms: interval * 1000 } }); });
  void processRun(); return { resumed: true };
}
async function getState(full = false) {
  const { collection = emptyCollection(), run = null, preferences = null, last_navigation = null } = await chrome.storage.local.get(["collection", "run", "preferences", "last_navigation"]);
  const groups = S.supplierGroups(collection.products);
  return { count: collection.products.length, page_count: collection.pages.filter(page => !page.partial).length,
    supplier_count: groups.suppliers.length, unresolved_count: groups.unresolved.length, missing_names: collection.products.filter(item => !item.shop_name).length,
    raw_count: (collection.raw_cards || []).length, preview: collection.products.slice(-4).reverse(),
    warnings: collection.pages.at(-1)?.warnings || [], run, preferences, navigation: last_navigation?.analysis || run?.navigation || null,
    ...(full ? { products: collection.products, suppliers: groups.suppliers, unresolved: groups.unresolved } : {}) };
}
async function exportCollection(format = "json") {
  const { collection = emptyCollection() } = await chrome.storage.local.get("collection");
  if (!collection.products.length) throw new Error("Сначала соберите или импортируйте товары.");
  const groups = S.supplierGroups(collection.products);
  const output = { schema_version: 3, sources: [...new Set(collection.products.map(item => item.source))], exported_at: new Date().toISOString(), total_products: collection.products.length, total_suppliers: groups.suppliers.length,
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
      const source = S.site(card?.source_page_url);
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
async function listTabs() { return (await chrome.tabs.query({})).filter(tab => S.webUrl(tab.url || "") && !S.productUrl(tab.url)).map(tab => ({ id: tab.id, url: tab.url, title: tab.title || new URL(tab.url).hostname, source: S.site(tab.url) })); }
async function openWorkingTab() { const { run } = await chrome.storage.local.get("run"); const id = run?.phase === "details" ? run.detail_tab_id : run?.tab_id; if (id == null) throw new Error("Нет рабочей вкладки."); await chrome.tabs.update(id, { active: true }); return {}; }
async function selectedTab(options = {}) {
  const { run } = await chrome.storage.local.get("run");
  return options.tab_id ? chrome.tabs.get(Number(options.tab_id)) : run?.tab_id ? chrome.tabs.get(run.tab_id) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}
async function inspectNavigation(options) {
  const tab = await selectedTab(options); await ensureAccess(tab?.url);
  const analysis = await sendToTab(tab.id, "NAVIGATE_OPTIONS", { profile: await siteProfile(tab.url) });
  await chrome.storage.local.set({ last_navigation: { tab_id: tab.id, origin: new URL(tab.url).origin, analysis } });
  return analysis;
}
async function chooseNavigation(options) {
  if (processing || starting) throw new Error("Поставьте задание на паузу и дождитесь остановки.");
  const tab = await selectedTab(options), analysis = await inspectNavigation({ tab_id: tab.id });
  const candidate = analysis.candidates.find(item => item.id === options.candidate_id);
  if (!candidate) throw new Error("Элемент изменился. Повторите поиск кнопок.");
  await storeProfile(tab.url, { navigation: { selector: candidate.selector, label: candidate.label } });
  const learned = await sendToTab(tab.id, "NAVIGATE_OPTIONS", { profile: await siteProfile(tab.url) });
  await chrome.storage.local.set({ last_navigation: { tab_id: tab.id, origin: new URL(tab.url).origin, analysis: learned } });
  await withStateLock(async () => {
    const { run } = await chrome.storage.local.get("run");
    if (run && ["paused", "stopped"].includes(run.status) && run.phase !== "details" && run.tab_id === tab.id) await chrome.storage.local.set({ run: { ...run, navigation: analysis, chosen_navigation: candidate.id } });
  }); return { chosen: candidate.label };
}
async function enablePicker(options) {
  const { run } = await chrome.storage.local.get("run"); if (run?.status === "running") throw new Error("Поставьте работу на паузу перед обучением.");
  const tab = await selectedTab(options); await ensureAccess(tab?.url);
  const nonce = crypto.randomUUID(); await chrome.storage.local.set({ pending_pick: { tab_id: tab.id, nonce, origin: new URL(tab.url).origin, mode: options.mode, at: Date.now() } });
  await chrome.tabs.update(tab.id, { active: true });
  return sendToTab(tab.id, "PICKER", { mode: options.mode, nonce });
}
async function profilePicked(sender, detail) {
  const { pending_pick } = await chrome.storage.local.get("pending_pick");
  if (pending_pick?.tab_id !== sender.tab?.id || pending_pick.nonce !== detail.nonce || Date.now() - pending_pick.at > 600000) return;
  const tab = await chrome.tabs.get(sender.tab.id); if (new URL(tab.url).origin !== pending_pick.origin) return;
  if (typeof detail.selector !== "string" || detail.selector.length > 1500 || detail.mode !== pending_pick.mode) return;
  await storeProfile(tab.url, detail.mode === "card" ? { card_selector: detail.selector } : { navigation: { selector: detail.selector, label: S.text(detail.label)?.slice(0, 160) } });
  await chrome.storage.local.remove("pending_pick");
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "1688-background" || sender.id !== chrome.runtime.id) return;
  if (message.type === "PROFILE_PICKED" && sender.tab) { void profilePicked(sender, message.detail || {}).then(() => respond({ ok: true })).catch(error => respond({ ok: false, error: error.message })); return true; }
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
    NAV_SCAN: () => inspectNavigation(message.options || {}), NAV_CHOOSE: () => chooseNavigation(message.options || {}), PICK: () => enablePicker(message.options || {}),
    FINISH_SEARCH: async () => { const { run } = await chrome.storage.local.get("run"); if (!run || !["paused", "stopped"].includes(run.status) || run.phase === "details" || processing || starting) throw new Error("Нет остановленного сбора выдачи."); await chrome.storage.local.set({ run: { ...run, status: "running", pending_navigation: null } }); await beginDetails(run.id, "Пользователь завершил сбор выдачи."); void processRun(); return {}; },
    RESET_PROFILE: async () => { const tab = await selectedTab(message.options); return withStateLock(async () => { const { profiles = {} } = await chrome.storage.local.get("profiles"); delete profiles[new URL(tab.url).origin]; await chrome.storage.local.set({ profiles, last_navigation: null }); return {}; }); },
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
async function recordOpenedTab(tab) {
  await withStateLock(async () => {
    const { run } = await chrome.storage.local.get("run"); const pending = run?.pending_navigation;
    if (!pending || Date.now() - pending.started_at > 20000 || tab.id === pending.source_tab_id) return;
    const related = tab.openerTabId === pending.source_tab_id || pending.candidate.href && S.canonicalUrl(tab.url) === S.canonicalUrl(pending.candidate.href);
    if (related) await chrome.storage.local.set({ run: { ...run, pending_navigation: { ...pending, opened_ids: [...new Set([...(pending.opened_ids || []), tab.id])] } } });
  });
}
if (chrome.tabs.onCreated) chrome.tabs.onCreated.addListener(tab => { void recordOpenedTab(tab); });
if (chrome.tabs.onUpdated) chrome.tabs.onUpdated.addListener((id, change, tab) => { if (change.url || change.status === "complete") void recordOpenedTab(tab); });
