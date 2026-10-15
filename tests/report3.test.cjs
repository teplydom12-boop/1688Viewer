"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { chromium } = require("playwright-core");
const { createHarness } = require("./helpers/background-harness.cjs");
const P = require("../extension/prices.js");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });

test("history prices read marketplace ranges, decimal/group separators and currencies without comparing unlike currencies", () => {
  for (const [price, amount, currency] of [["US$1.56-3.89", 1.56, "USD"], ["USD1,000.00-2,000.00", 1000, "USD"], ["CNY¥1,997.34-5,858.87", 1997.34, "CNY"], ["1 200,50 ₽", 1200.5, "RUB"], ["1.299,99 EUR", 1299.99, "EUR"], ["5USD", 5, "USD"], ["RMB0.00", 0, "CNY"]]) {
    const result = P.parse({ price, source: "alibaba" }); assert.equal(result.amount, amount, price); assert.equal(result.currency, currency, price);
  }
  for (const price of [null, "", "Цена по запросу", "Negotiable", "USD -5", "USD 10 / EUR 9"]) assert.equal(P.parse({ price }), null);
  const products = [{ price: "¥9", source: "1688" }, { price: "¥2", source: "1688" }, { price: null, source: "1688" }], original = structuredClone(products);
  assert.deepEqual(P.sort(products, "price-desc").map(row => row.price), ["¥9", "¥2", null]); assert.deepEqual(P.sort(products, "price-asc").map(row => row.price), ["¥2", "¥9", null]); assert.deepEqual(products, original);
  assert.equal(P.minimum([{ price: "USD 2" }, { price: "CNY 10" }]), null); assert.equal(P.minimum([{ price: "CNY 100-999" }, { price: "CNY 200" }]).amount, 100);
});

async function pageFor(t) {
  const context = await browser.newContext(); t.after(() => context.close()); const page = await context.newPage();
  await page.route("**/*", route => route.request().resourceType() === "document" ? route.fulfill({ body: "<!doctype html><body></body>", contentType: "text/html" }) : route.abort());
  await page.goto("https://catalog.example/search");
  for (const file of ["shared.js", "navigation.js", "generic.js", "data-sources.js", "engine.js", "page-data.js"]) await page.addScriptTag({ path: path.join(__dirname, "../extension", file) });
  return page;
}
test("MAIN reads 850 result rows beyond the old array and record limits without getters or private fields", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    window.getterCalls = 0;
    const rows = Array.from({ length: 850 }, (_, i) => ({ productId: String(i), title: "Item " + i, url: "/items/" + i, price: "12", token: "private-marker" }));
    const payload = { irrelevant: Array.from({ length: 9000 }, () => ({ value: 1 })), products: rows, auth: { password: "private-marker" } };
    Object.defineProperty(payload, "secretGetter", { enumerable: true, get() { getterCalls++; throw new Error("getter must not run"); } });
    const data = SupplierPageData.readPageState({ payload, onlyPayload: true });
    const clean = SupplierPageData.readPageState({ payload: { products: rows }, onlyPayload: true });
    return { data, getterCalls, cleanCount: clean.products.length, cleanTruncated: clean.diagnostics.truncated };
  });
  assert.equal(result.data.products.length, 850); assert.ok(result.data.products.some(row => row.productId === "849")); assert.equal(result.getterCalls, 0); assert.doesNotMatch(JSON.stringify(result.data.products), /private-marker|secretGetter/);
  assert.equal(result.cleanCount, 850); assert.equal(result.cleanTruncated, false);
});

test("framework bookkeeping and repeated references do not hide product occurrences", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const row = { productId: "same", title: "Same offer", url: "/items/same", price: "2" };
    const props = { children: [row, row], _owner: { tree: Array.from({ length: 30000 }, () => ({ state: {} })) } };
    const node = document.createElement("article"); node.dataset.productId = "same"; node.__reactProps$test = props; document.body.append(node);
    return SupplierPageData.readPageState();
  });
  assert.equal(result.products.length, 2); assert.equal(result.diagnostics.truncated, false);
});

test("optional component discovery exhaustion is distinguished from unread known product data", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => { document.body.innerHTML = "<span></span>".repeat(6500); return SupplierPageData.readPageState(); });
  assert.equal(result.products.length, 0); assert.equal(result.diagnostics.truncated, false); assert.equal(result.diagnostics.component_discovery_limited, true);
});

test("actual product-record limits remain bounded and explicit", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => SupplierPageData.readPageState({ onlyPayload: true, payload: { products: Array.from({ length: 2100 }, (_, i) => ({ productId: String(i), title: "Cup", url: "/items/" + i, price: "1" })) } }));
  assert.ok(result.products.length > 0 && result.products.length <= 2000); assert.equal(result.diagnostics.truncated, true); assert.ok(result.diagnostics.truncation_reasons.some(reason => ["records", "time"].includes(reason)));
});

