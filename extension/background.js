"use strict";
importScripts("shared.js");
const S = globalThis.SupplierCollector;
const ALARM = "1688-collector-progress";
let processing = false;
let starting = false;
let stateQueue = Promise.resolve();

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emptyCollection = () => ({ products: [], pages: [] });

function withStateLock(operation) {
  const result = stateQueue.then(operation);
  stateQueue = result.catch(() => {});
  return result;
}

async function activeRun(id) {
  const { run } = await chrome.storage.local.get("run");
  return run?.id === id && run.status === "running" ? run : null;
}

async function sendToTab(tabId, type, options) {
  const tab = await chrome.tabs.get(tabId);
  if (!S.isMarketplaceUrl(tab.url || "")) throw new Error("Откройте поисковую выдачу на 1688.com.");
  const message = { target: "1688-content", type, options };
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!/receiving end|establish connection/i.test(error.message)) throw error;
    // Also supports a tab that was already open when the extension was installed.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "content.js"] });
    response = await chrome.tabs.sendMessage(tabId, message);
  }
  if (!response?.ok) throw new Error(response?.error || "Страница не ответила. Обновите её и повторите сбор.");
  return response.result;
}

async function finish(id, status, message) {
  return withStateLock(async () => {
    const run = await activeRun(id);
    if (!run) return;
    await chrome.storage.local.set({ run: { ...run, status, message } });
    await chrome.alarms.clear(ALARM);
  });
}

async function waitForTab(tabId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await delay(350);
  }
  throw new Error("Страница долго загружается. Дождитесь её загрузки и повторите сбор.");
}

async function processRun() {
  if (processing) return;
  processing = true;
  let currentId;
  try {
    let { run } = await chrome.storage.local.get("run");
    if (!run || run.status !== "running") return;
    currentId = run.id;
    // A watchdog resumes the saved job if the service worker is suspended.
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    await waitForTab(run.tab_id);
    const result = await sendToTab(run.tab_id, "COLLECT", {
      query: run.query,
      scroll: run.scroll,
      previousFingerprint: run.previous_fingerprint
    });
    const saved = await withStateLock(async () => {
      const active = await activeRun(currentId);
      if (!active) return null;
      if (active.seen_fingerprints.includes(result.page.fingerprint)) throw new Error("Повторилась уже собранная выдача. Проверьте следующую страницу и запустите сбор снова.");
      const { collection = emptyCollection() } = await chrome.storage.local.get("collection");
      const products = S.mergeProducts(collection.products, result.products);
      const pageKey = page => JSON.stringify([page.page_url, page.query, page.fingerprint]);
      const pages = collection.pages.filter(page => pageKey(page) !== pageKey(result.page));
      pages.push(result.page);
      const nextRun = {
        ...active,
        completed_pages: active.completed_pages + 1,
        previous_fingerprint: result.page.fingerprint,
        seen_fingerprints: [...active.seen_fingerprints, result.page.fingerprint],
        message: `Собрано страниц: ${active.completed_pages + 1} из ${active.max_pages}. Товаров на последней странице: ${result.products.length}.`
      };
      // Commit data and the checkpoint together; STOP cannot be overwritten by this step.
      await chrome.storage.local.set({ collection: { products, pages }, run: nextRun });
      return { run: nextRun, count: products.length };
    });
    if (!saved) return;
    run = saved.run;
    if (run.completed_pages >= run.max_pages) {
      await finish(currentId, "finished", `Сбор завершён: ${run.completed_pages} стр., ${saved.count} уникальных товаров в файле.`);
      return;
    }
    if (!await activeRun(currentId)) return;
    const next = await sendToTab(run.tab_id, "NEXT");
    if (!next.moved) {
      await finish(currentId, "finished", `Собрано ${run.completed_pages} стр. Доступная кнопка «Следующая страница» не найдена. Можно перейти вручную и продолжить сбор.`);
      return;
    }
    await delay(1200);
  } catch (error) {
    if (currentId) await finish(currentId, "paused", error.message);
  } finally {
    processing = false;
    const { run } = await chrome.storage.local.get("run");
    if (run?.status === "running") setTimeout(processRun, 100);
  }
}

