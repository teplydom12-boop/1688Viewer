"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium } = require("playwright-core");
const { createHarness } = require("./helpers/background-harness.cjs");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
async function collect(h, query) {
  assert.equal((await h.command("START", { query, max_pages: 1, scroll: false, interval_seconds: 1 })).ok, true);
  await h.waitFor(data => data.run?.status === "finished"); await h.waitFor(() => h.idle());
  return h.data.run.id;
}
function exported(h, index = h.downloads.length - 1) { return JSON.parse(decodeURIComponent(h.downloads[index].url.split(",").slice(1).join(","))); }
async function ui(h, filename) {
  const page = await h.context.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.exposeFunction("__command", ({ type, options }) => h.command(type, options));
  await page.exposeFunction("__tabs", () => [{ id: 1, url: h.page.url() }]);
  await page.exposeFunction("__subscribe", () => { h.observers.push(changes => { void page.evaluate(changes => window.__changed?.(changes, "local"), changes).catch(() => {}); }); });
  await page.addInitScript(() => {
    globalThis.chrome = { runtime: { sendMessage: message => __command(message) }, tabs: { query: () => __tabs() }, storage: { onChanged: { addListener(listener) { window.__changed = listener; void __subscribe(); } } } };
  });
  await page.route("https://collector.test/**", route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    return route.fulfill({ body: fs.readFileSync(path.join(__dirname, "../extension", file)), contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8" });
  });
  await page.goto(`https://collector.test/${filename}.html`);
  await page.waitForFunction(() => document.getElementById("count").textContent === "2");
  return page;
}

test("multiple searches preserve independent snapshots, cumulative memory and task provenance after restart", async t => {
  const h = await createHarness(browser, t), first = await collect(h, "Чашки");
  const snapshot = structuredClone(h.data.tasks[0]);
  await h.page.locator('[data-offer-id="1001"] .price').evaluate(node => { node.textContent = "¥99.00"; });
  await h.page.locator('[data-offer-id="1002"]').evaluate(node => {
    node.dataset.offerId = "1003";
    node.querySelector("a").href = "https://detail.1688.com/offer/1003.html";
    node.querySelector("a").textContent = "Другой термос";
  });
  const second = await collect(h, "Термосы");
  assert.equal(h.data.tasks.length, 2); assert.equal(h.data.collection.products.length, 3);
  assert.deepEqual(h.data.tasks[0], snapshot);
  assert.equal(h.data.tasks[1].products.find(p => p.product_id === "1001").price, "¥99.00");
  assert.deepEqual(h.data.collection.products[0].task_ids, [first, second]);
  assert.deepEqual(h.data.collection.products.find(p => p.product_id === "1002").task_ids, [first]);
  assert.deepEqual(h.data.collection.products.find(p => p.product_id === "1003").task_ids, [second]);
  assert.equal(h.data.collection.pages.length, 2);
  assert.equal(new Set(h.data.collection.raw_cards.map(card => card.task_id)).size, 2);
  assert.equal(h.tabs.size, 1, "collection-only tasks must not open product details");
  h.resume(); await h.waitFor(() => h.idle());
  const state = (await h.command("STATE")).result;
  assert.equal(state.task_count, 2); assert.equal(state.tasks[0].id, second); assert.equal(state.tasks[0].product_count, 2);
  assert.equal(state.tasks[0].products, undefined, "tracker payload should contain summaries");
  assert.equal((await h.command("TASK", { id: first })).result.products[0].price, "¥12.50");
  assert.equal((await h.command("EXPORT")).ok, true);
  const output = exported(h);
  assert.equal(output.total_tasks, 2); assert.equal(output.total_products, 3);
  assert.deepEqual(output.tasks.map(task => task.query), ["Чашки", "Термосы"]);
  assert.equal(output.tasks[0].products[0].price, "¥12.50");
  assert.ok(output.tasks.every(task => task.finished_at && task.completed_pages === 1));
});

test("a stopped partial task remains in history when another task starts", async t => {
  const h = await createHarness(browser, t);
  await h.command("START", { query: "Первый", max_pages: 5, scroll: true });
  await h.waitFor(data => data.run?.current_count === 2);
  assert.equal((await h.command("PAUSE")).ok, true); await h.waitFor(() => h.idle());
  const first = h.data.run.id;
  assert.equal(h.data.tasks[0].status, "paused");
  assert.equal(h.data.tasks[0].products.length, 2);
  assert.ok(h.data.tasks[0].pages.some(page => page.partial));
  await collect(h, "Второй");
  const task = h.data.tasks.find(task => task.id === first);
  assert.equal(task.status, "stopped"); assert.equal(task.products.length, 2); assert.ok(task.finished_at);
  assert.equal(h.data.tasks.length, 2);
});

test("captcha task can be exported without products, resumes with the same ID and keeps its progress", async t => {
  const h = await createHarness(browser, t);
  await h.page.evaluate(() => { document.body.innerHTML = '<div class="nc-container">滑动验证</div>'; });
  await h.command("START", { query: "Капча", max_pages: 1, scroll: false });
  await h.waitFor(data => data.run?.status === "paused"); await h.waitFor(() => h.idle());
  const id = h.data.run.id;
  assert.equal(h.data.tasks[0].pause_reason, "challenge");
  assert.equal((await h.command("EXPORT")).ok, true); assert.equal(exported(h).total_products, 0);
  assert.equal((await h.command("EXPORT", { format: "xlsx" })).ok, true);
  await h.page.goto(h.initialUrl);
  assert.equal((await h.command("RESUME")).ok, true);
  await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.tasks.length, 1); assert.equal(h.data.tasks[0].id, id);
  assert.equal(h.data.tasks[0].completed_pages, 1); assert.equal(h.data.tasks[0].products.length, 2);
});

