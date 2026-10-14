(function () {
  "use strict";
  // Optional, local observation of responses the page already requested.
  // Never issue requests or return raw bodies/headers/cookies to the extension.
  if (window.__supplierResponseObservation) return;
  const state = { enabled: false, blocked: false, epoch: 0, readers: new Set(), products: [], pagination: [], truncated: false, responses: 0, challenge: false };
  Object.defineProperty(window, "__supplierResponseObservation", { value: state, configurable: true });
  document.addEventListener("supplier-response-control", event => { if (!state.blocked && event.detail?.enabled === true && !state.enabled) { state.taskId = event.detail.taskId; state.enabled = true; state.epoch++; } });
  const maximumBytes = 2 * 1024 * 1024;
  const privateUrl = url => /\/(?:login|signin|auth|session|account|cart|checkout|captcha|verify)(?:\/|\?|$)/i.test(String(url || ""));
  function retain(payload) {
    if (!state.enabled) return;
    if (payload?.captcha_required === true || payload?.isCaptcha === true || [].concat(payload?.ret || payload?.code || []).some(value => /FAIL_SYS_USER_VALIDATE|RGV587_ERROR|NEED_CAPTCHA|captcha_required/i.test(String(value)))) state.challenge = true;
    const result = window.SupplierPageData.readPageState({ payload, onlyPayload: true });
    const products = new Map((result.products.length >= 2 ? [] : state.products).map(item => [item.url || item.productId, item]));
    for (const product of result.products) products.set(product.url || product.productId, product);
    state.products = [...products.values()].slice(-600);
    // Latest response's pagination replaces older search checkpoints.
    if (result.pagination.length) state.pagination = result.pagination;
    state.truncated ||= result.diagnostics.truncated || products.size > 600;
    state.responses++;
  }
  async function observe(response) {
    if (!state.enabled || privateUrl(response.url) || !/json/i.test(response.headers.get("content-type") || "")) return;
    if (state.readers.size >= 4) { state.truncated = true; return; }
    if (Number(response.headers.get("content-length")) > maximumBytes) { state.truncated = true; return; }
    const clone = response.clone(), reader = clone.body?.getReader(); if (!reader) return;
    state.readers.add(reader);
    const decoder = new TextDecoder(), epoch = state.epoch; let text = "", bytes = 0;
    try {
      while (state.enabled) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maximumBytes) { state.truncated = true; void reader.cancel().catch(() => {}); return; }
        text += decoder.decode(chunk.value, { stream: true });
      }
      if (!state.enabled || epoch !== state.epoch) { void reader.cancel().catch(() => {}); return; }
      text += decoder.decode(); retain(JSON.parse(text));
    } finally { state.readers.delete(reader); reader.releaseLock(); }
  }
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const result = originalFetch.apply(this, args);
    return result && typeof result.then === "function" ? result.then(response => { if (state.enabled) void observe(response).catch(() => {}); return response; }) : result;
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("loadend", () => {
      if (!state.enabled || privateUrl(this.responseURL) || !/json/i.test(this.getResponseHeader("content-type") || "")) return;
      try {
        if (this.responseType === "json") retain(this.response);
        else if (this.responseType === "" || this.responseType === "text") {
          if (this.responseText.length > maximumBytes) { state.truncated = true; return; }
          retain(JSON.parse(this.responseText));
        }
      } catch { /* binary responses and malformed JSON do not affect the page */ }
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
