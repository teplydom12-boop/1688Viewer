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
  assert.equal(output.schema_version, 1);
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
