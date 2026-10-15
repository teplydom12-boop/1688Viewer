(function (root) {
  "use strict";
  // Serialized by chrome.scripting into MAIN. No closure, eval, getters, network
  // interception or whole-store return: only whitelisted business fields leave it.
  function readPageState(options = {}) {
    const products = [], pagination = [], seen = new WeakSet(), queue = [], priority = [], reasons = new Set();
    let visited = 0, head = 0, priorityHead = 0, componentsLimited = false, componentNodes = 0;
    const deadline = Date.now() + 150, maximumRecords = 2000;
    const pending = () => queue.length - head + priority.length - priorityHead;
    const important = /^(?:products?|offers?|items?|results?|records?|goods|list|data|props|children|payload|pagin\w*|pageInfo)$/i;
    const privateKey = /token|password|secret|credential|cookie|session|authorization|userProfile|address|cart|checkout|^_(?:owner|store|debugInfo|debugOwner)$/i;
    const enqueue = (value, path, urgent = false, arrayEntry = false) => { if (value && typeof value === "object") { if (pending() >= 20000) reasons.add("queue"); else (urgent ? priority : queue).push({ value, path, arrayEntry }); } };
    const own = (object, key) => { if (object == null || typeof object !== "object" && typeof object !== "function") return undefined; try { return Object.getOwnPropertyDescriptor(object, key)?.value; } catch { return undefined; } };
    const pick = (object, keys) => { for (const key of keys) { const value = own(object, key); if (value !== undefined && value !== null) return value; } };
    const scalar = value => typeof value === "string" ? value.trim().slice(0, 2000) || null : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
    const identifier = value => typeof value === "number" && !Number.isSafeInteger(value) ? null : scalar(value);
    const quantity = value => { if (!value || typeof value !== "object") return scalar(value); const amount = scalar(own(value, "minValue") ?? own(value, "value")), unit = scalar(own(value, "unitText") ?? own(value, "unitCode")); return amount ? [amount, unit].filter(Boolean).join(" ") : null; };
    const safeUrl = value => { if (typeof value !== "string" || !value.trim()) return null; try { const url = new URL(value, location.href); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } };
    if (options.payload && typeof options.payload === "object") enqueue(options.payload, "response", true);
    for (const key of options.onlyPayload ? [] : ["__INITIAL_STATE__", "__PRELOADED_STATE__", "__NEXT_DATA__", "__NUXT__", "__APP_DATA__", "__INIT_DATA__", "__APOLLO_STATE__"]) {
      enqueue(own(window, key), key, true);
    }
    // React/Vue props are a fallback for pages that do not expose a root store.
    let componentsRead = Boolean(options.onlyPayload);
    function* componentCandidates() {
      const roots = [document], nodes = new WeakSet();
      for (let index = 0; index < roots.length && index < 30; index++) {
        const scope = roots[index];
        for (const seed of scope.querySelectorAll('[data-product-id],[data-offer-id],[data-renderkey],[class*="product-card"],[class*="offer-card"]')) {
          for (let node = seed, depth = 0; node && depth < 3; node = node.parentElement, depth++) if (!nodes.has(node)) { nodes.add(node); yield node; }
        }
        for (const node of scope.querySelectorAll("*")) {
          if (node.shadowRoot && !roots.includes(node.shadowRoot)) roots.push(node.shadowRoot);
          if (!nodes.has(node)) { nodes.add(node); yield node; }
        }
      }
      if (roots.length > 30) componentsLimited = true;
    }
    const componentIterator = options.onlyPayload ? null : componentCandidates();
    function appendComponentData() {
      for (let count = 0; count < 128; count++) {
        if (Date.now() > deadline || componentNodes >= 6000) { componentsLimited = true; componentsRead = true; break; }
        const next = componentIterator.next(); if (next.done) { componentsRead = true; break; }
        const node = next.value; componentNodes++;
        let keys; try { keys = Object.getOwnPropertyNames(node); } catch { continue; }
        for (const key of keys) {
          if (/^__reactProps\$/.test(key)) enqueue(own(node, key), "react.props", true);
          if (key === "__vueParentComponent") { const instance = own(node, key); enqueue(own(instance, "props"), "vue.props", true); enqueue(own(instance, "setupState"), "vue.state", true); }
          if (key === "__vue__") enqueue(own(own(node, key), "_data"), "vue.data", true);
        }
      }
    }
    while ((pending() || !componentsRead) && visited < 20000 && products.length < maximumRecords) {
      if (Date.now() > deadline) { if (pending()) reasons.add("time"); else if (!componentsRead) componentsLimited = true; break; }
      if (!pending()) { appendComponentData(); if (!pending()) continue; }
      const { value, path, arrayEntry } = priorityHead < priority.length ? priority[priorityHead++] : queue[head++];
      const repeated = seen.has(value); if (repeated && !arrayEntry) continue;
      seen.add(value); visited++;
      const type = own(value, "@type");
      const title = scalar(pick(value, ["name", "title", "subject", "productName", "productTitle", "offerTitle"]));
      const url = safeUrl(pick(value, ["url", "productUrl", "detailUrl", "offerUrl", "detail_url", "product_url"]));
      const id = identifier(pick(value, ["offerId", "offerID", "productId", "productID", "product_id", "sku"]));
      const strongId = identifier(pick(value, ["offerId", "offerID", "productId", "productID", "product_id"]));
      const offer = own(value, "offers"); const firstOffer = Array.isArray(offer) ? own(offer, "0") : offer;
      const image = pick(value, ["image", "imageUrl", "picUrl", "image_url", "mainImage"]);
      const firstImage = Array.isArray(image) ? own(image, "0") : image;
      const imageUrl = safeUrl(typeof firstImage === "object" ? pick(firstImage, ["url", "src"]) : firstImage);
      const price = scalar(pick(firstOffer, ["price", "lowPrice"]) ?? pick(value, ["price", "salePrice", "offerPrice", "minPrice"]));
      const explicit = type === "Product" || Array.isArray(type) && Array.from({ length: Math.min(8, own(type, "length") || 0) }, (_, index) => own(type, String(index))).includes("Product");
      if ((explicit || strongId && (title || price || imageUrl) || id && title && (price || imageUrl) || title && url && imageUrl && price) && (url || id || explicit)) {
        const seller = pick(firstOffer, ["seller"]) || pick(value, ["seller", "supplier", "company", "shop"]) || {};
        products.push({ "@type": "Product", name: title?.slice(0, 500) || null, url, productId: id, image: imageUrl,
          price, currency: scalar(pick(firstOffer, ["priceCurrency"]) || pick(value, ["currency", "priceCurrency"])),
          companyName: scalar(pick(seller, ["name", "legalName", "companyName", "shopName"]) || pick(value, ["companyName", "shopName", "supplierName"])),
          companyUrl: safeUrl(pick(seller, ["url", "companyUrl", "shopUrl"]) || pick(value, ["companyUrl", "shopUrl", "supplierUrl"])),
          memberId: identifier(pick(seller, ["memberId", "id", "supplierId"]) || pick(value, ["memberId", "loginId", "supplierId"])),
          minimumOrderQuantity: quantity(pick(value, ["minimumOrderQuantity", "minOrder", "moq"])) });
      }
      if (/pagin|pager|pageInfo/i.test(path)) {
        const next = safeUrl(pick(value, ["nextPageUrl", "next_page_url", "nextUrl"]));
        const hasNext = pick(value, ["hasNextPage", "hasMore", "has_next"]);
        const current = pick(value, ["currentPage", "pageNo", "pageNum"]);
        if (next || typeof hasNext === "boolean" || Number.isSafeInteger(current)) pagination.push({ nextPageUrl: next, hasNextPage: typeof hasNext === "boolean" ? hasNext : null, currentPage: Number.isSafeInteger(current) ? current : null });
      }
      if (repeated) continue;
      const array = Array.isArray(value); let keys;
      try { keys = array ? Array.from({ length: Math.min(5000, own(value, "length") || 0) }, (_, index) => String(index)) : Object.getOwnPropertyNames(value).filter(key => !privateKey.test(key)); } catch { continue; }
      if (array && (own(value, "length") || 0) > 5000) reasons.add("children");
      if (!array) { const preferred = keys.filter(key => important.test(key)); keys = [...preferred, ...keys.filter(key => !important.test(key))]; if (keys.length > 1000) { reasons.add("children"); keys = keys.slice(0, 1000); } }
      for (const key of keys) {
        if (privateKey.test(key)) continue;
        enqueue(own(value, key), (path + "." + key).slice(-200), array || important.test(key), array);
      }
    }
    if (pending()) reasons.add(products.length >= maximumRecords ? "records" : visited >= 20000 ? "nodes" : "time");
    return { products, pagination: pagination.slice(0, 30), diagnostics: { visited, truncated: reasons.size > 0, truncation_reasons: [...reasons], component_discovery_limited: componentsLimited, component_nodes: componentNodes, maximum_records: maximumRecords } };
  }
  root.SupplierPageData = { readPageState };
})(globalThis);
