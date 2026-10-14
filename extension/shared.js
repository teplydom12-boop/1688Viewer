(function (root) {
  "use strict";

  function text(value) {
    if (typeof value !== "string") return null;
    return value.replace(/\s+/g, " ").trim() || null;
  }

  function isMarketplaceUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" &&
        (url.hostname === "1688.com" || url.hostname.endsWith(".1688.com"));
    } catch { return false; }
  }

  function productUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      if (!["detail.1688.com", "m.1688.com"].includes(url.hostname)) return null;
      const match = url.pathname.match(/^\/offer\/(\d+)(?:\.html)?\/?$/);
      if (!match) return null;
      return { id: match[1], url: `https://detail.1688.com/offer/${match[1]}.html` };
    } catch { return null; }
  }

  function supplierUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      if (!url.hostname.endsWith(".1688.com")) return null;
      const subdomain = url.hostname.slice(0, -9);
      if (!subdomain || ["s", "detail", "m", "www", "login", "air", "offer", "search", "imgsearch", "image", "sale"].includes(subdomain)) return null;
      // A company subdomain identifies the storefront; discard tracking and page paths.
      return `https://${url.hostname}/`;
    } catch { return null; }
  }

  function httpUrl(value, base) {
    try {
      const url = new URL(value, base);
      return ["https:", "http:"].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function detectSearch(urlValue, label, inputValue) {
    const url = new URL(urlValue);
    const imageSearch = /image|imgsearch/i.test(url.pathname) ||
      [...url.searchParams.keys()].some(key => /^(imageAddress|imageId|imageUrl|imagePath|imageBase64|imgUrl)$/i.test(key));
    let query = text(label);
    if (!query) {
      for (const key of ["keywords", "keyword", "q", "SearchText"]) {
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
          if (value !== null && value !== "" && value !== undefined && !["collected_at", "sightings"].includes(field)) merged[field] = value;
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
    return [...new Set(products.map(item => item.product_id))].sort().join(",");
  }

  const api = { text, isMarketplaceUrl, productUrl, supplierUrl, httpUrl, detectSearch, mergeProducts, fingerprint };
  root.SupplierCollector = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
