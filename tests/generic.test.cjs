"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright-core");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
async function setup(t) {
  const page = await browser.newPage(); t.after(() => page.close()); await page.route("**/*", route => route.abort());
  for (const name of ["shared.js", "navigation.js", "generic.js", "engine.js"]) await page.addScriptTag({ path: path.join(__dirname, "../extension", name) });
  return page;
}
function tiles(prefix = "x") { return '<section>' + [1, 2].map(id => `<div class="${prefix}-${id}"><a href="/items/cup-${id}?utm_source=test"><img src="https://cdn.example/cup-${id}.jpg" alt="Cup ${id}"></a><h3>Cup ${id}</h3><span class="${prefix}-amount">€ ${id}2.50</span></div>`).join("") + '</section>'; }
async function extract(page, html, extra = {}) { return page.evaluate(({ html, extra }) => SupplierCollectorEngine.fromHTML(html, { url: "https://catalog.example/catalog?q=cup", ...extra }), { html, extra }); }
test("unknown sites are inferred from repeated structure without fixed CSS card names", async t => {
  const page = await setup(t), result = await extract(page, tiles());
  assert.equal(result.products.length, 2); assert.equal(result.products[0].source, "web:catalog.example");
  assert.deepEqual(result.products.map(item => item.title), ["Cup 1", "Cup 2"]);
  assert.deepEqual(result.products.map(item => item.price), ["€ 12.50", "€ 22.50"]);
  assert.ok(result.products.every(item => item.product_url && !item.product_url.includes("utm_source")));
  const changed = await extract(page, tiles("completely-changed"));
  assert.deepEqual(changed.products.map(item => item.product_id), result.products.map(item => item.product_id));
});
test("a retained snapshot can be reanalysed even when only one generic card is present", async t => {
  const page = await setup(t), result = await extract(page, tiles());
  const reparsed = await page.evaluate(cards => SupplierCollectorEngine.reparse(cards), result.raw_cards.slice(0, 1));
  assert.equal(reparsed.length, 1); assert.equal(reparsed[0].product_url, result.products[0].product_url); assert.equal(reparsed[0].price, "€ 12.50");
  const all = await page.evaluate(cards => SupplierCollectorEngine.reparse(cards), result.raw_cards);
  assert.deepEqual(all.map(item => item.product_id).sort(), result.products.map(item => item.product_id).sort());
});
test("JSON-LD seller references and product variants preserve distinct identities", async t => {
  const page = await setup(t);
  const graph = { "@graph": [{ "@id": "#seller", "@type": "Organization", name: "Example vendor", url: "https://catalog.example/vendors/one" }, ...["red", "blue"].map(color => ({ "@type": "Product", name: `Cup ${color}`, url: `/item?id=1&color=${color}`, offers: { price: "8", priceCurrency: "USD", seller: { "@id": "#seller" } } }))] };
  const result = await extract(page, `<script type="application/ld+json">${JSON.stringify(graph)}</script>`);
  assert.equal(result.products.length, 2); assert.notEqual(result.products[0].product_id, result.products[1].product_id);
  assert.ok(result.products.every(item => item.shop_name === "Example vendor" && item.supplier_url === "https://catalog.example/vendors/one"));
});
test("cards without links retain explicit local IDs and remain importable", async t => {
  const page = await setup(t);
  const html = '<section>' + [1, 2].map(id => `<article data-product-id="SKU-${id}"><img src="https://cdn.example/${id}.jpg"><h3>Widget ${id}</h3><span>$${id}0.00</span></article>`).join("") + '</section>';
  const result = await extract(page, html);
  assert.equal(result.products.length, 2); assert.ok(result.products.every(item => item.product_url === null && item.identity_type === "native-id"));
  const imported = await page.evaluate(products => SupplierCollector.importProducts({ products }), result.products);
  assert.equal(imported.length, 2);
});
test("ordinary image-based articles without product evidence are excluded", async t => {
  const page = await setup(t); const result = await extract(page, '<section><article><img src="https://cdn.example/a.jpg"><h3>Travel stories</h3><a href="/news/a">Read more</a></article><article><img src="https://cdn.example/b.jpg"><h3>Weather report</h3><a href="/news/b">Read more</a></article></section>');
  assert.equal(result.products.length, 0);
});
test("generic raw snapshots preserve variant URLs and labelled seller identities", async t => {
  const page = await setup(t);
  const html = '<section>' + ["red", "blue"].map(color => `<article><a href="/vendors/a">Vendor link</a><a href="/item?id=1&color=${color}&utm_source=ad"><img src="https://cdn.example/${color}.jpg" alt="Cup ${color}"></a><h3>Cup ${color}</h3><p>$10</p><p>MOQ: 20 pieces</p><p>Sold by: <a href="/vendors/a">Example factory</a></p></article>`).join("") + '</section>';
  const result = await extract(page, html);
  assert.equal(result.products.length, 2); assert.ok(result.products.every(item => item.minimum_order === "MOQ: 20 pieces" && item.shop_name === "Example factory"));
  const reparsed = await page.evaluate(cards => SupplierCollectorEngine.reparse(cards), result.raw_cards);
  assert.deepEqual(reparsed.map(item => item.product_id).sort(), result.products.map(item => item.product_id).sort());
  assert.ok(reparsed.every(item => item.supplier_url === "https://catalog.example/vendors/a"));
});
test("a generic detail page reads one JSON-LD graph product without a URL", async t => {
  const page = await setup(t);
  const graph = { "@graph": [{ "@id": "#company", "@type": "Organization", name: "Detail factory", url: "/vendors/a" }, { "@type": "Product", name: "Graph cup", offers: { seller: { "@id": "#company" }, price: "17", priceCurrency: "EUR" } }] };
  const result = await extract(page, `<script type="application/ld+json">${JSON.stringify(graph)}</script>`, { url: "https://catalog.example/items/cup", mode: "detail" });
  assert.equal(result.products.length, 1); assert.equal(result.products[0].title, "Graph cup");
  assert.equal(result.products[0].price, "EUR 17"); assert.equal(result.products[0].shop_name, "Detail factory");
});
test("seller statistics and legal footer links are not invented as business records", async t => {
  const page = await setup(t);
  const html = '<main><div><div><section>' + [1, 2].map(id => `<article><a href="/items/${id}"><img src="https://cdn.example/${id}.jpg" alt="Cup ${id}"></a><h3>Cup ${id}</h3><p>$10</p><div class="overseas-seller-info-wrap">Repurchase Rate 50%</div></article>`).join("") + '</section></div></div><div><div><a href="https://legal.example/privacy"><img src="https://cdn.example/logo.png" alt="Protection of intellectual property rights"></a></div></div></main>';
  const result = await extract(page, html);
  assert.equal(result.products.length, 2); assert.ok(result.products.every(item => item.shop_name === null && item.supplier_url === null));
});
test("an explicitly selected single result card can be extracted without repeated siblings", async t => {
  const page = await setup(t);
  await page.evaluate(() => { document.body.innerHTML = '<section><article id="only"><a href="https://catalog.example/items/one"><img src="https://cdn.example/one.jpg" alt="Single cup"></a><h3>Single cup</h3><p>$10</p></article></section>'; });
  const result = await page.evaluate(() => {
    const card = SupplierGeneric.sampleCard(document.querySelector("h3"), "https://catalog.example/catalog");
    return SupplierCollectorEngine.extract(document, { url: "https://catalog.example/catalog", profile: { card_selector: SupplierNavigator.selectorFor(card, true) }, raw: false });
  });
  assert.equal(result.products.length, 1); assert.equal(result.products[0].title, "Single cup");
  assert.equal(result.products[0].field_sources.title, "learned-card");
});
test("SPA fragment routes identify different products while ordinary anchors are ignored", async t => {
  const page = await setup(t);
  const html = '<section>' + [1, 2].map(id => `<article><a href="#/items/${id}?color=red&utm_source=test"><img src="https://cdn.example/${id}.jpg" alt="SPA cup ${id}"></a><h3>SPA cup ${id}</h3><p>$10</p><a href="#specifications">Specifications</a></article>`).join("") + '</section>';
  const result = await extract(page, html);
  assert.equal(result.products.length, 2); assert.notEqual(result.products[0].product_id, result.products[1].product_id);
  assert.ok(result.products.every(item => item.product_url.includes("#/items/") && !item.product_url.includes("utm_source")));
  const reparsed = await page.evaluate(cards => SupplierCollectorEngine.reparse(cards), result.raw_cards);
  assert.deepEqual(reparsed.map(item => item.product_id).sort(), result.products.map(item => item.product_id).sort());
  assert.equal(await page.evaluate(() => SupplierCollector.dangerousUrl("https://catalog.example/#/checkout")), true);
});
test("open shadow-root components can expose product cards and navigation", async t => {
  const page = await setup(t);
  await page.evaluate(() => { const host = document.createElement("catalog-grid"); host.id = "grid"; document.body.append(host); host.attachShadow({ mode: "open" }).innerHTML = '<article><a href="https://catalog.example/p/a"><img src="https://cdn.example/a.jpg" alt="Cup A"></a><h3>Cup A</h3><p>$10</p></article><article><a href="https://catalog.example/p/b"><img src="https://cdn.example/b.jpg" alt="Cup B"></a><h3>Cup B</h3><p>$20</p></article><nav class="pagination"><button aria-label="Next page">Next</button></nav>'; });
  const result = await page.evaluate(() => SupplierCollectorEngine.extract(document, { url: "https://catalog.example/catalog", raw: false }));
  assert.equal(result.products.length, 2);
  const navigation = await page.evaluate(() => SupplierNavigator.publicResult(SupplierNavigator.analyze(document, { url: "https://catalog.example/catalog" })));
  assert.equal(navigation.decision, "automatic"); assert.match(navigation.chosen.selector, />>>/);
});
