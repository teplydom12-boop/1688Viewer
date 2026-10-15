"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright-core");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
async function setup(t, url = "https://catalog.example/search") {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.route("**/*", route => route.request().resourceType() === "document" ? route.fulfill({ body: "<!doctype html><body></body>", contentType: "text/html" }) : route.abort());
  await page.goto(url);
  for (const name of ["shared.js", "navigation.js", "generic.js", "page-data.js", "data-sources.js", "engine.js", "observer.js", "content.js"]) await page.addScriptTag({ path: path.join(__dirname, "../extension", name) });
  return page;
}
async function inert(page, html, extra = {}) { return page.evaluate(({ html, extra }) => SupplierCollectorEngine.fromHTML(html, { url: location.href, ...extra }), { html, extra }); }

test("product images prefer an explicit original or the largest responsive source over a small loaded thumbnail", async t => {
  const page = await setup(t);
  const html = '<article data-product-id="cup"><a href="/items/cup"><img src="https://img.example/small.jpg" data-src="https://img.example/medium.jpg" data-original="https://img.example/original.jpg" srcset="https://img.example/400.jpg 400w, https://img.example/1600.jpg 1600w" alt="Cup"></a><h3>Cup</h3><p>$10</p></article>';
  const original = await inert(page, html); assert.equal(original.cards[0].image_url, "https://img.example/original.jpg");
  const responsive = await inert(page, html.replace('data-original="https://img.example/original.jpg"', ''));
  assert.equal(responsive.cards[0].image_url, "https://img.example/1600.jpg");
});