test("inert hydration lists retain more than 300 elements and cycle handling is bounded", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const items = Array.from({ length: 850 }, (_, i) => ({ productId: String(i), title: "Cup " + i, url: "/items/" + i, price: 10 }));
    const data = { products: items }; data.loop = data;
    return SupplierDataSources.walk(data, { url: location.href }, "test", 95);
  });
  assert.equal(result.records.length, 850); assert.equal(result.truncated, false);
});

test("seller names use the company link, not the surrounding badge and popup descriptions", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => SupplierCollectorEngine.fromHTML('<article class="product-card"><a href="https://example.en.made-in-china.com/product/AbCd/Cup.html"><img src="https://img.example/cup.jpg"></a><h3>Cup</h3><span class="price">US$15</span><div class="company-name-txt"><a class="compnay-name" href="https://example.en.made-in-china.com/"><span>Example Tools Co., Ltd.</span></a><div class="company-name-popup"><a href="https://example.en.made-in-china.com/">Example Tools Co., Ltd.</a><p>Diamond Member Audited Supplier More than 50% repeat buyers</p></div></div></article>', { url: 'https://www.made-in-china.com/search', raw: false }));
  assert.equal(result.cards.length, 1); assert.equal(result.cards[0].shop_name, "Example Tools Co., Ltd.");
});

test("certification artwork never becomes a product photo, and nested price lists stay within one physical card", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const card = id => '<div class="fy26-product-card-wrapper"><a href="https://www.alibaba.com/product-detail/Cup_' + id + '.html"><img class="searchx-product-e-slider__img" data-src="https://img.example/product.jpg"></a><h3>Cup</h3><ul><li><a href="https://www.alibaba.com/product-detail/Cup_' + id + '.html">Cup price</a><span class="price">US$12</span><div class="searchx-product-e-certification-wrapper"><img class="searchx-product-e-certification" alt="CE" src="https://img.example/cert.png"></div></li></ul></div>';
    const first = SupplierCollectorEngine.fromHTML(card(101) + card(101), { url: 'https://www.alibaba.com/search', raw: false });
    const doc = new DOMParser().parseFromString('<article><div class="certificate"><img src="https://img.example/cert.png" alt="CE"></div></article>', 'text/html');
    return { first, image: SupplierGeneric.image(doc.querySelector('article'), 'https://www.alibaba.com/search') };
  });
  assert.equal(result.first.cards.length, 2); assert.ok(result.first.cards.every(row => row.image_url === "https://img.example/product.jpg")); assert.equal(result.image, null);
});

test("per-sample caches never retain old fields across a DOM update", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    document.body.innerHTML = '<article class="offer-card" data-offer-id="1001"><a class="offer-title" href="https://detail.1688.com/offer/1001.html">Old title</a><span class="price">¥1</span><img src="https://img.example/old.jpg"></article>';
    const options = { url: 'https://s.1688.com/search', raw: false };
    const first = SupplierCollectorEngine.extract(document, options);
    document.querySelector('.price').textContent = '¥50'; document.querySelector('a').textContent = 'New title'; document.querySelector('img').src = 'https://img.example/new.jpg';
    const second = SupplierCollectorEngine.extract(document, options);
    return { first: first.cards[0], second: second.cards[0] };
  });
  assert.equal(result.first.price, "¥1"); assert.equal(result.second.price, "¥50"); assert.equal(result.second.title, "New title"); assert.equal(result.second.image_url, "https://img.example/new.jpg");
});

test("image-only loading does not trigger a full card parse on every scroll", async t => {
  const h = await createHarness(browser, t);
  h.flags.routeHtml = () => '<style>body{margin:0}article{height:1400px}</style><article class="offer-card" data-offer-id="1001"><a class="offer-title" href="https://detail.1688.com/offer/1001.html">Cup</a><span class="price">¥12</span><img data-src="https://img.example/cup.jpg"></article><script>let n=0;setInterval(()=>document.querySelector("img").setAttribute("src","https://img.example/loading-"+(n++)+".jpg"),40);</script>';
  await h.page.goto(h.initialUrl);
  await h.page.evaluate(() => { window.extractCalls = 0; const original = SupplierCollectorEngine.extract; SupplierCollectorEngine.extract = function(...args) { extractCalls++; return original.apply(this, args); }; });
  await h.command("START", { max_pages: 1, scroll: true, interval_seconds: 1 }); await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.collection.products.length, 1); assert.ok(h.data.collection.pages[0].diagnostics.image_changes > 0); assert.ok(await h.page.evaluate(() => extractCalls <= 4));
});

