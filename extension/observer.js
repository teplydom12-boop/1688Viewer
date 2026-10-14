(function (root) {
  "use strict";
  function watch(doc, sample, check) {
    const observed = new Map(); let timer = null, fault = null, stopped = false, lastChange = Date.now(), samples = 0;
    const flush = () => {
      timer = null; if (stopped || fault) return;
      try { check(); attach(); sample(); samples++; } catch (error) { fault = error; }
    };
    const changed = () => { lastChange = Date.now(); if (!timer && !stopped) timer = setTimeout(flush, 35); };
    function attach() {
      for (const scope of root.SupplierNavigator.scopes(doc)) if (!observed.has(scope)) {
        const observer = new MutationObserver(changed); observer.observe(scope, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["href", "src", "data-src", "data-price", "class", "hidden", "aria-hidden", "aria-busy"] });
        observed.set(scope, observer);
      }
    }
    attach();
    return {
      async wait({ minMs = 250, maxMs = 1500, quietMs = 200 } = {}) {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
          check(); if (fault) throw fault; attach();
          const busy = root.SupplierNavigator.scopes(doc).some(scope => [...scope.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(node => root.SupplierNavigator.visible(node, false)));
          if (Date.now() - start >= minMs && Date.now() - lastChange >= quietMs && !busy) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (fault) throw fault; check(); flush(); if (fault) throw fault;
      },
      stats: () => ({ observed_roots: observed.size, mutation_samples: samples }),
      stop() { stopped = true; if (timer) clearTimeout(timer); for (const observer of observed.values()) observer.disconnect(); }
    };
  }
  root.SupplierObserver = { watch };
})(globalThis);
