(function (root) {
  "use strict";
  // Serialized by chrome.scripting into MAIN. No closure, eval, getters, network
  // interception or whole-store return: only whitelisted business fields leave it.
  function readPageState(options = {}) {
    const products = [], pagination = [], seen = new WeakSet(), queue = [];
    let visited = 0, truncated = false;
    const deadline = Date.now() + 90;
    const own = (object, key) => { try { return Object.getOwnPropertyDescriptor(object, key)?.value; } catch { return undefined; } };
    const pick = (object, keys) => { for (const key of keys) { const value = own(object, key); if (value !== undefined && value !== null) return value; } };
    const scalar = value => typeof value === "string" ? value.trim().slice(0, 2000) || null : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
    const identifier = value => typeof value === "number" && !Number.isSafeInteger(value) ? null : scalar(value);
    const quantity = value => { if (!value || typeof value !== "object") return scalar(value); const amount = scalar(own(value, "minValue") ?? own(value, "value")), unit = scalar(own(value, "unitText") ?? own(value, "unitCode")); return amount ? [amount, unit].filter(Boolean).join(" ") : null; };
    const safeUrl = value => { if (typeof value !== "string" || !value.trim()) return null; try { const url = new URL(value, location.href); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } };
    if (options.payload && typeof options.payload === "object") queue.push({ value: options.payload, path: "response" });
    for (const key of options.onlyPayload ? [] : ["__INITIAL_STATE__", "__PRELOADED_STATE__", "__NEXT_DATA__", "__NUXT__", "__APP_DATA__", "__INIT_DATA__", "__APOLLO_STATE__"]) {
      const value = own(window, key); if (value && typeof value === "object") queue.push({ value, path: key });
    }
    // React/Vue props are a fallback for pages that do not expose a root store.
    let componentsRead = Boolean(options.onlyPayload);
    function appendComponentData() {
    const roots = [document];
    for (let index = 0; index < roots.length && index < 30; index++) {
      for (const node of [...roots[index].querySelectorAll("*")].slice(0, 1800)) {
        if (Date.now() > deadline) { truncated = true; break; }
        if (node.shadowRoot) roots.push(node.shadowRoot);
        let keys; try { keys = Object.getOwnPropertyNames(node); } catch { continue; }
        for (const key of keys) {
          if (/^__reactProps\$/.test(key)) queue.push({ value: own(node, key), path: "react.props" });
          if (key === "__vueParentComponent") { const instance = own(node, key); queue.push({ value: own(instance, "props"), path: "vue.props" }, { value: own(instance, "setupState"), path: "vue.state" }); }
          if (key === "__vue__") queue.push({ value: own(own(node, key), "_data"), path: "vue.data" });
        }
      }
    }
    }
    while ((queue.length || !componentsRead) && visited < 8000 && products.length < 600) {
      if (Date.now() > deadline) { truncated = true; break; }
      if (!queue.length) { componentsRead = true; appendComponentData(); if (!queue.length) break; }
      const { value, path } = queue.pop();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
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
      const explicit = [].concat(type || []).includes("Product");
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
      let descriptors; try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { continue; }
      for (const [key, descriptor] of Object.entries(descriptors).slice(0, 300)) {
        if (/(?:token|password|secret|credential|cookie|session|authorization|userProfile|address|cart|checkout)/i.test(key)) continue;
        if (descriptor.value && typeof descriptor.value === "object") queue.push({ value: descriptor.value, path: `${path}.${key}`.slice(-200) });
      }
    }
    return { products, pagination: pagination.slice(0, 30), diagnostics: { visited, truncated: truncated || queue.length > 0 } };
  }
  root.SupplierPageData = { readPageState };
})(globalThis);
