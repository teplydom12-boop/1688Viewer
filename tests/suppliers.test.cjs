"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { chromium } = require("playwright-core");
const { createHarness } = require("./helpers/background-harness.cjs");
const S = require("../extension/shared.js"), C = require("../extension/suppliers-core.js");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
function product(id, extra = {}) { return { source: "1688", product_id: String(id), product_url: "https://detail.1688.com/offer/" + id + ".html", title: "Cup " + id, observation_id: "obs-" + id, collected_at: "2026-10-15T10:00:00Z", ...extra }; }
function task(id, products, extra = {}) { return { id, query: "Поиск " + id, source: products[0]?.source || "1688", kind: "collection", status: "finished", started_at: "2026-10-15T10:00:00Z", completed_pages: 1, max_pages: 1, products, pages: [], log: [], ...extra }; }
function seed(h, tasks) { h.data.tasks = structuredClone(tasks); h.data.collection = { products: tasks.flatMap(item => item.products), pages: [], raw_cards: [] }; }
async function prepare(h, ids, interval_seconds = 1) { const response = await h.command("SUPPLIERS_PREPARE", { task_ids: ids, interval_seconds }); assert.equal(response.ok, true, response.error); return h.data.supplier_search; }
async function start(h) { const response = await h.command("SUPPLIERS_START"); assert.equal(response.ok, true, response.error); }
async function done(h) { await h.waitFor(data => data.supplier_search?.status === "finished"); await h.waitFor(() => h.stage2Idle()); return (await h.command("SUPPLIERS_STATE")).result; }
const download = h => JSON.parse(decodeURIComponent(h.downloads.at(-1).url.split(",").slice(1).join(",")));

test("supplier search preserves every selected appearance and uses no price/MOQ filtering", () => {
  const tasks = [task("a", [product(1, { price: "1", minimum_order: "999999" }), product(1, { price: "999999", observation_id: "again" })]), task("b", [product(1), product(2)])];
  const before = structuredClone(tasks), rows = C.rowsFromTasks(tasks, {});
  assert.equal(rows.length, 4); assert.equal(C.queue(rows).length, 2); assert.deepEqual(tasks, before);
  assert.equal(new Set(rows.map(row => row.stage2_row_id)).size, 4);
});

test("supplier identity is scoped by platform; equal names and images never establish a seller", () => {
  const rows = C.rowsFromTasks([task("a", [product(1, { shop_name: "Same", image_url: "https://img.example/same.jpg" }), product(2, { shop_name: "Same", supplier_id: "42" }), product(3, { shop_name: "Same", source: "alibaba", supplier_id: "42" }), product(4, { shop_name: "Same", supplier_id: "43" })])], {});
  const report = C.report({ id: "j", products: rows, source_tasks: [], queue: C.queue(rows), cursor: 0, opened_keys: [], checked_count: 0 });
  assert.equal(report.total_suppliers, 3); assert.equal(report.unknown_cards, 1); assert.equal(report.suppliers.at(-1).shop_name, "Поставщик неизвестен");
});

test("saved supplier IDs share only company fields and reduce the queue to one representative", () => {
  const rows = C.rowsFromTasks([task("a", [product(1, { supplier_id: "owner", price: "10" }), product(2, { supplier_id: "owner", price: "20" })])], {}), queue = C.queue(rows);
  assert.equal(queue.length, 1);
  C.applyDetail(rows, queue[0], { source: "1688", supplier_id: null, shop_name: "Factory", supplier_url: "https://factory.1688.com/" }, "now");
  assert.deepEqual(rows.map(row => row.supplier.shop_name), ["Factory", "Factory"]); assert.deepEqual(rows.map(row => row.price), ["10", "20"]);
  assert.equal(C.queue(rows).length, 0);
});

test("a known storefront without a display name needs no card opening", async t => {
  const h = await createHarness(browser, t); seed(h, [task("a", [product(1, { supplier_id: "maker", supplier_url: "https://maker.1688.com/" }), product(2, { supplier_id: "maker" })])]);
  await prepare(h, ["a"]); const state = (await h.command("SUPPLIERS_STATE")).result;
  assert.equal(state.job.status, "finished"); assert.equal(state.job.queue.length, 0); assert.equal(h.tabs.size, 1);
  assert.equal(state.result.total_suppliers, 1); assert.equal(state.result.suppliers[0].shop_name, "maker.1688.com"); assert.equal(state.result.suppliers[0].products.length, 2);
});

