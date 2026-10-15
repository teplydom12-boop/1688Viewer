"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { createHarness } = require("./helpers/background-harness.cjs");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
async function collect(h, query) {
  assert.equal((await h.command("START", { query, max_pages: 1, scroll: false, interval_seconds: 1 })).ok, true);
  await h.waitFor(data => data.run?.status === "finished"); await h.waitFor(() => h.idle()); return h.data.run.id;
}
async function twoChecks(h) {
  const first = await collect(h, "Чашки");
  await h.page.locator('[data-offer-id="1001"] .price').evaluate(node => { node.textContent = "¥99.00"; });
  await h.page.locator('[data-offer-id="1002"]').evaluate(node => { node.dataset.offerId = "1003"; node.querySelector("a").href = "https://detail.1688.com/offer/1003.html"; node.querySelector("a").textContent = "Новый термос"; });
  const second = await collect(h, "Термосы"); return { first, second };
}
const jsonDownload = h => JSON.parse(decodeURIComponent(h.downloads.at(-1).url.split(",").slice(1).join(",")));

test("deleting the newest check restores shared product fields and removes its exclusive memory permanently", async t => {
  const h = await createHarness(browser, t), { first, second } = await twoChecks(h);
  const preserved = structuredClone(h.data.tasks[0]);
  assert.equal((await h.command("DELETE_TASK", { id: second })).ok, true);
  assert.deepEqual(h.data.tasks, [preserved]); assert.equal(h.data.run, null);
  assert.equal(h.data.collection.products.length, 2);
  assert.equal(h.data.collection.products[0].price, "¥12.50");
  assert.deepEqual(h.data.collection.products[0].task_ids, [first]);
  assert.ok(h.data.collection.products.every(item => !item.sightings.some(sighting => sighting.query === "Термосы")));
  assert.ok(h.data.collection.pages.every(page => page.task_id === first));
  assert.ok(h.data.collection.raw_cards.every(card => card.task_id === first));
  h.resume(); await h.waitFor(() => h.idle());
  assert.equal((await h.command("STATE")).result.task_count, 1);
  assert.equal((await h.command("TASK", { id: second })).ok, false);
  await h.command("EXPORT", { format: "raw" }); assert.doesNotMatch(JSON.stringify(jsonDownload(h)), new RegExp(second));
  await h.command("DELETE_TASK", { id: first });
  assert.equal((await h.command("STATE")).result.count, 0);
  assert.equal(h.data.collection.raw_cards.length, 0);
  await h.command("START", { query: "Новый после удаления", max_pages: 1, scroll: false });
  await h.waitFor(data => data.run?.status === "finished"); assert.equal(h.data.tasks.length, 1);
});

test("deleting an older check keeps the current check and never copies removed fields into it", async t => {
  const h = await createHarness(browser, t), { first, second } = await twoChecks(h);
  await h.page.locator('[data-offer-id="1001"] .company-name').evaluate(node => node.remove());
  const third = await collect(h, "Без имени магазина");
  assert.equal((await h.command("DELETE_TASK", { id: first })).ok, true);
  assert.equal(h.data.run.id, third); assert.equal(h.data.run.status, "finished");
  assert.deepEqual(h.data.collection.products.map(item => item.product_id).sort(), ["1001", "1003"]);
  assert.deepEqual(h.data.collection.products[0].task_ids, [second, third]);
  await h.command("DELETE_TASK", { id: second });
  assert.equal(h.data.collection.products[0].shop_name, null, "a name known only from deleted checks must disappear");
  assert.equal(h.data.collection.products[0].price, "¥99.00");
  assert.deepEqual(h.data.collection.products[0].task_ids, [third]);
});

