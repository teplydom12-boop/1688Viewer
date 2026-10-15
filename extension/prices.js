(function (root) {
  "use strict";
  function number(value) {
    let text = value.replace(/[\s\u00a0\u202f']/g, "");
    if (!/^\d+(?:[.,]\d+)*$/.test(text)) return null;
    if (text.includes(",") && text.includes(".")) {
      const decimal = text.lastIndexOf(",") > text.lastIndexOf(".") ? "," : ".";
      text = text.replace(decimal === "," ? /\./g : /,/g, ""); if (decimal === ",") text = text.replace(",", ".");
    } else if (text.includes(",")) {
      if (/^[1-9]\d{0,2}(?:,\d{3})+$/.test(text)) text = text.replace(/,/g, "");
      else if ((text.match(/,/g) || []).length === 1) text = text.replace(",", "."); else return null;
    } else if ((text.match(/\./g) || []).length > 1) {
      if (/^\d{1,3}(?:\.\d{3})+$/.test(text)) text = text.replace(/\./g, ""); else return null;
    }
    const amount = Number(text); return Number.isFinite(amount) && amount >= 0 ? amount : null;
  }
  function parse(product) {
    const raw = typeof product === "string" ? product : product?.price;
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    const text = String(raw).trim(); if (!text || /price on request|contact.*price|цена по запросу|negotiable|面议/i.test(text)) return null;
    const codes = [...new Set((text.toUpperCase().match(/(?<![A-Z])(?:USD|CNY|RMB|EUR|GBP|RUB|JPY|INR|CAD|AUD|HKD)(?![A-Z])/g) || []).map(code => code === "RMB" ? "CNY" : code))];
    if (codes.length > 1) return null;
    if (/^(?:-\s*\d)|(?:USD|CNY|RMB|EUR|GBP|RUB|JPY|INR|[$€£¥￥₹₽])\s*-\s*\d/i.test(text)) return null;
    let currency = codes[0] || (/US\s*\$/i.test(text) ? "USD" : /€/.test(text) ? "EUR" : /£/.test(text) ? "GBP" : /₽|руб\.?/i.test(text) ? "RUB" : /₹/.test(text) ? "INR" : /[¥￥]/.test(text) ? ["1688", "alibaba", "made-in-china"].includes(product?.source) ? "CNY" : "¥" : /\$/.test(text) ? ["alibaba", "made-in-china"].includes(product?.source) ? "USD" : "$" : product?.source === "1688" ? "CNY" : "unspecified");
    const marker = text.match(/(?:US\s*\$|USD|CNY|RMB|EUR|GBP|RUB|JPY|INR|CAD|AUD|HKD|[$€£¥￥₹₽])/i);
    const after = marker ? text.slice(marker.index + marker[0].length) : text;
    const pattern = /\d[\d\s\u00a0\u202f'.,]*/;
    const first = after.match(pattern) || text.match(pattern); if (!first) return null;
    const amount = number(first[0].trim()); if (amount == null) return null;
    const tail = after.slice((first.index || 0) + first[0].length);
    const range = tail.match(/^\s*(?:[-–—~]|至)\s*(?:(?:US\s*\$|USD|CNY|RMB|EUR|GBP|RUB|JPY|INR|[$€£¥￥₹₽])\s*)?(\d[\d\s\u00a0\u202f'.,]*)/i);
    const other = range && number(range[1].trim());
    return { amount: other == null ? amount : Math.min(amount, other), currency, range: Boolean(range), text };
  }
  function compare(a, b, direction = "price-asc") {
    if (!a || !b) return a ? -1 : b ? 1 : 0;
    if (a.currency !== b.currency) return a.currency.localeCompare(b.currency, "en");
    return (direction === "price-desc" ? -1 : 1) * (a.amount - b.amount);
  }
  function sort(products, direction = "original") {
    if (direction === "original") return [...products];
    return products.map((product, index) => ({ product, index, price: parse(product) })).sort((a, b) => compare(a.price, b.price, direction) || a.index - b.index).map(item => item.product);
  }
  function minimum(products) {
    const prices = products.map(parse).filter(Boolean), currencies = new Set(prices.map(price => price.currency));
    if (currencies.size !== 1) return null;
    return prices.reduce((best, price) => !best || price.amount < best.amount ? price : best, null);
  }
  const api = { parse, compare, sort, minimum };
  root.SupplierPrices = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
