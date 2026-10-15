(function (root) {
  "use strict";
  const S = root.SupplierCollector;
  const ANCHORS = 'a[href], [data-snapshot-anchor][href]';
  const normalizedClass = node => String(node.className || "").toLowerCase().replace(/[-_]/g, "");
  const memo = (node, key, read) => root.SupplierNavigator?.memo ? root.SupplierNavigator.memo(node, key, read) : read();
  const classNodes = (node, patterns) => memo(node, "class-nodes", () => [...node.querySelectorAll("[class]")]).filter(item => patterns.some(pattern => normalizedClass(item).includes(pattern)));
  function businessText(node) {
    if (!node) return null;
    return memo(node, "business-text", () => readBusinessText(node));
  }
  function readBusinessText(node) {
    const parts = [], walker = node.ownerDocument.createTreeWalker(node, 4, { acceptNode: child => child.parentElement?.closest("script,style,template,noscript") ? 2 : 1 });
    while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
    return S.text(parts.join(""));
  }
  const text = node => node ? S.text(node.getAttribute("content")) || businessText(node) : null;
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
    return memo(node, "offer-ids:" + url, () => new Set([...node.querySelectorAll(ANCHORS)].map(anchor => linkOffer(anchor, url)?.id).filter(Boolean)));
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
    const declared = node.closest('article,[data-offer-id],[data-offerid],[data-renderkey],[class*="product-card" i],[class*="productCard"],[class*="offer-card" i],[class*="offerCard"]');
    if (declared) { const ids = idsIn(declared, url); if (ids.size === 1 && ids.has(offer.id)) return declared; }
    let selected = node;
    for (let depth = 0, current = node; current && depth < 14; depth++, current = current.parentElement) {
      if (["BODY", "HTML", "MAIN"].includes(current.tagName)) break;
      if (idsIn(current, url).size > 1) break;
      if ((text(current) || "").length > 6000) break;
      selected = current;
      if (CARD_PATTERN.test(normalizedClass(current)) || current.hasAttribute("data-renderkey") || current.hasAttribute("data-offer-id")) return current;
      if (["ARTICLE", "LI"].includes(current.tagName)) return current;
      if (current.querySelector('.price,[itemprop="price"]') && [...(current.parentElement?.children || [])].some(peer => peer !== current && peer.tagName === current.tagName && peer.querySelector('.price,[itemprop="price"]') && idsIn(peer, url).size)) return current;
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

  function domFields(card, anchor, url, snapshot, detail = false) {
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
    const currentId = detail && S.productUrl(url)?.id;
    const belongs = node => {
      if (!currentId) return true;
      for (let parent = node; parent && parent !== card; parent = parent.parentElement) {
        if (parent.matches('article,li,[data-offer-id],[data-product-id],[data-renderkey]') || CARD_PATTERN.test(normalizedClass(parent))) {
          const ids = idsIn(parent, url); if (ids.size && !ids.has(currentId)) return false;
        }
      }
      return true;
    };
    const supplierLinks = [...card.querySelectorAll(ANCHORS)].filter(node => shown(node, snapshot) && belongs(node))
      .map(node => ({ node, url: S.supplierUrl(node.getAttribute("href"), url) })).filter(item => item.url);
    const ambiguous = detail && new Set(supplierLinks.map(item => item.url)).size > 1;
    const supplierLink = ambiguous ? null : supplierLinks[0];
    const shopName = usefulName(supplierLink?.node.getAttribute("title")) || usefulName(text(supplierLink?.node)) ||
      !ambiguous && firstText(classNodes(card, ["companyname", "shopname", "suppliername", "sellername"]).filter(belongs), snapshot);
    const imageUrl = root.SupplierGeneric.image(card, url);
    return { title, price, minimum_order: minimumOrder, shop_name: shopName, supplier_url: supplierLink?.url || null, image_url: imageUrl };
  }

  function structuredRecords(doc, url, mode = "search") {
    const records = [];
    const source = S.site(url);
    const generic = !S.marketplace(url);
    let inspected = 0;
    for (const script of doc.querySelectorAll('script[type="application/ld+json"], script[type="application/json"], script#__NEXT_DATA__')) {
      if (script.textContent.length > 1000000) continue;
      let parsed;
      try { parsed = JSON.parse(script.textContent); } catch { continue; }
      const references = new Map(), productNodes = [], pending = [parsed]; let referenceCount = 0;
      while (pending.length && referenceCount++ < 10000) { const object = pending.pop(); if (!object || typeof object !== "object") continue; if (typeof object["@id"] === "string" && Object.keys(object).length > 1) references.set(object["@id"], object); if ([].concat(object["@type"] || []).includes("Product")) productNodes.push(object); pending.push(...Object.values(object).filter(item => item && typeof item === "object")); }
      const stack = [parsed];
      while (stack.length && inspected++ < 10000) {
        const value = stack.pop();
        if (!value || typeof value !== "object") continue;
        if (Array.isArray(value)) { stack.push(...value); continue; }
        const type = [].concat(value["@type"] || []);
        const isProduct = type.includes("Product") || ((value.offerId || value.productId) && (value.title || value.subject || value.productName));
        if (isProduct) {
          const rawUrl = value.url || value.productUrl || value.detailUrl || (Array.isArray(value.offers) ? value.offers[0]?.url : value.offers?.url);
          let offer = typeof rawUrl === "string" && !rawUrl.startsWith("#") ? S.productUrl(rawUrl, url, generic) : null;
          const id = String(value.offerId || value.productId || "");
          if (!offer && source === "1688" && /^\d+$/.test(id)) offer = { id, url: `https://detail.1688.com/offer/${id}.html` };
          if (!offer && mode === "detail" && type.includes("Product") && (value === parsed || productNodes.length === 1)) offer = S.productUrl(url, url, generic);
          if (offer) {
            const offers = Array.isArray(value.offers) ? value.offers[0] : value.offers;
            const seller = offers?.seller || value.seller || value.supplier || {};
            const referenced = references.get(typeof seller === "string" ? seller : seller?.["@id"]);
            const sellerObject = typeof seller === "object" ? { ...(referenced || {}), ...seller } : referenced || {};
            const priceValue = offers?.price ?? offers?.lowPrice ?? value.price;
            const price = ["string", "number"].includes(typeof priceValue) && /\d/.test(String(priceValue)) ? `${offers?.priceCurrency || value.currency || ""} ${String(priceValue)}`.trim() : null;
            const identifier = sellerObject.identifier;
            const sellerId = value.memberId || value.loginId || (typeof identifier === "object" ? identifier?.value : identifier);
            records.push({ offer, fields: {
              title: S.text(value.name || value.title || value.subject || value.productName),
              price,
              minimum_order: S.quantity(value.minimumOrderQuantity),
              shop_name: S.text(sellerObject.name || sellerObject.legalName || value.companyName || value.shopName),
              supplier_id: ["string", "number"].includes(typeof sellerId) ? S.text(String(sellerId)) : null,
              supplier_url: S.supplierUrl(sellerObject.url || value.companyUrl || value.shopUrl, url, generic),
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
    if (S.webUrl(card.ownerDocument.URL)) url = card.ownerDocument.URL;
    const clone = card.cloneNode(true);
    const rememberedImage = root.SupplierGeneric?.image(card, url);
    if (rememberedImage) clone.setAttribute("data-image-url", rememberedImage);
    clone.querySelectorAll("script, style, iframe, svg, form, input, textarea, button").forEach(node => node.remove());
    for (const node of [clone, ...clone.querySelectorAll("*")]) {
      for (const attribute of [...node.attributes]) {
        if (!["class", "title", "alt", "href", "src", "data-src", "data-original", "data-image-url", "data-sku", "data-renderkey", "data-offer-id", "data-offerid", "data-product-id", "data-snapshot-anchor", "itemprop", "itemtype", "itemscope", "itemid", "property", "typeof", "resource", "about", "role", "aria-label", "aria-labelledby", "id", "content"].includes(attribute.name)) node.removeAttribute(attribute.name);
        else if (["href", "src", "data-src", "data-original"].includes(attribute.name)) {
          let safe = S.httpUrl(attribute.value, url);
          if (safe && attribute.name === "href") {
            const offer = S.productUrl(safe);
            const supplier = S.supplierUrl(safe);
            if (offer) safe = offer.url;
            else if (supplier) safe = supplier;
            else if (!S.marketplace(safe)) safe = S.canonicalUrl(safe);
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
    return root.SupplierNavigator?.withSample ? root.SupplierNavigator.withSample(() => extractSample(doc, options)) : extractSample(doc, options);
  }
  function extractSample(doc, options) {
    const { url, label, mode = "search", snapshot = false, raw = true, profile = {} } = options;
    const source = S.site(url);
    const generic = !S.marketplace(url);
    if (!source) throw new Error("Откройте обычный сайт с адресом HTTP или HTTPS.");
    const queryInput = doc.querySelector('input[name="keywords"], input[name="keyword"], input[name="q"], input[name="SearchText"], #alisearch-keywords, input[type="search"], [role="searchbox"]');
    const search = S.detectSearch(url, label, queryInput?.value);
    const timestamp = new Date().toISOString();
    const candidates = [];
    const scopes = root.SupplierNavigator ? root.SupplierNavigator.scopes(doc) : [doc];
    const additions = root.SupplierDataSources?.extract(doc, { ...options, mode }) || { records: [], pagination: [] };
    const structured = scopes.flatMap(scope => structuredRecords(scope, S.webUrl(scope.URL || scope.ownerDocument?.URL) ? scope.URL || scope.ownerDocument.URL : url, mode));
    for (const record of structured) candidates.push({ ...record, method: "structured-data", confidence: 100 });
    candidates.push(...additions.records);
    if (mode === "detail") {
      const offer = S.productUrl(url, url, generic);
      if (!offer) throw new Error("Это не распознанная карточка товара.");
      const primary = generic ? doc.querySelector('[itemtype*="Product"],main') || doc.body : doc.body;
      const fields = generic ? root.SupplierGeneric.fields(primary, url, profile.fields) : domFields(doc.body, doc.body, url, snapshot, true);
      fields.title = S.text(doc.querySelector('meta[property="og:title"]')?.getAttribute("content")) || usefulName(text(doc.querySelector("h1"))) || fields.title;
      if (generic && !structured.length && !additions.records.length && (!fields.title || !fields.price && !fields.image_url)) throw new Error("Не удалось подтвердить, что открытая страница содержит карточку товара.");
      candidates.push({ offer, fields, method: "detail-dom", confidence: 75 });
    } else {
      for (const node of scopes.flatMap(scope => [...scope.querySelectorAll("[data-renderkey], [data-offer-id], [data-offerid], [data-product-id]")])) {
        if (!shown(node, snapshot)) continue;
        const metadata = source === "1688" ? renderKey(node) : null;
        const id = metadata?.id || node.getAttribute("data-offer-id") || node.getAttribute("data-offerid") || node.getAttribute("data-product-id");
        if (source === "1688" && /^\d+$/.test(id || "")) {
          candidates.push({ anchor: node, offer: { id, url: `https://detail.1688.com/offer/${id}.html` }, supplier_id: metadata?.supplier_id, method: metadata ? "1688:renderkey" : "dom-id" });
        }
      }
      for (const anchor of scopes.flatMap(scope => [...scope.querySelectorAll(ANCHORS)])) {
        const offer = linkOffer(anchor, url);
        if (offer && shown(anchor, snapshot)) candidates.push({ anchor, offer, method: "dom-link" });
      }
      if (root.SupplierGeneric) {
        const nativeCards = [...new Set(candidates.filter(candidate => candidate.anchor && ["dom-link", "dom-id", "1688:renderkey"].includes(candidate.method)).map(candidate => cardFor(candidate.anchor, candidate.offer, url)).filter(node => node && (CARD_PATTERN.test(normalizedClass(node)) || node.matches("article,li,[data-offer-id],[data-renderkey]"))))];
        candidates.push(...root.SupplierGeneric.infer(doc, { url, snapshot, profile, nativeCards }).candidates);
      }
    }
    const records = [], entries = [];
    const currentOffer = S.productUrl(url, url, generic);
    const known = new Set((options.known_fingerprint || "").split(",").filter(Boolean));
    const domKeys = new Set(candidates.filter(candidate => candidate.anchor).map(candidate => `${candidate.offer.url ? S.site(candidate.offer.url) : source}:${candidate.offer.id}`));
    const hasFreshDOM = [...domKeys].some(key => !known.has(key));
    for (const candidate of candidates) {
      const key = `${candidate.offer.url ? S.site(candidate.offer.url) : source}:${candidate.offer.id}`;
      if (mode === "search" && hasFreshDOM && !candidate.anchor && known.has(key) && !domKeys.has(key)) continue;
      if (!generic && candidate.offer.url && S.marketplace(candidate.offer.url) !== source) continue;
      if (mode === "detail" && candidate.offer.id !== currentOffer.id) continue;
      const inferred = ["learned-card", "semantic-card", "repeated-card-structure", "linked-card-cluster", "visual-card-layout", "microdata", "rdfa", "microformats"].includes(candidate.method);
      const card = candidate.anchor ? inferred ? candidate.anchor : cardFor(candidate.anchor, candidate.offer, url) : null;
      const fields = candidate.fields || domFields(card, candidate.anchor, url, snapshot);
      const metadata = card && source === "1688" ? renderKey(card) : null;
      const record = {
        source: candidate.offer.url ? S.site(candidate.offer.url) : source, product_id: candidate.offer.id, product_url: candidate.offer.url,
        title: fields.title || null, price: fields.price || null, minimum_order: fields.minimum_order || null,
        shop_name: fields.shop_name || null, supplier_url: fields.supplier_url || null,
        supplier_id: fields.supplier_id || candidate.supplier_id || metadata?.supplier_id || null,
        image_url: fields.image_url || null, ...search, collected_at: timestamp, source_page_url: url,
        identity_type: candidate.offer.identity_type || (generic ? "url" : "marketplace-id"), native_id: candidate.offer.native_id || card?.getAttribute("data-product-id") || card?.getAttribute("data-sku") || null,
        extraction_confidence: candidate.confidence || 85, field_sources: {}, field_confidence: {}
      };
      for (const [field, value] of Object.entries(record)) if (value && ["title", "price", "minimum_order", "shop_name", "supplier_url", "supplier_id", "image_url"].includes(field)) { record.field_sources[field] = candidate.method; record.field_confidence[field] = candidate.confidence || 85; }
      records.push(record); entries.push({ record, card });

    }
    const aliases = new Map();
    for (const record of records) if (record.product_url && record.native_id) {
      const key = `${record.source}:${record.native_id}`; if (!aliases.has(key)) aliases.set(key, new Map()); aliases.get(key).set(record.product_url, record);
    }
    for (const record of records) if (!record.product_url && record.native_id) {
      const matches = aliases.get(`${record.source}:${record.native_id}`); if (matches?.size !== 1) continue;
      const found = [...matches.values()][0];
      record.product_id = found.product_id; record.product_url = found.product_url; record.identity_type = found.identity_type;
    }
    const products = S.mergeProducts([], records);
    const conflicting = [];
    for (const product of products) {
      const prices = records.filter(record => record.source === product.source && record.product_id === product.product_id && record.price).map(record => ({ value: record.price, method: record.field_sources.price }));
      const amount = value => value.replace(/US\s*\$|USD|EUR|GBP|RUB|CNY|RMB|INR|[$€£¥￥₹₽]|руб\.?|\s/gi, "").replace(/(\.\d*?[1-9])0+$|\.0+$/g, "$1");
      const currencies = prices.map(price => price.value.match(/\b(?:USD|EUR|GBP|RUB|CNY|INR|JPY)\b/i)?.[0]?.toUpperCase()).filter(Boolean);
      if (new Set(prices.map(price => amount(price.value))).size > 1 || new Set(currencies).size > 1) {
        product.data_conflicts = [{ field: "price", observations: [...new Map(prices.map(price => [price.method + price.value, price])).values()].slice(0, 8) }];
        conflicting.push(product.product_id);
      }
    }
    // Sources describing the same DOM card supply fields to one appearance.
    // Equal IDs in disjoint DOM cards remain separate, including different prices.
    const domGroups = new Map(), dataGroups = new Map();
    for (const entry of entries) {
      const key = `${entry.record.source}:${entry.record.product_id}`;
      if (entry.card) {
        if (!domGroups.has(entry.card)) domGroups.set(entry.card, new Map());
        const group = domGroups.get(entry.card);
        if (!group.has(key)) group.set(key, []); group.get(key).push(entry.record);
      } else {
        if (!dataGroups.has(key)) dataGroups.set(key, new Map());
        const methods = dataGroups.get(key), method = Object.values(entry.record.field_sources)[0] || "data";
        if (!methods.has(method)) methods.set(method, []); methods.get(method).push(entry.record);
      }
    }
    const occurrences = [];
    for (const [node, group] of domGroups) for (const [key, values] of group) {
      const supplements = [...(dataGroups.get(key)?.values() || [])].flat();
      const merged = S.mergeProducts([], [...supplements, ...values])[0];
      // A value actually shown on this card takes precedence over a different
      // appearance of the same offer in JSON or another card.
      const shown = S.mergeProducts([], values)[0];
      for (const field of ["title", "price", "minimum_order", "shop_name", "supplier_url", "supplier_id", "image_url"]) {
        if (shown[field] != null) { merged[field] = shown[field]; merged.field_sources[field] = shown.field_sources[field]; merged.field_confidence[field] = shown.field_confidence[field]; }
      }
      occurrences.push({ record: merged, node });
    }
    for (const [key, methods] of dataGroups) {
      // Use one representation rather than multiplying a list by the number of
      // readers (JSON-LD, hydration and page state can describe the same list).
      const primary = [...methods.values()].reverse().sort((a, b) => b.length - a.length || (b[0]?.extraction_confidence || 0) - (a[0]?.extraction_confidence || 0))[0];
      const remaining = [...primary];
      for (const visible of occurrences.filter(item => item.node && `${item.record.source}:${item.record.product_id}` === key)) {
        const amount = value => String(value || "").replace(/[^\d.,-]/g, "");
        const match = remaining.findIndex(item => visible.record.price && amount(item.price) === amount(visible.record.price));
        if (remaining.length) remaining.splice(match < 0 ? 0 : match, 1);
      }
      for (const record of remaining) occurrences.push({ record: { ...record }, node: null });
    }
    const ranks = new Map(), cards = [], occurrenceRaw = [];
    for (const { record, node } of occurrences) {
      const key = `${record.source}:${record.product_id}`;
      const position = node && ["aria-posinset", "data-index", "data-item-index", "data-renderkey"].map(attr => node.getAttribute(attr)).find(Boolean);
      const slot = `${key}:${position ? `position:${position}` : "occurrence"}`, rank = (ranks.get(slot) || 0) + 1; ranks.set(slot, rank);
      const pageCardKey = `${slot}:${rank}`;
      const item = { ...record, page_card_key: pageCardKey, card_index: cards.length + 1 };
      cards.push(item);
      if (raw) occurrenceRaw.push({ product_id: item.product_id, source: item.source, page_card_key: pageCardKey, source_page_url: url, collected_at: timestamp, html: node ? sanitizedCard(node, url) || "" : "", record: item });
    }
    return { products, cards, raw_cards: occurrenceRaw, diagnostics: {
      engine_version: "0.12.0", source, methods: [...new Set(candidates.map(item => item.method))], expected_page_size: expectedPageSize(doc, url), page_context: mode === "search" ? pageContext(doc, url) : null,
      data_truncated: Boolean(additions.truncated), data_truncation_reasons: additions.truncation_reasons || [], component_discovery_limited: additions.component_discovery_limited || false, pagination: additions.pagination,
      price_conflicts: conflicting.length,
      inferred_cards: products.filter(item => item.extraction_confidence < 90).length, no_detail_links: products.filter(item => !item.product_url).length,
      missing_supplier_names: products.filter(item => !item.shop_name).length,
      missing_supplier_identity: products.filter(item => !item.supplier_id && !item.supplier_url).length
    } };
  }
  function expectedPageSize(doc, url) {
    const sizes = [];
    const add = value => { const size = Number(value); if (Number.isInteger(size) && size >= 1 && size <= 1000) sizes.push(size); };
    for (const [key, value] of new URL(url).searchParams) if (/^(?:page[_-]?size|per[_-]?page|itemsPerPage)$/i.test(key)) add(value);
    for (const scope of root.SupplierNavigator.scopes(doc)) {
      for (const node of scope.querySelectorAll('[data-page-size],[data-page_size],select[name="pageSize"],select[name="page_size"]')) add(node.getAttribute("data-page-size") || node.getAttribute("data-page_size") || node.value);
      if (S.marketplace(url) === "1688") for (const node of [...scope.querySelectorAll("[data-renderkey]")].slice(0, 80)) {
        for (const attr of node.attributes) { const size = attr.value.match(/(?:^|[\^&])page_size@(\d+)(?:\^|$)/); if (size) add(size[1]); }
      }
    }
    return sizes.length && new Set(sizes).size === 1 ? sizes[0] : null;
  }
  function pageContext(doc, url) {
    const address = new URL(url);
    let urlPage = null;
    for (const [key, value] of address.searchParams) if (/^(?:beginPage|page|pageNo|pageNum|currentPage)$/i.test(key) && /^\d+$/.test(value) && Number(value) >= 1) { urlPage = Number(value); break; }
    const pages = [];
    for (const scope of root.SupplierNavigator.scopes(doc)) {
      if (S.marketplace(url) === "1688") for (const node of [...scope.querySelectorAll("[data-renderkey]")].slice(0, 80)) {
        for (const attr of node.attributes) { const found = attr.value.match(/(?:^|[\^&])page_num@(\d+)(?:\^|$)/); if (found && Number(found[1]) >= 1) { pages.push(Number(found[1])); break; } }
      }
    }
    if (!pages.length) for (const scope of root.SupplierNavigator.scopes(doc)) for (const node of scope.querySelectorAll('[aria-current="page"]')) {
      if (node.closest('nav,[class*="pagin"],[class*="pager"]') && /^\d+$/.test(text(node) || "")) pages.push(Number(text(node)));
    }
    const frequencies = new Map(); for (const page of pages) frequencies.set(page, (frequencies.get(page) || 0) + 1);
    const ranked = [...frequencies].sort((a, b) => b[1] - a[1]);
    const rendered = ranked[0]?.[0] || null, mixed = ranked.length > 1 && ranked[0][1] / pages.length < 0.9;
    return { url_page: urlPage, rendered_page: rendered, mixed, mismatch: urlPage != null && rendered != null && urlPage !== rendered };
  }

  function reparse(cards) {
    const products = [];
    for (const card of cards) {
      if (!S.webUrl(card.source_page_url) || typeof card.html !== "string" || card.html.length > 20000) continue;
      let appearance = card.html ? fromHTML(card.html, { url: card.source_page_url, raw: false, profile: { card_selector: "body > *" } }).products : [];
      if (card.record) try { appearance = S.mergeProducts(appearance, S.importProducts({ products: [card.record] }).filter(item => item.product_id === card.product_id && item.source === card.source)); } catch { /* malformed imported business record */ }
      for (const item of appearance) products.push({ ...item, ...Object.fromEntries(["observation_id", "page_card_key", "task_id", "checkpoint_id", "page_index", "card_index", "capture_status"].filter(field => card[field] != null).map(field => [field, card[field]])) });
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
  root.SupplierCollectorEngine = { extract, reparse, sanitizedCard, fromHTML, expectedPageSize, pageContext };
})(globalThis);