test("independent imports before and after scans survive deletion, including a shared product", async t => {
  const h = await createHarness(browser, t);
  await h.command("IMPORT", { data: { products: [{ source: "1688", product_url: "https://detail.1688.com/offer/7777.html", title: "Импорт до проверки" }] } });
  const first = await collect(h, "Проверка");
  const imported = { source: "1688", product_url: "https://detail.1688.com/offer/1001.html", title: "Импортированная версия", price: "¥200", collected_at: "2099-01-01T00:00:00Z" };
  await h.command("IMPORT", { data: { products: [imported] } });
  await h.command("DELETE_TASK", { id: first });
  assert.equal(h.data.tasks.length, 0); assert.equal(h.data.collection.products.length, 2);
  const shared = h.data.collection.products.find(item => item.product_id === "1001");
  assert.equal(shared.title, "Импортированная версия"); assert.equal(shared.price, "¥200"); assert.deepEqual(shared.task_ids || [], []);
  assert.equal(h.data.collection.raw_cards.length, 0);
  await h.command("CLEAR"); assert.deepEqual(h.data, {});
});

test("legacy history migration retains unassigned data when the recorded check is deleted", async t => {
  const h = await createHarness(browser, t), id = await collect(h, "Старое задание");
  delete h.data.tasks; delete h.data.unassigned_memory;
  h.data.collection.products.push({ source: "1688", product_id: "8888", product_url: "https://detail.1688.com/offer/8888.html", title: "Ранее импортировано" });
  assert.equal((await h.command("DELETE_TASK", { id })).ok, true);
  assert.equal(h.data.tasks.length, 0); assert.equal(h.data.collection.products.length, 1);
  assert.equal(h.data.collection.products[0].product_id, "8888");
});

test("running and resuming checks cannot be deleted; a paused check can be removed without resurrection", async t => {
  const h = await createHarness(browser, t), first = await collect(h, "Первый");
  await h.command("START", { query: "Второй", max_pages: 5, scroll: true });
  await h.waitFor(data => data.run?.current_count === 2);
  assert.equal((await h.command("DELETE_TASK", { id: first })).ok, false);
  assert.equal((await h.command("CLEAR")).ok, false);
  await h.command("PAUSE"); await h.waitFor(() => h.idle());
  const second = h.data.run.id;
  const resuming = h.command("RESUME");
  assert.equal((await h.command("DELETE_TASK", { id: second })).ok, false);
  assert.equal((await resuming).ok, true);
  await h.command("PAUSE"); await h.waitFor(() => h.idle());
  assert.equal((await h.command("DELETE_TASK", { id: second })).ok, true);
  assert.equal((await h.command("RESUME")).ok, false);
  h.resume(); await h.waitFor(() => h.idle());
  assert.deepEqual(h.data.tasks.map(task => task.id), [first]);
});

test("scoped JSON, raw and Excel exports contain only the selected check; invalid IDs and senders cannot delete data", async t => {
  const h = await createHarness(browser, t), { first, second } = await twoChecks(h);
  const sender = { id: "testextension", url: `chrome-extension://testextension/history.html#${first}` };
  assert.equal((await h.command("STATE", {}, sender)).ok, true);
  await h.command("EXPORT", { format: "raw", task_id: first }, sender);
  let output = jsonDownload(h);
  assert.equal(output.total_tasks, 1); assert.equal(output.total_products, 2); assert.equal(output.tasks[0].id, first);
  assert.equal(output.products[0].price, "¥12.50");
  assert.ok(output.raw_cards.every(card => card.task_id === first)); assert.doesNotMatch(JSON.stringify(output), new RegExp(second));
  await h.command("EXPORT", { format: "json", task_id: second }, sender);
  output = jsonDownload(h); assert.equal(output.tasks[0].id, second); assert.equal(output.products[0].price, "¥99.00");
  await h.command("EXPORT", { format: "xlsx", task_id: first }, sender); assert.match(h.downloads.at(-1).filename, /suppliers-task-xlsx.*\.xlsx$/);
  assert.equal((await h.command("EXPORT", { task_id: "missing" })).ok, false);
  assert.equal((await h.command("DELETE_TASK", { id: "missing" })).ok, false);
  assert.equal((await h.command("DELETE_TASK", { id: first }, { id: "testextension", url: "https://s.1688.com/history.html", tab: { id: 1 } })).ok, false);
  assert.equal(h.data.tasks.length, 2);
});

