"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");

test("native installed extension: pagination, persistent collection, JSON download and stop", { timeout: 60000 }, async t => {
  const extensionPath = path.resolve(__dirname, "../extension");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "1688-viewer-test-"));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    acceptDownloads: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-extension-debugging"]
  });
  t.after(async () => { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: extensionPath });
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path.join(profile, "downloads") });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const errors = [];
  worker.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  assert.equal(new URL(worker.url()).host, extensionId);
  const first = fs.readFileSync(path.join(__dirname, "fixtures/results.html"), "utf8");
  const second = fs.readFileSync(path.join(__dirname, "fixtures/results-page2.html"), "utf8");
  const url = "https://s.1688.com/selloffer/offer_search.htm?keywords=%E6%B0%B4%E6%9D%AF&page=1";
  await context.route("https://**/*", route => {
    const request = route.request();
    if (request.resourceType() !== "document") return route.abort();
    const page2 = new URL(request.url()).searchParams.get("page") === "2";
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: page2 ? second : first });
  });
  const results = await context.newPage();
  await results.goto(url);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  // The popup is opened as a test document; collection still targets the search tab.
  await results.bringToFront();
  async function command(type, options) {
    return popup.evaluate(async ({ type, options }) => chrome.runtime.sendMessage({ target: "1688-background", type, options }), { type, options });
  }
  async function waitFinished() {
    await popup.waitForFunction(async () => {
      const { run } = await chrome.storage.local.get("run");
      return run && run.status !== "running";
    }, null, { timeout: 25000 });
    return (await command("STATE")).result;
  }

  await t.test("two pages collect three products and retain fields from the first sighting", async () => {
    const started = await command("START", { max_pages: 3, scroll: false, query: "Водяные чашки" });
    assert.equal(started.ok, true);
    const state = await waitFinished();
    assert.equal(state.run.status, "finished");
    assert.equal(state.run.completed_pages, 2);
    assert.equal(state.count, 3);
    assert.equal(state.page_count, 2);
    const { collection } = await popup.evaluate(() => chrome.storage.local.get("collection"));
    assert.equal(collection.products.find(item => item.product_id === "1001").price, "¥12.50");
    assert.equal(collection.products.find(item => item.product_id === "1001").sightings.length, 2);
    assert.equal(collection.products[0].query, "Водяные чашки");
    await popup.waitForFunction(() => document.getElementById("count").textContent === "3");
  });

  await t.test("reopening the popup retains data and downloaded JSON matches storage", async () => {
    await popup.reload();
    assert.equal((await command("STATE")).result.count, 3);
    const response = await command("EXPORT");
    assert.equal(response.ok, true);
    // Chrome's downloads API may not emit Playwright's page download event for a worker.
    await popup.waitForFunction(async id => {
      const [download] = await chrome.downloads.search({ id });
      return download?.state === "complete";
    }, response.result.download_id, { timeout: 10000 });
    const filename = await popup.evaluate(async id => (await chrome.downloads.search({ id }))[0].filename, response.result.download_id);
    const output = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert.equal(output.schema_version, 3);
    assert.equal(output.total_products, 3);
    assert.equal(output.pages.length, 2);
    assert.equal(output.products.find(item => item.product_id === "1002").minimum_order, null);
    assert.equal(output.products.find(item => item.product_id === "1003").price, "￥8.00–10.00");
    fs.rmSync(filename);
  });

  await t.test("an interrupted collection preserves existing data", async () => {
    await results.goto(url);
    await results.bringToFront();
    assert.equal((await command("START", { max_pages: 2, scroll: true })).ok, true);
    assert.equal((await command("START", { max_pages: 1, scroll: false })).ok, false);
    await command("STOP");
    const state = await waitFinished();
    assert.equal(state.run.status, "stopped");
    assert.equal(state.count, 3);
  });

  await t.test("sites without granted access are rejected without clearing existing data", async () => {
    await results.goto("https://example.org/");
    await results.bringToFront();
    // Allow the cancellation of the in-flight content operation to complete.
    await new Promise(resolve => setTimeout(resolve, 700));
    const response = await command("START", { max_pages: 1, scroll: false });
    assert.equal(response.ok, false);
    assert.match(response.error, /доступ/);
    assert.equal((await command("STATE")).result.count, 3);
    assert.equal((await command("CLEAR")).ok, true);
    assert.equal((await command("STATE")).result.count, 0);
    assert.equal((await command("EXPORT")).ok, false);
  });
  assert.deepEqual(errors, []);
});
