"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium } = require("playwright-core");
const { createHarness } = require("./helpers/background-harness.cjs");
const S = require("../extension/shared.js"), C = require("../extension/suppliers-core.js");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
const row = (id, extra = {}) => ({ source: "1688", product_id: String(id), product_url: "https://detail.1688.com/offer/" + id + ".html", title: "Tool " + id, ...extra });
const task = (id, products) => ({ id, query: "Tools " + id, source: products[0]?.source || "1688", kind: "collection", status: "finished", started_at: "2026-10-15T10:00:00Z", completed_pages: 1, max_pages: 1, products, pages: [], log: [] });
function seed(h, tasks) { h.data.tasks = structuredClone(tasks); h.data.collection = { products: tasks.flatMap(t => t.products), pages: [], raw_cards: [] }; }
async function prepare(h, tasks = ["a"]) { const r = await h.command("SUPPLIERS_PREPARE", { task_ids: tasks, interval_seconds: 1 }); assert.equal(r.ok, true, r.error); }
async function start(h) { const r = await h.command("SUPPLIERS_START"); assert.equal(r.ok, true, r.error); }
async function paused(h) { await h.waitFor(d => d.supplier_search?.status === "paused"); await h.waitFor(() => h.stage2Idle()); await h.attentionIdle(); }

test("TrustPass store URLs are accepted conservatively and canonicalized like existing Alibaba storefronts", () => {
  assert.equal(S.supplierUrl("//exampletools.trustpass.alibaba.com/company_profile.html?spm=x", "https://www.alibaba.com/search"), "https://exampletools.trustpass.alibaba.com/");
  assert.equal(S.supplierUrl("https://exampletools.en.alibaba.com/productlist.html"), "https://exampletools.en.alibaba.com/");
  for (const url of ["https://exampletools.trustpass.alibaba.com.evil.test/", "https://trustpass.alibaba.com/", "https://exampletools.trustpass.alibaba.com/product-detail/Tool_123.html", "https://www.alibaba.com/product-detail/Tool_123.html"]) assert.equal(S.supplierUrl(url), null, url);
});

test("TrustPass evidence is extracted from search and detail pages and skips unnecessary supplier checks", async t => {
  const h = await createHarness(browser, t), url = "https://www.alibaba.com/product-detail/Tool_123.html", store = "https://exampletools.trustpass.alibaba.com/";
  const html = '<article class="product-card"><a href="' + url + '">Electric log splitter</a><span class="price">US$250</span><a href="' + store + 'company_profile.html">Example Tools Inc</a></article>';
  const result = await h.page.evaluate(({ html, url }) => ({ search: SupplierCollectorEngine.fromHTML(html, { url: "https://www.alibaba.com/search", raw: false }), detail: SupplierCollectorEngine.fromHTML('<h1>Electric log splitter</h1>' + html, { url, mode: "detail", raw: false }) }), { html, url });
  assert.equal(result.search.cards[0].supplier_url, store); assert.equal(result.search.cards[0].shop_name, "Example Tools Inc"); assert.equal(result.detail.products[0].supplier_url, store);
  seed(h, [task("a", result.search.cards)]); const original = structuredClone(h.data.tasks); await prepare(h);
  assert.equal(h.data.supplier_search.queue.length, 0); assert.equal(h.data.supplier_search.status, "finished"); assert.equal(h.tabs.size, 1); assert.deepEqual(h.data.tasks, original);
});

test("unique-card counts preserve cross-task repeats, platform boundaries, web variants and unidentified rows", () => {
  const rows = C.rowsFromTasks([task("a", [row(1, { supplier_url: "https://factory.1688.com/" }), row(1), row(1, { source: "alibaba", product_url: "https://www.alibaba.com/product-detail/Tool_1.html" }), row("x", { source: "web:catalog.test", product_url: "https://catalog.test/items/x?variant=a" }), row("x", { source: "web:catalog.test", product_url: "https://catalog.test/items/x?variant=b" }), row("x", { source: "web:catalog.test", product_url: "https://catalog.test/items/x?variant=a&utm_source=test" }), row(null, { product_id: null, product_url: null }), row(null, { product_id: null, product_url: null })]), task("b", [row(1)])], {});
  const original = structuredClone(rows), result = C.report({ id: "j", status: "ready", products: rows, source_tasks: [], queue: C.queue(rows), cursor: 0, opened_keys: [], checked_count: 0 });
  assert.equal(result.total_cards, 9); assert.equal(result.unique_offers, 6); assert.equal(result.duplicate_cards, 3); assert.equal(result.unknown_cards, 6); assert.equal(result.unknown_unique_offers, 5);
  assert.equal(result.suppliers[0].products.length, 3); assert.equal(result.suppliers[0].unique_offers, 1); assert.equal(result.suppliers[0].duplicate_cards, 2); assert.deepEqual(rows, original);
});