async function startRun(options) {
  if (starting || processing) throw new Error("Сбор уже идёт или останавливается. Дождитесь остановки.");
  starting = true;
  try {
    const { run: old } = await chrome.storage.local.get("run");
    if (old?.status === "running") throw new Error("Сбор уже идёт. Остановите его перед новым запуском.");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !S.isMarketplaceUrl(tab.url || "")) throw new Error("Сначала откройте поисковую выдачу 1688 в активной вкладке.");
    if (S.productUrl(tab.url, tab.url)) throw new Error("Откройте поисковую выдачу, а не карточку товара.");
    const maxPages = Number(options.max_pages);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error("Укажите число страниц от 1 до 20.");
    const run = {
      id: crypto.randomUUID(),
      status: "running",
      tab_id: tab.id,
      max_pages: maxPages,
      completed_pages: 0,
      query: S.text(options.query),
      scroll: options.scroll !== false,
      previous_fingerprint: null,
      seen_fingerprints: [],
      started_at: new Date().toISOString(),
      message: "Ожидаю товары и собираю страницу…"
    };
    await withStateLock(async () => {
      await chrome.storage.local.set({ run, preferences: {
        max_pages: maxPages, query: run.query || "", scroll: run.scroll
      } });
      await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    });
    void processRun();
    return { started: true };
  } finally { starting = false; }
}

async function stopRun() {
  const stopped = await withStateLock(async () => {
    const { run } = await chrome.storage.local.get("run");
    if (run?.status !== "running") return null;
    await chrome.storage.local.set({ run: { ...run, status: "stopped", message: "Сбор остановлен. Уже сохранённые страницы доступны для экспорта." } });
    await chrome.alarms.clear(ALARM);
    return run;
  });
  if (stopped) {
    try { await chrome.tabs.sendMessage(stopped.tab_id, { target: "1688-content", type: "CANCEL" }); } catch { /* tab may have navigated */ }
  }
  return { stopped: true };
}

async function getState() {
  const { collection = emptyCollection(), run = null, preferences = null } = await chrome.storage.local.get(["collection", "run", "preferences"]);
  return {
    count: collection.products.length,
    page_count: collection.pages.length,
    preview: collection.products.slice(-4).reverse(),
    warnings: collection.pages.at(-1)?.warnings || [],
    run,
    preferences
  };
}

async function exportCollection() {
  const { collection = emptyCollection() } = await chrome.storage.local.get("collection");
  if (!collection.products.length) throw new Error("Сначала соберите хотя бы одну страницу с товарами.");
  const output = {
    schema_version: 1,
    source: "1688",
    exported_at: new Date().toISOString(),
    total_products: collection.products.length,
    pages: collection.pages,
    products: collection.products
  };
  const url = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(output, null, 2));
  const downloadId = await chrome.downloads.download({
    url,
    filename: `1688-suppliers-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
    saveAs: true
  });
  return { download_id: downloadId };
}

async function clearCollection() {
  return withStateLock(async () => {
    const { run } = await chrome.storage.local.get("run");
    if (run?.status === "running" || processing || starting) throw new Error("Перед очисткой остановите сбор и дождитесь его завершения.");
    await chrome.storage.local.remove(["collection", "run"]);
    return { cleared: true };
  });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "1688-background" || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return;
  const operations = {
    STATE: getState,
    START: () => startRun(message.options || {}),
    STOP: stopRun,
    EXPORT: exportCollection,
    CLEAR: clearCollection
  };
  const operation = operations[message.type];
  if (!operation) return;
  Promise.resolve().then(operation).then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void processRun(); });
chrome.runtime.onStartup.addListener(() => { void processRun(); });
chrome.tabs.onRemoved.addListener(async tabId => {
  const { run } = await chrome.storage.local.get("run");
  if (run?.tab_id === tabId && run.status === "running") await finish(run.id, "paused", "Вкладка с выдачей закрыта. Откройте выдачу и запустите сбор снова.");
});