test("conflicting seller evidence and redirected recommendations cannot silently join suppliers", () => {
  const rows = C.rowsFromTasks([task("a", [product(1, { supplier_id: "one" }), product(1, { supplier_id: "two" })])], {}), queue = C.queue(rows);
  assert.ok(rows.every(row => row.supplier_conflict)); assert.equal(queue.length, 1);
  assert.equal(C.matchDetail(queue[0], rows, [product(999, { supplier_url: "https://wrong.1688.com/" })]), null);
  C.applyDetail(rows, queue[0], { source: "1688", supplier_id: "verified", shop_name: "Verified", supplier_url: "https://verified.1688.com/" }, "now");
  assert.ok(rows.every(row => row.supplier.supplier_id === "verified" && !row.supplier_conflict));
});

test("stage 2 prepares mixed-site snapshots without network and skip produces a complete uniform JSON", async t => {
  const h = await createHarness(browser, t);
  seed(h, [task("a", [product(1, { shop_name: "Factory", supplier_url: "https://factory.1688.com/" }), product(2), product(2)]), task("b", [product(3, { source: "alibaba", product_url: "https://www.alibaba.com/product-detail/Cup_3.html" })]), task("unselected", [product(999)])]);
  const original = structuredClone(h.data.tasks);
  await prepare(h, ["a", "b", "a"]); assert.equal(h.tabs.size, 1); assert.equal(h.data.supplier_search.queue.length, 2);
  const prepared = (await h.command("SUPPLIERS_STATE")).result;
  assert.equal(prepared.result.total_cards, 4); assert.equal(prepared.result.total_suppliers, 1); assert.equal(prepared.result.unknown_cards, 3);
  assert.deepEqual(Array.from(prepared.result.sources), ["1688", "alibaba"]);
  assert.equal((await h.command("SUPPLIERS_SKIP")).ok, true); await h.command("SUPPLIERS_EXPORT", { format: "json" });
  const result = download(h); assert.equal(result.status, "finished"); assert.equal(result.card_checks.opened, 0); assert.equal(result.card_checks.skipped, 2);
  assert.equal(result.suppliers.at(-1).shop_name, "Поставщик неизвестен"); assert.ok(result.products.every(row => row.product_id !== "999"));
  assert.deepEqual(h.data.tasks, original); assert.equal(h.tabs.size, 1);
});

test("one real detail read enriches repeat appearances across chosen tasks and caches positive evidence", async t => {
  const h = await createHarness(browser, t); seed(h, [task("a", [product(1001), product(1001, { price: "90" })]), task("b", [product(1001)])]);
  const original = structuredClone(h.data.tasks);
  await prepare(h, ["a", "b"]); await start(h); const state = await done(h);
  assert.equal(state.job.checked_count, 1); assert.equal(state.job.opened_keys.length, 1); assert.equal(h.tabs.size, 2);
  assert.equal(state.result.total_cards, 3); assert.equal(state.result.total_suppliers, 1); assert.equal(state.result.suppliers[0].products.length, 3);
  assert.equal(state.result.suppliers[0].shop_name, "浙江水杯工厂"); assert.deepEqual(h.data.tasks, original);
  await prepare(h, ["b"]); assert.equal(h.data.supplier_search.status, "finished"); assert.equal(h.data.supplier_search.queue.length, 0); assert.equal(h.tabs.size, 2);
  assert.equal((await h.command("SUPPLIERS_STATE")).result.result.total_cards, 1);
});

test("card checks respect the configured interval and resume a persisted wait without another early open", async t => {
  const h = await createHarness(browser, t); seed(h, [task("a", [product(1001), product(1002)])]);
  const opened = []; h.flags.routeHtml = url => { if (url.hostname === "detail.1688.com") { opened.push({ at: Date.now(), url: url.href }); return h.detailHtml; } };
  await prepare(h, ["a"], 2); await start(h);
  await h.waitFor(data => data.supplier_search?.cursor === 1);
  const nextAt = h.data.supplier_search.next_open_at; h.resume();
  await done(h); assert.equal(opened.length, 2); assert.ok(opened[1].at >= nextAt, "restart must preserve the next-opening deadline");
  assert.equal(h.data.supplier_search.opened_keys.length, 2); assert.equal(h.data.supplier_search.checked_count, 2);
});

