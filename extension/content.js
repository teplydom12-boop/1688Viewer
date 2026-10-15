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
  let pageData = { products: [], pagination: [] }, dataReadAt = 0;
  let knownFingerprint = "";
  const documentId = crypto.randomUUID();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function visible(element) {
    if (!element || !element.isConnected) return false;
    return N.visible(element, false);
  }

  function blockedReason() {
    if (/^(login|passport|accounts)\./.test(location.hostname) || /\/(?:login|punish|captcha|verify)(?:[/.?]|$)/i.test(location.pathname)) return "Откройте страницу после входа и проверки безопасности.";
    const scopes = N.scopes(document);
    const challenge = scopes.flatMap(scope => [...scope.querySelectorAll('#nc_1_wrapper, .nc-container, [class*="baxia-dialog"], [id*="captcha"], [class*="captcha"], [class*="turnstile"], [class*="hcaptcha"], [data-sitekey], iframe[src*="punish"], iframe[src*="captcha"], iframe[src*="challenge"], input[type="password"]')]).find(node => !node.closest('.grecaptcha-badge,[class*="captcha-badge"],[class*="turnstile-badge"]') && visible(node));
    if (challenge) return "Сайт показывает вход или проверку безопасности. Пройдите её вручную и нажмите «Продолжить».";
    const body = S.text(scopes.map(scope => {
      if (scope.body) return !scope.defaultView?.frameElement || visible(scope.defaultView.frameElement) ? scope.body.innerText : "";
      if (scope.host && visible(scope.host)) return [...scope.querySelectorAll("*")].filter(node => !node.children.length && visible(node)).map(node => node.innerText || node.textContent).join(" ");
      return "";
    }).join(" ")) || "";
    if (body.length < 2000 && /too many requests|temporarily blocked|request limit|(?:HTTP|status|error)\s*[:=-]?\s*429\b|系统繁忙/i.test(body)) return "Сайт ограничил частоту запросов. Подождите, увеличьте паузу между переходами и продолжите работу.";
    if (body.length < 2000 && /滑动验证|拖动滑块|安全验证|访问受限|请完成验证|verify you are human|access denied|unusual traffic|security verification|slide to verify|подтвердите.{0,40}(?:человек|робот)|проверка безопасности/i.test(body)) return "Сайт запросил проверку безопасности. Пройдите её вручную и нажмите «Продолжить».";
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
    const result = E.extract(document, { url: location.href, label, mode, raw, profile, pageData, known_fingerprint: knownFingerprint });
    return { ...result, products: mode === "search" ? result.cards : result.products, diagnostics: { ...result.diagnostics, document_id: documentId, content_signature: S.cardSignature(result.cards) } };
  }
  async function refreshPageData(force = false) {
    check();
    if (!force && Date.now() - dataReadAt < 350 || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    dataReadAt = Date.now();
    try { const response = await chrome.runtime.sendMessage({ target: "1688-background", type: "PAGE_DATA" }); if (response?.ok) pageData = response.result; } catch { /* DOM and inert JSON remain available */ }
    if (pageData.diagnostics?.challenge) { const error = new Error("Сайт запросил проверку безопасности в ответе на загрузку товаров. Пройдите её вручную и нажмите «Продолжить»."); error.code = "CHALLENGE"; throw error; }
    check();
  }
  function readPage(label) { return extract(label).products; }

  function quality(result, options, initial = false) {
    const terminal = N.analyze(document, { url: location.href, profile: profile.navigation, pagination: result.diagnostics.pagination || [] }).decision === "exhausted";
    return S.collectionQuality(result.products, { known_keys: (options.known_fingerprint || "").split(",").filter(Boolean), expected_count: result.diagnostics.expected_page_size || options.expected_count, check_count: options.scroll === true, initial, terminal, page_context: result.diagnostics.page_context, append_mode: options.append_mode === true, allow_repeats: options.allow_repeats === true });
  }
  function incomplete(result, coverage) {
    const error = new Error(`Полнота страницы не подтверждена: найдено ${coverage.observed_count} товаров, новых ${coverage.new_count}, повторных ${coverage.repeated_count}${coverage.expected_count ? `; ориентир ${coverage.expected_count}` : ""}${coverage.reason === "page-mismatch" ? `; адрес страницы ${coverage.url_page ?? "не указан"}, загружена выдача ${coverage.rendered_page ?? "смешанных страниц"}` : ""}. Дождитесь загрузки выдачи и нажмите «Продолжить». Страница не засчитана.`);
    error.code = "INCOMPLETE_RESULTS"; error.candidate = result; error.coverage = coverage; return error;
  }
  async function waitForResults(label, previousFingerprint, mode, raw, options = {}) {
    const deadline = Date.now() + 15000;
    const previousIds = new Set((previousFingerprint || "").split(","));
    let pending;
    while (Date.now() < deadline) {
      await refreshPageData();
      const result = extract(label, mode, raw);
      if (result.products.length) {
        const coverage = quality(result, options, true);
        if (!coverage.complete) pending = { result, coverage };
        else if (!previousFingerprint || options.allow_repeats || S.pageChangeConfirmed(location.href, result.diagnostics, options.previous_url, options.previous_page_context, options.previous_document_id) || result.products.some(item => !previousIds.has(`${item.source}:${item.product_id}`) && !previousIds.has(item.product_id))) return result;
      }
      await delay(400);
    }
    if (pending) throw incomplete(pending.result, pending.coverage);
    throw new Error(previousFingerprint ? "Выдача после перехода не изменилась. Проверьте страницу и продолжите сбор." : "Товары не найдены. Дождитесь загрузки; для этой страницы могут понадобиться дополнительные правила извлечения.");
  }

  function pageResult(products, rawCards, diagnostics, query, warnings = []) {
    if (products.some(item => !item.title)) warnings.push("У части товаров не найдено название.");
    if (products.some(item => !item.shop_name)) warnings.push("В выдаче не показаны названия части магазинов. Используйте проверку карточек товаров.");
    if (products.some(item => item.extraction_confidence < 90)) warnings.push("Часть карточек определена по структуре. Проверьте несколько строк перед большим сбором.");
    if (products.some(item => !item.product_url)) warnings.push("У части товаров нет доступной ссылки на карточку; автоматическая проверка таких товаров пропускается.");
    if (diagnostics.data_truncated) warnings.push("Данные приложения превысили лимит анализа. Часть результатов могла быть пропущена.");
    if (diagnostics.price_conflicts) warnings.push(`У ${diagnostics.price_conflicts} товаров источники показывают разные цены. Сравните значения со страницей.`);
    products = products.map((item, index) => ({ ...item, card_index: index + 1 }));
    return { products, raw_cards: [...rawCards.values()], page: {
      page_url: location.href, ...S.detectSearch(location.href, query, document.querySelector('input[name="keywords"], input[name="SearchText"], input[type="search"], [role="searchbox"]')?.value),
      source: S.site(location.href), collected_at: new Date().toISOString(), product_count: products.length,
      fingerprint: S.fingerprint(products), diagnostics, warnings
    } };
  }

  async function collect(options = {}) {
    profile = options.profile || profile;
    if (collecting) throw new Error("Сбор этой страницы уже идёт.");
    collecting = true; cancelled = false; knownFingerprint = options.known_fingerprint || "";
    pageData = { products: [], pagination: [] }; dataReadAt = 0;
    let products = [];
    const rawCards = new Map();
    let diagnostics = {};
    const absorb = result => {
      products = S.mergeCardSamples(products, result.products); diagnostics = result.diagnostics;
      for (const card of result.raw_cards) rawCards.set(card.page_card_key, card);
    };
    let accepting = false;
    const watcher = SupplierObserver.watch(document, () => { if (accepting) absorb(extract(options.query, "search", options.raw !== false)); }, check);
    try {
      progress("loading", "Ожидаю загрузку выдачи…", 0);
      const ready = await waitForResults(options.query, options.previousFingerprint, "search", options.raw !== false, options);
      accepting = true; absorb(ready);
      await watcher.wait({ minMs: 350, maxMs: 1800 }); await refreshPageData();
      absorb(extract(options.query, "search", options.raw !== false));
      let reachedBottom = false, stableAtBottom = 0;
      if (options.scroll) {
        const targets = N.scrollTargets(document); targets.forEach(target => target.node.scrollTop = 0); await watcher.wait({ minMs: 350, maxMs: 1400 });
        absorb(extract(options.query, "search", options.raw !== false));
        for (let scrolls = 0; scrolls < 32; scrolls++) {
          check();
          progress("scrolling", `Догружаю выдачу: ${products.length} товаров, прокрутка ${scrolls + 1}.`, products.length);
          const before = products.length;
          const surfaces = N.scrollTargets(document);
          for (const target of surfaces) target.node.scrollTop += Math.max(200, target.node.clientHeight * 0.85);
          await watcher.wait({ minMs: options.scroll_delay || 650, maxMs: Math.max(1600, (options.scroll_delay || 650) * 2) });
          await refreshPageData();
          absorb(extract(options.query, "search", options.raw !== false));
          reachedBottom = surfaces.every(target => target.node.scrollTop + target.node.clientHeight >= target.node.scrollHeight - 12);
          stableAtBottom = reachedBottom && products.length === before ? stableAtBottom + 1 : 0;
          if (stableAtBottom >= 3) break;
        }
      }
      const warnings = options.scroll && !reachedBottom ? ["Достигнут предел прокрутки. Часть выдачи могла не загрузиться; соберите её вручную."] : [];
      let coverage = quality({ products, diagnostics }, options);
      if (!coverage.complete) {
        progress("loading", "Проверяю полноту выдачи перед сохранением…", products.length);
        await watcher.wait({ minMs: 1500, maxMs: 3000 }); await refreshPageData(); absorb(extract(options.query, "search", options.raw !== false));
        coverage = quality({ products, diagnostics }, options);
        if (!coverage.complete) throw incomplete({ products, raw_cards: [...rawCards.values()], diagnostics }, coverage);
      }
      return pageResult(products, rawCards, { ...diagnostics, ...watcher.stats(), collection_quality: coverage }, options.query, warnings);
    } catch (error) {
      if (error.code === "INCOMPLETE_RESULTS") {
        const candidate = error.candidate;
        products = candidate.products; rawCards.clear();
        for (const card of candidate.raw_cards || []) rawCards.set(card.page_card_key, card);
        diagnostics = { ...candidate.diagnostics, collection_quality: error.coverage };
        error.partial = pageResult(products, rawCards, diagnostics, options.query, [error.message]);
      } else if (products.length) error.partial = pageResult(products, rawCards, diagnostics, options.query, ["Страница собрана частично: работа была прервана."]);
      throw error;
    } finally { watcher.stop(); collecting = false; knownFingerprint = ""; }
  }

  async function detail(options = {}) {
    profile = options.profile || profile;
    cancelled = false;
    progress("detail", "Проверяю карточку товара и данные компании…", 0);
    let result;
    const deadline = Date.now() + (options.timeout || 8000);
    do {
      check();
      await refreshPageData();
      result = E.extract(document, { url: location.href, label: options.query, mode: "detail", raw: false, profile, pageData });
      if (result.products.some(item => item.shop_name && item.supplier_url)) break;
      await delay(500);
    } while (Date.now() < deadline);
    for (const item of result.products) item.detail_checked_at = new Date().toISOString();
    return result;
  }

  function nextPageElement() {
    return N.analyze(document, { url: location.href, profile: profile.navigation }).chosen?.node || null;
  }
  async function navigation(options = {}) {
    check(); profile = options.profile || profile;
    await refreshPageData(true);
    const data = SupplierDataSources.extract(document, { url: location.href, pageData });
    return N.publicResult(N.analyze(document, { url: location.href, profile: profile.navigation, pagination: data.pagination }));
  }
  async function goNext(options = {}) {
    check();
    profile = options.profile || profile;
    await refreshPageData(true);
    const data = SupplierDataSources.extract(document, { url: location.href, pageData });
    const result = N.analyze(document, { url: location.href, profile: profile.navigation, pagination: data.pagination });
    const selected = options.candidate_id ? result.candidates.find(item => item.id === options.candidate_id) : result.chosen;
    if (!selected) return { moved: false, navigation: N.publicResult(result) };
    const element = selected.node;
    setTimeout(() => {
      if (cancelled || blockedReason()) return;
      if (selected.action === "open-url") {
        (element.ownerDocument?.defaultView || document.defaultView).location.href = selected.href;
      } else if (selected.action === "form-page") {
        const form = N.resolve(document, selected.form_selector)[0]; if (!form || !element.isConnected) return;
        const view = element.ownerDocument.defaultView;
        const prototype = element.tagName === "SELECT" ? view.HTMLSelectElement.prototype : view.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, selected.next_value);
        element.dispatchEvent(new view.Event("input", { bubbles: true })); element.dispatchEvent(new view.Event("change", { bubbles: true }));
        const submitter = [...form.querySelectorAll('button:not([type]),button[type="submit"],input[type="submit"]')].find(node => !N.disabled(node));
        if (submitter || element.tagName !== "SELECT") form.requestSubmit(submitter);
      } else element.click();
    }, 100);
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
    if (message.type === "RESET") { cancelled = false; dataReadAt = 0; pageData = { products: [], pagination: [] }; respond({ ok: true, result: {} }); return; }
    const operation = message.type === "COLLECT" ? () => collect(message.options) : message.type === "DETAIL" ? () => detail(message.options) : message.type === "NEXT" ? () => goNext(message.options) : message.type === "NAVIGATE_OPTIONS" ? () => navigation(message.options) : message.type === "PICKER" ? () => picker(message.options) : message.type === "CHECK" ? () => { check(); return {}; } : message.type === "PEEK" ? async () => { profile = message.options?.profile || profile; await refreshPageData(); return extract(message.options?.query, "search", false); } : null;
    if (!operation) return;
    Promise.resolve().then(operation).then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, error: error.message, code: error.code, partial: error.partial }));
    return true;
  });
  globalThis.SupplierCollectorDOM = { readPage, collect, detail, navigation, nextPageElement, blockedReason };
})();