test("microdata keeps seller scope separate from the product and supplies currency", async t => {
  const page = await setup(t);
  const html = '<article itemscope itemtype="https://schema.org/Product" itemid="https://catalog.example/items/cup"><div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><div itemprop="seller" itemscope itemtype="https://schema.org/Organization"><span itemprop="name">Factory first in markup</span><a itemprop="url" href="/vendors/one">Store</a></div><meta itemprop="price" content="12.50"><meta itemprop="priceCurrency" content="EUR"></div><h3 itemprop="name">Actual cup</h3><img itemprop="image" src="https://cdn.example/cup.jpg"></article>';
  const result = await inert(page, html);
  assert.equal(result.products.length, 1); assert.equal(result.products[0].title, "Actual cup");
  assert.equal(result.products[0].price, "EUR 12.50"); assert.equal(result.products[0].shop_name, "Factory first in markup");
  assert.equal(result.products[0].field_sources.price, "microdata");
});
test("RDFa namespaced properties identify products and an explicit seller", async t => {
  const page = await setup(t);
  const html = '<article typeof="schema:Product" about="https://catalog.example/items/rdfa"><h3 property="schema:name">RDFa cup</h3><img property="schema:image" src="https://cdn.example/cup.jpg"><div property="schema:offers" typeof="schema:Offer"><meta property="schema:price" content="8"><meta property="schema:priceCurrency" content="USD"><div property="schema:seller" typeof="schema:Organization" resource="https://catalog.example/vendors/rdfa"><span property="schema:name">RDFa factory</span></div></div></article>';
  const result = await inert(page, html);
  assert.equal(result.products.length, 1); assert.equal(result.products[0].title, "RDFa cup");
  assert.equal(result.products[0].price, "USD 8"); assert.equal(result.products[0].supplier_url, "https://catalog.example/vendors/rdfa");
});
test("h-product microformats are supported independently of wrapper tags", async t => {
  const page = await setup(t);
  const result = await inert(page, '<section class="h-product"><h3 class="p-name">Microformat cup</h3><a class="u-url" href="/items/micro">View</a><img class="u-photo" src="https://cdn.example/cup.jpg"><span class="p-price">$17</span></section>');
  assert.equal(result.products[0].title, "Microformat cup"); assert.equal(result.products[0].field_sources.price, "microformats");
});
test("hydration assignments are parsed as inert JSON and retain no unrelated secrets", async t => {
  const page = await setup(t);
  const data = { products: [{ productId: "one", title: "Cup } ] one", url: "/items/one", price: "11", companyName: "Cup factory", token: "private-marker" }], auth: { password: "private-marker" } };
  const result = await inert(page, `<script>window.__INITIAL_STATE__ = ${JSON.stringify(data)}; globalThis.savedScriptExecuted=true;</script>`);
  assert.equal(result.products.length, 1); assert.equal(result.products[0].title, "Cup } ] one");
  assert.equal(await page.evaluate(() => globalThis.savedScriptExecuted), undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-marker|password/);
  const reparsed = await page.evaluate(cards => SupplierCollectorEngine.reparse(cards), result.raw_cards);
  assert.equal(reparsed.length, 1); assert.equal(reparsed[0].title, result.products[0].title);
});
test("JavaScript expressions embedded in a store are never evaluated", async t => {
  const page = await setup(t);
  const result = await inert(page, '<script>window.__INITIAL_STATE__ = { products: (()=>{globalThis.executed=true;return []})() };</script>');
  assert.equal(result.products.length, 0); assert.equal(await page.evaluate(() => globalThis.executed), undefined);
});
test("embedded JSON attributes supply explicit product fields", async t => {
  const page = await setup(t);
  const data = JSON.stringify({ product: { productId: "a", title: "Embedded cup", productUrl: "/items/embed", price: 10 } }).replaceAll('"', "&quot;");
  const result = await inert(page, `<div data-props="${data}"></div>`);
  assert.equal(result.products[0].title, "Embedded cup"); assert.equal(result.products[0].field_sources.title, "embedded-json");
});
test("MAIN state reading skips getters and exports only the whitelisted business fields", async t => {
  const page = await setup(t, "https://www.alibaba.com/trade/search?SearchText=cup");
  await page.evaluate(() => {
    globalThis.getterCalls = 0;
    const product = { productId: "1600000012345", title: "State cup", productUrl: "https://www.alibaba.com/product-detail/State-Cup_1600000012345.html", price: 10, companyName: "State factory", companyUrl: "https://statecups.en.alibaba.com/", token: "private-marker" };
    Object.defineProperty(product, "hiddenData", { enumerable: true, get() { getterCalls++; throw new Error("Getter must not run"); } });
    window.__INITIAL_STATE__ = { products: [product], auth: { accessToken: "private-marker" } };
  });
  const data = await page.evaluate(() => SupplierPageData.readPageState());
  assert.equal(data.products.length, 1); assert.equal(await page.evaluate(() => getterCalls), 0);
  assert.doesNotMatch(JSON.stringify(data), /private-marker|accessToken|hiddenData/);
  const result = await page.evaluate(pageData => SupplierCollectorEngine.extract(document, { url: location.href, pageData }), data);
  assert.equal(result.products[0].shop_name, "State factory"); assert.equal(result.products[0].field_sources.title, "page-state");
});
test("React and non-enumerable Vue props are read without framework-specific layouts", async t => {
  const page = await setup(t);
  await page.evaluate(() => {
    const a = document.createElement("div"), b = document.createElement("div"); document.body.append(a, b);
    a.__reactProps$test = { product: { productId: "a", title: "React cup", url: "/items/react", price: 7 } };
    Object.defineProperty(b, "__vueParentComponent", { value: { props: { product: { productId: "b", title: "Vue cup", url: "/items/vue", price: 9 } } } });
  });
  const data = await page.evaluate(() => SupplierPageData.readPageState());
  assert.deepEqual(data.products.map(item => item.name).sort(), ["React cup", "Vue cup"]);
});
test("Open Graph prices are used only for an explicitly identified product detail page", async t => {
  const page = await setup(t, "https://catalog.example/items/meta?color=red");
  const html = '<meta property="og:type" content="product"><meta property="og:title" content="Metadata cup"><meta property="og:url" content="https://catalog.example/items/meta"><meta property="product:price:amount" content="14"><meta property="product:price:currency" content="EUR">';
  assert.equal((await inert(page, html)).products.length, 0);
  const detail = await inert(page, html, { mode: "detail" });
  assert.equal(detail.products.length, 1); assert.equal(detail.products[0].price, "EUR 14"); assert.match(detail.products[0].product_url, /color=red/);
});
test("link clustering finds separated cards whose wrapper tags differ", async t => {
  const page = await setup(t);
  const html = '<main style="display:flex;gap:20px">' + ["div", "section", "aside"].map((tag, index) => `<${tag}><article style="width:250px"><a href="/items/${index}"><img width="100" height="100" src="https://cdn.example/${index}.jpg" alt="Separated cup ${index}"></a><h3>Separated cup ${index}</h3><p>$10</p></article></${tag}>`).join("") + '</main>';
  await page.setContent(html);
  const result = await page.evaluate(() => SupplierCollectorEngine.extract(document, { url: location.href }));
  assert.equal(result.products.length, 3); assert.ok(result.diagnostics.methods.includes("visual-card-layout"));
});
test("accessible headings, linked labels and responsive images remain readable in raw snapshots", async t => {
  const page = await setup(t);
  const html = '<section>' + [1, 2].map(id => `<article><a href="/items/${id}" aria-labelledby="title-${id}"><img srcset="https://cdn.example/${id}-small.jpg 100w, https://cdn.example/${id}-large.jpg 600w"></a><div role="heading" id="title-${id}">Accessible cup ${id}</div><p>$10</p></article>`).join("") + '</section>';
  const result = await inert(page, html);
  assert.deepEqual(result.products.map(item => item.title), ["Accessible cup 1", "Accessible cup 2"]);
  assert.ok(result.products.every(item => /large\.jpg$/.test(item.image_url)));
  const reparse = await page.evaluate(cards => SupplierCollectorEngine.reparse(cards), result.raw_cards);
  assert.deepEqual(reparse.map(item => item.title), result.products.map(item => item.title));
});
test("same-origin frame URLs and controls resolve against their own document", async t => {
  const page = await setup(t);
  const childHtml = '<section>' + [1, 2].map(id => `<article><a href="items/${id}"><img src="https://cdn.example/${id}.jpg" alt="Frame cup ${id}"></a><h3>Frame cup ${id}</h3><p>$10</p></article>`).join("") + '</section><nav class="pagination"><button aria-label="Next page">Next</button></nav>';
  await page.route("https://catalog.example/nested/list", route => route.fulfill({ body: childHtml, contentType: "text/html" }));
  await page.evaluate(() => { const frame = document.createElement("iframe"); frame.src = "/nested/list"; frame.id = "catalog"; document.body.append(frame); });
  await page.frameLocator("#catalog").locator("h3").first().waitFor();
  const result = await page.evaluate(() => { const products = SupplierCollectorEngine.extract(document, { url: location.href }).products; const nav = SupplierNavigator.analyze(document, { url: location.href }); return { products, selector: nav.chosen.selector, resolved: SupplierNavigator.resolve(document, nav.chosen.selector)[0]?.tagName }; });
  assert.equal(result.products.length, 2); assert.match(result.products[0].product_url, /\/nested\/items\/1$/);
  assert.match(result.selector, / ::: /); assert.equal(result.resolved, "BUTTON");
});
test("shadow-root captcha and hidden preloaded widgets are distinguished", async t => {
  const page = await setup(t);
  await page.evaluate(() => { const host = document.createElement("x-verify"); host.id = "verify"; host.hidden = true; document.body.append(host); host.attachShadow({ mode: "open" }).innerHTML = '<div class="captcha">Verify you are human</div>'; });
  assert.equal(await page.evaluate(() => SupplierCollectorDOM.blockedReason()), null);
  await page.evaluate(() => document.getElementById("verify").hidden = false);
  assert.match(await page.evaluate(() => SupplierCollectorDOM.blockedReason()), /проверку безопасности/);
});
test("an orphan store record joins a visible URL only by a unique matching native ID", async t => {
  const page = await setup(t);
  const html = '<article data-product-id="SKU-ONE"><a href="/items/one"><img src="https://cdn.example/cup.jpg" alt="Cup one"></a><h3>Cup one</h3><p>$10</p></article><script>window.__INITIAL_STATE__={"products":[{"productId":"SKU-ONE","title":"Cup one","price":"10","companyName":"Verified store","companyUrl":"/vendors/one"}]};</script>';
  const result = await inert(page, html);
  assert.equal(result.products.length, 1); assert.equal(result.products[0].product_url, "https://catalog.example/items/one");
  assert.equal(result.products[0].shop_name, "Verified store");
  const reparse = await page.evaluate(cards => SupplierCollectorEngine.reparse(cards), result.raw_cards);
  assert.equal(reparse.length, 1); assert.equal(reparse[0].shop_name, "Verified store");
});
test("conflicting prices are exposed while stronger structured fields retain priority", async t => {
  const page = await setup(t);
  const json = { "@type": "Product", name: "Cup", url: "/items/one", offers: { price: "12", priceCurrency: "USD" } };
  const html = `<script type="application/ld+json">${JSON.stringify(json)}</script><article data-product-id="SKU-ONE"><a href="/items/one"><img src="https://cdn.example/cup.jpg" alt="Cup"></a><h3>Cup</h3><p>$9</p></article>`;
  const result = await inert(page, html);
  assert.equal(result.products.length, 1); assert.equal(result.products[0].price, "USD 12");
  assert.equal(result.diagnostics.price_conflicts, 1); assert.equal(result.products[0].data_conflicts[0].field, "price");
});
test("structured quantity objects keep the stated minimum and units instead of object placeholders", async t => {
  const page = await setup(t);
  const json = { "@type": "Product", name: "Quantity cup", url: "/items/quantity", minimumOrderQuantity: { minValue: 20, unitText: "pieces" } };
  const result = await inert(page, `<script type="application/ld+json">${JSON.stringify(json)}</script>`);
  assert.equal(result.products[0].minimum_order, "20 pieces");
});
