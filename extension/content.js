(function () {
  "use strict";
  if (globalThis.__supplierCollectorInstalled) return;
  globalThis.__supplierCollectorInstalled = true;
  const S = globalThis.SupplierCollector;
  const E = globalThis.SupplierCollectorEngine;
  let collecting = false;
  let cancelled = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function blockedReason() {
    if (/^(login|passport|accounts)\./.test(location.hostname) || /\/(?:login|punish|captcha|verify)(?:[/.?]|$)/i.test(location.pathname)) return "Откройте страницу после входа и проверки безопасности.";
    const challenge = [...document.querySelectorAll('#nc_1_wrapper, .nc-container, [class*="baxia-dialog"], [id*="captcha"], [class*="captcha"], iframe[src*="punish"], iframe[src*="captcha"], input[type="password"]')].find(visible);
    if (challenge) return "Сайт показывает вход или проверку безопасности. Пройдите её вручную и нажмите «Продолжить».";
    const body = S.text(document.body?.innerText) || "";
    if (body.length < 2000 && /too many requests|temporarily blocked|request limit|\b429\b|系统繁忙/i.test(body)) return "Сайт ограничил частоту запросов. Подождите, увеличьте паузу между переходами и продолжите работу.";
    if (body.length < 2000 && /滑动验证|拖动滑块|安全验证|访问受限|请完成验证|verify you are human|access denied|unusual traffic|security verification/i.test(body)) return "Сайт запросил проверку безопасности. Пройдите её вручную и нажмите «Продолжить».";
    return null;
  }

  function check() {
    if (cancelled) { const error = new Error("Сбор приостановлен."); error.code = "CANCELLED"; throw error; }
    const reason = blockedReason();
    if (reason) { const error = new Error(reason); error.code = /частоту запросов/.test(reason) ? "RATE_LIMIT" : "CHALLENGE"; throw error; }
  }

  function progress(stage, message, count) {
    if (typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function") {
      void chrome.runtime.sendMessage({ target: "1688-background", type: "PROGRESS", detail: { stage, message, count } }).catch(() => {});
    }
  }

  function extract(label, mode = "search", raw = true) {
    check();
    if (mode === "search" && S.productUrl(location.href, location.href)) throw new Error("Откройте страницу поисковой выдачи, а не карточку товара.");
    return E.extract(document, { url: location.href, label, mode, raw });
  }
  function readPage(label) { return extract(label).products; }

  async function waitForResults(label, previousFingerprint, mode, raw) {
    const deadline = Date.now() + 15000;
    const previousIds = new Set((previousFingerprint || "").split(","));
    while (Date.now() < deadline) {
      const result = extract(label, mode, raw);
      if (result.products.length && (!previousFingerprint || result.products.some(item => !previousIds.has(`${item.source}:${item.product_id}`) && !previousIds.has(item.product_id)))) return result;
      await delay(400);
    }
    throw new Error(previousFingerprint ? "Выдача после перехода не изменилась. Проверьте страницу и продолжите сбор." : "Товары не найдены. Дождитесь загрузки; для этой страницы могут понадобиться дополнительные правила извлечения.");
  }

  function pageResult(products, rawCards, diagnostics, query, warnings = []) {
    if (products.some(item => !item.title)) warnings.push("У части товаров не найдено название.");
    if (products.some(item => !item.shop_name)) warnings.push("В выдаче не показаны названия части магазинов. Используйте проверку карточек товаров.");
    return { products, raw_cards: [...rawCards.values()], page: {
      page_url: location.href, ...S.detectSearch(location.href, query, document.querySelector('input[name="keywords"], input[name="SearchText"]')?.value),
      source: S.marketplace(location.href), collected_at: new Date().toISOString(), product_count: products.length,
      fingerprint: S.fingerprint(products), diagnostics, warnings
    } };
  }

  async function collect(options = {}) {
    if (collecting) throw new Error("Сбор этой страницы уже идёт.");
    collecting = true; cancelled = false;
    let products = [];
    const rawCards = new Map();
    let diagnostics = {};
    const absorb = result => {
      products = S.mergeProducts(products, result.products); diagnostics = result.diagnostics;
      for (const card of result.raw_cards) rawCards.set(card.product_id, card);
    };
    try {
      progress("loading", "Ожидаю загрузку выдачи…", 0);
      absorb(await waitForResults(options.query, options.previousFingerprint, "search", options.raw !== false));
      let reachedBottom = false, stableAtBottom = 0;
      if (options.scroll) {
        window.scrollTo(0, 0); await delay(350);
        absorb(extract(options.query, "search", options.raw !== false));
        for (let scrolls = 0; scrolls < 32; scrolls++) {
          check();
          progress("scrolling", `Догружаю выдачу: ${products.length} товаров, прокрутка ${scrolls + 1}.`, products.length);
          const before = products.length;
          window.scrollBy(0, Math.max(500, innerHeight * 0.85));
          await delay(options.scroll_delay || 650);
          absorb(extract(options.query, "search", options.raw !== false));
          reachedBottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 12;
          stableAtBottom = reachedBottom && products.length === before ? stableAtBottom + 1 : 0;
          if (stableAtBottom >= 3) break;
        }
      }
      const warnings = options.scroll && !reachedBottom ? ["Достигнут предел прокрутки. Часть выдачи могла не загрузиться; соберите её вручную."] : [];
      return pageResult(products, rawCards, diagnostics, options.query, warnings);
    } catch (error) {
      if (products.length) error.partial = pageResult(products, rawCards, diagnostics, options.query, ["Страница собрана частично: работа была прервана."]);
      throw error;
    } finally { collecting = false; }
  }

  async function detail(options = {}) {
    cancelled = false;
    progress("detail", "Проверяю карточку товара и данные компании…", 0);
    let result;
    const deadline = Date.now() + (options.timeout || 8000);
    do {
      check();
      result = E.extract(document, { url: location.href, label: options.query, mode: "detail", raw: false });
      if (result.products.some(item => item.shop_name && item.supplier_url)) break;
      await delay(500);
    } while (Date.now() < deadline);
    for (const item of result.products) item.detail_checked_at = new Date().toISOString();
    return result;
  }

  function nextPageElement() {
    for (const element of document.querySelectorAll('a, button, [role="button"]')) {
      if (!visible(element) || element.disabled || element.getAttribute("aria-disabled") === "true" || /disabled/i.test(element.className)) continue;
      const label = S.text(element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent) || "";
      const namedNext = /^(?:下一页|下一頁|下页|next(?: page)?)[\s›»>]*$/i.test(label);
      const pagination = element.closest('[class*="pagination"], [class*="paging"], [class*="pager"], .fui-paging');
      const classNext = pagination && /(?:^|[\s_-])next(?:[\s_-]|$)/i.test(element.className);
      if (!namedNext && !classNext) continue;
      const href = element.getAttribute("href");
      if (href && !/^(?:javascript:|#)/i.test(href)) {
        const url = S.httpUrl(href, location.href);
        if (!url || !S.isMarketplaceUrl(url) || S.marketplace(url) !== S.marketplace(location.href) || S.productUrl(url, location.href) || /^(?:login|passport|accounts)\./.test(new URL(url).hostname)) continue;
      }
      return element;
    }
    return null;
  }

  function goNext() {
    check();
    const element = nextPageElement();
    if (!element) return { moved: false };
    setTimeout(() => { if (!cancelled) element.click(); }, 100);
    return { moved: true };
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target !== "1688-content") return;
    if (message.type === "CANCEL") { cancelled = true; respond({ ok: true }); return; }
    if (message.type === "RESET") { cancelled = false; respond({ ok: true, result: {} }); return; }
    const operation = message.type === "COLLECT" ? () => collect(message.options) : message.type === "DETAIL" ? () => detail(message.options) : message.type === "NEXT" ? goNext : message.type === "PEEK" ? () => extract(message.options?.query, "search", false) : null;
    if (!operation) return;
    Promise.resolve().then(operation).then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, error: error.message, code: error.code, partial: error.partial }));
    return true;
  });
  globalThis.SupplierCollectorDOM = { readPage, collect, detail, nextPageElement, blockedReason };
})();
