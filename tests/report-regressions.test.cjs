"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium } = require("playwright-core");
const S = require("../extension/shared.js");
const Excel = require("../extension/excel.js");
const { createHarness } = require("./helpers/background-harness.cjs");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
function cards(start, count) { return Array.from({ length: count }, (_, i) => `<article class="offer-card" data-offer-id="${start + i}"><a class="offer-title" href="https://detail.1688.com/offer/${start + i}.html">Test item ${start + i}</a><span class="price">¥12</span></article>`).join(""); }
const layout = '<style>.grid{display:grid;grid-template-columns:repeat(10,1fr)}.offer-card{height:50px;font-size:9px}</style>';
async function collect(h, query) { assert.equal((await h.command("START", { query, max_pages: 1, scroll: false, interval_seconds: 1 })).ok, true); await h.waitFor(data => data.run?.status === "finished"); await h.waitFor(() => h.idle()); }

test("coverage distinguishes a stale mixed page, a short loading page, ordinary duplicates and a genuine short last page", () => {
  const old = Array.from({ length: 60 }, (_, i) => ({ source: "1688", product_id: String(100000 + i) })), fresh = { source: "1688", product_id: "200000" };
  const options = { known_keys: old.map(item => `${item.source}:${item.product_id}`), expected_count: 60, check_count: true };
  assert.equal(S.collectionQuality([...old, fresh], options).reason, "stale-results");
  assert.equal(S.collectionQuality([...old.slice(0, 59), fresh], options).reason, "stale-results");
  assert.equal(S.collectionQuality([...old, fresh], { ...options, append_mode: true }).complete, true);
  assert.equal(S.collectionQuality([fresh], options).reason, "short-results");
  assert.equal(S.collectionQuality([fresh], { ...options, terminal: true }).complete, true);
  assert.equal(S.collectionQuality([fresh], { ...options, expected_count: 2 }).complete, true);
  assert.equal(S.collectionQuality([...old.slice(0, 2), ...Array.from({ length: 58 }, (_, i) => ({ source: "1688", product_id: String(300000 + i) }))], options).complete, true);
});

test("an explicit load-more action on the same URL accepts a small append to a large existing list", async t => {
  const h = await createHarness(browser, t);
  h.flags.routeHtml = () => layout + `<div class="grid">${cards(100000, 60)}</div><button id="more">Load more</button><script>document.getElementById('more').onclick=()=>{document.querySelector('.grid').insertAdjacentHTML('beforeend',${JSON.stringify(cards(200000, 1))});document.getElementById('more').disabled=true;};</script>`;
  await h.page.goto("https://s.1688.com/selloffer/offer_search.htm?page=1");
  await h.command("START", { max_pages: 2, scroll: false, interval_seconds: 1 });
  await h.waitFor(data => data.run?.status === "finished", 30000);
  assert.equal(h.data.run.collection_mode, "append"); assert.equal(h.data.run.completed_pages, 2); assert.equal(h.data.collection.products.length, 61);
});

test("a delayed replacement waits for fresh results and excludes stale hydration records and pre-ready mutations", async t => {
  const h = await createHarness(browser, t), old = cards(100000, 60);
  await h.page.evaluate(({ old, layout }) => { document.body.innerHTML = layout + '<div class="grid">' + old + '</div>'; }, { old, layout });
  const known = S.fingerprint(Array.from({ length: 60 }, (_, i) => ({ source: "1688", product_id: String(100000 + i) })));
  await h.page.evaluate(({ newOne, all, old }) => {
    window.__INITIAL_STATE__ = { products: Array.from({ length: 60 }, (_, i) => ({ offerId: String(100000 + i), title: `Old item ${i}` })) };
    document.querySelector(".grid").innerHTML = old + newOne;
    setTimeout(() => { document.querySelector(".grid").innerHTML = all; }, 1800);
  }, { old, newOne: cards(200000, 1), all: cards(200000, 60) });
  const result = await h.page.evaluate(known => SupplierCollectorDOM.collect({ scroll: false, known_fingerprint: known, previousFingerprint: known, expected_count: 60 }), known);
  assert.equal(result.products.length, 60); assert.ok(result.products.every(item => Number(item.product_id) >= 200000));
  assert.equal(result.page.diagnostics.collection_quality.new_count, 60);
});

