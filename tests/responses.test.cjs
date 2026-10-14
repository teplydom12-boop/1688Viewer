"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { createHarness } = require("./helpers/background-harness.cjs");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
const payload = { products: [1, 2].map(id => ({ productId: String(id), title: `Response cup ${id}`, url: `/items/${id}`, price: 10, companyName: "Response factory", companyUrl: "/vendors/one", token: "private-marker" })), pagination: { hasNextPage: false }, auth: { password: "private-marker" } };
async function setup(t) {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.route("**/*", route => route.request().resourceType() === "document" ? route.fulfill({ body: "<!doctype html><body>Catalogue</body>", contentType: "text/html" }) : route.abort());
  await page.goto("https://catalog.example/search");
  for (const file of ["page-data.js", "response-observer.js"]) await page.addScriptTag({ path: path.join(__dirname, "../extension", file) });
  await page.evaluate(() => { window.__supplierResponseObservation.enabled = true; window.__supplierResponseObservation.epoch++; });
  return page;
}
test("fetch bodies remain intact, no extra request is made, and only business records are retained", async t => {
  const page = await setup(t); let requests = 0;
  await page.route("https://catalog.example/api/products", route => { requests++; return route.fulfill({ json: payload }); });
  const received = await page.evaluate(() => fetch("/api/products").then(response => response.json()));
  assert.deepEqual(received, payload);
  await page.waitForFunction(() => window.__supplierResponseObservation.responses === 1);
  const observed = await page.evaluate(() => window.__supplierResponseObservation);
  assert.equal(requests, 1); assert.equal(observed.products.length, 2);
  assert.doesNotMatch(JSON.stringify(observed), /private-marker|password/);
});
test("XHR JSON is observed without changing the application's parsed response", async t => {
  const page = await setup(t); await page.route("https://catalog.example/api/products", route => route.fulfill({ json: payload }));
  const received = await page.evaluate(() => new Promise((resolve, reject) => { const request = new XMLHttpRequest(); request.open("GET", "/api/products"); request.responseType = "json"; request.onload = () => resolve(request.response); request.onerror = reject; request.send(); }));
  assert.deepEqual(received, payload); assert.equal(await page.evaluate(() => window.__supplierResponseObservation.products.length), 2);
});
test("authentication endpoints and non-JSON resources are excluded", async t => {
  const page = await setup(t);
  await page.route("https://catalog.example/api/account", route => route.fulfill({ json: payload }));
  await page.route("https://catalog.example/image", route => route.fulfill({ body: JSON.stringify(payload), contentType: "text/plain" }));
  await page.evaluate(async () => { await fetch("/api/account").then(response => response.json()); await fetch("/image").then(response => response.text()); });
  assert.equal(await page.evaluate(() => window.__supplierResponseObservation.products.length), 0);
});
test("response limits do not truncate or consume the original application body", async t => {
  const page = await setup(t), large = { ...payload, padding: "x".repeat(2 * 1024 * 1024 + 100) };
  await page.route("https://catalog.example/api/large", route => route.fulfill({ json: large }));
  const size = await page.evaluate(() => fetch("/api/large").then(response => response.json()).then(data => data.padding.length));
  assert.equal(size, large.padding.length);
  await page.waitForFunction(() => window.__supplierResponseObservation.truncated);
  assert.equal(await page.evaluate(() => window.__supplierResponseObservation.products.length), 0);
});
test("a late permission signal cannot restart observation after a pause", async t => {
  const page = await setup(t);
  await page.evaluate(() => { const state = window.__supplierResponseObservation; state.enabled = false; state.blocked = true; document.dispatchEvent(new CustomEvent("supplier-response-control", { detail: { enabled: true } })); });
  assert.equal(await page.evaluate(() => window.__supplierResponseObservation.enabled), false);
});
test("a denied bootstrap permission leaves an unrelated tab inactive", async t => {
  const page = await setup(t);
  await page.evaluate(() => { window.__supplierResponseObservation.enabled = false; window.chrome = { runtime: { sendMessage: () => Promise.resolve({ ok: true, result: { allowed: false } }) } }; });
  await page.addScriptTag({ path: path.join(__dirname, "../extension/response-bootstrap.js") });
  assert.equal(await page.evaluate(() => window.__supplierResponseObservation.enabled), false);
});
test("the collection uses opted-in responses and stops observation when finished", async t => {
  const h = await createHarness(browser, t); h.granted.add("https://catalog.example/*");
  h.flags.routeHtml = () => '<main><p>Items are painted by the app</p></main>';
  let requests = 0;
  await h.context.route("https://catalog.example/api/products", route => { requests++; return route.fulfill({ json: payload }); });
  await h.page.goto("https://catalog.example/search");
  await h.command("START", { max_pages: 1, scroll: false, observe_responses: true });
  await h.waitFor(data => data.run?.response_tab_ids?.includes(1));
  await h.page.evaluate(() => fetch("/api/products").then(response => response.json()));
  await h.waitFor(data => data.run?.status === "finished"); await h.waitFor(() => h.idle());
  assert.equal(requests, 1); assert.equal(h.data.collection.products.length, 2);
  assert.ok(h.data.collection.products.every(item => item.field_sources.title === "observed-response"));
  assert.doesNotMatch(JSON.stringify(h.data.collection), /private-marker/);
  assert.equal(await h.page.evaluate(() => window.__supplierResponseObservation.enabled), false);
});
test("an explicit captcha response pauses the collection before any product is stored", async t => {
  const h = await createHarness(browser, t); h.granted.add("https://catalog.example/*"); h.flags.routeHtml = () => "<main>Loading products</main>";
  await h.context.route("https://catalog.example/api/products", route => route.fulfill({ json: { ret: ["FAIL_SYS_USER_VALIDATE::verification required"] } }));
  await h.page.goto("https://catalog.example/search"); await h.command("START", { max_pages: 1, scroll: false, observe_responses: true });
  await h.waitFor(data => data.run?.response_tab_ids?.includes(1)); await h.page.evaluate(() => fetch("/api/products").then(response => response.json()));
  await h.waitFor(data => data.run?.status === "paused"); await h.waitFor(() => h.idle());
  assert.equal(h.data.run.pause_reason, "challenge"); assert.equal(h.data.collection?.products.length || 0, 0);
  assert.equal(await h.page.evaluate(() => window.__supplierResponseObservation.enabled), false);
});
test("one resume refreshes a 1688 text search after a response-only challenge, preserving its URL", async t => {
  const h = await createHarness(browser, t); let completedByUser = false, documents = 0, requests = 0;
  h.flags.routeHtml = () => `<main>Loading products</main>${++documents > 1 ? '<script>setTimeout(()=>fetch("/api/products").then(response=>response.json()),400);</script>' : ''}`;
  await h.context.route("https://s.1688.com/api/products", route => { requests++; return route.fulfill({ json: completedByUser ? payload : { ret: ["FAIL_SYS_USER_VALIDATE::verification required"] } }); });
  await h.page.goto(h.initialUrl); await h.command("START", { max_pages: 1, scroll: false, observe_responses: true });
  await h.waitFor(data => data.run?.response_tab_ids?.includes(1)); await h.page.evaluate(() => fetch("/api/products").then(response => response.json()));
  await h.waitFor(data => data.run?.status === "paused"); await h.waitFor(() => h.idle());
  completedByUser = true; assert.equal((await h.command("RESUME")).ok, true);
  await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.collection.products.length, 2); assert.equal(h.page.url(), h.initialUrl); assert.equal(requests, 2);
});