for (const [source, url, store] of [
  ["1688", "https://detail.1688.com/offer/1001.html", "https://cupfactory.1688.com/"],
  ["alibaba", "https://www.alibaba.com/product-detail/Cup_1001.html", "https://cupfactory.en.alibaba.com/"],
  ["made-in-china", "https://cupfactory.en.made-in-china.com/product/AbCd/Cup.html", "https://cupfactory.en.made-in-china.com/"]
]) test(source + ": captcha pauses stage 2, unresolved captcha cannot resume, one click continues the same card", async t => {
  const h = await createHarness(browser, t), id = S.productUrl(url).id;
  let blocked = true, navigations = 0;
  h.flags.routeHtml = target => { if (target.href === url) { navigations++; return blocked ? '<div class="nc-container">滑动验证</div>' : '<h1>Cup</h1><a class="company-name" href="' + store + '">Cup Factory</a>'; } };
  seed(h, [task("a", [product(id, { source, product_url: url })])]);
  await prepare(h, ["a"]); await start(h); await h.waitFor(data => data.supplier_search?.status === "paused"); await h.waitFor(() => h.stage2Idle());
  assert.equal(h.data.supplier_search.pause_reason, "challenge"); assert.equal(h.data.supplier_search.cursor, 0);
  assert.equal(h.data.supplier_search.opened_keys.length, 1); assert.equal((await h.command("SUPPLIERS_START")).ok, false); assert.equal(navigations, 1);
  blocked = false; await h.tabs.get(h.data.supplier_search.tab_id).setContent('<h1>Cup</h1><a class="company-name" href="' + store + '">Cup Factory</a>');
  await start(h); const result = (await done(h)).result;
  assert.equal(result.suppliers[0].supplier_url, store); assert.equal(result.card_checks.opened, 1); assert.equal(result.card_checks.checked, 1); assert.equal(navigations, 1);
});

test("skipping an in-flight detail discards its late result and never opens the next card", async t => {
  const h = await createHarness(browser, t); seed(h, [task("a", [product(1001), product(1002)])]);
  h.flags.routeHtml = url => url.hostname === "detail.1688.com" ? '<h1>Cup</h1>' : null;
  await prepare(h, ["a"]); await start(h); await h.waitFor(data => data.supplier_search?.stage === "reading");
  assert.equal((await h.command("SUPPLIERS_SKIP")).ok, true); const finished = structuredClone(h.data.supplier_search);
  await h.waitFor(() => h.stage2Idle()); const state = (await h.command("SUPPLIERS_STATE")).result;
  assert.equal(state.result.unknown_cards, 2); assert.equal(state.job.checked_count, 0); assert.equal(state.job.opened_keys.length, 1);
  assert.equal(state.job.status, "finished"); assert.equal(h.tabs.size, 2); assert.deepEqual(state.result.products, finished.products);
});

test("an unreadable supplier remains unknown after checking and its row is retained", async t => {
  const h = await createHarness(browser, t); seed(h, [task("a", [product(1001)])]); h.flags.routeHtml = url => url.hostname === "detail.1688.com" ? '<h1>Cup without seller</h1>' : null;
  await prepare(h, ["a"]); await start(h); const state = await done(h);
  assert.equal(state.result.unknown_cards, 1); assert.equal(state.result.suppliers[0].shop_name, "Поставщик неизвестен");
  assert.equal(state.result.products[0].supplier_check, "unknown"); assert.equal(state.job.checked_count, 1);
});

test("supplier discovery excludes other offers' recommended stores on the detail page", async t => {
  const h = await createHarness(browser, t); seed(h, [task("a", [product(1001)])]);
  h.flags.routeHtml = url => url.hostname === "detail.1688.com" ? '<article data-offer-id="999"><a href="https://detail.1688.com/offer/999.html">Other product</a><a class="company-name" href="https://wrong.1688.com/">Wrong shop</a></article><h1>Main cup</h1><a class="company-name" href="https://right.1688.com/">Right shop</a>' : null;
  await prepare(h, ["a"]); await start(h); const state = await done(h);
  assert.equal(state.result.suppliers[0].supplier_url, "https://right.1688.com/"); assert.equal(state.result.suppliers[0].shop_name, "Right shop");
});