test("one new item mixed with 60 old items pauses without advancing or relabelling old products, then resumes all 60", async t => {
  const h = await createHarness(browser, t);
  h.flags.routeHtml = url => layout + `<div class="grid" data-page-size="60">${url.searchParams.get("page") === "2" ? cards(100000, 60) + cards(200000, 1) : cards(100000, 60)}</div><nav class="pagination"><a rel="next" href="?page=2">Next page</a></nav>`;
  await h.page.goto("https://s.1688.com/selloffer/offer_search.htm?page=1");
  await h.command("START", { query: "Regression", max_pages: 2, scroll: true, interval_seconds: 1 });
  await h.waitFor(data => data.run?.status === "paused", 60000); await h.waitFor(() => h.idle());
  assert.equal(h.data.run.pause_reason, "incomplete-results"); assert.equal(h.data.run.completed_pages, 1);
  assert.equal(h.data.collection.products.length, 61); assert.equal(h.data.collection.pages.filter(page => !page.partial).length, 1);
  assert.ok(h.data.collection.products.filter(item => Number(item.product_id) < 200000).every(item => item.source_page_url.endsWith("page=1")));
  assert.equal(h.data.collection.pages.at(-1).diagnostics.collection_quality.new_count, 1);
  await h.page.evaluate(html => { document.querySelector(".grid").innerHTML = html; document.querySelector("nav").innerHTML = '<button disabled>Next page</button>'; }, cards(200000, 60));
  assert.equal((await h.command("RESUME")).ok, true);
  await h.waitFor(data => data.run?.status === "finished", 30000);
  assert.equal(h.data.run.completed_pages, 2); assert.equal(h.data.collection.products.length, 120);
  assert.equal(h.data.tasks[0].pages.length, 2); assert.ok(h.data.tasks[0].pages.every(page => !page.partial));
});

test("popup count and preview belong to the new task while all accumulated memory stays available", async t => {
  const h = await createHarness(browser, t); await collect(h, "Первый");
  await h.page.goto(h.initialUrl.replace("page=1", "page=2")); await collect(h, "Второй");
  assert.equal(h.data.collection.products.length, 3);
  const ui = await h.context.newPage();
  await ui.exposeFunction("__command", ({ type, options }) => h.command(type, options));
  await ui.addInitScript(() => { globalThis.chrome = { runtime: { sendMessage: message => __command(message) }, storage: { onChanged: { addListener() {} } } }; });
  await ui.route("https://collector.test/**", route => { const f = new URL(route.request().url()).pathname.slice(1); return route.fulfill({ body: fs.readFileSync(path.join(__dirname, "../extension", f)), contentType: f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "text/html; charset=utf-8" }); });
  await ui.goto("https://collector.test/popup.html"); await ui.waitForFunction(() => document.getElementById("count").textContent === "2");
  assert.match(await ui.locator("#task-count").textContent(), /Всего товаров в памяти: 3/);
  assert.match(await ui.locator("#count-label").textContent(), /задании/);
  assert.doesNotMatch(await ui.locator("#preview").textContent(), /不锈钢保温杯/);
  await h.command("START", { query: "Третий", max_pages: 1, scroll: true });
  const state = (await h.command("STATE")).result;
  assert.equal(state.current_task.product_count, 0); assert.equal(state.current_task.page_count, 0); assert.equal(state.current_task.preview.length, 0); assert.equal(state.count, 3);
  await h.command("PAUSE"); await h.waitFor(() => h.idle());
});

test("a genuine short last page is accepted despite the preceding full page and page-size setting", async t => {
  const h = await createHarness(browser, t);
  h.flags.routeHtml = url => layout + `<div class="grid" data-page-size="60">${url.searchParams.get("page") === "2" ? cards(200000, 1) : cards(100000, 60)}</div><nav class="pagination">${url.searchParams.get("page") === "2" ? '<button disabled aria-label="Next page">Next page</button>' : '<a rel="next" href="?page=2">Next page</a>'}</nav>`;
  await h.page.goto("https://s.1688.com/selloffer/offer_search.htm?page=1");
  await h.command("START", { max_pages: 2, scroll: true, interval_seconds: 1 });
  await h.waitFor(data => data.run?.status === "finished", 30000);
  assert.equal(h.data.run.completed_pages, 2); assert.equal(h.data.collection.products.length, 61);
  assert.equal(h.data.collection.pages[1].diagnostics.collection_quality.terminal, true);
});

