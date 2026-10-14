(function (root) {
  "use strict";

  function text(value) {
    if (typeof value !== "string") return null;
    return value.replace(/\s+/g, " ").trim() || null;
  }

  function isMarketplaceUrl(value) {
    return Boolean(marketplace(value));
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

  function productUrl(value, base) {
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
      return null;
    } catch { return null; }
  }

  function supplierUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      const source = marketplace(`https://${url.hostname}/`);
      if (source === "alibaba" && /^[a-z0-9-]+\.en\.alibaba\.com$/.test(url.hostname)) return `https://${url.hostname}/`;
      if (source === "made-in-china" && /^[a-z0-9-]+\.en\.made-in-china\.com$/.test(url.hostname)) return `https://${url.hostname}/`;
      if (source !== "1688" || !url.hostname.endsWith(".1688.com")) return null;
      const subdomain = url.hostname.slice(0, -9);
      if (!subdomain || ["s", "detail", "m", "www", "login", "passport", "air", "offer", "search", "imgsearch", "image", "sale", "dj", "rule", "fuwu", "cart", "trade", "work", "buy", "club", "view", "payments"].includes(subdomain)) return null;
      // A company subdomain identifies the storefront; discard tracking and page paths.
      return `https://${url.hostname}/`;
    } catch { return null; }
  }

  function httpUrl(value, base) {
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
          if (value !== null && value !== "" && value !== undefined && !["collected_at", "sightings", "field_sources"].includes(field)) merged[field] = value;
        }
      }
      merged.field_sources = { ...(old?.field_sources || {}), ...(item.field_sources || {}) };
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
    const aliases = item => { const url = supplierUrl(item.supplier_url); return [item.supplier_id && `${item.source}:id:${item.supplier_id}`, url && `${item.source}:url:${url}`].filter(Boolean); };
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
      const offer = productUrl(item.product_url);
      const source = marketplace(item.product_url);
      if (!offer || !source || (item.source && item.source !== source)) throw new Error("В файле обнаружена неверная ссылка или площадка товара.");
      const result = { source, product_id: offer.id, product_url: offer.url };
      for (const field of ["title", "shop_name", "price", "minimum_order", "query", "search_type", "supplier_id"]) result[field] = text(item[field])?.slice(0, 1000) || null;
      result.supplier_url = supplierUrl(item.supplier_url);
      result.image_url = httpUrl(item.image_url);
      result.source_page_url = isMarketplaceUrl(item.source_page_url) ? item.source_page_url : result.product_url;
      result.collected_at = Number.isNaN(Date.parse(item.collected_at)) ? new Date().toISOString() : item.collected_at;
      result.last_seen_at = result.collected_at;
      if (!Number.isNaN(Date.parse(item.last_seen_at))) result.last_seen_at = item.last_seen_at;
      if (item.field_sources && typeof item.field_sources === "object") {
        result.field_sources = {};
        for (const field of ["title", "price", "minimum_order", "shop_name", "supplier_url", "supplier_id"]) if (text(item.field_sources[field])) result.field_sources[field] = text(item.field_sources[field]).slice(0, 100);
      }
      result.sightings = [{ query: result.query, search_type: result.search_type, source_page_url: result.source_page_url }];
      return result;
    });
  }

  const api = { text, marketplace, isMarketplaceUrl, productUrl, supplierUrl, httpUrl, detectSearch, mergeProducts, fingerprint, supplierGroups, csv, importProducts };
  root.SupplierCollector = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
