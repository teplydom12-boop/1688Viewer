(function (root) {
  "use strict";

  function text(value) {
    if (typeof value !== "string") return null;
    return value.replace(/\s+/g, " ").trim() || null;
  }

  function isMarketplaceUrl(value) {
    return Boolean(marketplace(value));
  }
  function quantity(value) {
    const scalar = input => typeof input === "number" && Number.isFinite(input) ? String(input) : text(input);
    if (!value || typeof value !== "object") return scalar(value);
    const amount = scalar(value.minValue ?? value.value), unit = scalar(value.unitText ?? value.unitCode);
    return amount ? [amount, unit].filter(Boolean).join(" ") : null;
  }

  function webUrl(value) {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
  }
  function site(value) {
    if (!webUrl(value)) return null;
    return marketplace(value) || `web:${new URL(value).host.toLowerCase()}`;
  }
  function originPattern(value) { const url = new URL(value); return `${url.protocol}//${url.hostname}/*`; }
  function digest(value) {
    let hash = 14695981039346656037n;
    for (const char of value) { hash ^= BigInt(char.codePointAt(0)); hash = BigInt.asUintN(64, hash * 1099511628211n); }
    return hash.toString(16).padStart(16, "0");
  }
  function canonicalUrl(value, base) {
    const safe = httpUrl(value, base); if (!safe) return null;
    const url = new URL(safe);
    const stripTracking = params => { for (const key of [...params.keys()]) if (/^(?:utm_.*|spm|ref|referrer|tracking|track|from|fbclid|gclid|_ga)$/i.test(key)) params.delete(key); params.sort(); };
    if (/^#!?\//.test(url.hash)) {
      const route = new URL(url.hash.replace(/^#!?/, ""), url.origin); stripTracking(route.searchParams);
      url.hash = `${url.hash.startsWith("#!") ? "!" : ""}${route.pathname}${route.search}`;
    } else url.hash = "";
    stripTracking(url.searchParams);
    url.searchParams.sort(); return url.href;
  }
  function dangerousUrl(value) {
    try { const url = new URL(value); const route = /^#!?\//.test(url.hash) ? new URL(url.hash.replace(/^#!?/, ""), url.origin) : null; return /(?:^|\/)(?:cart|checkout|buy|payment|logout|signout|delete|remove|login|signin|register|account)(?:\/|$)/i.test(url.pathname + (route ? "/" + route.pathname : "")) || /(?:action|do)=(?:delete|remove|logout|buy|checkout)/i.test(url.search + (route?.search || "")); } catch { return true; }
  }

  function marketplace(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return null;
      for (const [domain, source] of [["1688.com", "1688"], ["alibaba.com", "alibaba"], ["made-in-china.com", "made-in-china"]]) {
        if (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) return source;
      }
      return null;
    } catch { return null; }
  }

  function productUrl(value, base, generic = false) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, base);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      const source = marketplace(`https://${url.hostname}/`);
      if (source === "1688" && ["detail.1688.com", "m.1688.com"].includes(url.hostname)) {
        const match = url.pathname.match(/^\/offer\/(\d+)(?:\.html)?\/?$/);
        if (match) return { id: match[1], url: `https://detail.1688.com/offer/${match[1]}.html` };
      }
      if (source === "alibaba") {
        const match = url.pathname.match(/^\/product(?:-detail)?\/(?:.*_)?(\d+)\.html\/?$/);
        if (match) return { id: match[1], url: `https://${url.hostname}${url.pathname}` };
      }
      if (source === "made-in-china") {
        const match = url.pathname.match(/\/product\/([^/]+)\/[^/]+\.html\/?$/) || url.pathname.match(/\/product-detail-([^/.]+)\.html$/);
        if (match) return { id: match[1], url: `https://${url.hostname}${url.pathname}` };
      }
      if (generic && !dangerousUrl(url.href)) {
        const canonical = canonicalUrl(url.href);
        if (canonical) return { id: `url:${digest(canonical)}`, url: canonical };
      }
      return null;
    } catch { return null; }
  }

  function supplierUrl(value, base, generic = false) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, base);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      const source = marketplace(`https://${url.hostname}/`);
      if (source === "alibaba" && /^[a-z0-9-]+\.en\.alibaba\.com$/.test(url.hostname)) return `https://${url.hostname}/`;
      if (source === "made-in-china" && /^[a-z0-9-]+\.en\.made-in-china\.com$/.test(url.hostname)) return `https://${url.hostname}/`;
      if (source !== "1688" || !url.hostname.endsWith(".1688.com")) return generic && !dangerousUrl(url.href) ? canonicalUrl(url.href) : null;
      const subdomain = url.hostname.slice(0, -9);
      if (!subdomain || ["s", "detail", "m", "www", "login", "passport", "air", "offer", "search", "imgsearch", "image", "sale", "dj", "rule", "fuwu", "cart", "trade", "work", "buy", "club", "view", "payments"].includes(subdomain)) return null;
      // A company subdomain identifies the storefront; discard tracking and page paths.
      return `https://${url.hostname}/`;
    } catch { return null; }
  }

  function httpUrl(value, base) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, base);
      url.username = ""; url.password = "";
      return ["https:", "http:"].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function detectSearch(urlValue, label, inputValue) {
    const url = new URL(urlValue);
    const imageSearch = /image|imgsearch|youyuan/i.test(url.pathname) ||
      [...url.searchParams.keys()].some(key => /^(imageAddress|imageId|imageUrl|imagePath|imageBase64|imgUrl)$/i.test(key));
    let query = text(label);
    if (!query) {
      for (const key of ["keywords", "keyword", "q", "SearchText", "word", "query"]) {
        query = text(url.searchParams.get(key));
        // Some 1688 links still encode keywords in GBK rather than UTF-8.
        if (query?.includes("\uFFFD")) query = text(inputValue);
        if (query) break;
      }
    }
    if (!query && !imageSearch) query = text(inputValue);
    return { query, search_type: imageSearch ? "image" : query ? "text" : "unknown" };
  }

  function mergeProducts(existing, incoming) {
    const map = new Map(existing.map(item => [`${item.source}:${item.product_id}`, { ...item }]));
    for (const item of incoming) {
      const key = `${item.source}:${item.product_id}`;
      const old = map.get(key);
      const merged = old ? { ...old } : { ...item };
      if (old) {
        for (const [field, value] of Object.entries(item)) {
          const samePass = old.last_seen_at === (item.last_seen_at || item.collected_at);
          const weaker = samePass && (old.field_confidence?.[field] || 0) > (item.field_confidence?.[field] || 0);
          if (value !== null && value !== "" && value !== undefined && !["collected_at", "sightings", "field_sources", "field_confidence"].includes(field) && !weaker) merged[field] = value;
        }
      }
      merged.field_sources = { ...(old?.field_sources || {}) };
      merged.field_confidence = { ...(old?.field_confidence || {}) };
      for (const [field, method] of Object.entries(item.field_sources || {})) {
        const samePass = old?.last_seen_at === (item.last_seen_at || item.collected_at);
        if (item[field] != null && (!samePass || (item.field_confidence?.[field] || 0) >= (old?.field_confidence?.[field] || 0))) {
          merged.field_sources[field] = method;
          merged.field_confidence[field] = item.field_confidence?.[field] || 0;
        }
      }
      merged.last_seen_at = item.last_seen_at || item.collected_at;
      const initialSightings = old ? old.sightings || [{
        query: old.query, search_type: old.search_type, source_page_url: old.source_page_url
      }] : [];
      const sightings = [...initialSightings, ...(item.sightings || [{
        query: item.query,
        search_type: item.search_type,
        source_page_url: item.source_page_url
      }])];
      merged.sightings = [...new Map(sightings.map(sighting => [JSON.stringify(sighting), sighting])).values()];
      map.set(key, merged);
    }
    return [...map.values()];
  }

  function fingerprint(products) {
    return [...new Set(products.map(item => `${item.source}:${item.product_id}`))].sort().join(",");
  }

  function supplierGroups(products) {
    const parent = new Map();
    const find = value => {
      if (!parent.has(value)) parent.set(value, value);
      if (parent.get(value) !== value) parent.set(value, find(parent.get(value)));
      return parent.get(value);
    };
    const aliases = item => { const url = supplierUrl(item.supplier_url, undefined, String(item.source).startsWith("web:")); return [item.supplier_id && `${item.source}:id:${item.supplier_id}`, url && `${item.source}:url:${url}`].filter(Boolean); };
    for (const item of products) {
      const keys = aliases(item);
      if (keys.length === 2) parent.set(find(keys[1]), find(keys[0]));
    }
    const groups = new Map();
    const unresolved = [];
    for (const item of products) {
      const keys = aliases(item);
      if (!keys.length) { unresolved.push(item); continue; }
      const key = find(keys[0]);
      if (!groups.has(key)) groups.set(key, { key, source: item.source, supplier_id: item.supplier_id || null, shop_name: null, supplier_url: null, products: [] });
      const group = groups.get(key);
      group.shop_name ||= item.shop_name;
      group.supplier_url ||= item.supplier_url;
      group.products.push(item);
    }
    return { suppliers: [...groups.values()], unresolved };
  }

  function csv(products) {
    const fields = ["source", "supplier_id", "shop_name", "supplier_url", "product_id", "title", "product_url", "price", "minimum_order", "query"];
    const escape = value => {
      let string = String(value ?? "");
      if (/^[\s]*[=+@-]/.test(string) || /^[\t\r]/.test(string)) string = "'" + string;
      return '"' + string.replace(/"/g, '""') + '"';
    };
    return "\uFEFF" + [fields.map(escape).join(","), ...products.map(item => fields.map(field => escape(item[field])).join(","))].join("\r\n");
  }

  function importProducts(input) {
    if (!input || !Array.isArray(input.products) || input.products.length > 10000) throw new Error("Нужен JSON с массивом products (не больше 10 000 товаров).");
    return input.products.map(item => {
      const generic = String(item?.source || "").startsWith("web:");
      const offer = productUrl(item?.product_url, undefined, generic);
      const source = site(item?.product_url) || (generic ? site(item.source_page_url) : null);
      const noLink = !item?.product_url && /^(?:native|card):[a-zA-Z0-9:_-]+$/.test(String(item?.product_id)) && site(item?.source_page_url);
      const actualSource = source || (noLink ? site(item.source_page_url) : null);
      if ((!offer && !noLink) || !actualSource || (item.source && item.source !== actualSource)) throw new Error("В файле обнаружена неверная ссылка или площадка товара.");
      const result = { source: actualSource, product_id: offer?.id || item.product_id, product_url: offer?.url || null };
      for (const field of ["title", "shop_name", "price", "minimum_order", "query", "search_type", "supplier_id"]) result[field] = text(item[field])?.slice(0, 1000) || null;
      result.supplier_url = supplierUrl(item.supplier_url, undefined, generic);
      result.image_url = httpUrl(item.image_url);
      result.source_page_url = webUrl(item.source_page_url) ? item.source_page_url : result.product_url;
      result.identity_type = text(item.identity_type) || (generic ? noLink ? "card-fingerprint" : "url" : "marketplace-id");
      result.native_id = text(item.native_id)?.slice(0, 1000) || null;
      result.extraction_confidence = Math.min(100, Math.max(0, Number(item.extraction_confidence) || 0));
      if (Array.isArray(item.data_conflicts)) result.data_conflicts = item.data_conflicts.filter(conflict => conflict?.field === "price" && Array.isArray(conflict.observations)).slice(0, 1).map(conflict => ({ field: "price", observations: conflict.observations.slice(0, 8).map(observation => ({ value: text(observation?.value)?.slice(0, 1000) || "", method: text(observation?.method)?.slice(0, 100) || "" })).filter(observation => observation.value) }));
      result.collected_at = Number.isNaN(Date.parse(item.collected_at)) ? new Date().toISOString() : item.collected_at;
      result.last_seen_at = result.collected_at;
      if (!Number.isNaN(Date.parse(item.last_seen_at))) result.last_seen_at = item.last_seen_at;
      if (item.field_sources && typeof item.field_sources === "object") {
        result.field_sources = {};
        result.field_confidence = {};
        for (const field of ["title", "price", "minimum_order", "shop_name", "supplier_url", "supplier_id", "image_url"]) if (text(item.field_sources[field])) result.field_sources[field] = text(item.field_sources[field]).slice(0, 100);
        for (const field of Object.keys(result.field_sources)) if (Number.isFinite(item.field_confidence?.[field])) result.field_confidence[field] = Math.min(100, Math.max(0, item.field_confidence[field]));
      }
      result.sightings = [{ query: result.query, search_type: result.search_type, source_page_url: result.source_page_url }];
      return result;
    });
  }

  const api = { text, quantity, marketplace, isMarketplaceUrl, webUrl, site, originPattern, digest, canonicalUrl, dangerousUrl, productUrl, supplierUrl, httpUrl, detectSearch, mergeProducts, fingerprint, supplierGroups, csv, importProducts };
  root.SupplierCollector = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