async function openHistory(h, id = "") {
  const page = await h.context.newPage({ viewport: { width: 1440, height: 1050 } });
  await page.exposeFunction("__command", ({ type, options }) => h.command(type, options, { id: "testextension", url: `chrome-extension://testextension/history.html#${id}` }));
  await page.exposeFunction("__subscribe", () => { h.observers.push(changes => { void page.evaluate(changes => window.__changed?.(changes, "local"), changes).catch(() => {}); }); });
  await page.addInitScript(() => { globalThis.chrome = { runtime: { sendMessage: message => __command(message) }, storage: { onChanged: { addListener(listener) { window.__changed = listener; void __subscribe(); } } } }; });
  await page.route("https://collector.test/**", route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    return route.fulfill({ body: fs.readFileSync(path.join(__dirname, "../extension", file)), contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8" });
  });
  await page.goto(`https://collector.test/history.html${id ? `#${id}` : ""}`);
  await page.waitForFunction(() => document.getElementById("history-count").textContent.includes("из")); return page;
}

test("history tab opens snapshots, exports one check and deletes one/all with confirmation and live updates", async t => {
  const h = await createHarness(browser, t), { first, second } = await twoChecks(h);
  const history = await openHistory(h);
  assert.equal(await history.locator("#history-tasks tr").count(), 2);
  await history.locator(`#history-tasks tr[data-task-id="${first}"] [data-action="open"]`).click();
  await history.waitForFunction(() => document.getElementById("memory-title").textContent === "Чашки");
  assert.match(await history.locator("#memory-products").textContent(), /12.50/); assert.doesNotMatch(await history.locator("#memory-products").textContent(), /99.00/);
  assert.ok(await history.locator("#memory-log li").count()); assert.equal(await history.locator("#memory-pages li").count(), 1);
  await history.locator("#export-task-json").click(); await h.waitFor(() => h.downloads.length === 1); assert.equal(jsonDownload(h).tasks[0].id, first);
  history.once("dialog", dialog => dialog.dismiss()); await history.locator("#delete-task").click(); assert.equal(h.data.tasks.length, 2);
  history.once("dialog", dialog => dialog.accept()); await history.locator("#delete-task").click();
  await history.waitForFunction(() => document.querySelectorAll("#history-tasks tr").length === 1 && document.getElementById("task-memory").hidden);
  assert.equal(h.data.tasks[0].id, second); assert.equal(h.data.collection.products[0].price, "¥99.00");
  h.data.profiles = { site: { card_selector: ".offer" } };
  history.once("dialog", dialog => dialog.accept()); await history.locator("#clear-all").click();
  await history.waitForFunction(() => document.querySelectorAll("#history-tasks tr").length === 0);
  assert.deepEqual(h.data, {}); assert.equal(await history.locator("#clear-all").isDisabled(), true);
  assert.equal(await history.locator("#memory-products tr").count(), 0); assert.equal(await history.locator("#memory-log li").count(), 0);
});

test("a second history tab updates if its selected check is deleted elsewhere, with safe rendering of titles", async t => {
  const h = await createHarness(browser, t), { first, second } = await twoChecks(h);
  h.data.tasks[0].query = '<img src=x onerror="alert(1)">'; h.data.tasks[0].products[0].title = '<script>alert(1)</script>';
  const history = await openHistory(h, first);
  await history.waitForFunction(() => !document.getElementById("task-memory").hidden);
  assert.equal(await history.locator("#history-tasks img").count(), 0); assert.equal(await history.locator("#memory-products script").count(), 0);
  assert.match(await history.locator("#memory-products").textContent(), /<script>/);
  fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true });
  await history.screenshot({ path: path.join(__dirname, "../test-results/history.png"), fullPage: true });
  await h.command("DELETE_TASK", { id: first });
  await history.waitForFunction(() => document.getElementById("task-memory").hidden && document.querySelectorAll("#history-tasks tr").length === 1);
  assert.equal(h.data.tasks[0].id, second); assert.equal(await history.locator("#error").isHidden(), true);
  await history.reload(); await history.waitForFunction(() => document.querySelectorAll("#history-tasks tr").length === 1);
});
