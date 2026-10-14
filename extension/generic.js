(function (root) {
  "use strict";
  const S = root.SupplierCollector;
  const moneyPrefix = /(?:US\s*\$|[$€£¥￥₹₽]|USD|EUR|GBP|RUB|CNY|INR)\s*\d[\d\s.,]*(?:\s*[-–~]\s*(?:[$€£¥￥₹₽]|USD|EUR)?\s*\d[\d\s.,]*)?/i;
  const moneySuffix = /\d[\d\s.,]*\s*(?:руб\.?|USD|EUR|GBP|RUB|CNY|INR|€|₽)/i;
  const money = new RegExp(moneyPrefix.source + "|" + moneySuffix.source, "i");
  const words = /\p{L}/u;
  const nonTitle = /^(?:add to cart|buy now|view details|wishlist|купить|в корзину|подробнее|цена|price|sold by|seller|supplier|поставщик|магазин)/i;
  function query(node, selector) { try { for (const scope of root.SupplierNavigator.scopes(node)) { const found = selector ? scope.querySelector(selector) : null; if (found) return found; } } catch { /* invalid learned selector */ } return null; }
  const value = node => S.text(node?.getAttribute("content") || node?.getAttribute("data-price") || node?.textContent || (node && root.SupplierNavigator.accessibleName(node)));
  function nodes(node, selector) { return [...new Set([...(node.matches?.(selector) ? [node] : []), ...root.SupplierNavigator.scopes(node).flatMap(scope => [...scope.querySelectorAll(selector)])])]; }
  function image(card, url, profile = {}) {
    const remembered = S.httpUrl(card.getAttribute("data-image-url"), url); if (remembered) return remembered;
    const selected = query(card, profile.image);
    const images = selected ? [selected] : nodes(card, 'img, [itemprop="image"], [property$=":image"], [role="img"]');
    for (const node of images) {
      if (/icon|logo|star|badge/i.test(node.getAttribute("class") || "")) continue;
      const responsive = (node.getAttribute("srcset") || node.getAttribute("data-srcset") || "").split(",").map(item => item.trim().split(/\s+/)).sort((a, b) => parseFloat(b[1] || "0") - parseFloat(a[1] || "0"))[0]?.[0];
      for (const raw of [node.getAttribute("data-src"), node.getAttribute("data-lazy-src"), node.getAttribute("data-original"), node.currentSrc, node.getAttribute("src"), node.getAttribute("content"), responsive]) {
        if (!raw || /placeholder|spacer|loading\.gif/i.test(raw)) continue;
        const safe = S.httpUrl(raw, url); if (safe) return safe;
      }
    }
    for (const node of [card, ...card.querySelectorAll("div,span,figure")].slice(0, 35)) {
      const css = node.style.backgroundImage || node.ownerDocument.defaultView?.getComputedStyle(node).backgroundImage || "";
      const raw = css.match(/url\(["']?(.+?)["']?\)/)?.[1]; const safe = raw && S.httpUrl(raw, url); if (safe) return safe;
    }
    return null;
  }
  function title(card, profile = {}) {
    const selected = query(card, profile.title);
    if (selected) return value(selected)?.slice(0, 500) || null;
    for (const node of nodes(card, '[itemprop="name"], [role="heading"], h1,h2,h3,h4,[data-title],a[title],a[aria-label],a[aria-labelledby]')) {
      if (node.closest('[itemprop="seller"],[itemprop="brand"],[typeof*="Organization"]')) continue;
      const text = S.text(node.getAttribute("title") || node.getAttribute("data-title")) || root.SupplierNavigator.accessibleName(node) || value(node);
      if (text && words.test(text) && text.length <= 500 && !nonTitle.test(text)) return text;
    }
    const alt = nodes(card, "img[alt]").map(node => S.text(node.alt)).find(text => text && words.test(text) && !/^(?:image|photo|product image|изображение|фото)$/i.test(text));
    if (alt) return alt.slice(0, 500);
    const leaves = nodes(card, "a,span,p,div,strong").filter(node => !node.children.length).map(value)
      .filter(text => text && text.length >= 3 && text.length <= 220 && words.test(text) && !money.test(text) && !nonTitle.test(text) && !/^(?:\d+\s*(?:reviews|stars)|free shipping|доставка)/i.test(text));
    return leaves.sort((a, b) => b.length - a.length)[0] || null;
  }
  function price(card, profile = {}) {
    const selected = query(card, profile.price);
    if (selected) return value(selected);
    for (const node of nodes(card, '[itemprop="price"],[data-price],[class]')) {
      const name = node.getAttribute("class") || "";
      if (/original|old.?price|was.?price/i.test(name)) continue;
      if (!node.matches('[itemprop="price"],[data-price]') && !/price/i.test(name)) continue;
      const text = value(node)?.replace(/\s*\.\s*/g, ".");
      if (text && /\d/.test(text) && text.length <= 100) return text;
    }
    // Try small price nodes before combined card text, which can join a title's
    // trailing number to a currency symbol in the following element.
    const amounts = nodes(card, "span,p,div,strong,b,small").filter(node => !node.children.length && !/original|old.?price|was.?price/i.test(node.getAttribute("class") || "")).map(value);
    for (const text of [...amounts, value(card)]) {
      const match = text?.match(moneyPrefix) || text?.match(moneySuffix);
      if (match) return match[0].trim();
    }
    return /price on request|contact for price|цена по запросу/i.test(value(card) || "") ? "Цена по запросу" : null;
  }
  function link(card, url, profile = {}) {
    const selected = query(card, profile.link);
    const anchors = selected ? [selected] : nodes(card, 'a[href], [data-snapshot-anchor][href], [data-product-url], [data-url]');
    const links = anchors.map(node => {
      const raw = node.getAttribute("href") || node.getAttribute("data-product-url") || node.getAttribute("data-url");
      if (!raw || /^#(?!!?\/)/.test(raw) || /^javascript:/i.test(raw)) return null;
      const href = S.httpUrl(raw, url); if (!href || S.dangerousUrl(href)) return null;
      const label = value(node) || "";
      if (/sold by|supplier|seller|vendor|магазин|поставщик/i.test(label + " " + (node.getAttribute("class") || "")) || /\/(?:vendors?|sellers?|suppliers?|stores?)\//i.test(new URL(href).pathname)) return null;
      if (node.closest('[itemprop="seller"], [class*="seller"], [class*="supplier"], [class*="merchant"], [class*="shop-name"]')) return null;
      const canonical = S.canonicalUrl(href);
      if (canonical === S.canonicalUrl(url)) return null;
      let score = 10;
      if (query(node, "img")) score += 35;
      if (/\/(?:products?|item|p|dp|goods|sku|товар)(?:\/|[-_])/i.test(new URL(href).pathname)) score += 30;
      if (label && words.test(label) && label.length < 300) score += 25;
      if (label && label === title(card, profile)) score += 30;
      if (node.getAttribute("title")) score += 15;
      return { href, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    return links[0]?.score >= 30 ? links[0].href : null;
  }
  function fields(card, url, profile = {}) {
    const supplierSelector = '[itemprop="seller"], [class*="seller"], [class*="supplier"], [class*="merchant"], [class*="company-name"], [class*="shop-name"]';
    let seller = query(card, profile.shop_name) || query(card, supplierSelector);
    if (!seller) seller = nodes(card, "p,span,div,small").find(node => /^(?:sold by|seller|supplier|продавец|поставщик|магазин)\s*[:：]?\s+/i.test(value(node) || "") && (value(node) || "").length < 250) || null;
    const sellerLink = query(card, profile.supplier_url) || (seller?.matches('a[href], [data-snapshot-anchor][href]') ? seller : seller && query(seller, 'a[href], [data-snapshot-anchor][href], [itemprop="url"]'));
    const sellerUrl = sellerLink && S.supplierUrl(sellerLink.getAttribute("href") || sellerLink.getAttribute("content"), url, true);
    const explicitName = seller?.matches('[itemprop="seller"]') || /(?:seller|supplier|merchant|company|shop)[-_]?name/i.test(seller?.getAttribute("class") || "") || /^(?:sold by|seller|supplier|продавец|поставщик|магазин)\s*[:：]?\s+/i.test(value(seller) || "") || Boolean(profile.shop_name);
    const nameNode = seller && query(seller, '[itemprop="name"], [class*="seller-name"], [class*="supplier-name"], [class*="company-name"], [class*="shop-name"]');
    let shopName = (value(nameNode) || value(sellerLink) || (explicitName ? value(seller) : null))?.replace(/^(?:sold by|seller|supplier|продавец|поставщик|магазин)\s*[:：]?\s*/i, "") || null;
    if (shopName && /^(?:contact supplier|visit store|view company|продавец|магазин)$/i.test(shopName)) shopName = null;
    const moq = query(card, profile.minimum_order) || query(card, '[class*="moq"], [class*="min-order"], [itemprop="eligibleQuantity"]');
    const minimumOrder = value(moq) || (value(card) || "").match(/(?:MOQ|min\.?\s*order(?:\s*quantity)?|minimum\s*order(?:\s*quantity)?|минимальн[\p{L}]*\s*заказ|мин\.?\s*заказ|起订量|起批量)\s*[:：]?\s*\d[\d.,]*(?:\s*(?:pcs|pieces?|units?|sets?|kg|шт\.?|кг|件|个|套))?/iu)?.[0] || null;
    return { title: title(card, profile), price: price(card, profile), image_url: image(card, url, profile),
      minimum_order: minimumOrder, shop_name: shopName?.slice(0, 500) || null, supplier_url: sellerUrl || null };
  }
  function identity(card, url, profile = {}) {
    if (card.matches('[itemtype*="Product"],[typeof*="Product"]')) {
      const declared = card.getAttribute("itemid") || card.getAttribute("about");
      const explicit = declared && S.productUrl(declared, url, true);
      if (explicit && !S.dangerousUrl(explicit.url)) return { ...explicit, identity_type: S.productUrl(explicit.url) ? "marketplace-id" : "url" };
    }
    const metadataId = card.getAttribute("data-offer-id") || card.getAttribute("data-offerid") || (card.getAttribute("data-renderkey") || "").match(/_(\d{6,})$/)?.[1];
    if (S.marketplace(url) === "1688" && /^\d+$/.test(metadataId || "")) return { id: metadataId, url: `https://detail.1688.com/offer/${metadataId}.html`, identity_type: "marketplace-id" };
    const href = link(card, url, profile);
    if (href) return { ...S.productUrl(href, url, true), identity_type: S.productUrl(href, url) ? "marketplace-id" : "url" };
    const native = card.getAttribute("data-product-id") || card.getAttribute("data-sku") || value(query(card, '[itemprop="sku"],[itemprop="productID"]'));
    const data = fields(card, url, profile);
    if (!native && (!data.title || !data.image_url || !data.price)) return null;
    return { id: native ? `native:${S.digest(String(native))}` : `card:${S.digest([S.site(url), data.title, data.image_url, data.price].join("|"))}`, url: null, native_id: native || null, identity_type: native ? "native-id" : "card-fingerprint" };
  }
  function infer(doc, options = {}) {
    const { url, snapshot = false, profile = {} } = options;
    const candidates = [], seen = new Set();
    const roots = root.SupplierNavigator.scopes(doc);
    const add = (card, method, confidence) => {
      if (seen.has(card) || !root.SupplierNavigator.visible(card, snapshot) || (card.textContent || "").length > 6500 || card.closest("header,footer,form")) return;
      seen.add(card);
      const base = S.webUrl(card.ownerDocument.URL) ? card.ownerDocument.URL : url;
      const data = fields(card, base, profile.fields);
      if (!data.title) return;
      const offer = identity(card, base, profile.fields); if (!offer) return;
      if (method === "repeated-card-structure" && !data.price && !S.productUrl(offer.url)) return;
      const strongLinks = new Set(nodes(card, 'a[href]').map(node => S.productUrl(node.getAttribute("href"), url)?.url).filter(Boolean));
      if (strongLinks.size > 1) return;
      candidates.push({ anchor: card, offer, fields: data, method, confidence });
    };
    if (profile.card_selector) for (const node of root.SupplierNavigator.resolve(doc, profile.card_selector)) add(node, "learned-card", 95);
    for (const scope of roots) {
      for (const node of scope.querySelectorAll('[itemtype*="Product"], [data-product-id], [data-sku]')) add(node, "semantic-card", 95);
      for (const parent of [scope, ...scope.querySelectorAll("*")]) {
        if (candidates.length >= 600) break;
        if (parent.closest?.("header,footer,form,nav") || parent.children.length < 2 || parent.children.length > 250) continue;
        const groups = new Map();
        for (const node of parent.children) {
          const signature = `${node.localName}:${[...node.children].slice(0, 4).map(child => child.localName).join(",")}`;
          if (!groups.has(signature)) groups.set(signature, []); groups.get(signature).push(node);
        }
        for (const group of groups.values()) {
          if (group.length < 2) continue;
          const priced = group.filter(node => price(node)).length;
          if (priced < 2 || priced < group.length / 2) continue;
          for (const card of group) {
            if (!image(card, url) && !query(card, 'img,[role="img"],[itemprop="name"], [itemtype*="Product"]')) continue;
            add(card, "repeated-card-structure", 80);
          }
        }
      }
    }
    // Find complete cards around links even when extra wrappers separate siblings.
    const linked = [];
    const productPath = href => /\/(?:products?|items?|p|dp|goods|sku)(?:\/|[-_])/i.test(new URL(href).pathname);
    for (const scope of roots) for (const seed of [...scope.querySelectorAll('a[href], [data-snapshot-anchor][href]')].slice(0, 1000)) {
      const base = S.webUrl(seed.ownerDocument.URL) ? seed.ownerDocument.URL : url;
      const href = S.httpUrl(seed.getAttribute("href"), base);
      if (!href || S.dangerousUrl(href) || S.canonicalUrl(href) === S.canonicalUrl(base) || seed.closest("header,footer,form,nav")) continue;
      let chosen = null;
      for (let card = seed, depth = 0; card && depth < 6; card = card.parentElement, depth++) {
        if (["BODY", "HTML", "MAIN"].includes(card.tagName) || seen.has(card) || (card.textContent || "").length > 6500) break;
        const urls = new Set(nodes(card, 'a[href], [data-snapshot-anchor][href]').filter(anchor => query(anchor, "img") || S.productUrl(anchor.getAttribute("href"), base)).map(anchor => S.canonicalUrl(anchor.getAttribute("href"), base)).filter(Boolean));
        if (urls.size > 1) break;
        const data = fields(card, base);
        if (data.title && query(card, 'img,[role="img"]') && (data.price || productPath(href) && query(card, 'h1,h2,h3,h4,[role="heading"]'))) {
          chosen = card; if (data.price) break;
        }
      }
      if (chosen && !linked.includes(chosen)) linked.push(chosen);
    }
    const shape = node => `${nodes(node, 'img,[role="img"]').length}:${nodes(node, 'h1,h2,h3,h4,[role="heading"]').length}:${nodes(node, 'a[href],[data-snapshot-anchor][href]').length}`;
    const shapes = new Map(linked.map(card => [card, shape(card)]));
    for (const card of linked) {
      const rect = card.getBoundingClientRect();
      const peers = linked.filter(other => other !== card && shapes.get(other) === shapes.get(card));
      if (!peers.length) continue;
      const aligned = !snapshot && rect.width > 80 && peers.some(other => { const next = other.getBoundingClientRect(); return next.width / rect.width > 0.65 && next.width / rect.width < 1.55 && (Math.abs(rect.left - next.left) < 20 || Math.abs(rect.top - next.top) < 20); });
      add(card, aligned ? "visual-card-layout" : "linked-card-cluster", aligned ? 82 : 78);
    }
    const ordered = candidates.sort((a, b) => b.confidence - a.confidence || Number(Boolean(b.offer.url)) - Number(Boolean(a.offer.url)) || (b.anchor.textContent || "").length - (a.anchor.textContent || "").length);
    const selected = [];
    for (const candidate of ordered) if (!selected.some(old => old.anchor.contains(candidate.anchor) || candidate.anchor.contains(old.anchor))) selected.push(candidate);
    return { candidates: selected.slice(0, 600), truncated: candidates.length >= 600 };
  }
  function sampleCard(node, url) {
    let fallback = null;
    for (let current = node, depth = 0; current && depth < 8; current = current.parentElement || current.getRootNode()?.host, depth++) {
      if (["BODY", "HTML", "MAIN"].includes(current.tagName)) break;
      const data = fields(current, url);
      const siblings = current.parentElement?.children || current.getRootNode()?.children || [];
      const siblingCount = [...siblings].filter(item => item.localName === current.localName).length;
      if (data.title && (data.image_url || data.price) && siblingCount >= 2) return current;
      if (!fallback && data.title && data.image_url && data.price && identity(current, url)) fallback = current;
    }
    return fallback;
  }
  root.SupplierGeneric = { infer, fields, identity, sampleCard, price, image };
})(globalThis);