test("clear removes all app memory and restart cannot restore it; old data migrates without invented history", async t => {
  const h = await createHarness(browser, t);
  const first = await collect(h, "Старый поиск");
  delete h.data.tasks;
  assert.equal((await h.command("STATE")).result.task_count, 1);
  const legacy = (await h.command("TASK", { id: first })).result;
  assert.equal(legacy.products.length, 2);
  await collect(h, "Новый поиск"); assert.equal(h.data.tasks.length, 2);
  h.data.profiles = { "https://s.1688.com": { card_selector: ".offer-card" } };
  h.data.last_navigation = { analysis: {} }; h.data.pending_pick = { nonce: "old" };
  assert.equal((await h.command("CLEAR")).ok, true);
  assert.deepEqual(h.data, {});
  h.resume(); await h.waitFor(() => h.idle());
  const state = (await h.command("STATE")).result;
  assert.equal(state.task_count, 0); assert.equal(state.count, 0); assert.equal(state.can_clear, false);
  assert.equal((await h.command("TASK", { id: first })).ok, false);
  assert.equal((await h.command("EXPORT")).ok, false);
});

test("Excel download is an intact OOXML workbook with cumulative and per-task results", async t => {
  const h = await createHarness(browser, t);
  await collect(h, "Запрос №1"); await collect(h, "Запрос №2");
  h.data.collection.products[0].title = '=HYPERLINK("https://example.test","测试 & <товар> ☕")';
  assert.equal((await h.command("EXPORT", { format: "xlsx" })).ok, true);
  const download = h.downloads.at(-1);
  assert.match(download.filename, /\.xlsx$/); assert.equal(download.saveAs, true);
  const buffer = Buffer.from(download.url.split(",")[1], "base64"); assert.equal(buffer.readUInt32LE(), 0x04034b50);
  const result = spawnSync("python3", ["-c", `import sys,io,zipfile,xml.etree.ElementTree as ET,json
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
ns={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
book=ET.fromstring(z.read('xl/workbook.xml'))
assert [s.attrib['name'] for s in book.find('x:sheets',ns)] == ['Товары','Поставщики','Задания','Товары заданий']
sheets=[ET.fromstring(z.read('xl/worksheets/sheet%d.xml'%i)) for i in range(1,5)]
assert [len(s.find('x:sheetData',ns)) for s in sheets] == [3,2,3,5]
for s in sheets: assert not s.findall('.//x:f',ns)
cells=sheets[0].findall('.//x:row',ns)[1].findall('x:c',ns)
assert cells[1].attrib['t']=='inlineStr'
assert cells[1].find('x:is/x:t',ns).text=='1001'
assert cells[2].find('x:is/x:t',ns).text.startswith('=HYPERLINK(')
assert '测试 & <товар> ☕' in cells[2].find('x:is/x:t',ns).text
print('Workbook XML, CRC, rows and literal strings verified')`], { input: buffer, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await h.command("EXPORT", { format: "unknown" })).ok, false);
});

