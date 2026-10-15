"use strict";
importScripts("shared.js");
importScripts("page-data.js");
importScripts("excel.js");
importScripts("suppliers-core.js");
const S = globalThis.SupplierCollector;
const ALARM = "1688-collector-progress";
const RESPONSE_SCRIPT = "supplier-observed-responses";
const RESPONSE_BOOTSTRAP = "supplier-observed-response-permission";
let processing = false, starting = false, stateQueue = Promise.resolve();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emptyCollection = () => ({ products: [], pages: [], raw_cards: [] });
const productKey = item => `${item.source}:${item.product_id}`;
// Each stored row is one card appearance. Equal offer IDs never collapse here.
function taskRecord(run, previous = {}) {
  const record = { ...previous };
  for (const field of ["id", "kind", "query", "source", "source_url", "started_at", "updated_at", "finished_at", "status", "phase", "stage", "message", "pause_reason", "completed_pages", "max_pages", "detail_index", "detail_total", "current_count", "log"]) record[field] = run[field] ?? null;
  return { ...record, products: previous.products || [], pages: previous.pages || [] };
}
function storedTasks(tasks = [], run, collection = emptyCollection()) {
  if (!run || tasks.some(task => task.id === run.id)) return tasks;
  const keys = new Set(run.product_keys || []);
  return [...tasks, taskRecord(run, { products: collection.products.filter(item => item.observation_id ? item.task_id === run.id : keys.has(productKey(item))), pages: collection.pages.filter(page => page.checkpoint?.startsWith(`${run.id}:`)) })];
}
function unassignedMemory(collection, tasks) {
  const keys = new Set(tasks.flatMap(task => task.products.map(productKey)));
  const observations = new Set(tasks.flatMap(task => task.products.map(item => item.observation_id).filter(Boolean)));
  const ids = new Set(tasks.map(task => task.id));
  return {
    products: collection.products.filter(item => item.observation_id ? !observations.has(item.observation_id) : !keys.has(productKey(item))).map(item => ({ ...item, task_ids: [] })),
    pages: collection.pages.filter(page => !ids.has(page.task_id) && !tasks.some(task => page.checkpoint?.startsWith(`${task.id}:`))),
    raw_cards: (collection.raw_cards || []).filter(card => !ids.has(card.task_id))
  };
}
function rebuildMemory(tasks, independent, rawCards) {
  const observations = [...independent.products, ...tasks.flatMap(task => task.products.map(item => ({ ...item, task_ids: [task.id] })))];
  observations.sort((a, b) => (Date.parse(a.last_seen_at || a.collected_at) || 0) - (Date.parse(b.last_seen_at || b.collected_at) || 0));
  const ids = new Set(tasks.map(task => task.id));
  return {
    products: observations,
    pages: [...independent.pages, ...tasks.flatMap(task => task.pages.map(page => ({ ...page, task_id: task.id })))],
    raw_cards: rawCards.filter(card => !card.task_id || ids.has(card.task_id))
  };
}
// Called inside withStateLock, so task snapshots and the current run change atomically.
async function persistState(values, result = null, partial = false) {
  const stored = await chrome.storage.local.get(["tasks", "run"]);
  // Read old raw-card memory only once when migrating a pre-history run.
  if (stored.run && !stored.tasks?.some(task => task.id === stored.run.id)) stored.collection = (await chrome.storage.local.get("collection")).collection;
  let tasks = storedTasks(stored.tasks, stored.run, stored.collection);
  const run = values.run;
  if (run) {
    if (run.id !== stored.run?.id) {
      const { unassigned_memory } = await chrome.storage.local.get("unassigned_memory");
      if (!unassigned_memory) {
        const collection = stored.collection || (await chrome.storage.local.get("collection")).collection || emptyCollection();
        values.unassigned_memory = unassignedMemory(collection, tasks);
      }
    }
    if (stored.run && stored.run.id !== run.id) tasks = tasks.map(task => task.id === stored.run.id && ["paused", "stopped"].includes(task.status) ? { ...task, status: "stopped", finished_at: new Date().toISOString(), message: "Сохранено в истории перед запуском нового задания." } : task);
    const index = tasks.findIndex(task => task.id === run.id);
    let record = taskRecord(run, tasks[index]);
    if (result) {
      const merged = mergeResult({ products: record.products, pages: record.pages, raw_cards: [] }, result, partial, `${run.id}:${partial ? run.completed_pages : run.completed_pages - 1}`);
      record = { ...record, products: merged.products, pages: merged.pages };
    }
    if (index < 0) tasks = [...tasks, record]; else tasks = tasks.map((task, position) => position === index ? record : task);
  }
  await chrome.storage.local.set({ ...values, tasks });
}
function taskSummary(task) {
  const { products, pages, log, ...summary } = task;
  return { ...summary, product_count: products.length, page_count: pages.filter(page => !page.partial).length, partial_page_count: pages.filter(page => page.partial).length };
}
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
  return withStateLock(async () => { const run = await activeRun(id); if (!run) return null; const next = change(run); await persistState({ run: next }); return next; });
}
async function sendToTab(tabId, type, options) {
  const tab = await chrome.tabs.get(tabId);
  await ensureAccess(tab.url);
  const message = { target: "1688-content", type, options };
  let response;
  try { response = await chrome.tabs.sendMessage(tabId, message); }
  catch (error) {
    if (!/receiving end|establish connection/i.test(error.message)) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "navigation.js", "generic.js", "data-sources.js", "engine.js", "observer.js", "content.js"] });
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
async function registerResponseScripts(url) {
    const matches = S.isMarketplaceUrl(url) ? ["https://*.1688.com/*", "https://*.alibaba.com/*", "https://*.made-in-china.com/*"] : [S.originPattern(url)];
    if (chrome.scripting.registerContentScripts) {
      const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [RESPONSE_SCRIPT, RESPONSE_BOOTSTRAP] });
      const spec = { id: RESPONSE_SCRIPT, matches, js: ["page-data.js", "response-observer.js"], world: "MAIN", runAt: "document_start", persistAcrossSessions: false };
      const bootstrap = { id: RESPONSE_BOOTSTRAP, matches, js: ["response-bootstrap.js"], world: "ISOLATED", runAt: "document_start", persistAcrossSessions: false };
      for (const script of [spec, bootstrap]) { if (scripts.some(item => item.id === script.id)) await chrome.scripting.updateContentScripts([script]); else await chrome.scripting.registerContentScripts([script]); }
    }
}
async function responseObservation(tabId, enabled, install = false) {
  if (tabId == null) return;
  const tab = await chrome.tabs.get(tabId); await ensureAccess(tab.url);
  const { run } = await chrome.storage.local.get("run");
  if (install) { await registerResponseScripts(tab.url); await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["page-data.js", "response-observer.js"] }); }
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: ({ enabled, taskId }) => {
    const state = window.__supplierResponseObservation; if (!state) return;
    if (enabled && state.taskId !== taskId) { state.products = []; state.pagination = []; state.truncated = false; state.taskId = taskId; }
    if (state.enabled !== enabled) { state.epoch++; if (enabled) state.challenge = false; }
    if (!enabled) for (const reader of state.readers || []) void reader.cancel().catch(() => {});
    state.enabled = enabled; state.blocked = !enabled;
  }, args: [{ enabled, taskId: run?.id }] });
  if (enabled && run?.observe_responses) await updateRun(run.id, task => ({ ...task, response_tab_ids: [...new Set([...(task.response_tab_ids || []), tabId])] }));
}
async function stopResponseObservation(run) {
  if (!run?.observe_responses) return;
  for (const tabId of [...new Set([run.tab_id, run.detail_tab_id, ...(run.response_tab_ids || []), ...(run.pending_navigation?.opened_ids || [])])].filter(id => id != null)) try { await responseObservation(tabId, false); } catch { /* closed or redirected tab */ }
  if (chrome.scripting.unregisterContentScripts) { const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [RESPONSE_SCRIPT, RESPONSE_BOOTSTRAP] }); if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: registered.map(item => item.id) }); }
}
async function siteProfile(url) { const { profiles = {} } = await chrome.storage.local.get("profiles"); return profiles[new URL(url).origin] || {}; }
async function storeProfile(url, patch) {
  return withStateLock(async () => { const { profiles = {} } = await chrome.storage.local.get("profiles"); const origin = new URL(url).origin; profiles[origin] = { ...(profiles[origin] || {}), ...patch, updated_at: new Date().toISOString() }; await chrome.storage.local.set({ profiles }); return profiles[origin]; });
}
async function finish(id, status, message, reason = null) {
  let stopped;
  await withStateLock(async () => {
    const run = await activeRun(id); if (!run) return;
    stopped = run;
    await persistState({ run: { ...logEntry(run, status, message), status, pause_reason: reason, ...(status === "finished" ? { finished_at: new Date().toISOString() } : {}) } });
    await chrome.alarms.clear(ALARM);
  });
  await stopResponseObservation(stopped);
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
  if (!result.page) {
    // Explicit detail checks update supplier evidence without erasing captured
    // rows, prices or provenance. A detail-only task can own its own observation.
    const updates = new Map(result.products.map(item => [productKey(item), item]));
    const products = collection.products.map(item => {
      const update = updates.get(productKey(item)); if (!update) return item;
      const copy = { ...item, field_sources: { ...item.field_sources }, field_confidence: { ...item.field_confidence } };
      for (const field of ["shop_name", "supplier_url", "supplier_id", "detail_checked_at"]) if (update[field]) { copy[field] = update[field]; if (update.field_sources?.[field]) copy.field_sources[field] = update.field_sources[field]; }
      for (const field of ["title", "price", "minimum_order", "image_url"]) if (!copy[field] && update[field]) { copy[field] = update[field]; if (update.field_sources?.[field]) copy.field_sources[field] = update.field_sources[field]; }
      return copy;
    });
    for (const item of result.products) if (!products.some(old => productKey(old) === productKey(item))) products.push({ ...item, observation_id: item.observation_id || crypto.randomUUID(), capture_status: "detail" });
    return { ...collection, products };
  }
  const prior = collection.products.filter(item => item.checkpoint_id === checkpoint);
  const samples = partial ? S.mergeCardSamples(prior, result.products) : result.products;
  const rawKey = card => card.observation_id || `${card.source}:${card.product_id}:${card.source_page_url}:${card.task_id || "legacy"}`;
  const raw = new Map((collection.raw_cards || []).filter(card => partial || card.checkpoint_id !== checkpoint).map(card => [rawKey(card), card]));
  for (const card of result.raw_cards || []) raw.set(rawKey(card), card);
  return {
    products: [...collection.products.filter(item => item.checkpoint_id !== checkpoint), ...samples],
    pages: [...(collection.pages || []).filter(page => page.checkpoint !== checkpoint), { ...result.page, partial, checkpoint }],
    raw_cards: [...raw.values()]
  };
}
async function saveSearch(id, result, partial = false) {
  return withStateLock(async () => {
    const { run, collection = emptyCollection() } = await chrome.storage.local.get(["run", "collection"]);
    if (run?.id !== id || (!partial && run.status !== "running")) return null;
    if (!partial) {
      const known = run.seen_fingerprints.flatMap(value => value.split(",").filter(Boolean));
      const coverage = S.collectionQuality(result.products, { known_keys: known, expected_count: result.page.diagnostics?.expected_page_size || run.previous_card_count || run.previous_fingerprint?.split(",").length, check_count: run.scroll, terminal: result.page.diagnostics?.collection_quality?.terminal, page_context: result.page.diagnostics?.page_context, append_mode: run.collection_mode === "append", allow_repeats: run.allow_repeats === true });
      if (!coverage.complete) {
        const error = new Error(`Страница не засчитана: найдено ${coverage.observed_count}, новых ${coverage.new_count}, повторных ${coverage.repeated_count}. Дождитесь загрузки выдачи и нажмите «Продолжить».`);
        error.code = "INCOMPLETE_RESULTS";
        error.partial = { ...result, page: { ...result.page, diagnostics: { ...result.page.diagnostics, collection_quality: coverage }, warnings: [...(result.page.warnings || []), error.message] } };
        throw error;
      }
    }
    const checkpoint = `${id}:${run.completed_pages}`, observedCount = result.products.length;
    let incoming = result.products;
    if (run.collection_mode === "append") {
      const priorSlots = new Set(collection.products.filter(item => item.task_id === id && item.checkpoint_id !== checkpoint && S.canonicalUrl(item.source_page_url) === S.canonicalUrl(result.page.page_url)).map(item => item.page_card_key));
      incoming = incoming.filter(item => !priorSlots.has(item.page_card_key));
    }
    const previous = new Map(collection.products.filter(item => item.checkpoint_id === checkpoint).map(item => [item.page_card_key, item]));
    const rows = incoming.map((item, index) => ({ ...item, observation_id: previous.get(item.page_card_key)?.observation_id || crypto.randomUUID(), checkpoint_id: checkpoint, task_id: id, task_ids: [id], page_index: run.completed_pages + 1, card_index: index + 1, capture_status: partial ? "partial" : "confirmed" }));
    const appearances = new Map(rows.map(item => [item.page_card_key, item]));
    result = { ...result, products: rows, page: result.page ? { ...result.page, product_count: rows.length, task_id: id, collection_mode: "all_cards" } : null,
      raw_cards: (result.raw_cards || []).filter(card => appearances.has(card.page_card_key)).map(card => ({ ...card, ...Object.fromEntries(["observation_id", "checkpoint_id", "task_id", "page_index", "card_index", "capture_status"].map(field => [field, appearances.get(card.page_card_key)[field]])) })) };
    const verified = run.allow_repeats || S.pageChangeConfirmed(result.page.page_url, result.page.diagnostics, run.last_page_url, run.previous_page_context, run.previous_document_id);
    if (!partial && run.seen_fingerprints.includes(result.page.fingerprint) && !verified && run.collection_mode !== "append") throw new Error("Переход на следующую страницу не подтверждён. Проверьте страницу и продолжите сбор.");
    const merged = mergeResult(collection, result, partial, checkpoint);
    const keys = [...new Set([...(run.product_keys || []), ...result.products.map(productKey)])];
    let next = { ...run, product_keys: keys };
    if (!partial) next = logEntry({ ...next, completed_pages: run.completed_pages + 1, previous_fingerprint: result.page.fingerprint, previous_card_count: observedCount, previous_signature: result.page.diagnostics?.content_signature, previous_page_context: result.page.diagnostics?.page_context, previous_document_id: result.page.diagnostics?.document_id, last_page_url: result.page.page_url, seen_fingerprints: [...run.seen_fingerprints, result.page.fingerprint], phase: "navigate", allow_repeats: false }, "saved", `Сохранена страница ${run.completed_pages + 1}: ${result.products.length} карточек. В задании: ${merged.products.filter(item => item.task_id === id || item.task_ids?.includes(id)).length}. В общей памяти: ${merged.products.length}. Повторы сохранены.`);
    await persistState({ collection: merged, run: next }, result, partial);
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
  if (run.observe_responses) { await ensureAccess(item.product_url); await registerResponseScripts(item.product_url); }
  let tab;
  if (run.detail_tab_id != null) { try { tab = await chrome.tabs.get(run.detail_tab_id); } catch { /* user closed the working tab */ } }
  if (!tab) {
    tab = await chrome.tabs.create({ url: item.product_url, active: false });
    await updateRun(run.id, current => ({ ...current, detail_tab_id: tab.id }));
  } else if (S.productUrl(tab.url, undefined, String(item.source).startsWith("web:"))?.url !== item.product_url) tab = await chrome.tabs.update(tab.id, { url: item.product_url });
  if (!await activeRun(run.id)) return;
  await waitForTab(tab.id, run.id);
  if (run.observe_responses) await responseObservation(tab.id, true, true);
  const result = await sendToTab(tab.id, "DETAIL", { query: item.query, timeout: 6000, profile: await siteProfile(item.product_url) });
  await withStateLock(async () => {
    const current = await activeRun(run.id); if (!current) return;
    const { collection: latest = emptyCollection() } = await chrome.storage.local.get("collection");
    const matched = result.products.filter(product => productKey(product) === key).map(product => ({ ...product, task_ids: [run.id] }));
    if (!matched.length && String(item.source).startsWith("web:") && result.products.length === 1) matched.push({ ...result.products[0], canonical_detail_url: result.products[0].product_url, source: item.source, product_id: item.product_id, product_url: item.product_url, task_ids: [run.id] });
    let products = mergeResult(latest, { products: matched }, true).products;
    const found = products.find(product => productKey(product) === key);
    if (found && (found.shop_name || found.supplier_url)) products = products.map(product => {
      const related = product.source === item.source && ((item.supplier_id && product.supplier_id === item.supplier_id) || (item.supplier_url && product.supplier_url === item.supplier_url));
      if (!related) return product;
      const copy = { ...product, field_sources: { ...(product.field_sources || {}) } };
      for (const field of ["shop_name", "supplier_url"]) if (!copy[field] && found[field]) { copy[field] = found[field]; copy.field_sources[field] = "verified-card:shared-supplier-identity"; }
      return copy;
    });
    const message = found?.shop_name ? `Получен магазин: ${found.shop_name}.` : `У товара ${item.product_id} имя магазина не найдено; данные не выдумываются.`;
    await persistState({ collection: { ...latest, products }, run: logEntry({ ...current, detail_index: current.detail_index + 1 }, "detail-saved", message) }, { products: found && matched.length ? [{ ...found, task_ids: [run.id] }] : [] }, true);
  });
  await delay(run.interval_ms);
}
async function pauseAccess(id, error, tabId) {
  await updateRun(id, current => ({ ...current, required_origin: error.required_origin, ...(current.phase !== "details" && tabId != null ? { tab_id: tabId, phase: "search", pending_navigation: null } : {}) }));
  await finish(id, "paused", error.message, "permission");
}
function changedPage(run, url, peek, append = false, clicked = false) {
  const previous = new Set((run.previous_fingerprint || "").split(","));
  const fresh = peek.products.some(item => !previous.has(productKey(item)));
  const proof = S.pageChangeConfirmed(url, peek.diagnostics, run.last_page_url, run.previous_page_context, run.previous_document_id);
  const context = peek.diagnostics?.page_context || {};
  const changedContent = clicked && run.previous_signature && peek.diagnostics?.content_signature !== run.previous_signature && !context.mismatch && !context.mixed;
  const repeatedPage = !fresh && (proof || changedContent);
  const grown = append && peek.products.length > (run.previous_card_count || previous.size);
  return { changed: fresh || repeatedPage || grown, allow_repeats: repeatedPage || grown };
}
async function awaitNavigation(run) {
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
        const change = changedPage(current, tab.url, peek, pending.candidate.kind === "load-more", true);
        if (change.changed) matches.push({ ...tab, allow_repeats: change.allow_repeats });
      } catch (error) {
        if (["CHALLENGE", "RATE_LIMIT"].includes(error.code)) {
          await updateRun(run.id, task => ({ ...task, tab_id: tabId, phase: "search", pending_navigation: null, challenge_navigation: { source_url: pending.source_url, source_tab_id: pending.source_tab_id, target_tab_id: tabId } })); throw error;
        }
      }
    }
    if (matches.length === 1 && !inaccessible.length && (pending.exact_tab_id != null || Date.now() - pending.started_at >= 800)) {
      const target = matches[0];
      const append = pending.candidate.kind === "load-more" && S.canonicalUrl(target.url) === S.canonicalUrl(pending.source_url);
      await updateRun(run.id, task => logEntry({ ...task, tab_id: target.id, phase: "search", allow_repeats: target.allow_repeats, collection_mode: append ? "append" : "replace", pending_navigation: null, navigation: null }, "loading", target.id !== pending.source_tab_id ? "Следующая выдача открылась в новой вкладке. Переключаю сбор на неё." : "Переход подтверждён. Сохраняю все карточки, включая повторы.")); return;
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
  const change = changedPage(run, tab.url, peek);
  if (change.changed) { await updateRun(run.id, current => ({ ...current, phase: "search", allow_repeats: change.allow_repeats, collection_mode: S.canonicalUrl(tab.url) === S.canonicalUrl(run.last_page_url) ? current.collection_mode : "replace" })); return; }
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
  } else if (selected.action === "open-url" && !selected.selector.includes(" ::: ")) await chrome.tabs.update(run.tab_id, { url: selected.href });
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
    if (run.observe_responses) await responseObservation(run.tab_id, true, true);
    if (run.phase === "navigate") {
      await navigateStep(run);
      return;
    }
    await waitForTab(run.tab_id, id);
    const tab = await chrome.tabs.get(run.tab_id);
    const result = await sendToTab(run.tab_id, "COLLECT", { query: run.query, scroll: run.scroll, raw: run.raw, profile: await siteProfile(tab.url), previousFingerprint: run.previous_fingerprint, previous_url: run.last_page_url, previous_page_context: run.previous_page_context, previous_document_id: run.previous_document_id, allow_repeats: run.allow_repeats === true, known_fingerprint: run.seen_fingerprints.join(","), expected_count: run.previous_card_count || run.previous_fingerprint?.split(",").length || null, append_mode: run.collection_mode === "append", scroll_delay: run.interval_ms >= 5000 ? 1000 : 650 });
    const saved = await saveSearch(id, result); if (!saved) return;
    if (saved.run.completed_pages >= saved.run.max_pages) await beginDetails(id);
  } catch (error) {
    if (id && error.partial) await saveSearch(id, error.partial, true);
    if (id && error.code === "ACCESS") { await pauseAccess(id, error); return; }
    if (id) await finish(id, "paused", error.message, error.code === "CHALLENGE" ? "challenge" : error.code === "RATE_LIMIT" ? "rate-limit" : error.code === "INCOMPLETE_RESULTS" ? "incomplete-results" : "error");
  } finally {
    processing = false;
    const { run } = await chrome.storage.local.get("run");
    if (run?.status === "running") setTimeout(processRun, 100);
  }
}
async function startRun(options, detailsOnly = false) {
  if (starting || processing || SupplierStage.busy()) throw new Error("Работа уже идёт или приостанавливается. Поставьте активный этап на паузу и дождитесь остановки.");
  starting = true;
  try {
    if (await SupplierStage.isRunning()) throw new Error("Сначала приостановите этап 2.");
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
      kind: detailsOnly ? "details" : "collection", source: tab ? S.site(tab.url) : null, source_url: tab?.url || null,
      max_pages: maxPages, completed_pages: 0, query: S.text(options.query) || (tab ? S.detectSearch(tab.url).query : null), scroll: options.scroll !== false,
      raw: options.raw !== false, enrich: options.enrich === true, interval_ms: interval * 1000,
      observe_responses: options.observe_responses === true,
      previous_fingerprint: null, seen_fingerprints: [], product_keys: [],
      detail_queue: detailsOnly ? queue : [], detail_index: 0, detail_total: detailsOnly ? queue.length : 0,
      started_at: new Date().toISOString(), pause_reason: null, log: []
    }, detailsOnly ? "details" : "loading", detailsOnly ? `Проверю ${queue.length} карточек товаров.` : "Ожидаю товары и собираю выдачу…");
    await withStateLock(async () => { await persistState({ run, last_navigation: null, preferences: { max_pages: maxPages, query: run.query || "", scroll: run.scroll, raw: run.raw, enrich: run.enrich, observe_responses: run.observe_responses, interval_seconds: interval } }); await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); });
    void processRun();
    return { started: true };
  } finally { starting = false; }
}
async function pauseRun(status = "paused") {
  const paused = await withStateLock(async () => {
    const { run } = await chrome.storage.local.get("run"); if (run?.status !== "running") return null;
    await persistState({ run: { ...logEntry(run, status, "Работа приостановлена. Данные сохранены; можно продолжить с текущего этапа."), status, pause_reason: "manual" } });
    await chrome.alarms.clear(ALARM); return run;
  });
  if (paused) for (const tabId of [paused.tab_id, paused.detail_tab_id].filter(id => id != null)) {
    try { await chrome.tabs.sendMessage(tabId, { target: "1688-content", type: "CANCEL" }); } catch { /* navigation can replace the page */ }
  }
  await stopResponseObservation(paused);
  return { paused: true, stopped: true };
}
async function resumeRun(options = {}) {
  if (processing || starting || SupplierStage.busy()) throw new Error("Приостановите этап 2 и дождитесь завершения текущей операции.");
  starting = true;
  try {
    if (await SupplierStage.isRunning()) throw new Error("Сначала приостановите этап 2.");
    const { run } = await chrome.storage.local.get("run");
    if (!run || !["paused", "stopped"].includes(run.status)) throw new Error("Нет приостановленного задания.");
    const interval = Number(options.interval_seconds ?? run.interval_ms / 1000);
    if (!Number.isFinite(interval) || interval < 1 || interval > 30) throw new Error("Укажите паузу от 1 до 30 секунд.");
    if (options.tab_id != null && run.phase !== "details") { const selected = await chrome.tabs.get(Number(options.tab_id)); await ensureAccess(selected.url); run.tab_id = selected.id; run.phase = "search"; run.pending_navigation = null; run.navigation = null; run.collection_mode = "replace"; }
    const tabId = run.phase === "details" ? run.detail_tab_id : run.tab_id;
    let reloadForResponses = false;
    if (tabId != null) {
      const tab = await chrome.tabs.get(tabId); await sendToTab(tabId, "RESET"); await sendToTab(tabId, "CHECK");
      if (run.challenge_navigation && options.tab_id == null && run.phase !== "details") {
        const peek = await sendToTab(tabId, "PEEK", { profile: await siteProfile(tab.url), query: run.query });
        const change = changedPage(run, tab.url, peek, false, true); const changed = change.changed;
        run.allow_repeats = change.allow_repeats;
        const recovery = run.challenge_navigation;
        run.phase = !changed && tabId === recovery.source_tab_id && S.canonicalUrl(tab.url) === S.canonicalUrl(recovery.source_url) ? "navigate" : "search";
        run.pending_navigation = null; run.challenge_navigation = null;
      } else if (run.observe_responses && run.pause_reason === "challenge" && run.phase === "search" && S.isMarketplaceUrl(tab.url) && S.detectSearch(tab.url).search_type === "text" && S.detectSearch(tab.url).query) {
        const peek = await sendToTab(tabId, "PEEK", { profile: await siteProfile(tab.url), query: run.query });
        reloadForResponses = !peek.products.length;
      }
    }
    await withStateLock(async () => { await persistState({ run: { ...logEntry(run, run.phase, "Продолжаю с сохранённого этапа…"), status: "running", pause_reason: null, required_origin: null, interval_ms: interval * 1000 } }); });
    if (reloadForResponses) { const tab = await chrome.tabs.get(tabId); await registerResponseScripts(tab.url); await chrome.tabs.update(tabId, { url: tab.url }); }
    void processRun(); return { resumed: true };
  } finally { starting = false; }
}
async function getState(full = false) {
  const { collection = emptyCollection(), run = null, preferences = null, view_preferences = {}, last_navigation = null, tasks = [], profiles = {} } = await chrome.storage.local.get(["collection", "run", "preferences", "view_preferences", "last_navigation", "tasks", "profiles"]);
  const history = storedTasks(tasks, run, collection);
  const groups = S.supplierGroups(collection.products);
  const current = history.find(task => task.id === run?.id);
  const currentGroups = current ? S.supplierGroups(current.products) : null;
  const { supplier_search, supplier_search_cache } = await chrome.storage.local.get(["supplier_search", "supplier_search_cache"]);
  return { supplier_stage: supplier_search ? { id: supplier_search.id, status: supplier_search.status, message: supplier_search.message } : null, stage2_busy: SupplierStage.busy() || supplier_search?.status === "running", view_preferences, tasks: history.map(taskSummary).reverse(), task_count: history.length, can_clear: Boolean(supplier_search || supplier_search_cache || history.length || collection.products.length || collection.raw_cards?.length || preferences || Object.keys(view_preferences).length || Object.keys(profiles).length || last_navigation), count: collection.products.length, page_count: collection.pages.filter(page => !page.partial).length,
    supplier_count: groups.suppliers.length, unresolved_count: groups.unresolved.length, missing_names: collection.products.filter(item => !item.shop_name).length,
    raw_count: (collection.raw_cards || []).length, preview: collection.products.slice(-4).reverse(),
    current_task: current ? { product_count: current.products.length, supplier_count: currentGroups.suppliers.length, page_count: current.completed_pages, preview: current.products.slice(-4).reverse() } : null,
    warnings: run ? current?.pages.at(-1)?.warnings || [] : collection.pages.at(-1)?.warnings || [], run, preferences, navigation: last_navigation?.analysis || run?.navigation || null,
    ...(full ? { products: collection.products, suppliers: groups.suppliers, unresolved: groups.unresolved } : {}) };
}
async function getTask(id) {
  const { tasks = [], run, collection = emptyCollection() } = await chrome.storage.local.get(["tasks", "run", "collection"]);
  const task = storedTasks(tasks, run, collection).find(item => item.id === id);
  if (!task) throw new Error("Задание не найдено. Возможно, память была очищена.");
  return { ...task, raw_count: collection.raw_cards.filter(card => card.task_id === id).length };
}
async function exportSnapshot(taskId = null, raw = false) {
  let { collection = emptyCollection(), tasks = [], run } = await chrome.storage.local.get(["collection", "tasks", "run"]);
  let history = storedTasks(tasks, run, collection);
  if (taskId != null) {
    const task = history.find(item => item.id === taskId);
    if (!task) throw new Error("Проверка не найдена. Возможно, её память уже удалена.");
    history = [task];
    collection = { products: task.products, pages: task.pages, raw_cards: collection.raw_cards.filter(card => card.task_id === taskId) };
  }
  if (!collection.products.length && !history.length) throw new Error("Сначала запустите задание или импортируйте товары.");
  const groups = S.supplierGroups(collection.products);
  return { schema_version: 3, collection_mode: "all_cards", sources: [...new Set(collection.products.map(item => item.source))], exported_at: new Date().toISOString(), total_products: collection.products.length, total_suppliers: groups.suppliers.length,
    tasks: history, total_tasks: history.length, pages: collection.pages, suppliers: groups.suppliers, unresolved_products: groups.unresolved, products: collection.products,
    ...(raw ? { raw_cards: collection.raw_cards || [] } : {}) };
}
async function exportCollection(format = "json", taskId = null) {
  if (!["json", "raw", "csv", "xlsx"].includes(format)) throw new Error("Неизвестный формат экспорта.");
  const output = await exportSnapshot(taskId, format === "raw");
  const csv = format === "csv";
  const url = format === "xlsx" ? globalThis.SupplierExcel.dataUrl(output) : `data:${csv ? "text/csv" : "application/json"};charset=utf-8,` + encodeURIComponent(csv ? S.csv(output.products) : JSON.stringify(output, null, 2));
  const downloadId = await chrome.downloads.download({ url, filename: `suppliers-${taskId == null ? "all" : "task"}-${format}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${format === "xlsx" ? "xlsx" : csv ? "csv" : "json"}`, saveAs: true });
  return { download_id: downloadId };
}
async function importCollection(input) {
  return withStateLock(async () => {
    const { collection = emptyCollection(), run, tasks = [], unassigned_memory } = await chrome.storage.local.get(["collection", "run", "tasks", "unassigned_memory"]);
    if (processing || starting || run?.status === "running") throw new Error("Приостановите работу перед импортом.");
    const imported = S.importProducts(input);
    const independent = unassigned_memory || unassignedMemory(collection, storedTasks(tasks, run, collection));
    const independentRaw = new Map(independent.raw_cards.map(card => [card.observation_id || `${card.source}:${card.product_id}:${card.source_page_url}`, card]));
    const batch = crypto.randomUUID();
    const rows = imported.map((item, index) => ({ ...item, observation_id: crypto.randomUUID(), imported_observation_id: item.observation_id || null, imported_task_id: item.task_id || null, import_batch_id: batch, task_id: null, task_ids: [], checkpoint_id: null, capture_status: "imported", card_index: index + 1 }));
    const products = [...collection.products, ...rows];
    const raw = new Map((collection.raw_cards || []).map(card => [card.observation_id || `${card.source}:${card.product_id}:${card.source_page_url}:${card.task_id || "legacy"}`, card]));
    const keys = new Set(imported.map(productKey));
    const usedRawRows = new Set();
    if (Array.isArray(input.raw_cards) && input.raw_cards.length <= 10000) for (const card of input.raw_cards) {
      const source = card?.source || S.site(card?.source_page_url);
      if (source && keys.has(`${source}:${card.product_id}`) && typeof card.html === "string" && card.html.length <= 20000) {
        const key = `${source}:${card.product_id}`;
        const row = rows.find(item => !usedRawRows.has(item.observation_id) && item.imported_observation_id && item.imported_observation_id === card.observation_id) || rows.find(item => !usedRawRows.has(item.observation_id) && productKey(item) === key);
        if (row) usedRawRows.add(row.observation_id);
        const safe = { observation_id: row?.observation_id || crypto.randomUUID(), import_batch_id: batch, source, product_id: String(card.product_id), source_page_url: card.source_page_url, html: card.html, collected_at: new Date().toISOString() };
        if (!S.webUrl(safe.source_page_url)) continue;
        if (card.record) try { const parsed = S.importProducts({ products: [card.record] })[0]; if (productKey(parsed) === `${source}:${safe.product_id}`) safe.record = { ...parsed, observation_id: safe.observation_id, task_id: null, task_ids: [], checkpoint_id: null, capture_status: "imported" }; } catch { /* preserve inert markup, discard malformed business record */ }
        raw.set(safe.observation_id, safe);
        independentRaw.set(safe.observation_id, safe);
      }
    }
    await chrome.storage.local.set({ collection: { ...collection, products, raw_cards: [...raw.values()] }, unassigned_memory: { ...independent, products: [...independent.products, ...rows], raw_cards: [...independentRaw.values()] } });
    return { imported: imported.length, total: products.length };
  });
}
async function deleteTask(id) {
  return withStateLock(async () => {
    const { collection = emptyCollection(), run, tasks = [], unassigned_memory, preferences } = await chrome.storage.local.get(["collection", "run", "tasks", "unassigned_memory", "preferences"]);
    if (run?.status === "running" || processing || starting || SupplierStage.busy() || await SupplierStage.isRunning()) throw new Error("Приостановите выполняемую проверку и дождитесь остановки перед удалением памяти.");
    const history = storedTasks(tasks, run, collection);
    const task = history.find(item => item.id === id);
    if (!task) throw new Error("Проверка не найдена. Возможно, её память уже удалена.");
    const independent = unassigned_memory || unassignedMemory(collection, history);
    const remaining = history.filter(item => item.id !== id);
    const values = { tasks: remaining, collection: rebuildMemory(remaining, independent, collection.raw_cards), unassigned_memory: independent };
    if (run?.id === id) { values.run = null; values.last_navigation = null; await chrome.alarms.clear(ALARM); }
    if (preferences?.query === task.query) values.preferences = { ...preferences, query: "" };
    await chrome.storage.local.set(values);
    const { supplier_search } = await chrome.storage.local.get("supplier_search");
    if (supplier_search?.source_tasks.some(task => task.id === id)) await chrome.storage.local.remove("supplier_search");
    await chrome.storage.local.remove("supplier_search_cache");
    return { deleted: true, id, remaining_tasks: remaining.length, total_products: values.collection.products.length };
  });
}
async function clearCollection() {
  return withStateLock(async () => {
    const { run } = await chrome.storage.local.get("run");
    if (run?.status === "running" || processing || starting || SupplierStage.busy() || await SupplierStage.isRunning()) throw new Error("Приостановите работу и дождитесь остановки перед очисткой.");
    await chrome.alarms.clear(ALARM);
    await chrome.alarms.clear(SupplierStage.alarm);
    await chrome.storage.local.remove(["collection", "run", "tasks", "unassigned_memory", "preferences", "view_preferences", "profiles", "last_navigation", "pending_pick", "supplier_search", "supplier_search_cache"]); return { cleared: true };
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
    if (run && ["paused", "stopped"].includes(run.status) && run.phase !== "details" && run.tab_id === tab.id) await persistState({ run: { ...run, navigation: analysis, chosen_navigation: candidate.id } });
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
importScripts("suppliers-background.js");
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "1688-background" || sender.id !== chrome.runtime.id) return;
  if (message.type === "RESPONSE_ALLOWED" && sender.tab) {
    void chrome.storage.local.get("run").then(({ run }) => { const allowed = run?.status === "running" && run.observe_responses && [run.tab_id, run.detail_tab_id, run.pending_navigation?.exact_tab_id, ...(run.pending_navigation?.opened_ids || [])].includes(sender.tab.id); respond({ ok: true, result: { allowed: Boolean(allowed), taskId: allowed ? run.id : null } }); }); return true;
  }
  if (message.type === "PAGE_DATA" && sender.tab) {
    void (async () => {
      const tab = await chrome.tabs.get(sender.tab.id); await ensureAccess(tab.url);
      const results = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: "MAIN", func: globalThis.SupplierPageData.readPageState });
      const result = results[0]?.result || { products: [], pagination: [] };
      const observed = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: "MAIN", func: () => { const state = window.__supplierResponseObservation; return state ? { products: state.products, pagination: state.pagination, truncated: state.truncated, enabled: state.enabled, challenge: state.challenge } : null; } });
      const data = observed[0]?.result;
      if (data?.enabled) { result.responses = data.products; result.pagination.push(...data.pagination); result.diagnostics.truncated ||= data.truncated; result.diagnostics.challenge = data.challenge; }
      return result;
    })().then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, error: error.message })); return true;
  }
  if (message.type === "PROFILE_PICKED" && sender.tab) { void profilePicked(sender, message.detail || {}).then(() => respond({ ok: true })).catch(error => respond({ ok: false, error: error.message })); return true; }
  if (message.type === "PROGRESS" && sender.tab) {
    void SupplierStage.progress(sender, message.detail || {}).catch(() => {});
    void withStateLock(async () => {
      const { run } = await chrome.storage.local.get("run");
      if (run?.status !== "running" || ![run.tab_id, run.detail_tab_id].includes(sender.tab.id)) return;
      const detail = message.detail || {};
      await persistState({ run: logEntry({ ...run, current_count: Math.max(0, Number(detail.count) || 0) }, S.text(detail.stage)?.slice(0, 40) || "loading", S.text(detail.message)?.slice(0, 500) || "Обрабатываю страницу…") });
    }); respond({ ok: true }); return;
  }
  if (!["popup.html", "dashboard.html", "history.html", "export.html", "suppliers.html"].map(file => chrome.runtime.getURL(file)).includes(sender.url?.split(/[?#]/)[0])) return;
  const operations = {
    SUPPLIERS_STATE: () => SupplierStage.state(), SUPPLIERS_PREPARE: () => SupplierStage.prepare(message.options || {}),
    SUPPLIERS_START: () => SupplierStage.start(message.options || {}), SUPPLIERS_PAUSE: () => SupplierStage.pause(), SUPPLIERS_SKIP: () => SupplierStage.skip(),
    SUPPLIERS_INTERVAL: () => SupplierStage.setInterval(message.options || {}), SUPPLIERS_TAB: () => SupplierStage.showTab(), SUPPLIERS_EXPORT: () => SupplierStage.exportResult(message.options?.format),
    OPEN_SUPPLIERS: async () => { await chrome.tabs.create({ url: chrome.runtime.getURL("suppliers.html") }); return {}; },
    STATE: () => getState(false), DATA: () => getState(true), TASK: () => getTask(message.options?.id), TABS: listTabs,
    START: () => startRun(message.options || {}), ENRICH: () => startRun(message.options || {}, true),
    NAV_SCAN: () => inspectNavigation(message.options || {}), NAV_CHOOSE: () => chooseNavigation(message.options || {}), PICK: () => enablePicker(message.options || {}),
    FINISH_SEARCH: async () => { const id = await withStateLock(async () => { const { run } = await chrome.storage.local.get("run"); if (!run || !["paused", "stopped"].includes(run.status) || run.phase === "details" || processing || starting) throw new Error("Нет остановленного сбора выдачи."); await persistState({ run: { ...run, status: "running", pending_navigation: null } }); return run.id; }); await beginDetails(id, "Пользователь завершил сбор выдачи."); void processRun(); return {}; },
    RESET_PROFILE: async () => { const tab = await selectedTab(message.options); return withStateLock(async () => { const { profiles = {} } = await chrome.storage.local.get("profiles"); delete profiles[new URL(tab.url).origin]; await chrome.storage.local.set({ profiles, last_navigation: null }); return {}; }); },
    PAUSE: () => pauseRun(), STOP: () => pauseRun("stopped"), RESUME: () => resumeRun(message.options || {}),
    EXPORT: () => exportCollection(message.options?.format || "json", message.options?.task_id ?? null), IMPORT: () => importCollection(message.options?.data),
    EXCEL_DATA: async () => { const snapshot = message.options?.stage === 2 ? await SupplierStage.excelSnapshot() : await exportSnapshot(message.options?.task_id ?? null); const { view_preferences = {} } = await chrome.storage.local.get("view_preferences"); return { ...snapshot, export_image_quality: view_preferences.excel_image_quality || "high" }; },
    OPEN_EXCEL: async () => { await chrome.tabs.create({ url: chrome.runtime.getURL("export.html") + (message.options?.stage === 2 ? "?stage=2" : message.options?.task_id ? `?task=${encodeURIComponent(message.options.task_id)}` : "") }); return {}; },
    SET_VIEW: () => withStateLock(async () => {
      const options = message.options || {}, updates = {};
      if ("history_images" in options) { if (typeof options.history_images !== "boolean") throw new Error("Некорректный режим отображения."); updates.history_images = options.history_images; }
      if ("history_image_size" in options) {
        const size = options.history_image_size;
        if (!Number.isInteger(size) || size < 32 || size > 192 || size % 16 !== 0) throw new Error("Размер картинок должен быть от 32 до 192 px с шагом 16.");
        updates.history_image_size = size;
      }
      if ("excel_image_quality" in options) {
        if (!["standard", "high", "maximum"].includes(options.excel_image_quality)) throw new Error("Неизвестное качество изображений.");
        updates.excel_image_quality = options.excel_image_quality;
      }
      if (!Object.keys(updates).length || Object.keys(options).some(key => !(key in updates))) throw new Error("Некорректная настройка отображения.");
      const { view_preferences = {} } = await chrome.storage.local.get("view_preferences");
      await chrome.storage.local.set({ view_preferences: { ...view_preferences, ...updates } }); return {};
    }),
    RAW: async () => (await chrome.storage.local.get("collection")).collection?.raw_cards || [],
    OPEN_DASHBOARD: async () => { await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }); return {}; },
    OPEN_HISTORY: async () => { await chrome.tabs.create({ url: chrome.runtime.getURL("history.html") }); return {}; },
    SHOW_TAB: openWorkingTab, DELETE_TASK: () => deleteTask(message.options?.id), CLEAR: clearCollection
  };
  const operation = operations[message.type]; if (!operation) return;
  Promise.resolve().then(operation).then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, error: error.message })); return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void processRun(); if (alarm.name === SupplierStage.alarm) void SupplierStage.process(); });