test("custom websites require exact-origin access and denied access makes no product navigation", async t => {
  const h = await createHarness(browser, t), url = "https://catalog.example/items/cup";
  seed(h, [task("web", [product("web-cup", { source: "web:catalog.example", product_url: url })])]);
  h.flags.routeHtml = target => target.href === url ? '<main itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">Cup</h1><span itemprop="price">12</span><div itemprop="seller" itemscope itemtype="https://schema.org/Organization"><span itemprop="name">Local maker</span><a itemprop="url" href="/vendors/maker">Store</a></div></main>' : null;
  await prepare(h, ["web"]); assert.deepEqual(Array.from((await h.command("SUPPLIERS_STATE")).result.required_origins), ["https://catalog.example/*"]);
  await start(h); await h.waitFor(data => data.supplier_search?.status === "paused"); await h.waitFor(() => h.stage2Idle()); assert.equal(h.tabs.size, 1);
  assert.equal(h.data.supplier_search.pause_reason, "permission"); h.granted.add("https://catalog.example/*"); await start(h);
  const state = await done(h); assert.equal(state.result.total_suppliers, 1); assert.equal(state.result.suppliers[0].supplier_url, "https://catalog.example/vendors/maker");
});

test("stage 1 and stage 2 cannot run together, and deleting selected history removes dependent stage 2 memory", async t => {
  const h = await createHarness(browser, t); seed(h, [task("a", [product(1001), product(1002)])]);
  await prepare(h, ["a"], 30); await start(h); await h.waitFor(data => data.supplier_search?.cursor === 1);
  for (const [type, options] of [["START", { max_pages: 1 }], ["DELETE_TASK", { id: "a" }], ["CLEAR"], ["SUPPLIERS_PREPARE", { task_ids: ["a"] }]]) assert.equal((await h.command(type, options)).ok, false, type);
  await h.command("SUPPLIERS_PAUSE"); await h.waitFor(() => h.stage2Idle());
  assert.equal((await h.command("DELETE_TASK", { id: "a" })).ok, true); assert.equal(h.data.supplier_search, undefined); assert.equal(h.data.supplier_search_cache, undefined);
  h.resume(); await h.waitFor(() => h.stage2Idle() && h.idle()); assert.equal((await h.command("SUPPLIERS_START")).ok, false);
});

test("closed working tabs pause safely, interval changes apply, and CLEAR removes results and cache", async t => {
  const h = await createHarness(browser, t); seed(h, [task("a", [product(1001), product(1002)])]);
  await prepare(h, ["a"], 30); await start(h); await h.waitFor(data => data.supplier_search?.cursor === 1);
  await h.closeTab(h.data.supplier_search.tab_id); await h.waitFor(data => data.supplier_search?.status === "paused"); await h.waitFor(() => h.stage2Idle());
  assert.equal(h.data.supplier_search.pause_reason, "tab-closed"); assert.equal((await h.command("SUPPLIERS_INTERVAL", { interval_seconds: 1 })).ok, true);
  await start(h); await done(h); assert.equal(h.data.supplier_search.checked_count, 2);
  assert.equal((await h.command("CLEAR")).ok, true); assert.deepEqual(h.data, {});
});

test("supplier-search commands validate tasks, intervals, formats and trusted UI senders", async t => {
  const h = await createHarness(browser, t); seed(h, [task("a", [product(1)])]);
  for (const options of [{ task_ids: [] }, { task_ids: ["missing"] }, { task_ids: ["a"], interval_seconds: 0 }, { task_ids: ["a"], interval_seconds: 301 }]) assert.equal((await h.command("SUPPLIERS_PREPARE", options)).ok, false);
  assert.equal((await h.command("SUPPLIERS_PREPARE", { task_ids: ["a"] }, { id: "testextension", url: "https://s.1688.com/", tab: { id: 1 } })).ok, false);
  await prepare(h, ["a"]); assert.equal((await h.command("SUPPLIERS_EXPORT", { format: "html" })).ok, false);
  assert.equal((await h.command("SUPPLIERS_STATE", {}, { id: "testextension", url: "chrome-extension://testextension/suppliers.html#result" })).ok, true);
});

