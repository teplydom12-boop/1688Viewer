(function (root) {
  "use strict";
  const S = root.SupplierCollector;
  const scalar = value => typeof value === "string" ? S.text(value) : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  const idText = value => typeof value === "number" && !Number.isSafeInteger(value) ? null : scalar(value);
  const pick = (value, keys) => keys.map(key => value?.[key]).find(item => item !== undefined && item !== null);
  const privateKey = /token|password|secret|credential|cookie|session|authorization|userProfile|address|cart|checkout/i;

  function normalize(value, options) {
    const { url, mode = "search" } = options;
    const source = S.site(url), generic = !S.marketplace(url);
    const type = [].concat(value["@type"] || []);
    const title = scalar(pick(value, ["name", "title", "subject", "productName", "productTitle", "offerTitle"]));
    const id = idText(pick(value, ["offerId", "offerID", "productId", "productID", "product_id", "sku"]));
    const offers = Array.isArray(value.offers) ? value.offers[0] : value.offers;
    const rawUrl = pick(value, ["url", "productUrl", "detailUrl", "offerUrl", "detail_url", "product_url"]) || offers?.url;
    let offer = S.productUrl(rawUrl, url, generic);
    if (mode === "search" && generic && offer?.url === S.canonicalUrl(url)) offer = null;
    if (!offer && source === "1688" && /^\d+$/.test(id || "")) offer = { id, url: `https://detail.1688.com/offer/${id}.html` };
    if (!offer && mode === "detail" && type.includes("Product")) offer = S.productUrl(url, url, generic);
    if (!offer && id && (title || type.includes("Product"))) offer = { id: `native:${S.digest(id)}`, native_id: id, url: null, identity_type: "native-id" };
    if (offer && id) offer.native_id = id;
    const priceValue = scalar(offers?.price ?? offers?.lowPrice ?? pick(value, ["price", "salePrice", "offerPrice", "minPrice"]));
    const currency = scalar(offers?.priceCurrency || value.currency || value.priceCurrency);
    const price = priceValue && /\d/.test(priceValue) ? currency && !priceValue.toUpperCase().includes(currency.toUpperCase()) && !/[$€£¥￥₹₽]/.test(priceValue) ? `${currency} ${priceValue}` : priceValue : null;
    const image = [].concat(value.image || value.imageUrl || value.picUrl || value.image_url || value.mainImage || [])[0];
    const imageUrl = S.httpUrl(typeof image === "object" ? image?.url || image?.src : image, url);
    if (!offer || !title && !type.includes("Product") || (!type.includes("Product") && !id && !(imageUrl && price && offer.url))) return null;
    const seller = offers?.seller || value.seller || value.supplier || value.company || value.shop || {};
    const identifier = seller.identifier;
    return { offer, fields: { title: title?.slice(0, 500) || null, price, image_url: imageUrl,
      minimum_order: S.quantity(value.minimumOrderQuantity ?? value.minOrder ?? value.moq),
      shop_name: scalar(seller.name || seller.legalName || value.companyName || value.shopName || value.supplierName)?.slice(0, 500) || null,
      supplier_url: S.supplierUrl(seller.url || value.companyUrl || value.shopUrl || value.supplierUrl, url, generic),
      supplier_id: idText(value.memberId || value.loginId || value.supplierId || (typeof identifier === "object" ? identifier?.value : identifier)) } };
  }

  function walk(data, options, method, confidence) {
    const records = [], pagination = [], reasons = new Set(), seen = new WeakSet(), stack = [{ value: data, path: "" }]; let inspected = 0;
    while (stack.length && inspected++ < 20000 && records.length < 2000) {
      const { value, path } = stack.pop(); if (!value || typeof value !== "object") continue;
      if (seen.has(value)) continue; seen.add(value);
      if (!Array.isArray(value)) {
        const record = normalize(value, options); if (record) records.push({ ...record, method, confidence });
        if (/pagin|pager|pageInfo/i.test(path)) {
          const next = value.nextPageUrl || value.next_page_url || value.nextUrl;
          if (typeof next === "string" || typeof value.hasNextPage === "boolean" || typeof value.hasMore === "boolean") pagination.push({ nextPageUrl: next, hasNextPage: value.hasNextPage ?? value.hasMore, currentPage: value.currentPage ?? value.pageNo ?? value.pageNum });
        }
      }
      const keys = Object.keys(value).filter(key => !privateKey.test(key) && !/^_(?:owner|store|debugInfo|debugOwner)$/.test(key));
      const important = key => /^(?:products?|offers?|items?|results?|records?|list|data|props|children|payload|pagin\w*)$/i.test(key);
      keys.sort((a, b) => Number(important(a)) - Number(important(b)));
      const maximum = Array.isArray(value) ? 5000 : 1000;
      if (keys.length > maximum) reasons.add("children");
      for (const key of keys.slice(-maximum)) { const child = Object.getOwnPropertyDescriptor(value, key)?.value; if (child && typeof child === "object") stack.push({ value: child, path: `${path}.${key}`.slice(-200) }); }
    }
    if (stack.length) reasons.add(records.length >= 2000 ? "records" : "nodes");
    return { records, pagination, truncated: reasons.size > 0, truncation_reasons: [...reasons] };
  }

  function jsonPrefix(text, offset) {
    let start = offset; while (/\s/.test(text[start] || "") && start < text.length) start++;
    if (!["{", "["].includes(text[start])) return null;
    let depth = 0, quoted = false, escape = false;
    for (let index = start; index < text.length && index - start < 1000000; index++) {
      const char = text[index];
      if (quoted) { if (escape) escape = false; else if (char === "\\") escape = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") { if (--depth === 0) { try { return JSON.parse(text.slice(start, index + 1)); } catch { return null; } } }
    }
    return null;
  }
  function readProperty(scope, name, rdfa = false) {
    const selector = rdfa ? "[property]" : `[itemprop~="${name}"], [itemprop$="/${name}"]`;
    return [...scope.querySelectorAll(selector)].find(node => {
      if (rdfa && !(node.getAttribute("property") || "").split(/\s+/).some(token => token === name || token.endsWith(":" + name) || token.endsWith("/" + name))) return false;
      const owner = node.parentElement?.closest(rdfa ? "[typeof]" : "[itemscope]");
      return !owner || owner === scope || /^(?:price|lowPrice|priceCurrency|seller|eligibleQuantity)$/.test(name) && /Offer/.test(owner.getAttribute(rdfa ? "typeof" : "itemtype") || "");
    });
  }
  function property(node) { return node && (node.getAttribute("content") || node.getAttribute("href") || node.getAttribute("resource") || node.getAttribute("src") || node.getAttribute("datetime") || S.text(node.textContent)); }
  function semantic(scope, options, rdfa = false) {
    const records = [];
    for (const node of scope.querySelectorAll(rdfa ? "[typeof]" : "[itemscope][itemtype]")) {
      if (!(node.getAttribute(rdfa ? "typeof" : "itemtype") || "").split(/\s+/).some(token => /(?:^|[/#:])Product$/.test(token))) continue;
      const read = name => property(readProperty(node, name, rdfa));
      const sellerNode = readProperty(node, "seller", rdfa);
      const quantity = readProperty(node, "eligibleQuantity", rdfa);
      const minimumOrder = quantity ? property(readProperty(quantity, "minValue", rdfa)) || property(readProperty(quantity, "value", rdfa)) : null;
      const unit = quantity ? property(readProperty(quantity, "unitText", rdfa)) || property(readProperty(quantity, "unitCode", rdfa)) : null;
      const sellerRead = name => sellerNode && property(readProperty(sellerNode, name, rdfa));
      const data = { "@type": "Product", name: read("name"), url: read("url") || node.getAttribute("itemid") || node.getAttribute("about"), image: read("image"), sku: read("sku") || read("productID"),
        offers: { price: read("price") || read("lowPrice"), priceCurrency: read("priceCurrency"), seller: sellerNode ? { name: sellerRead("name"), url: sellerRead("url") || sellerNode.getAttribute("resource") || sellerNode.getAttribute("href"), identifier: sellerRead("identifier") } : null }, minimumOrderQuantity: minimumOrder ? { minValue: minimumOrder, unitText: unit } : read("eligibleQuantity") };
      const record = normalize(data, options);
      if (record) records.push({ ...record, anchor: node, method: rdfa ? "rdfa" : "microdata", confidence: 98 });
    }
    return records;
  }
  function microformats(scope, options) {
    const records = [];
    for (const node of scope.querySelectorAll(".h-product")) {
      const val = selector => property(node.querySelector(selector));
      const record = normalize({ "@type": "Product", name: val(".p-name"), url: val(".u-url"), image: val(".u-photo"), price: val(".p-price"), sku: val(".p-identifier") }, options);
      if (record) records.push({ ...record, anchor: node, method: "microformats", confidence: 98 });
    }
    return records;
  }
  function metadata(doc, options) {
    if (options.mode !== "detail") return [];
    const get = key => doc.querySelector(`meta[property="${key}"],meta[name="${key}"]`)?.getAttribute("content");
    const amount = get("product:price:amount") || get("og:price:amount");
    if (!amount && !/^product/i.test(get("og:type") || "")) return [];
    const record = normalize({ "@type": "Product", name: get("og:title"), url: options.url, image: get("og:image"), offers: { price: amount, priceCurrency: get("product:price:currency") || get("og:price:currency") } }, options);
    return record ? [{ ...record, method: "open-graph", confidence: 95 }] : [];
  }
  function extract(doc, options = {}) {
    const records = [], pagination = [], truncationReasons = new Set(); let truncated = false;
    const add = result => { records.push(...result.records); pagination.push(...result.pagination); truncated ||= result.truncated; for (const reason of result.truncation_reasons || []) truncationReasons.add(reason); };
    for (const scope of root.SupplierNavigator.scopes(doc)) {
      const location = scope.URL || scope.ownerDocument?.URL;
      const scopedOptions = { ...options, url: S.webUrl(location) ? location : options.url };
      records.push(...semantic(scope, scopedOptions), ...semantic(scope, scopedOptions, true), ...microformats(scope, scopedOptions));
      for (const script of scope.querySelectorAll("script:not([src])")) {
        if (script.textContent.length > 1000000 || /ld\+json|application\/json/i.test(script.type) || script.id === "__NEXT_DATA__") continue;
        const pattern = /(?:window\.|globalThis\.)?__(?:INITIAL_STATE|PRELOADED_STATE|NEXT_DATA|NUXT|APP_DATA|INIT_DATA|APOLLO_STATE)__\s*=\s*/g;
        for (const match of script.textContent.matchAll(pattern)) { const parsed = jsonPrefix(script.textContent, match.index + match[0].length); if (parsed) add(walk(parsed, options, "hydration-json", 95)); }
      }
      for (const node of scope.querySelectorAll("[data-product], [data-props], [data-json]")) for (const key of ["data-product", "data-props", "data-json"]) {
        const text = node.getAttribute(key); if (!text || text.length > 100000) continue;
        try { add(walk(JSON.parse(text), options, "embedded-json", 95)); } catch { /* no JS execution */ }
      }
    }
    for (const item of options.pageData?.products || []) {
      const record = normalize(item, options); if (record) records.push({ ...record, method: "page-state", confidence: 95 });
    }
    for (const item of options.pageData?.responses || []) { const record = normalize(item, options); if (record) records.push({ ...record, method: "observed-response", confidence: 95 }); }
    pagination.push(...(options.pageData?.pagination || []));
    records.push(...metadata(doc, options));
    for (const reason of options.pageData?.diagnostics?.truncation_reasons || []) truncationReasons.add(reason);
    return { records, pagination: cleanPagination(pagination, options.url), truncated: truncated || options.pageData?.diagnostics?.truncated || false, truncation_reasons: [...truncationReasons], component_discovery_limited: options.pageData?.diagnostics?.component_discovery_limited || false };
  }
  function cleanPagination(items, url) {
    return items.slice(0, 30).map(item => {
      const href = S.httpUrl(item.nextPageUrl, url);
      const next = href && !S.dangerousUrl(href) && !S.productUrl(href) && !/\/(?:api|graphql)\/|\.json(?:$|\?)/i.test(href) ? href : null;
      return { nextPageUrl: next, hasNextPage: typeof item.hasNextPage === "boolean" ? item.hasNextPage : null, currentPage: Number.isSafeInteger(item.currentPage) ? item.currentPage : null };
    });
  }
  root.SupplierDataSources = { extract, normalize, walk, cleanPagination };
})(globalThis);
