"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { createHarness } = require("./helpers/background-harness.cjs");
let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});
after(async () => { await browser?.close(); });

test("background with simulated Chrome APIs collects two real DOM pages and exports complete JSON", async t => {
  const h = await createHarness(browser, t);
  assert.equal((await h.command("START", { max_pages: 3, scroll: false, query: "Чашки" })).ok, true);
  await h.waitFor(data => data.run?.status === "finished");
  const state = (await h.command("STATE")).result;
  assert.equal(state.count, 3);
  assert.equal(state.page_count, 2);
  assert.equal(state.run.completed_pages, 2);
  assert.match(state.run.message, /кнопка/);
  assert.equal((await h.command("EXPORT")).ok, true);
  const output = JSON.parse(decodeURIComponent(h.downloads[0].url.split(",").slice(1).join(",")));
  assert.equal(output.total_products, 3);
  assert.equal(output.schema_version, 2);
  assert.equal(output.pages.length, 2);
  const duplicate = output.products.find(item => item.product_id === "1001");
  assert.equal(duplicate.price, "¥12.50");
  assert.equal(duplicate.shop_name, "浙江水杯工厂");
  assert.equal(duplicate.sightings.length, 2);
  assert.equal(duplicate.query, "Чашки");
  assert.equal(output.products.find(item => item.product_id === "1002").minimum_order, null);
  assert.equal(h.downloads[0].saveAs, true);
});

test("stop prevents a pending collection from overwriting the stopped job", async t => {
  const h = await createHarness(browser, t);
  await h.command("START", { max_pages: 1, scroll: false });
  await h.waitFor(data => data.run?.status === "finished");
  const count = h.data.collection.products.length;
  await h.command("START", { max_pages: 3, scroll: true });
  assert.equal((await h.command("START", { max_pages: 1, scroll: false })).ok, false);
  assert.equal((await h.command("CLEAR")).ok, false);
  assert.equal((await h.command("STOP")).ok, true);
  await h.waitFor(() => h.idle());
  assert.equal(h.data.run.status, "stopped");
  assert.equal(h.data.collection.products.length, count);
  assert.equal((await h.command("EXPORT")).ok, true);
  assert.equal((await h.command("CLEAR")).ok, true);
  assert.equal((await h.command("STATE")).result.count, 0);
  assert.equal((await h.command("EXPORT")).ok, false);
});

test("stored checkpoints resume after a background restart", async t => {
  const h = await createHarness(browser, t);
  await h.command("START", { max_pages: 1, scroll: false });
  await h.waitFor(data => data.run?.status === "finished");
  await h.waitFor(() => h.idle());
  await h.page.goto(h.initialUrl.replace("page=1", "page=2"));
  h.data.run.status = "running";
  h.data.run.max_pages = 2;
  h.resume();
  await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.run.completed_pages, 2);
  assert.equal(h.data.collection.products.length, 3);
});

test("captcha pauses collection, invalid tabs and untrusted messages are rejected", async t => {
  const h = await createHarness(browser, t);
  await h.page.evaluate(() => {
    const captcha = document.createElement("div"); captcha.className = "nc-container"; captcha.textContent = "滑动验证"; document.body.prepend(captcha);
  });
  await h.command("START", { max_pages: 1, scroll: false });
  await h.waitFor(data => data.run?.status === "paused");
  assert.match(h.data.run.message, /проверку безопасности/);
  assert.equal((await h.command("STATE")).result.count, 0);
  await h.waitFor(() => h.idle());
  await h.page.goto("https://example.org/");
  assert.equal((await h.command("START", { max_pages: 1 })).ok, false);
  assert.equal((await h.command("CLEAR", null, { id: "other-extension", url: "https://example.org/" })).ok, false);
});

test("detail enrichment fills a missing shop and groups its products with the known storefront", async t => {
  const h = await createHarness(browser, t);
  await h.command("START", { max_pages: 1, scroll: false, enrich: true, interval_seconds: 1 });
  await h.waitFor(data => data.run?.status === "finished");
  const item = h.data.collection.products.find(product => product.product_id === "1002");
  assert.equal(item.shop_name, "浙江水杯工厂"); assert.equal(item.supplier_url, "https://cupfactory.1688.com/");
  assert.equal(item.price, "¥15"); assert.ok(item.detail_checked_at);
  const state = (await h.command("DATA")).result;
  assert.equal(state.supplier_count, 1); assert.equal(state.suppliers[0].products.length, 2); assert.equal(state.run.detail_index, 1);
  assert.ok(h.data.collection.raw_cards.length);
});

test("one representative card enriches a known supplier's products without copying product prices", async t => {
  const h = await createHarness(browser, t);
  await h.command("IMPORT", { data: { products: ["1001", "1002"].map(id => ({ source: "1688", product_url: `https://detail.1688.com/offer/${id}.html`, supplier_id: "b2b-samefactory", price: id === "1002" ? "¥20" : null })) } });
  await h.command("ENRICH", { interval_seconds: 1 }); await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.run.detail_total, 1);
  assert.deepEqual(h.data.collection.products.map(item => item.shop_name), ["浙江水杯工厂", "浙江水杯工厂"]);
  assert.equal(h.data.collection.products[1].price, "¥20");
  assert.equal(h.data.collection.products[1].field_sources.shop_name, "verified-card:shared-supplier-identity");
});

