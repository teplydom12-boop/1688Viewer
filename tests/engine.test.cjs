"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
async function engine(t) {
  const page = await browser.newPage(); t.after(() => page.close()); await page.route("**/*", route => route.abort());
  for (const name of ["shared.js", "engine.js"]) await page.addScriptTag({ path: path.join(__dirname, "../extension", name) });
  return page;
}
async function extract(page, html, url, mode = "search") { return page.evaluate(({ html, url, mode }) => SupplierCollectorEngine.fromHTML(html, { url, mode }), { html, url, mode }); }

test("image-search metadata survives changing class hashes and groups products without inventing shop names", async t => {
  const page = await engine(t); const html = fs.readFileSync(path.join(__dirname, "fixtures/image-search-v2.html"), "utf8");
  const result = await extract(page, html, "https://s.1688.com/youyuan/index.htm");
  assert.deepEqual(result.products.map(item => item.product_id), ["812345678901", "812345678902"]);
  assert.equal(result.products[0].price, "¥1950.0");
  assert.equal(result.products[0].supplier_id, "b2b-samplefactory");
  assert.equal(result.products[0].shop_name, null);
  assert.equal(result.products[0].supplier_url, null);
  const groups = await page.evaluate(products => SupplierCollector.supplierGroups(products), result.products);
  assert.equal(groups.suppliers.length, 1); assert.equal(groups.suppliers[0].products.length, 2);
  const changed = await extract(page, html.replace(/--[a-zA-Z0-9_]+/g, "--CompletelyNewSuffix"), "https://s.1688.com/youyuan/index.htm");
  assert.deepEqual(changed.products.map(item => [item.product_id, item.price, item.title]), result.products.map(item => [item.product_id, item.price, item.title]));
});

test("nested anchors in saved cards keep prices, titles and boundaries on reanalysis", async t => {
  const page = await engine(t);
  const html = '<a class="i18n-card-wrap" data-renderkey="1_0_normal_812345678901" href="https://detail.1688.com/offer/812345678901.html"><div><a class="rec-offer-find-similar-link" href="https://s.1688.com/selloffer/offer_search.htm?offerId=812345678901">Find Similar</a></div><span class="offer-title">Sample converter</span><div class="price-wrap">¥12.50</div></a>';
  const result = await extract(page, html, "https://s.1688.com/selloffer/offer_search.htm");
  assert.equal(result.products.length, 1); assert.equal(result.products[0].price, "¥12.50"); assert.equal(result.products[0].title, "Sample converter");
  const reparsed = await page.evaluate(cards => SupplierCollectorEngine.reparse(cards), result.raw_cards);
  assert.equal(reparsed[0].price, "¥12.50"); assert.equal(reparsed[0].title, "Sample converter");
});

test("Alibaba JSON-LD provides stable seller and price fields when CSS names are unknown", async t => {
  const page = await engine(t);
  const structured = { "@type": "Product", name: "Sample thermos", url: "https://www.alibaba.com/product-detail/Sample-thermos_1600000012345.html?spm=x", image: "https://img.example/thermos.jpg", offers: { price: "3.50", priceCurrency: "USD", seller: { "@type": "Organization", name: "Sample Thermos Co", url: "https://samplethermos.en.alibaba.com/" } } };
  const result = await extract(page, `<script type="application/ld+json">${JSON.stringify(structured)}</script>`, "https://www.alibaba.com/trade/search?SearchText=thermos");
  assert.equal(result.products.length, 1); assert.equal(result.products[0].source, "alibaba"); assert.equal(result.products[0].price, "USD 3.50");
  assert.equal(result.products[0].shop_name, "Sample Thermos Co"); assert.equal(result.products[0].supplier_url, "https://samplethermos.en.alibaba.com/");
  assert.equal(result.products[0].field_sources.shop_name, "structured-data");
});

test("Made-in-China product and company links are extracted by the same engine", async t => {
  const page = await engine(t); const url = "https://www.made-in-china.com/products-search/hot-china-products/Cup.html";
  const html = '<article class="product-card"><a class="product-title" href="https://samplecups.en.made-in-china.com/product/AaBbCcDd/China-Sample-Cup.html?tracking=x">Sample cup</a><span class="price">US $2.50</span><span class="moq">100 pieces</span><a class="company-name" href="https://samplecups.en.made-in-china.com/">Sample Cups Factory</a></article>';
  const [product] = (await extract(page, html, url)).products;
  assert.equal(product.source, "made-in-china"); assert.equal(product.product_id, "AaBbCcDd"); assert.equal(product.shop_name, "Sample Cups Factory");
  assert.equal(product.price, "US $2.50"); assert.equal(product.minimum_order, "100 pieces");
});

test("product brand is not treated as a supplier and raw card exports remove executable and private attributes", async t => {
  const page = await engine(t);
  const product = { "@type": "Product", name: "Branded cup", url: "https://detail.1688.com/offer/812345678901.html", brand: { name: "Consumer brand" } };
  const html = `<script type="application/ld+json">${JSON.stringify(product)}</script><article class="offer-card" data-offer-id="812345678901" onclick="alert(1)" data-token="not-to-be-exported"><a href="https://detail.1688.com/offer/812345678901.html">Branded cup</a><script>globalThis.injectionExecuted=true</script><form><input type="password" value="not-to-be-exported"></form></article>`;
  const result = await extract(page, html, "https://s.1688.com/selloffer/offer_search.htm");
  assert.equal(result.products[0].shop_name, null);
  assert.equal(await page.evaluate(() => globalThis.injectionExecuted), undefined);
  assert.doesNotMatch(result.raw_cards[0].html, /onclick|data-token|not-to-be-exported|<script|<input|<form/);
});

test("structured identifier objects never collapse unrelated sellers and malformed prices remain empty", async t => {
  const page = await engine(t);
  const products = ["a", "b"].map((id, index) => ({ "@type": "Product", name: `Cup ${id}`, url: `https://www.alibaba.com/product-detail/Cup_${1600000012345 + index}.html`, offers: { price: { min: 1 }, priceCurrency: "USD", seller: { name: `Company ${id}`, identifier: { "@type": "PropertyValue", value: id } } } }));
  const result = await extract(page, `<script type="application/ld+json">${JSON.stringify(products)}</script>`, "https://www.alibaba.com/trade/search?SearchText=cup");
  assert.deepEqual(result.products.map(item => item.supplier_id).sort(), ["a", "b"]);
  assert.ok(result.products.every(item => item.price === null));
  const groups = await page.evaluate(products => SupplierCollector.supplierGroups(products), result.products);
  assert.equal(groups.suppliers.length, 2);
});
