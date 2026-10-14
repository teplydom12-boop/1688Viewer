(function () {
  "use strict";
  if (globalThis.__supplierCollectorInstalled) return;
  globalThis.__supplierCollectorInstalled = true;
  const S = globalThis.SupplierCollector;
  const E = globalThis.SupplierCollectorEngine;
  const N = globalThis.SupplierNavigator;
  let profile = {};
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
    return E.extract(document, { url: location.href, label, mode, raw, profile });
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
    if (products.some(item => item.extraction_confidence < 90)) warnings.push("Часть карточек определена по структуре. Проверьте несколько строк перед большим сбором.");
    if (products.some(item => !item.product_url)) warnings.push("У части товаров нет доступной ссылки на карточку; автоматическая проверка таких товаров пропускается.");
    return { products, raw_cards: [...rawCards.values()], page: {
      page_url: location.href, ...S.detectSearch(location.href, query, document.querySelector('input[name="keywords"], input[name="SearchText"], input[type="search"], [role="searchbox"]')?.value),
      source: S.site(location.href), collected_at: new Date().toISOString(), product_count: products.length,
      fingerprint: S.fingerprint(products), diagnostics, warnings
    } };
  }

  async function collect(options = {}) {
    profile = options.profile || profile;
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
    profile = options.profile || profile;
    cancelled = false;
    progress("detail", "Проверяю карточку товара и данные компании…", 0);
    let result;
    const deadline = Date.now() + (options.timeout || 8000);
    do {
      check();
      result = E.extract(document, { url: location.href, label: options.query, mode: "detail", raw: false, profile });
      if (result.products.some(item => item.shop_name && item.supplier_url)) break;
      await delay(500);
    } while (Date.now() < deadline);
    for (const item of result.products) item.detail_checked_at = new Date().toISOString();
    return result;
  }

  function nextPageElement() {
    return N.analyze(document, { url: location.href, profile: profile.navigation }).chosen?.node || null;
  }
  function navigation(options = {}) {
    check(); profile = options.profile || profile;
    return N.publicResult(N.analyze(document, { url: location.href, profile: profile.navigation }));
  }
  function goNext(options = {}) {
    check();
    profile = options.profile || profile;
    const result = N.analyze(document, { url: location.href, profile: profile.navigation });
    const selected = options.candidate_id ? result.candidates.find(item => item.id === options.candidate_id) : result.chosen;
    if (!selected) return { moved: false, navigation: N.publicResult(result) };
    const element = selected.node;
    setTimeout(() => { if (!cancelled) element.click(); }, 100);
    return { moved: true, candidate: (({ node, ...item }) => item)(selected) };
  }

  let cancelPicker = null;
  function picker(options) {
    if (cancelPicker) cancelPicker();
    const banner = document.createElement("div"); banner.dataset.supplierPicker = "true";
    banner.textContent = options.mode === "card" ? "Supplier Viewer: выберите одну карточку товара. Esc — отмена." : "Supplier Viewer: выберите кнопку следующей страницы. Esc — отмена.";
    banner.style.cssText = "position:fixed;top:12px;left:12px;right:12px;z-index:2147483647;background:#fff3e5;color:#723515;border:2px solid #eb5e21;border-radius:9px;padding:15px;font:14px system-ui;pointer-events:none;box-shadow:0 4px 20px #0003";
    document.documentElement.append(banner);
    let outlined = null, oldOutline = "";
    const clean = () => { if (outlined) outlined.style.outline = oldOutline; banner.remove(); window.removeEventListener("mouseover", hover, true); window.removeEventListener("click", click, true); window.removeEventListener("keydown", key, true); cancelPicker = null; };
    const target = event => event.composedPath().find(node => node instanceof Element && !node.closest('[data-supplier-picker]'));
    const choose = event => { const node = target(event); return !node ? null : options.mode === "card" ? SupplierGeneric.sampleCard(node, location.href) : node.closest('a,button,[role="button"],[class*="next"],[tabindex]') || node; };
    const hover = event => { const node = choose(event); if (node === outlined) return; if (outlined) outlined.style.outline = oldOutline; outlined = node; if (node) { oldOutline = node.style.outline; node.style.outline = "3px solid #eb5e21"; } };
    const click = event => {
      event.preventDefault(); event.stopImmediatePropagation();
      const node = choose(event); if (!node) { banner.textContent = "Не удалось выделить отдельную карточку. Выберите её название или изображение."; return; }
      const href = node.getAttribute("href") && S.httpUrl(node.getAttribute("href"), location.href);
      if (options.mode !== "card" && (N.disabled(node) || href && S.dangerousUrl(href) || /купить|корзин|удалить|buy now|checkout|delete|logout/i.test(node.textContent))) { banner.textContent = "Это действие не подходит для перелистывания. Выберите другую кнопку."; return; }
      const selector = N.selectorFor(node, options.mode === "card");
      const detail = { nonce: options.nonce, mode: options.mode, selector, label: S.text(node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent)?.slice(0, 160) || "Кнопка со стрелкой" };
      clean(); void chrome.runtime.sendMessage({ target: "1688-background", type: "PROFILE_PICKED", detail }).catch(() => {});
    };
    const key = event => { if (event.key === "Escape") clean(); };
    window.addEventListener("mouseover", hover, true); window.addEventListener("click", click, true); window.addEventListener("keydown", key, true); cancelPicker = clean;
    return { enabled: true };
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target !== "1688-content") return;
    if (message.type === "CANCEL") { cancelled = true; respond({ ok: true }); return; }
    if (message.type === "RESET") { cancelled = false; respond({ ok: true, result: {} }); return; }
    const operation = message.type === "COLLECT" ? () => collect(message.options) : message.type === "DETAIL" ? () => detail(message.options) : message.type === "NEXT" ? () => goNext(message.options) : message.type === "NAVIGATE_OPTIONS" ? () => navigation(message.options) : message.type === "PICKER" ? () => picker(message.options) : message.type === "PEEK" ? () => { profile = message.options?.profile || profile; return extract(message.options?.query, "search", false); } : null;
    if (!operation) return;
    Promise.resolve().then(operation).then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, error: error.message, code: error.code, partial: error.partial }));
    return true;
  });
  globalThis.SupplierCollectorDOM = { readPage, collect, detail, navigation, nextPageElement, blockedReason };
})();