test("1688 page identity waits for the rendered page to match the explicit URL and supports URLs without a page number", async t => {
  const h = await createHarness(browser, t);
  await h.page.goto("https://s.1688.com/selloffer/offer_search.htm?beginPage=10");
  const html = Array.from({ length: 3 }, (_, i) => `<article class="offer-card" data-renderkey="0_normal_${300000 + i}" data-exposure="type@NORMAL^page_num@9^page_size@3^scene@search"><a href="https://detail.1688.com/offer/${300000 + i}.html">Test ${i}</a><span class="price">¥12</span></article>`).join("");
  const diagnostics = await h.page.evaluate(html => {
    const wrong = SupplierCollectorEngine.fromHTML(html, { url: location.href }).diagnostics;
    const spa = SupplierCollectorEngine.fromHTML(html, { url: "https://s.1688.com/selloffer/offer_search.htm" }).diagnostics;
    document.body.innerHTML = html;
    setTimeout(() => document.querySelectorAll("[data-exposure]").forEach(node => node.setAttribute("data-exposure", "type@NORMAL^page_num@10^page_size@3^scene@search")), 1000);
    return { wrong, spa };
  }, html);
  assert.equal(diagnostics.wrong.page_context.mismatch, true);
  assert.equal(diagnostics.wrong.page_context.rendered_page, 9);
  assert.equal(diagnostics.spa.page_context.mismatch, false);
  assert.equal(S.collectionQuality([{ source: "1688", product_id: "300000" }], { page_context: diagnostics.wrong.page_context }).reason, "page-mismatch");
  const start = Date.now();
  const result = await h.page.evaluate(() => SupplierCollectorDOM.collect({ scroll: false }));
  assert.ok(Date.now() - start >= 900); assert.equal(result.products.length, 3);
  assert.equal(result.page.diagnostics.page_context.url_page, 10); assert.equal(result.page.diagnostics.page_context.rendered_page, 10);
});

test("Excel explicitly records the source site on every sheet and keeps the actual source origin", () => {
  const products = ["1688", "alibaba", "made-in-china", "web:catalog.example"].map((source, i) => ({ source, product_id: String(i), source_page_url: i === 3 ? "http://catalog.example/search?q=x" : `https://${["s.1688.com", "www.alibaba.com", "www.made-in-china.com"][i]}/search` }));
  const tasks = products.map((product, i) => ({ id: String(i), source: product.source, source_url: product.source_page_url, products: [product] }));
  const bytes = Excel.workbook({ products, tasks, suppliers: products.map(product => ({ source: product.source, products: [product] })) });
  const check = spawnSync("python3", ["-c", `import io,sys,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None
n={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
sites=['1688.com','alibaba.com','made-in-china.com','catalog.example']
for i in range(1,5):
 s=E.fromstring(z.read('xl/worksheets/sheet%d.xml'%i));rows=s.findall('x:sheetData/x:row',n)
 texts=lambda row:[(c.find('x:is/x:t',n).text or '') if c.find('x:is/x:t',n) is not None else '' for c in row]
 h=texts(rows[0]);assert 'Сайт-источник' in h;idx=h.index('Сайт-источник')
 assert [texts(row)[idx] for row in rows[1:]]==sites
 if i==1:assert texts(rows[-1])[h.index('Адрес сайта-источника')]=='http://catalog.example'
print('Sources and actual origins verified')`], { input: Buffer.from(bytes), encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("native supplier URLs reject product pages; deep cards ignore scripts and use genuine company names", async t => {
  assert.equal(S.supplierUrl("https://sample.en.made-in-china.com/product/AaBb/China-Item.html"), null);
  const h = await createHarness(browser, t);
  const html = `<div class="list-node"><div class="prod-img">${'<div>'.repeat(9)}<a href="https://sample.en.made-in-china.com/product/AaBb/China-Item.html"><img src="https://img.example/product.jpg"></a>${'</div>'.repeat(9)}</div><div class="prod-content"><h2>Sample item</h2><script>${'privateScriptText'.repeat(700)}</script><span class="price">$10</span><div class="company-info"><a href="https://sample.en.made-in-china.com/">Sample Factory Ltd.</a></div></div></div>`;
  const result = await h.page.evaluate(html => SupplierCollectorEngine.fromHTML(html, { url: "https://www.made-in-china.com/search" }), html);
  assert.equal(result.products.length, 1); assert.equal(result.products[0].shop_name, "Sample Factory Ltd."); assert.equal(result.products[0].supplier_url, "https://sample.en.made-in-china.com/");
});

test("product photos win over small status SVGs and country flags, including raw reanalysis", async t => {
  const h = await createHarness(browser, t);
  const html = '<article class="product-card"><img src="https://s.alicdn.com/@img/status-12-10.svg"><a href="https://www.alibaba.com/product-detail/Sample_1600000012345.html"><img class="searchx-product-e-slider__img" src="https://img.example/item.jpg">Sample item</a><img src="https://cdn.example/flags/cn.png"><span class="price">$10</span></article>';
  const result = await h.page.evaluate(html => SupplierCollectorEngine.fromHTML(html, { url: "https://www.alibaba.com/search" }), html);
  assert.equal(result.products[0].image_url, "https://img.example/item.jpg");
  const reparsed = await h.page.evaluate(cards => SupplierCollectorEngine.reparse(cards), result.raw_cards);
  assert.equal(reparsed[0].image_url, "https://img.example/item.jpg");
});
