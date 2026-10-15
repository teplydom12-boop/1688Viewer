(function (root) {
  "use strict";
  const S = root.SupplierCollector || (typeof require === "function" ? require("./shared.js") : null);
  const unknown = "Поставщик неизвестен";
  function source(item) { return item.source || S.site(item.product_url || item.source_page_url); }
  function offerKey(item) {
    const site = source(item), url = S.webUrl(item.product_url) ? S.canonicalUrl(item.product_url) : null;
    return site + ":" + (String(site).startsWith("web:") && url ? url : item.product_id || url || item.stage2_row_id);
  }
  function evidence(item, method = "saved-results") {
    let url = S.webUrl(item.supplier_url) ? S.supplierUrl(item.supplier_url, undefined, String(source(item)).startsWith("web:")) : null;
    if (url && (url === S.canonicalUrl(item.product_url) || url === S.canonicalUrl(item.source_page_url) || ["1688", "alibaba", "made-in-china"].includes(source(item)) && S.marketplace(url) !== source(item))) url = null;
    const id = S.text(String(item.supplier_id ?? ""));
    return { source: source(item), supplier_id: id, shop_name: S.text(item.shop_name), supplier_url: url, method, checked_at: item.detail_checked_at || item.collected_at || null };
  }
  function combine(items) {
    const ids = new Set(items.map(item => item.supplier_id).filter(Boolean)), urls = new Set(items.map(item => item.supplier_url).filter(Boolean));
    if (ids.size > 1 || urls.size > 1) return null;
    return { ...items[0], supplier_id: [...ids][0] || null, supplier_url: [...urls][0] || null, shop_name: items.find(item => item.shop_name)?.shop_name || null };
  }
  const identified = item => Boolean(item.supplier_id || item.supplier_url);
  // A reliable storefront is enough for contacting the seller. A missing display
  // name alone must not trigger another product-page visit.
  const complete = item => Boolean(item.supplier_url);
  function aliases(rows) {
    const byUrl = new Map();
    for (const row of rows) {
      const e = row.supplier;
      if (!e.supplier_url || !e.supplier_id) continue;
      const key = e.source + ":url:" + e.supplier_url;
      if (!byUrl.has(key)) byUrl.set(key, new Set());
      byUrl.get(key).add(e.supplier_id);
    }
    return byUrl;
  }
  function identity(item, byUrl) {
    if (item.supplier_id) return item.source + ":id:" + item.supplier_id;
    if (!item.supplier_url) return null;
    const key = item.source + ":url:" + item.supplier_url, ids = byUrl.get(key);
    return ids?.size === 1 ? item.source + ":id:" + [...ids][0] : key;
  }
  function reuse(rows, cache = {}) {
    const offers = new Map();
    for (const row of rows) {
      const key = offerKey(row);
      if (!offers.has(key)) offers.set(key, []);
      offers.get(key).push(row);
    }
    for (const [key, members] of offers) {
      const cached = Object.hasOwn(cache, key) ? cache[key] : null;
      const merged = combine([...members.map(row => row.supplier), ...(cached ? [cached] : [])]);
      for (const row of members) {
        row.supplier_conflict = !merged;
        if (merged) row.supplier = { ...row.supplier, ...merged, method: cached ? "saved-card-check" : row.supplier.method, checked_at: cached?.checked_at || merged.checked_at };
      }
    }
    const byUrl = aliases(rows), groups = new Map();
    for (const row of rows) {
      const key = identity(row.supplier, byUrl);
      if (!key || row.supplier_conflict) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const members of groups.values()) {
      const merged = combine(members.map(row => row.supplier));
      if (merged) for (const row of members) row.supplier = { ...row.supplier, ...merged };
    }
    return rows;
  }
  function rowsFromTasks(tasks, cache) {
    return reuse(tasks.flatMap(task => (task.products || []).map((item, index) => ({ ...item,
      stage2_row_id: task.id + ":" + index, source_task_id: task.id, source_task_name: task.query || task.id,
      supplier: evidence(item)
    }))), cache);
  }
  function queue(rows) {
    const groups = new Map(), byUrl = aliases(rows);
    for (const row of rows) {
      if (!row.supplier_conflict && complete(row.supplier)) continue;
      if (!S.webUrl(row.product_url) || S.dangerousUrl(row.product_url)) continue;
      const offer = offerKey(row), owner = !row.supplier_conflict && identity(row.supplier, byUrl);
      const key = owner || "offer:" + offer;
      if (!groups.has(key)) groups.set(key, { key, offer_key: offer, product_url: row.product_url, title: row.title || row.product_id || row.product_url, query: row.query || null, row_id: row.stage2_row_id });
    }
    return [...groups.values()];
  }
  function needsCheck(rows, entry) {
    const row = rows.find(item => item.stage2_row_id === entry.row_id);
    return Boolean(row && (row.supplier_conflict || !complete(row.supplier)));
  }
  function matchDetail(entry, rows, products) {
    const target = rows.find(row => row.stage2_row_id === entry.row_id);
    if (!target) return null;
    const matches = products.filter(item => source(item) === source(target) && (offerKey(item) === offerKey(target) || S.webUrl(item.product_url) && S.canonicalUrl(item.product_url) === S.canonicalUrl(target.product_url)));
    if (!matches.length) return null;
    return combine(matches.map(item => evidence(item, "product-page")));
  }
  function applyDetail(rows, entry, found, checkedAt) {
    const target = rows.find(row => row.stage2_row_id === entry.row_id);
    if (!target) return rows;
    const byUrl = aliases(rows), owner = !target.supplier_conflict && identity(target.supplier, byUrl);
    for (const row of rows) {
      const exact = offerKey(row) === entry.offer_key;
      const related = owner && !row.supplier_conflict && identity(row.supplier, byUrl) === owner;
      if (!exact && !related) continue;
      if (exact) { row.supplier_check = found && identified(found) ? "identified" : "unknown"; row.supplier_checked_at = checkedAt; }
      if (!found || !identified(found)) continue;
      const merged = combine([row.supplier, found]);
      if (exact) {
        row.supplier = { ...(merged || found), method: "product-page", checked_at: checkedAt };
        row.supplier_conflict = false;
      } else if (merged) row.supplier = { ...merged, method: "shared-supplier-identity", checked_at: checkedAt };
    }
    return rows;
  }
  function report(job) {
    const rows = job.products, byUrl = aliases(rows), groups = new Map(), unresolved = [];
    for (const row of rows) {
      const key = !row.supplier_conflict && identity(row.supplier, byUrl);
      if (!key) { unresolved.push(row); continue; }
      if (!groups.has(key)) groups.set(key, { key, source: row.supplier.source, supplier_id: row.supplier.supplier_id, shop_name: row.supplier.shop_name || (row.supplier.supplier_url ? new URL(row.supplier.supplier_url).hostname : "Поставщик " + row.supplier.supplier_id), supplier_url: row.supplier.supplier_url, status: "identified", products: [] });
      groups.get(key).products.push(row);
    }
    const suppliers = [...groups.values()];
    if (unresolved.length) suppliers.push({ key: "unknown", source: null, supplier_id: null, shop_name: unknown, supplier_url: null, status: "unknown", products: unresolved });
    const unique = products => new Set(products.map(offerKey)).size;
    for (const supplier of suppliers) { supplier.unique_offers = unique(supplier.products); supplier.duplicate_cards = supplier.products.length - supplier.unique_offers; }
    const uniqueOffers = unique(rows);
    return { schema_version: 1, report_type: "supplier_search", job_id: job.id, status: job.status, started_at: job.started_at, finished_at: job.finished_at || null,
      source_tasks: job.source_tasks, sources: [...new Set(rows.map(source))], total_cards: rows.length, unique_offers: uniqueOffers, duplicate_cards: rows.length - uniqueOffers,
      total_suppliers: groups.size, unknown_cards: unresolved.length, unknown_unique_offers: unique(unresolved), card_checks: { planned: job.queue.length, opened: job.opened_keys.length, checked: job.checked_count, processed: job.cursor, skipped: job.skipped_count || 0 },
      suppliers, products: rows, scope: "only_cards_from_selected_tasks" };
  }
  const api = { unknown, offerKey, evidence, identified, complete, rowsFromTasks, queue, reuse, needsCheck, matchDetail, applyDetail, report };
  root.SupplierSearchCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