test("dashboard shows task history, historical results, Excel export and clears UI without reload", async t => {
  const h = await createHarness(browser, t), first = await collect(h, "Чашки");
  await h.page.locator('[data-offer-id="1001"] .price').evaluate(node => { node.textContent = "¥99.00"; });
  await collect(h, "Термосы");
  const dashboard = await ui(h, "dashboard");
  await dashboard.waitForFunction(() => document.querySelectorAll("#tasks tr").length === 2);
  assert.match(await dashboard.locator("#tasks").textContent(), /Термосы/);
  assert.equal(await dashboard.locator("#progress").evaluate(node => node.value), 100);
  await dashboard.locator("#task-filter").selectOption(first);
  await dashboard.waitForFunction(() => document.getElementById("task-view-note").textContent.includes("Снимок"));
  assert.match(await dashboard.locator(".product-tree").textContent(), /12.50/);
  assert.doesNotMatch(await dashboard.locator(".product-tree").textContent(), /99.00/);
  await dashboard.locator("#export-xlsx").click(); await h.waitFor(() => h.openedUi.length === 1);
  assert.match(h.openedUi[0], /\/export\.html$/);
  dashboard.once("dialog", dialog => dialog.accept()); await dashboard.locator("#clear").click();
  await dashboard.waitForFunction(() => document.getElementById("count").textContent === "0" && document.querySelectorAll("#tasks tr").length === 0);
  assert.equal(await dashboard.locator("#task-filter option").count(), 1);
  assert.equal(await dashboard.locator("#export-xlsx").isDisabled(), true);
  assert.equal(await dashboard.locator("#clear").isDisabled(), true);
  assert.equal(await dashboard.locator("#query").inputValue(), "");
});

test("popup starts a collection-only task even if old enrichment preference was enabled", async t => {
  const h = await createHarness(browser, t); await collect(h, "Первый");
  h.data.preferences.enrich = true;
  const popup = await ui(h, "popup");
  assert.match(await popup.locator("#task-count").textContent(), /1/);
  await popup.locator("#query").fill("Второй");
  await popup.locator("#collect").click(); await h.waitFor(data => data.tasks?.length === 2 && data.run.status === "finished");
  assert.equal(h.tabs.size, 1); assert.equal(h.data.run.enrich, false);
  await popup.locator("#export-xlsx").click(); await h.waitFor(() => h.openedUi.length === 1);
  assert.match(h.openedUi[0], /\/export\.html$/);
  popup.once("dialog", dialog => dialog.dismiss()); await popup.locator("#clear").click();
  assert.equal(h.data.tasks.length, 2);
  popup.once("dialog", dialog => dialog.accept()); await popup.locator("#clear").click();
  await popup.waitForFunction(() => document.getElementById("count").textContent === "0");
  assert.equal(await popup.locator("#progress").evaluate(node => node.value), 0);
});