chrome.runtime.onStartup.addListener(() => { void processRun(); void SupplierStage.process(); });
chrome.tabs.onRemoved.addListener(async tabId => { await SupplierStage.closed(tabId); const { run } = await chrome.storage.local.get("run"); if (run?.status === "running" && [run.tab_id, run.detail_tab_id].includes(tabId)) await finish(run.id, "paused", "Рабочая вкладка закрыта. Откройте выдачу и начните новое задание.", "tab-closed"); });
async function recordOpenedTab(tab) {
  await withStateLock(async () => {
    const { run } = await chrome.storage.local.get("run"); const pending = run?.pending_navigation;
    if (!pending || Date.now() - pending.started_at > 20000 || tab.id === pending.source_tab_id) return;
    const related = tab.openerTabId === pending.source_tab_id || pending.candidate.href && S.canonicalUrl(tab.url) === S.canonicalUrl(pending.candidate.href);
    if (related) await persistState({ run: { ...run, pending_navigation: { ...pending, opened_ids: [...new Set([...(pending.opened_ids || []), tab.id])] } } });
  });
}
if (chrome.tabs.onCreated) chrome.tabs.onCreated.addListener(tab => { void recordOpenedTab(tab); });
if (chrome.tabs.onUpdated) chrome.tabs.onUpdated.addListener((id, change, tab) => { if (change.url || change.status === "complete") void recordOpenedTab(tab); });
