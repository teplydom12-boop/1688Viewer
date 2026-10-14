(function () {
  "use strict";
  if (globalThis.__supplierCollectorInstalled) return;
  globalThis.__supplierCollectorInstalled = true;
  const S = globalThis.SupplierCollector;
  let collecting = false;
  let cancelled = false;
  const CARD_SELECTORS = [
    ".space-offer-card-box", ".offer-card", ".offer-item", ".offer-list-row-offer",
    ".offer-list-item", ".sm-offer", "[data-offer-id]", "[data-offerid]",
    '[class*="offer-card"]', '[class*="offer-item"]', '[class*="search-offer"]'
  ].join(",");
  const TITLE_SELECTORS = [
    '[class*="offer-title"]', '[class*="offerTitle"]', '[class*="product-title"]',
    '[class*="title-text"]', ".title", 'h2', 'h3', '[itemprop="name"]'
  ].join(",");
  const SHOP_SELECTORS = [
    ".company-name", ".shop-name", ".companyname", '[class*="company-name"]',
    '[class*="companyName"]', '[class*="shopName"]', '[class*="supplier-name"]'
  ].join(",");

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function getText(element) {
    return element ? S.text(element.getAttribute("content") || element.innerText || element.textContent) : null;
  }

  function firstVisible(root, selector) {
    return [...root.querySelectorAll(selector)].find(visible) || null;
  }

  function offerIds(root) {
    return new Set([...root.querySelectorAll("a[href]")].map(anchor => S.productUrl(anchor.getAttribute("href"), location.href)?.id).filter(Boolean));
  }

  function cardFor(anchor, id) {
    const selected = anchor.closest(CARD_SELECTORS);
    if (selected && offerIds(selected).size <= 1) return selected;
    let node = anchor;
    let best = anchor;
    for (let depth = 0; depth < 6 && node.parentElement; depth++) {
      node = node.parentElement;
      if (["BODY", "HTML", "MAIN"].includes(node.tagName)) break;
      const ids = offerIds(node);
      if (ids.size > 1 || (ids.size === 1 && !ids.has(id))) break;
      if ((node.textContent || "").length > 1800) break;
      best = node;
      if (node.querySelector('[class*="price"]') && node.querySelector(SHOP_SELECTORS)) break;
    }
    return best;
  }

  function usefulTitle(value) {
    const title = S.text(value);
    if (!title || title.length < 2 || /^(查看详情|立即购买|点击查看|详情|购买|立即订购|查看商品)$/.test(title)) return null;
    if (/^[¥￥\d\s.,~–\-/元件个]+$/.test(title)) return null;
    return title.slice(0, 500);
  }

  function getTitle(card, anchor) {
    for (const element of card.querySelectorAll(TITLE_SELECTORS)) {
      if (!visible(element)) continue;
      const title = usefulTitle(element.getAttribute("title")) || usefulTitle(getText(element));
      if (title) return title;
    }
    return usefulTitle(anchor.getAttribute("title")) || usefulTitle(anchor.getAttribute("aria-label")) ||
      usefulTitle(anchor.getAttribute("data-title")) || usefulTitle(anchor.querySelector("img")?.getAttribute("alt")) ||
      (anchor.tagName === "A" ? usefulTitle(getText(anchor)) : null);
  }

  function getPrice(card) {
    const selectors = ['[itemprop="price"]', ".offer-price", ".price", '[class*="offer-price"]', '[class*="price"]'];
    for (const selector of selectors) {
      for (const element of card.querySelectorAll(selector)) {
        if (!visible(element) || /original|old-price|price-old|freight/i.test(element.className)) continue;
        const price = getText(element)?.replace(/\s*\.\s*/g, ".");
        if (price && /\d/.test(price) && price.length < 120) return price;
      }
    }
    const raw = getText(card) || "";
    return raw.match(/(?:¥|￥|人民币|RMB|CNY)\s*\d[\d,.]*(?:\s*(?:-|~|至|–)\s*(?:¥|￥)?\s*\d[\d,.]*)?/i)?.[0] ||
      raw.match(/\d[\d,.]*\s*元(?:\s*\/\s*[^\s]{1,5})?/)?.[0] || null;
  }

  function getMinimumOrder(card) {
    const element = firstVisible(card, '.moq, [class*="min-order"], [class*="minOrder"], [class*="start-order"]');
    const value = getText(element);
    if (value && /\d/.test(value)) return value;
    const raw = getText(card) || "";
    return raw.match(/(?:[≥>]\s*)?\d[\d,.]*\s*(?:件|个|套|箱|包|袋|双|台|瓶|只|千克|公斤|吨|米|码|kg|pcs)\s*(?:起批|起订|起购|起售)/i)?.[0] ||
      raw.match(/(?:起批量|起订量|最小起订量|MOQ)\s*[:：]?\s*\d[\d,.]*\s*(?:件|个|套|箱|包|袋|双|台|瓶|只|千克|公斤|吨|米|码|kg|pcs)?/i)?.[0] || null;
  }

  function getImage(card, anchor) {
    const image = anchor.querySelector("img") || firstVisible(card, '[class*="offer-img"] img, [class*="product-img"] img, img');
    if (!image) return null;
    for (const value of [image.getAttribute("data-src"), image.getAttribute("data-lazy-src"), image.getAttribute("data-original"), image.currentSrc, image.getAttribute("src")]) {
      if (!value || /placeholder|transparent|loading\.gif|spacer/i.test(value)) continue;
      const url = S.httpUrl(value, location.href);
      if (url) return url;
    }
    return null;
  }

  function blockedReason() {
    if (/^(login|passport)\./.test(location.hostname) || /\/(?:login|punish|captcha|verify)(?:[/.?]|$)/i.test(location.pathname)) {
      return "Откройте выдачу после входа и проверки безопасности 1688.";
    }
    const challenge = firstVisible(document, '#nc_1_wrapper, .nc-container, .baxia-dialog, [id*="captcha"], [class*="captcha"]');
    const password = firstVisible(document, 'input[type="password"]');
    if (challenge || password) return "1688 показывает вход или проверку безопасности. Пройдите её вручную и возобновите сбор.";
    const body = getText(document.body) || "";
    if (body.length < 1500 && /滑动验证|拖动滑块|安全验证|访问受限|请完成验证/.test(body)) {
      return "1688 запросил проверку безопасности. Пройдите её вручную и возобновите сбор.";
    }
    return null;
  }

  function readPage(label) {
    const error = blockedReason();
    if (error) throw new Error(error);
    const input = document.querySelector('input[name="keywords"], input[name="keyword"], input[name="q"], #alisearch-keywords');
    const search = S.detectSearch(location.href, label, input?.value);
    const timestamp = new Date().toISOString();
    const records = [];
    const candidates = [...document.querySelectorAll("a[href]")].map(anchor => ({
      anchor, offer: S.productUrl(anchor.getAttribute("href"), location.href)
    }));
    // Some image-search cards use JS navigation instead of an ordinary product link.
    for (const card of document.querySelectorAll("[data-offer-id], [data-offerid]")) {
      const id = card.getAttribute("data-offer-id") || card.getAttribute("data-offerid");
      if (/^\d+$/.test(id || "") && offerIds(card).size === 0) candidates.push({
        anchor: card, offer: { id, url: `https://detail.1688.com/offer/${id}.html` }
      });
    }
    for (const { anchor, offer } of candidates) {
      if (!offer || !visible(anchor)) continue;
      // Recommendations on a product detail page are not search results.
      if (S.productUrl(location.href, location.href)) throw new Error("Откройте страницу поисковой выдачи, а не карточку товара.");
      const card = cardFor(anchor, offer.id);
      const shopElement = firstVisible(card, SHOP_SELECTORS);
      const supplier = [...card.querySelectorAll("a[href]")].filter(visible)
        .map(element => ({ element, url: S.supplierUrl(element.getAttribute("href"), location.href) }))
        .find(item => item.url);
      let shopName = getText(shopElement) || S.text(supplier?.element.getAttribute("title")) || getText(supplier?.element);
      if (shopName && /^(进店|进入店铺|联系卖家|店铺|旺铺)$/.test(shopName)) shopName = null;
      records.push({
        source: "1688",
        product_id: offer.id,
        title: getTitle(card, anchor),
        product_url: offer.url,
        shop_name: shopName,
        supplier_url: supplier?.url || null,
        price: getPrice(card),
        minimum_order: getMinimumOrder(card),
        image_url: getImage(card, anchor),
        query: search.query,
        search_type: search.search_type,
        collected_at: timestamp,
        source_page_url: location.href
      });
    }
    return S.mergeProducts([], records);
  }

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function checkCancelled() {
    if (cancelled) throw new Error("Сбор остановлен.");
  }

  async function waitForResults(label, previousFingerprint) {
    const deadline = Date.now() + 15000;
    const previousIds = new Set((previousFingerprint || "").split(","));
    while (Date.now() < deadline) {
      checkCancelled();
      const products = readPage(label);
      if (products.length && (!previousFingerprint || products.some(item => !previousIds.has(item.product_id)))) return products;
      await delay(400);
    }
    throw new Error(previousFingerprint
      ? "Выдача после перехода не изменилась. Сбор приостановлен; проверьте страницу."
      : "Товары не найдены. Откройте выдачу 1688 и дождитесь загрузки. Возможно, для этой страницы нужны другие правила извлечения.");
  }

  async function collect(options = {}) {
    if (collecting) throw new Error("Сбор этой страницы уже идёт.");
    collecting = true;
    cancelled = false;
    try {
      let products = await waitForResults(options.query, options.previousFingerprint);
      let reachedBottom = false;
      let stableAtBottom = 0;
      let scrolls = 0;
      if (options.scroll) {
        window.scrollTo(0, 0);
        await delay(350);
        products = S.mergeProducts(products, readPage(options.query));
        for (; scrolls < 24; scrolls++) {
          checkCancelled();
          const before = products.length;
          window.scrollBy(0, Math.max(500, innerHeight * 0.85));
          await delay(450);
          products = S.mergeProducts(products, readPage(options.query));
          reachedBottom = window.scrollY + innerHeight >= document.documentElement.scrollHeight - 12;
          stableAtBottom = reachedBottom && products.length === before ? stableAtBottom + 1 : 0;
          if (stableAtBottom >= 3) break;
        }
      }
      const warnings = [];
      if (options.scroll && !reachedBottom) warnings.push("Достигнут предел прокрутки. Часть выдачи могла не загрузиться; прокрутите дальше и соберите ещё раз.");
      if (products.some(item => !item.title)) warnings.push("У части товаров не найдено название; проверьте правила извлечения.");
      if (products.every(item => !item.shop_name && !item.supplier_url)) warnings.push("Магазины не указаны в доступной разметке этой выдачи. Поля оставлены пустыми.");
      return {
        products,
        page: {
          page_url: location.href,
          ...S.detectSearch(location.href, options.query, document.querySelector('input[name="keywords"]')?.value),
          collected_at: new Date().toISOString(),
          product_count: products.length,
          fingerprint: S.fingerprint(products),
          warnings
        }
      };
    } finally { collecting = false; }
  }

  function nextPageElement() {
    for (const element of document.querySelectorAll('a, button, [role="button"]')) {
      if (!visible(element) || element.disabled || element.getAttribute("aria-disabled") === "true" || /disabled/i.test(element.className)) continue;
      const label = S.text(element.getAttribute("aria-label") || element.getAttribute("title") || getText(element)) || "";
      const namedNext = /^(?:下一页|下一頁|下页|next(?: page)?)[\s›»>]*$/i.test(label);
      const pagination = element.closest('[class*="pagination"], [class*="paging"], [class*="pager"], .fui-paging');
      const classNext = pagination && /(?:^|[\s_-])next(?:[\s_-]|$)/i.test(element.className);
      if (!namedNext && !classNext) continue;
      const href = element.getAttribute("href");
      if (href && !/^(?:javascript:|#)/i.test(href)) {
        const url = S.httpUrl(href, location.href);
        if (!url || !S.isMarketplaceUrl(url) || S.productUrl(url, location.href) || /^(?:login|passport)\./.test(new URL(url).hostname)) continue;
      }
      return element;
    }
    return null;
  }

  function goNext() {
    const error = blockedReason();
    if (error) throw new Error(error);
    const element = nextPageElement();
    if (!element) return { moved: false };
    setTimeout(() => { if (!cancelled) element.click(); }, 100);
    return { moved: true };
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.target !== "1688-content") return;
      if (message.type === "CANCEL") { cancelled = true; respond({ ok: true }); return; }
      const operation = message.type === "COLLECT" ? () => collect(message.options) : message.type === "NEXT" ? goNext : null;
      if (!operation) return;
      Promise.resolve().then(operation).then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, error: error.message }));
      return true;
    });
  }
  // Pure DOM entry points are also exercised by the browser test suite.
  globalThis.SupplierCollectorDOM = { readPage, collect, nextPageElement, blockedReason };
})();