test("fragment-based product routes cannot reuse the previous card's seller", async t => {
  const h = await createHarness(browser, t), first = "https://catalog.example/#/items/one", second = "https://catalog.example/#/items/two";
  seed(h, [task("web", [product("one", { source: "web:catalog.example", product_url: first }), product("two", { source: "web:catalog.example", product_url: second })])]);
  h.granted.add("https://catalog.example/*");
  h.flags.routeHtml = url => url.hostname === "catalog.example" ? '<main itemscope itemtype="https://schema.org/Product"></main><script>function paint(){const id=location.hash.endsWith("one")?"one":"two";document.querySelector("main").innerHTML=\'<h1 itemprop="name">Cup \'+id+\'</h1><span itemprop="price">12</span><div itemprop="seller" itemscope itemtype="https://schema.org/Organization"><span itemprop="name">Maker \'+id+\'</span><a itemprop="url" href="/vendors/\'+id+\'">Store</a></div>\';}paint();window.onhashchange=()=>setTimeout(paint,3000);</script>' : null;
  await prepare(h, ["web"]); await start(h); const state = await done(h);
  assert.equal(state.result.total_suppliers, 2);
  assert.deepEqual(Array.from(state.result.products, row => row.supplier.shop_name), ["Maker one", "Maker two"]);
});

