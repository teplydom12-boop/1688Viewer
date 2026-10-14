(function (root) {
  "use strict";
  const S = root.SupplierCollector;
  const ANCHORS = 'a[href], [data-snapshot-anchor][href]';
  const normalizedClass = node => String(node.className || "").toLowerCase().replace(/[-_]/g, "");
  const classNodes = (node, patterns) => [...node.querySelectorAll("[class]")].filter(item => patterns.some(pattern => normalizedClass(item).includes(pattern)));
  const text = node => node ? S.text(node.getAttribute("content") || node.textContent) : null;
  const usefulName = value => {
    const name = S.text(value);
    return name && !/^(查看详情|立即购买|详情|购买|进店|进入店铺|联系卖家|店铺|旺铺|contact supplier|visit store|view details|company profile)$/i.test(name) && !/^[¥￥$\d\s.,~–\-/元件个]+$/.test(name) ? name.slice(0, 500) : null;
  };
  const CARD_PATTERN = /(?:offer(?:card|item)|searchofferwrapper|i18ncardwrap|productcard|productitem|productlistitem|listitem|searchcard)/;

  function shown(node, snapshot) {
    if (!node || node.closest('[hidden], [aria-hidden="true"]')) return false;
    if (snapshot) return !node.closest('[style*="display: none"], [style*="display:none"]');
    const view = node.ownerDocument.defaultView;
    if (!view || !node.isConnected) return false;
    const style = view.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && node.getClientRects().length > 0;
  }

  function renderKey(node) {
    const key = node.getAttribute("data-renderkey") || "";
    const id = key.match(/_(\d{6,})$/)?.[1];
    const supplier = key.match(/_((?:b2b-)[a-zA-Z0-9-]+)_\d+$/)?.[1] || null;
    return id ? { id, supplier_id: supplier } : null;
  }

  function idsIn(node, url) {
    return new Set([...node.querySelectorAll(ANCHORS)].map(anchor => linkOffer(anchor, url)?.id).filter(Boolean));
  }

  function linkOffer(anchor, base) {
    const direct = S.productUrl(anchor.getAttribute("href"), base);
    if (direct) return direct;
    try {
      const url = new URL(anchor.getAttribute("href"), base);
      const id = url.searchParams.get("offerId");
      // Find Similar links remain attached to a product even when nested-anchor HTML is repaired.
      if (S.marketplace(url.href) === "1688" && /^\d+$/.test(id || "") && /findsimilar|i18ncardwrap/.test(normalizedClass(anchor))) return { id, url: `https://detail.1688.com/offer/${id}.html` };
    } catch { /* not a URL */ }
    return null;
  }

  function cardFor(node, offer, url) {
    let selected = node;
    for (let depth = 0, current = node; current && depth < 7; depth++, current = current.parentElement) {
      if (["BODY", "HTML", "MAIN"].includes(current.tagName)) break;
      if (idsIn(current, url).size > 1) break;
      if ((current.textContent || "").length > 6000) break;
      selected = current;
      if (CARD_PATTERN.test(normalizedClass(current)) || current.hasAttribute("data-renderkey") || current.hasAttribute("data-offer-id")) return current;
    }
    return selected;
  }

  function firstText(nodes, snapshot) {
    for (const node of nodes) if (shown(node, snapshot)) {
      const value = usefulName(node.getAttribute("title")) || usefulName(text(node));
      if (value) return value;
    }
    return null;
  }

  function domFields(card, anchor, url, snapshot) {
    const title = firstText([...classNodes(card, ["offertitle", "producttitle", "titletext"]), ...card.querySelectorAll('h2, h3, [itemprop="name"], .title')], snapshot) ||
      usefulName(anchor.getAttribute("title")) || usefulName(anchor.getAttribute("data-title")) || usefulName(anchor.getAttribute("aria-label")) ||
      usefulName(anchor.querySelector("img")?.getAttribute("alt")) || (anchor.tagName === "A" || anchor.hasAttribute("data-snapshot-anchor") ? usefulName(text(anchor)) : null);
    const priceNodes = [...classNodes(card, ["pricewrap"]), ...card.querySelectorAll('[itemprop="price"], .price'), ...classNodes(card, ["offerprice", "productprice", "price"])]
      .filter(node => !/original|oldprice|freight/i.test(normalizedClass(node)));
    let price = null;
    for (const node of priceNodes) {
      if (!shown(node, snapshot)) continue;
      const value = text(node)?.replace(/\s*\.\s*/g, ".");
      if (value && /\d/.test(value) && value.length < 120) { price = value; break; }
    }
    const rawText = text(card) || "";
    price ||= rawText.match(/(?:¥|￥|US\s*\$|\$|RMB|CNY|USD)\s*\d[\d,.]*(?:\s*(?:-|~|至|–)\s*(?:¥|￥|\$)?\s*\d[\d,.]*)?/i)?.[0] || null;
    const moqNode = [...card.querySelectorAll(".moq"), ...classNodes(card, ["minorder", "startorder", "minimumorder"])].find(node => shown(node, snapshot) && /\d/.test(text(node) || ""));
    const minimumOrder = text(moqNode) || rawText.match(/(?:[≥>]\s*)?\d[\d,.]*\s*(?:件|个|套|箱|包|袋|双|台|瓶|只|千克|公斤|吨|米|码|kg|pcs)\s*(?:起批|起订|起购|起售)/i)?.[0] ||
      rawText.match(/(?:起批量|起订量|最小起订量|MOQ|min\.?\s*order|minimum order)\s*[:：]?\s*\d[\d,.]*\s*(?:件|个|套|kg|pcs|pieces?|sets?|units?)?/i)?.[0] || null;
    const supplierLink = [...card.querySelectorAll(ANCHORS)].filter(node => shown(node, snapshot))
      .map(node => ({ node, url: S.supplierUrl(node.getAttribute("href"), url) })).find(item => item.url);
    const shopName = firstText(classNodes(card, ["companyname", "shopname", "suppliername", "sellername"]), snapshot) ||
      usefulName(supplierLink?.node.getAttribute("title")) || usefulName(text(supplierLink?.node));
    const images = [...(anchor.querySelectorAll("img")), ...card.querySelectorAll("img")];
    let imageUrl = null;
    for (const image of images) {
      if (/icon|logo|divider|star/i.test(String(image.className))) continue;
      for (const value of [image.getAttribute("data-src"), image.getAttribute("data-lazy-src"), image.getAttribute("data-original"), image.currentSrc, image.getAttribute("src")]) {
        if (!value || /placeholder|transparent|loading\.gif|spacer/i.test(value)) continue;
        imageUrl = S.httpUrl(value, url);
        if (imageUrl) break;
      }
      if (imageUrl) break;
    }
    return { title, price, minimum_order: minimumOrder, shop_name: shopName, supplier_url: supplierLink?.url || null, image_url: imageUrl };
  }

  function structuredRecords(doc, url) {
    const records = [];
    const source = S.marketplace(url);
    let inspected = 0;
    for (const script of doc.querySelectorAll('script[type="application/ld+json"], script[type="application/json"], script#__NEXT_DATA__')) {
      if (script.textContent.length > 1000000) continue;
      let parsed;
      try { parsed = JSON.parse(script.textContent); } catch { continue; }
      const stack = [parsed];
      while (stack.length && inspected++ < 10000) {
        const value = stack.pop();
        if (!value || typeof value !== "object") continue;
        if (Array.isArray(value)) { stack.push(...value); continue; }
        const type = [].concat(value["@type"] || []);
        const isProduct = type.includes("Product") || ((value.offerId || value.productId) && (value.title || value.subject || value.productName));
        if (isProduct) {
          let offer = S.productUrl(value.url || value.productUrl || value.detailUrl, url);
          const id = String(value.offerId || value.productId || "");
          if (!offer && source === "1688" && /^\d+$/.test(id)) offer = { id, url: `https://detail.1688.com/offer/${id}.html` };
          if (!offer && type.includes("Product") && value === parsed) offer = S.productUrl(url, url);
          if (offer) {
            const offers = Array.isArray(value.offers) ? value.offers[0] : value.offers;
            const seller = offers?.seller || value.seller || value.supplier || {};
            const sellerObject = typeof seller === "object" ? seller : {};
            const priceValue = offers?.price ?? offers?.lowPrice ?? value.price;
            const price = ["string", "number"].includes(typeof priceValue) && /\d/.test(String(priceValue)) ? `${offers?.priceCurrency || value.currency || ""} ${String(priceValue)}`.trim() : null;
            const identifier = sellerObject.identifier;
            const sellerId = value.memberId || value.loginId || (typeof identifier === "object" ? identifier?.value : identifier);
            records.push({ offer, fields: {
              title: S.text(value.name || value.title || value.subject || value.productName),
              price,
              minimum_order: value.minimumOrderQuantity != null ? String(value.minimumOrderQuantity) : null,
              shop_name: S.text(sellerObject.name || sellerObject.legalName || value.companyName || value.shopName),
              supplier_id: ["string", "number"].includes(typeof sellerId) ? S.text(String(sellerId)) : null,
              supplier_url: S.supplierUrl(sellerObject.url || value.companyUrl || value.shopUrl, url),
              image_url: S.httpUrl([].concat(value.image || value.imageUrl || [])[0]?.url || [].concat(value.image || value.imageUrl || [])[0], url)
            } });
          }
        }
        stack.push(...Object.values(value).filter(item => item && typeof item === "object"));
      }
    }
    return records;
  }

  function sanitizedCard(card, url) {
    const clone = card.cloneNode(true);
    clone.querySelectorAll("script, style, iframe, svg, form, input, textarea, button").forEach(node => node.remove());
    for (const node of [clone, ...clone.querySelectorAll("*")]) {
      for (const attribute of [...node.attributes]) {
        if (!["class", "title", "alt", "href", "src", "data-src", "data-original", "data-renderkey", "data-offer-id", "data-offerid", "data-product-id", "data-snapshot-anchor", "itemprop", "itemtype", "itemscope", "content"].includes(attribute.name)) node.removeAttribute(attribute.name);
        else if (["href", "src", "data-src", "data-original"].includes(attribute.name)) {
          let safe = S.httpUrl(attribute.value, url);
          if (safe && attribute.name === "href") {
            const offer = S.productUrl(safe);
            const supplier = S.supplierUrl(safe);
            if (offer) safe = offer.url;
            else if (supplier) safe = supplier;
            else { const link = new URL(safe); const id = link.searchParams.get("offerId"); link.search = ""; link.hash = ""; if (id && /^\d+$/.test(id)) link.searchParams.set("offerId", id); safe = link.href; }
          }
          if (safe) node.setAttribute(attribute.name, safe); else node.removeAttribute(attribute.name);
        }
      }
    }
    // Complete cards only: cutting HTML mid-attribute can corrupt later reanalysis.
    const html = clone.outerHTML;
    return html.length <= 20000 ? html : null;
  }

  function extract(doc, options) {
    const { url, label, mode = "search", snapshot = false, raw = true } = options;
    const source = S.marketplace(url);
    if (!source) throw new Error("Поддерживаются 1688, Alibaba и Made-in-China.");
    const queryInput = doc.querySelector('input[name="keywords"], input[name="keyword"], input[name="q"], input[name="SearchText"], #alisearch-keywords');
    const search = S.detectSearch(url, label, queryInput?.value);
    const timestamp = new Date().toISOString();
    const candidates = [];
    const structured = structuredRecords(doc, url);
    for (const record of structured) candidates.push({ ...record, method: "structured-data" });
    if (mode === "detail") {
      const offer = S.productUrl(url, url);
      if (!offer) throw new Error("Это не распознанная карточка товара.");
      const fields = domFields(doc.body, doc.body, url, snapshot);
      fields.title = S.text(doc.querySelector('meta[property="og:title"]')?.getAttribute("content")) || usefulName(text(doc.querySelector("h1"))) || fields.title;
      candidates.push({ offer, fields, method: "detail-dom" });
    } else {
      for (const node of doc.querySelectorAll("[data-renderkey], [data-offer-id], [data-offerid], [data-product-id]")) {
        if (!shown(node, snapshot)) continue;
        const metadata = source === "1688" ? renderKey(node) : null;
        const id = metadata?.id || node.getAttribute("data-offer-id") || node.getAttribute("data-offerid") || node.getAttribute("data-product-id");
        if (source === "1688" && /^\d+$/.test(id || "")) {
          candidates.push({ anchor: node, offer: { id, url: `https://detail.1688.com/offer/${id}.html` }, supplier_id: metadata?.supplier_id, method: metadata ? "1688:renderkey" : "dom-id" });
        }
      }
      for (const anchor of doc.querySelectorAll(ANCHORS)) {
        const offer = linkOffer(anchor, url);
        if (offer && shown(anchor, snapshot)) candidates.push({ anchor, offer, method: "dom-link" });
      }
    }
    const rawCards = new Map();
    let products = [];
    const currentOffer = S.productUrl(url, url);
    for (const candidate of candidates) {
      if (S.marketplace(candidate.offer.url) !== source) continue;
      if (mode === "detail" && candidate.offer.id !== currentOffer.id) continue;
      const card = candidate.anchor ? cardFor(candidate.anchor, candidate.offer, url) : null;
      const fields = candidate.fields || domFields(card, candidate.anchor, url, snapshot);
      const metadata = card && source === "1688" ? renderKey(card) : null;
      const record = {
        source, product_id: candidate.offer.id, product_url: candidate.offer.url,
        title: fields.title || null, price: fields.price || null, minimum_order: fields.minimum_order || null,
        shop_name: fields.shop_name || null, supplier_url: fields.supplier_url || null,
        supplier_id: fields.supplier_id || candidate.supplier_id || metadata?.supplier_id || null,
        image_url: fields.image_url || null, ...search, collected_at: timestamp, source_page_url: url,
        field_sources: {}
      };
      for (const [field, value] of Object.entries(record)) if (value && ["title", "price", "minimum_order", "shop_name", "supplier_url", "supplier_id"].includes(field)) record.field_sources[field] = candidate.method;
      products = S.mergeProducts(products, [record]);
      if (raw && card) {
        const html = sanitizedCard(card, url);
        const old = rawCards.get(record.product_id);
        if (html && (!old || html.length > old.html.length)) rawCards.set(record.product_id, { product_id: record.product_id, source, source_page_url: url, collected_at: timestamp, html });
      }
    }
    return { products, raw_cards: [...rawCards.values()], diagnostics: {
      engine_version: "0.2.0", source, methods: [...new Set(candidates.map(item => item.method))],
      missing_supplier_names: products.filter(item => !item.shop_name).length,
      missing_supplier_identity: products.filter(item => !item.supplier_id && !item.supplier_url).length
    } };
  }

  function reparse(cards) {
    let products = [];
    for (const card of cards) {
      if (!S.isMarketplaceUrl(card.source_page_url) || typeof card.html !== "string" || card.html.length > 20000) continue;
      products = S.mergeProducts(products, fromHTML(card.html, { url: card.source_page_url, raw: false }).products);
    }
    return products;
  }
  function fromHTML(html, options) {
    // Sites can build nested <a> elements through JS. HTML parsing would split their cards.
    // In inert snapshots keep those boundaries as spans; scripts/comments stay untouched.
    const preserved = html.replace(/<script\b[\s\S]*?<\/script\s*>|<!--[\s\S]*?-->|<a(?=[\s>])|<\/a\s*>/gi, match => /^<script|^<!--/i.test(match) ? match : /^<\/a/i.test(match) ? "</span>" : '<span data-snapshot-anchor="true"');
    const doc = new DOMParser().parseFromString(preserved, "text/html");
    return extract(doc, { ...options, snapshot: true });
  }
  root.SupplierCollectorEngine = { extract, reparse, sanitizedCard, fromHTML };
})(globalThis);