test("captcha sends one notification per incident, survives restart, opens the working tab and clears on skip/delete", async t => {
  const h = await createHarness(browser, t); h.flags.detailChallenge = true; seed(h, [task("a", [row(1001)])]); await prepare(h); await start(h); await paused(h);
  const id = h.notifications[0].id, token = h.data.supplier_search.attention_id;
  assert.equal(h.notifications.length, 1); assert.equal(h.badge.text, "!"); assert.equal(h.activeNotifications.size, 1);
  h.notificationClick("unrelated"); assert.equal(h.activatedTabs.length, 0); h.notificationClick(id, true); await h.waitFor(() => h.activatedTabs.includes(h.data.supplier_search.tab_id));
  h.resume(); await h.attentionIdle(); assert.equal(h.notifications.length, 1); assert.equal(h.data.supplier_search.attention_id, token);
  assert.equal((await h.command("SUPPLIERS_START")).ok, false); await h.attentionIdle(); assert.equal(h.notifications.length, 1);
  await h.command("SUPPLIERS_SKIP"); await h.attentionIdle(); assert.equal(h.badge.text, ""); assert.equal(h.activeNotifications.size, 0);
  await prepare(h); await start(h); await paused(h); assert.equal(h.notifications.length, 2); assert.notEqual(h.data.supplier_search.attention_id, token);
  assert.equal((await h.command("DELETE_TASK", { id: "a" })).ok, true); await h.attentionIdle(); assert.equal(h.activeNotifications.size, 0); assert.equal(h.badge.text, "");
});

test("notification failure leaves a recoverable paused job and a badge without retries or loss of cards", async t => {
  const h = await createHarness(browser, t); h.flags.notificationError = "Notifications disabled"; h.flags.detailChallenge = true;
  seed(h, [task("a", [row(1001)])]); await prepare(h); await start(h); await paused(h);
  assert.equal(h.data.supplier_search.pause_reason, "challenge"); assert.equal(h.data.supplier_search.products.length, 1); assert.equal(h.data.supplier_search.attention_notification_error, "Notifications disabled"); assert.equal(h.badge.text, "!");
  h.resume(); await h.attentionIdle(); assert.equal(h.notifications.length, 1);
  assert.equal((await h.command("CLEAR")).ok, true); await h.attentionIdle(); assert.deepEqual(h.data, {}); assert.equal(h.badge.text, "");
});

test("skipping during notification creation cannot leave a late notification or resurrect a paused job", async t => {
  const h = await createHarness(browser, t); h.flags.detailChallenge = true; h.flags.notificationDelay = 600;
  seed(h, [task("a", [row(1001)])]); await prepare(h); await start(h); await h.waitFor(d => d.supplier_search?.status === "paused" && h.notifications.length === 1);
  await h.command("SUPPLIERS_SKIP"); await h.waitFor(() => h.stage2Idle()); await h.attentionIdle();
  assert.equal(h.data.supplier_search.status, "finished"); assert.equal(h.data.supplier_search.products.length, 1); assert.equal(h.activeNotifications.size, 0); assert.equal(h.badge.text, "");
});