function seedHistory(h) {
  const row = (id, owner, price) => ({ source: "1688", product_id: String(id), observation_id: "obs-" + id, product_url: "https://detail.1688.com/offer/" + id + ".html", title: "Cup " + id, price, supplier_id: owner, shop_name: owner ? "Factory " + owner : null, supplier_url: owner ? "https://" + owner + ".1688.com/" : null });
  const products = [row(1, "a", "¥1,000"), row(2, "a", "¥100"), row(3, "b", "¥250"), row(4, "c", null), row(5, "d", "USD12"), row(6, null, "¥1")];
  h.data.tasks = [{ id: "first", kind: "collection", query: "Cups", source: "1688", status: "finished", completed_pages: 1, max_pages: 1, started_at: "2026-10-15T10:00:00Z", products, pages: [], log: [] }, { id: "other", kind: "collection", query: "Other", source: "1688", status: "finished", completed_pages: 1, max_pages: 1, products: [row(999, "other", "¥99999")], pages: [], log: [] }];
  h.data.collection = { products: [...products, ...h.data.tasks[1].products], pages: [], raw_cards: [] };
}
async function openUi(h, file, hash = "") {
  const page = await h.context.newPage({ viewport: { width: 1450, height: 1050 } }); page.setDefaultTimeout(10000);
  await page.exposeFunction("__command", ({ type, options }) => h.command(type, options, { id: "testextension", url: "chrome-extension://testextension/" + file }));
  await page.addInitScript(() => { globalThis.chrome = { runtime: { sendMessage: message => __command(message) }, storage: { onChanged: { addListener: callback => { globalThis.__changed = callback; } } } }; });
  h.observers.push((changes, area) => { if (!page.isClosed()) void page.evaluate(({ changes, area }) => globalThis.__changed?.(changes, area), { changes, area }).catch(() => {}); });
  await page.route("https://collector.test/**", route => { const name = new URL(route.request().url()).pathname.slice(1); return route.fulfill({ body: fs.readFileSync(path.join(__dirname, "../extension", name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' }); });
  await page.goto("https://collector.test/" + file + hash); return page;
}
test("history sorts a selected task's cards and supplier minima, preserves unknown prices, currencies and stored rows", async t => {
  const h = await createHarness(browser, t); seedHistory(h); const original = structuredClone(h.data.tasks), page = await openUi(h, "history.html", "#first");
  await page.waitForFunction(() => document.querySelectorAll('#memory-products tr').length === 6);
  await page.locator('#price-order').selectOption('price-desc'); await h.waitFor(data => data.view_preferences?.history_price_order === 'price-desc');
  assert.match(await page.locator('#memory-products tr').first().textContent(), /Cup 1/); assert.match(await page.locator('#memory-products tr').last().textContent(), /Cup 4/);
  await page.locator('#memory-view').selectOption('suppliers'); await h.waitFor(data => data.view_preferences?.history_view === 'suppliers');
  assert.deepEqual(await page.locator('#memory-suppliers > tr[data-supplier-key]').evaluateAll(rows => rows.map(row => row.dataset.supplierKey)), ['1688:id:b', '1688:id:a', '1688:id:d', '1688:id:c', 'unknown']);
  await page.locator('[data-supplier-key="1688:id:a"] button').click(); assert.equal(await page.locator('#memory-suppliers .memory-products tbody tr').count(), 2);
  await page.locator('#price-order').selectOption('price-asc'); await h.waitFor(data => data.view_preferences?.history_price_order === 'price-asc');
  assert.equal(await page.locator('#memory-suppliers > tr[data-supplier-key]').first().getAttribute('data-supplier-key'), '1688:id:a');
  await page.locator('#price-currency').selectOption('CNY'); assert.match(await page.locator('#memory-visible').textContent(), /4 из 6/); assert.doesNotMatch(await page.locator('#memory-suppliers').textContent(), /Factory d|99999/);
  await page.reload(); await page.waitForFunction(() => document.getElementById('memory-view').value === 'suppliers'); assert.equal(await page.locator('#price-order').inputValue(), 'price-asc'); assert.deepEqual(h.data.tasks, original);
  for (const options of [{ history_view: 'unknown' }, { history_price_order: 'invalid' }]) assert.equal((await h.command('SET_VIEW', options)).ok, false);
  fs.mkdirSync(path.join(__dirname,'../test-results'),{recursive:true}); await page.screenshot({path:path.join(__dirname,'../test-results/history-price-sort.png'),fullPage:true});
});

test("history is a prominent entry and legacy result selection starts collapsed", async t => {
  const h = await createHarness(browser, t); seedHistory(h); const page = await openUi(h, "dashboard.html");
  await page.waitForFunction(() => document.querySelectorAll('#tasks tr').length === 2);
  assert.equal(await page.locator('.history-entry').isVisible(), true); assert.equal(await page.locator('#task-filter').isVisible(), false);
  assert.equal(await page.locator('#tasks a[href="history.html#first"]').count(), 1); assert.equal(await page.locator('#history-link').getAttribute('class'), 'history-nav');
  await page.locator('#extra-views > summary').click(); assert.equal(await page.locator('#task-filter').isVisible(), true);
  await page.locator('#extra-views > summary').click();
  fs.mkdirSync(path.join(__dirname,'../test-results'),{recursive:true}); await page.screenshot({path:path.join(__dirname,'../test-results/dashboard-history.png'),fullPage:true});
});