async function openUi(h) {
  const page = await h.context.newPage({ viewport: { width: 1450, height: 1100 } });
  await page.exposeFunction("__command", ({ type, options }) => h.command(type, options, { id: "testextension", url: "chrome-extension://testextension/suppliers.html" }));
  await page.addInitScript(() => { globalThis.chrome = { runtime: { sendMessage: message => __command(message) }, storage: { onChanged: { addListener: listener => { globalThis.__storageListener = listener; } } }, permissions: { request: async () => true } }; });
  h.observers.push((changes, area) => { if (!page.isClosed()) void page.evaluate(({ changes, area }) => globalThis.__storageListener?.(changes, area), { changes, area }).catch(() => {}); });
  await page.route("https://collector.test/**", route => { const file = new URL(route.request().url()).pathname.slice(1); return route.fulfill({ body: fs.readFileSync(path.join(__dirname, "../extension", file)), contentType: file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" }); });
  await page.goto("https://collector.test/suppliers.html"); await page.waitForFunction(() => document.querySelectorAll('#tasks input').length > 0); return page;
}

test("stage 2 UI selects mixed tasks, exposes queue/ETA/skip, renders safe trees and exports scoped JSON/Excel/CSV", async t => {
  const h = await createHarness(browser, t);
  seed(h, [task("a", [product(1001, { title: '<img src=x onerror="alert(1)">', shop_name: "Cup factory", supplier_url: "https://cupfactory.1688.com/", image_url: "https://cdn.example/cup.jpg" }), product(1002)]), task("b", [product(1003, { source: "alibaba", product_url: "https://www.alibaba.com/product-detail/Cup_1003.html" })])]);
  const page = await openUi(h); await page.locator("#select-all").click(); await page.locator("#prepare").click();
  await page.waitForFunction(() => document.getElementById('planned').textContent === '2');
  assert.equal(h.tabs.size, 1); assert.equal(await page.locator("#opened").textContent(), "0"); assert.match(await page.locator("#eta").textContent(), /≈/);
  await page.locator("#skip").click(); await page.waitForFunction(() => document.getElementById('result-state').textContent === 'Итоговый результат');
  assert.equal(await page.locator(".supplier-name").count(), 2); await page.locator("#expand-all").click(); assert.equal(await page.locator(".product-tree tbody tr").count(), 3);
  assert.equal(await page.locator("#suppliers img").count(), 0); assert.match(await page.locator("#suppliers").textContent(), /<img src=x/);
  await page.locator("#filter").fill("1002"); assert.equal(await page.locator(".product-tree tbody tr").count(), 1); await page.locator("#filter").fill("");
  await page.locator("#export-json").click(); await h.waitFor(() => h.downloads.length === 1); assert.equal(download(h).total_cards, 3);
  await page.locator("#export-csv").click(); await h.waitFor(() => h.downloads.length === 2); assert.match(decodeURIComponent(h.downloads.at(-1).url), /Поставщик неизвестен/);
  await page.locator("#export-xlsx").click(); await h.waitFor(() => h.openedUi.length === 1); assert.match(h.openedUi[0], /export.html\?stage=2$/);
  const snapshot = (await h.command("EXCEL_DATA", { stage: 2 })).result; assert.equal(snapshot.total_products, 3); assert.equal(snapshot.tasks.length, 2); assert.equal(snapshot.products.find(row => row.product_id === "1002").shop_name, "Поставщик неизвестен");
  const Excel = require("../extension/excel.js");
  fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true }); fs.writeFileSync(path.join(__dirname, "../test-results/stage2.xlsx"), Excel.workbook(snapshot));
  await page.screenshot({ path: path.join(__dirname, "../test-results/stage2.png"), fullPage: true });
  await page.reload(); await page.waitForFunction(() => document.getElementById('card-count').textContent === '3');
  assert.equal(await page.locator('#tasks input:checked').count(), 2); assert.equal(await page.locator('#result-state').textContent(), "Итоговый результат");
  await prepare(h, ["a"]); await page.waitForFunction(() => document.getElementById('card-count').textContent === '2');
  assert.equal(await page.locator('#tasks input:checked').count(), 1);
});

test("stage 2 UI opens the queue, displays progress, pauses and continues using the changed interval", async t => {
  const h = await createHarness(browser, t); seed(h, [task("a", [product(1001), product(1002)])]);
  const page = await openUi(h); await page.locator('#select-all').click(); await page.locator('#interval').fill('30'); await page.locator('#prepare').click();
  await page.locator('#start').click(); await page.waitForFunction(() => document.getElementById('checked').textContent === '1');
  assert.equal(await page.locator('#opened').textContent(), '1'); assert.equal(await page.locator('#remaining').textContent(), '1');
  await page.locator('#pause').click(); await h.waitFor(() => h.stage2Idle()); await page.waitForFunction(() => document.getElementById('eta').textContent === 'Пауза');
  await page.locator('#interval').fill('1'); await page.locator('#save-interval').click(); assert.equal(h.data.supplier_search.interval_ms, 1000);
  await page.locator('#start').click(); await done(h); await page.waitForFunction(() => document.getElementById('checked').textContent === '2');
  assert.equal(await page.locator('#progress').getAttribute('value'), '100'); assert.equal(await page.locator('#supplier-count').textContent(), '1');
});

test("stage 2 tree images keep the saved zoom, load on demand and do not reload on resize", async t => {
  const h = await createHarness(browser, t); seed(h, [task("a", [product(1001, { shop_name: "Factory", supplier_url: "https://cupfactory.1688.com/", image_url: "https://cdn.example/cup.jpg" })])]);
  let requests = 0;
  await h.context.route("https://cdn.example/**", route => { requests++; return route.fulfill({ contentType: "image/png", body: fs.readFileSync(path.join(__dirname, "fixtures/thumbnail.png")) }); });
  await prepare(h, ["a"]); const page = await openUi(h); await page.locator('#expand-all').click(); assert.equal(requests, 0);
  await page.locator('#toggle-images').click(); await page.waitForFunction(() => document.querySelector('.stage-thumbnail')?.naturalWidth > 0); assert.equal(requests, 1);
  await page.locator('#image-size').evaluate(node => { node.value = '192'; node.dispatchEvent(new Event('input')); });
  assert.equal(await page.locator('.stage-thumbnail').getAttribute('width'), '192');
  await page.locator('#image-size').dispatchEvent('change'); await h.waitFor(data => data.view_preferences?.history_image_size === 192); assert.equal(requests, 1);
  await page.reload(); await page.locator('#expand-all').click(); await page.waitForFunction(() => document.querySelector('.stage-thumbnail')?.width === 192);
  await page.locator('#toggle-images').click(); await page.waitForFunction(() => document.querySelectorAll('.stage-thumbnail').length === 0);
});