async function openUi(h, file = "suppliers.html") {
  const page = await h.context.newPage({ viewport: { width: 1450, height: 1050 } }), downloads = [];
  await page.exposeFunction("__command", ({ type, options }) => h.command(type, options, { id: "testextension", url: "chrome-extension://testextension/" + file }));
  await page.exposeFunction("__tabs", () => [{ id: 1, url: h.page.url() }]);
  await page.exposeFunction("__download", data => { downloads.push(data); return downloads.length; });
  await page.addInitScript(() => { globalThis.chrome = { runtime: { sendMessage: message => __command(message) }, tabs: { query: () => __tabs() }, storage: { onChanged: { addListener: listener => { globalThis.__changed = listener; } } }, permissions: { contains: async () => true, request: async () => true }, downloads: { download: async options => { const bytes = new Uint8Array(await (await fetch(options.url)).arrayBuffer()); let value = ""; for (const byte of bytes) value += String.fromCharCode(byte); return __download({ filename: options.filename, base64: btoa(value) }); } } }; });
  h.observers.push((changes, area) => { if (!page.isClosed()) void page.evaluate(({ changes, area }) => globalThis.__changed?.(changes, area), { changes, area }).catch(() => {}); });
  await page.route("https://collector.test/**", route => { const name = new URL(route.request().url()).pathname.slice(1); return route.fulfill({ body: fs.readFileSync(path.join(__dirname, "../extension", name)), contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html; charset=utf-8" }); });
  await page.goto("https://collector.test/" + file); return { page, downloads };
}

test("stage 2 exposes unique counts and downloads a real Excel workbook from the result table with all repeats", async t => {
  const h = await createHarness(browser, t); seed(h, [task("a", [row(1001, { supplier_url: "https://factory.1688.com/", shop_name: "Example Factory" }), row(1002)]), task("b", [row(1001)])]);
  const original = structuredClone(h.data.tasks), { page } = await openUi(h);
  await page.locator("#select-all").click(); await page.locator("#prepare").click(); await page.waitForFunction(() => document.getElementById("unique-count").textContent === "2");
  assert.equal(await page.locator("#card-count").textContent(), "3"); assert.equal(await page.locator("#repeat-count").textContent(), "1");
  const supplier = page.locator("#suppliers > tr").filter({ hasText: "Example Factory" }); assert.equal(await supplier.locator("td").nth(2).textContent(), "2"); assert.equal(await supplier.locator("td").nth(3).textContent(), "1");
  await page.locator("#skip").click(); await page.waitForFunction(() => document.getElementById("result-state").textContent === "Итоговый результат");
  await page.locator("#result-export-xlsx").click(); await h.waitFor(() => h.openedUi.length === 1); assert.match(h.openedUi[0], /export.html\?stage=2$/);
  const { page: excel, downloads } = await openUi(h, "export.html?stage=2"); await excel.waitForFunction(() => !document.getElementById("download").disabled);
  assert.match(await excel.locator("#summary").textContent(), /Уникальных карточек: 2/); await excel.locator("#download").click(); await h.waitFor(() => downloads.length === 1);
  assert.match(downloads[0].filename, /stage2.*\.xlsx$/); const file = path.join(__dirname, "../test-results/stage2-updated.xlsx"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(downloads[0].base64, "base64"));
  const result = spawnSync("python3", ["-c", ["import sys,zipfile,xml.etree.ElementTree as E", "z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None", "n={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}", "def rows(i):", " return [[c.find('x:is/x:t',n).text if c.find('x:is/x:t',n) is not None else c.findtext('x:v','',n) for c in r.findall('x:c',n)] for r in E.fromstring(z.read('xl/worksheets/sheet%d.xml'%i)).findall('x:sheetData/x:row',n)]", "p,s,t,tp,summary=[rows(i) for i in range(1,6)]", "assert len(p)==4 and len(tp)==4 and len(t)==3", "assert 'Уникальных карточек' in s[0] and 'Повторных появлений' in s[0]", "assert len(s)==3 and s[1][4:7]==['2','1','1'] and s[2][2]=='Поставщик неизвестен' and s[2][0]=='1688.com'", "assert 'Ключ уникальной карточки' in p[0] and 'Появлений карточки в выбранных заданиях' in p[0]", "stats=dict(summary[1:]); assert stats['Всего карточек']=='3' and stats['Уникальных карточек']=='2' and stats['Повторных появлений']=='1'", "assert stats['Уникальных карточек без поставщика']=='1'", "assert not any(E.fromstring(z.read(f)).findall('.//x:f',n) for f in z.namelist() if f.startswith('xl/worksheets/sheet') and f.endswith('.xml'))", "print('Stage-2 Excel download, CRC, all rows, unique counts and supplier sheet verified')"].join("\n"), file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(h.data.tasks, original);
  await page.locator("#expand-all").click(); assert.equal(await page.locator(".product-tree tbody tr").count(), 3); await page.screenshot({ path: path.join(__dirname, "../test-results/stage2-updated.png"), fullPage: true });
});

test("captcha is visible in stage 2 and popup; opening its tab and continuing clears all attention surfaces", async t => {
  const h = await createHarness(browser, t); h.flags.detailChallenge = true; seed(h, [task("a", [row(1001)])]); await prepare(h); await start(h); await paused(h);
  const { page } = await openUi(h), { page: popup } = await openUi(h, "popup.html");
  await page.locator("#challenge-alert").waitFor({ state: "visible" }); await popup.locator("#stage2-attention").waitFor({ state: "visible" });
  await popup.locator("#stage2-challenge").click(); await h.waitFor(() => h.activatedTabs.includes(h.data.supplier_search.tab_id));
  h.flags.detailChallenge = false; await h.tabs.get(h.data.supplier_search.tab_id).setContent(h.detailHtml);
  await page.waitForFunction(() => !document.getElementById("start").disabled); await page.locator("#start").click(); await h.waitFor(d => d.supplier_search?.status === "finished"); await h.attentionIdle();
  await page.locator("#challenge-alert").waitFor({ state: "hidden" }); await popup.locator("#stage2-attention").waitFor({ state: "hidden" }); assert.equal(h.badge.text, ""); assert.equal(h.activeNotifications.size, 0); assert.equal(h.data.supplier_search.checked_count, 1);
});