test("captcha in a detail tab preserves the queue and resumes after manual completion", async t => {
  const h = await createHarness(browser, t); h.flags.detailChallenge = true;
  await h.command("START", { max_pages: 1, scroll: false, enrich: true, interval_seconds: 1 });
  await h.waitFor(data => data.run?.status === "paused");
  assert.equal(h.data.run.pause_reason, "challenge"); assert.equal(h.data.run.detail_index, 0);
  assert.equal(h.data.collection.products.length, 2);
  await h.waitFor(() => h.idle());
  const tab = h.tabs.get(h.data.run.detail_tab_id);
  await tab.setContent(h.detailHtml);
  assert.equal((await h.command("RESUME")).ok, true);
  await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.run.detail_index, 1); assert.equal(h.data.collection.products[1].shop_name, "浙江水杯工厂");
});

test("manual pause keeps partial scroll data and resume continues the checkpoint", async t => {
  const h = await createHarness(browser, t);
  await h.command("START", { max_pages: 1, scroll: true, interval_seconds: 1 });
  await new Promise(resolve => setTimeout(resolve, 500));
  await h.command("PAUSE"); await h.waitFor(() => h.idle());
  assert.equal(h.data.run.status, "paused"); assert.ok(h.data.collection.products.length);
  assert.equal(h.data.run.completed_pages, 0);
  await h.command("RESUME"); await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.run.completed_pages, 1);
  assert.equal(h.data.collection.pages.filter(page => !page.partial).length, 1);
});

test("legacy JSON import, raw export and CSV retain usable supplier data", async t => {
  const h = await createHarness(browser, t);
  assert.equal((await h.command("IMPORT", { data: { products: [{ source: "1688", product_url: "https://detail.1688.com/offer/123.html", title: "=1+1", shop_name: null }] } })).ok, true);
  assert.equal((await h.command("STATE")).result.count, 1);
  await h.command("EXPORT", { format: "csv" });
  assert.match(decodeURIComponent(h.downloads[0].url), /'=1\+1/);
  await h.command("EXPORT", { format: "raw" });
  const raw = JSON.parse(decodeURIComponent(h.downloads[1].url.split(",").slice(1).join(",")));
  assert.equal(raw.schema_version, 2); assert.ok(Array.isArray(raw.raw_cards)); assert.equal(raw.unresolved_products.length, 1);
});

test("the dashboard shows unique suppliers and their product tree, filters products and exposes task history", async t => {
  const h = await createHarness(browser, t);
  await h.command("START", { max_pages: 1, scroll: false, interval_seconds: 1, enrich: true });
  await h.waitFor(data => data.run?.status === "finished");
  const dashboard = await h.context.newPage(); await dashboard.setViewportSize({ width: 1440, height: 1050 });
  await dashboard.exposeFunction("__backgroundCommand", ({ type, options }) => h.command(type, options));
  await dashboard.addInitScript(() => { globalThis.chrome = { runtime: { sendMessage: message => __backgroundCommand(message) }, storage: { onChanged: { addListener() {} } } }; });
  await dashboard.route("https://collector.test/**", route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    const contentType = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8";
    return route.fulfill({ body: fs.readFileSync(path.join(__dirname, "../extension", file)), contentType });
  });
  await dashboard.goto("https://collector.test/dashboard.html");
  await dashboard.waitForFunction(() => document.getElementById("supplier-count").textContent === "1");
  assert.equal(await dashboard.locator(".supplier-name").count(), 1);
  assert.equal(await dashboard.locator(".product-tree tbody tr").count(), 2);
  assert.ok((await dashboard.locator("#log li").count()) > 2);
  assert.equal(await dashboard.locator("#missing-names").textContent(), "0");
  await dashboard.locator("#filter").fill("1002");
  assert.equal(await dashboard.locator(".product-tree tbody tr").count(), 1);
  await dashboard.locator("#filter").fill("");
  await dashboard.locator("#export-csv").click(); await h.waitFor(() => h.downloads.length === 1);
  assert.match(h.downloads[0].filename, /\.csv$/);
  fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true });
  await dashboard.screenshot({ path: path.join(__dirname, "../test-results/dashboard.png"), fullPage: true });
});

test("the popup renders collection state, escapes titles and triggers JSON export", async t => {
  const h = await createHarness(browser, t);
  await h.command("START", { max_pages: 1, scroll: false });
  await h.waitFor(data => data.run?.status === "finished");
  h.data.collection.products[0].title = '<img src=x onerror="alert(1)">';
  const popup = await h.context.newPage({ viewport: { width: 400, height: 760 } });
  await popup.exposeFunction("__backgroundCommand", ({ type, options }) => h.command(type, options));
  await popup.addInitScript(() => {
    globalThis.chrome = {
      runtime: { sendMessage: message => __backgroundCommand(message) },
      storage: { onChanged: { addListener() {} } }
    };
  });
  await popup.route("https://collector.test/**", route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    const contentType = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8";
    return route.fulfill({ body: fs.readFileSync(path.join(__dirname, "../extension", file)), contentType });
  });
  await popup.goto("https://collector.test/popup.html");
  await popup.waitForFunction(() => document.getElementById("count").textContent === "2");
  assert.equal(await popup.locator("#preview img").count(), 0);
  assert.match(await popup.locator("#preview").textContent(), /<img src=x/);
  await popup.locator("#export").click();
  await h.waitFor(() => h.downloads.length === 1);
  // Capture the real popup layout using fixture data, not a live 1688 collection.
  h.data.collection.products[0].title = "透明水杯 500ml";
  await popup.reload();
  await popup.waitForFunction(() => document.getElementById("count").textContent === "2");
  fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true });
  await popup.screenshot({ path: path.join(__dirname, "../test-results/popup.png"), fullPage: true });
});
