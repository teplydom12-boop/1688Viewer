"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chromium } = require("playwright-core");
const { createHarness } = require("./helpers/background-harness.cjs");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
async function collect(h, options = {}) {
  assert.equal((await h.command("START", { max_pages: 1, scroll: false, interval_seconds: 1, ...options })).ok, true);
  await h.waitFor(data => data.run?.status === "finished", 30000); await h.waitFor(() => h.idle()); return h.data.run.id;
}
const downloaded = h => JSON.parse(decodeURIComponent(h.downloads.at(-1).url.split(",").slice(1).join(",")));
const row = (id, price) => `<article class="offer-card" data-offer-id="${id}"><a class="offer-title" href="https://detail.1688.com/offer/${id}.html">Товар ${id}</a><span class="price">¥${price}</span></article>`;

test("equal IDs in separate cards retain both prices and raw markup through repeated DOM sampling and exports", async t => {
  const h = await createHarness(browser, t);
  await h.page.evaluate(() => { const first = document.querySelector('[data-offer-id="1001"]'), clone = first.cloneNode(true); clone.querySelector('.price').textContent = '¥99'; first.after(clone); });
  await collect(h, { scroll: true });
  const products = h.data.collection.products;
  assert.equal(products.length, 3); assert.equal(new Set(products.map(item => item.observation_id)).size, 3);
  assert.deepEqual(products.filter(item => item.product_id === "1001").map(item => item.price).sort(), ["¥12.50", "¥99"]);
  assert.equal(h.data.collection.raw_cards.length, 3);
  assert.deepEqual(h.data.collection.raw_cards.map(item => item.observation_id).sort(), products.map(item => item.observation_id).sort());
  assert.ok(products.every(item => item.page_index === 1 && item.task_id === h.data.run.id && item.capture_status === "confirmed"));
  assert.equal(h.data.collection.pages[0].product_count, 3);
  const reparsed = await h.page.evaluate(cards => SupplierCollectorEngine.reparse(cards), h.data.collection.raw_cards);
  assert.equal(reparsed.length, 3); assert.deepEqual(reparsed.filter(item => item.product_id === "1001").map(item => item.price).sort(), ["¥12.50", "¥99"]);
  await h.command("EXPORT"); const output = downloaded(h);
  assert.equal(output.collection_mode, "all_cards"); assert.equal(output.total_products, 3); assert.equal(output.tasks[0].products.length, 3);
  await h.command("EXPORT", { format: "csv" }); const csv = decodeURIComponent(h.downloads.at(-1).url.split(",").slice(1).join(",")); assert.equal(csv.split("\r\n").length, 4); assert.match(csv, /observation_id/);
  await h.command("EXPORT", { format: "xlsx" });
  const result = spawnSync("python3", ["-c", `import io,sys,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None
n={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
for i in [1,4]:
 s=E.fromstring(z.read(f'xl/worksheets/sheet{i}.xml'));rows=s.findall('x:sheetData/x:row',n); assert len(rows)==4
 headers=[c.find('x:is/x:t',n).text for c in rows[0]]
 index=headers.index('ID записи'); ids=[r[index].find('x:is/x:t',n).text for r in rows[1:]]; assert len(set(ids))==3
 assert 'Страница задания' in headers and 'Позиция карточки' in headers`], { input: Buffer.from(h.downloads.at(-1).url.split(",")[1], "base64"), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  await h.command("EXPORT", { format: "raw" }); const raw = downloaded(h);
  await h.command("CLEAR"); await h.command("IMPORT", { data: raw });
  assert.equal(h.data.collection.products.length, 3); assert.equal(h.data.collection.raw_cards.length, 3);
  assert.deepEqual(h.data.collection.raw_cards.map(item => item.observation_id).sort(), h.data.collection.products.map(item => item.observation_id).sort());
});

test("repeated offers on different result pages are separate observations with page provenance", async t => {
  const h = await createHarness(browser, t); await collect(h, { max_pages: 2 });
  assert.equal(h.data.collection.products.length, 4); assert.equal(h.data.tasks[0].products.length, 4);
  const repeat = h.data.collection.products.filter(item => item.product_id === "1001");
  assert.equal(repeat.length, 2); assert.deepEqual(repeat.map(item => item.page_index), [1, 2]);
  assert.notEqual(repeat[0].observation_id, repeat[1].observation_id); assert.notEqual(repeat[0].source_page_url, repeat[1].source_page_url);
  assert.equal((await h.command("STATE")).result.current_task.product_count, 4);
});

for (const indicator of [true, false]) test(`a confirmed next document containing only repeated offers is collected (page indicator: ${indicator})`, async t => {
  const h = await createHarness(browser, t);
  h.flags.routeHtml = url => {
    const page = Number(url.searchParams.get("page") || 1);
    return row("1001", page) + row("1002", page) + `<nav class="pagination">${indicator ? `<span aria-current="page">${page}</span>` : ""}${page === 1 ? '<a rel="next" href="?page=2">Next page</a>' : '<button disabled>Next page</button>'}</nav>`;
  };
  await h.page.goto(h.initialUrl); await collect(h, { max_pages: 2 });
  assert.equal(h.data.run.completed_pages, 2); assert.equal(h.data.collection.products.length, 4);
  assert.equal(new Set(h.data.collection.products.map(item => item.product_id)).size, 2);
  assert.deepEqual(h.data.collection.products.map(item => item.price), ["¥1", "¥1", "¥2", "¥2"]);
});

test("load more retains a newly added duplicate while earlier visible slots are not recaptured", async t => {
  const h = await createHarness(browser, t);
  h.flags.routeHtml = () => `<div id="list">${row("1001", 1)}</div><button id="more">Load more</button><script>document.getElementById('more').onclick=()=>{document.getElementById('list').insertAdjacentHTML('beforeend',${JSON.stringify(row("1001", 2))});document.getElementById('more').disabled=true;}</script>`;
  await h.page.goto(h.initialUrl); await collect(h, { max_pages: 2 });
  assert.equal(h.data.run.completed_pages, 2); assert.equal(h.data.collection.products.length, 2);
  assert.deepEqual(h.data.collection.products.map(item => item.price), ["¥1", "¥2"]);
  assert.deepEqual(h.data.collection.pages.map(item => item.product_count), [1, 1]);
  assert.equal(h.data.collection.raw_cards.length, 2);
});

test("a next-page click can confirm changed card values at the same SPA URL with unchanged offer IDs", async t => {
  const h = await createHarness(browser, t);
  h.flags.routeHtml = () => row("1001", 1) + row("1002", 1) + '<button id="next">Next page</button><script>document.getElementById("next").onclick=()=>{document.querySelectorAll(".price").forEach(node=>node.textContent="¥2");document.getElementById("next").disabled=true;}</script>';
  await h.page.goto(h.initialUrl); await collect(h, { max_pages: 2 });
  assert.equal(h.data.run.completed_pages, 2); assert.equal(h.data.collection.products.length, 4);
  assert.deepEqual(h.data.collection.products.map(item => item.price), ["¥1", "¥1", "¥2", "¥2"]);
});

test("unchanged content after a next-page click does not create another page or repeat the click", async t => {
  const h = await createHarness(browser, t);
  h.flags.routeHtml = () => row("1001", 1) + '<button onclick="window.clicks=(window.clicks||0)+1">Next page</button>';
  await h.page.goto(h.initialUrl); await h.command("START", { max_pages: 2, scroll: false, interval_seconds: 1 });
  await h.waitFor(data => data.run?.pending_navigation); await h.page.waitForFunction(() => window.clicks === 1);
  await h.page.waitForTimeout(900);
  assert.equal(h.data.run.completed_pages, 1); assert.equal(h.data.collection.products.length, 1); assert.equal(await h.page.evaluate(() => window.clicks), 1);
  await h.command("PAUSE"); await h.waitFor(() => h.idle());
});

test("pause, restart and resume replace the same page checkpoint and keep observation IDs", async t => {
  const h = await createHarness(browser, t);
  await h.command("START", { max_pages: 1, scroll: true }); await h.waitFor(data => data.run?.current_count >= 2);
  await h.command("PAUSE"); await h.waitFor(() => h.idle());
  const ids = h.data.collection.products.map(item => item.observation_id).sort(); assert.equal(ids.length, 2);
  assert.ok(h.data.collection.products.every(item => item.capture_status === "partial"));
  h.resume(); await h.waitFor(() => h.idle()); await h.command("RESUME");
  await h.waitFor(data => data.run?.status === "finished"); await h.waitFor(() => h.idle());
  assert.deepEqual(h.data.collection.products.map(item => item.observation_id).sort(), ids);
  assert.ok(h.data.collection.products.every(item => item.capture_status === "confirmed"));
  assert.equal(h.data.collection.pages.length, 1); assert.equal(h.data.collection.raw_cards.length, 2);
});

test("captcha recovery with one resume collects a changed SPA page even when every offer ID repeats", async t => {
  const h = await createHarness(browser, t);
  h.flags.routeHtml = () => row("1001", 1) + row("1002", 1) + '<button id="next">Next page</button><script>document.getElementById("next").onclick=()=>{const box=document.createElement("div");box.className="nc-container";box.textContent="滑动验证";document.body.prepend(box);}</script>';
  await h.page.goto(h.initialUrl); await h.command("START", { max_pages: 2, scroll: false, interval_seconds: 1 });
  await h.waitFor(data => data.run?.status === "paused"); await h.waitFor(() => h.idle());
  assert.equal(h.data.run.pause_reason, "challenge"); assert.equal(h.data.run.completed_pages, 1);
  await h.page.evaluate(() => { document.querySelector('.nc-container').remove(); document.querySelectorAll('.price').forEach(node => node.textContent = '¥2'); document.getElementById('next').disabled = true; });
  assert.equal((await h.command("RESUME")).ok, true); await h.waitFor(data => data.run?.status === "finished"); await h.waitFor(() => h.idle());
  assert.equal(h.data.run.completed_pages, 2); assert.equal(h.data.collection.products.length, 4);
  assert.deepEqual(h.data.collection.products.map(item => item.price), ["¥1", "¥1", "¥2", "¥2"]);
});

test("separate searches keep their own duplicate rows and deleting one task preserves the others", async t => {
  const h = await createHarness(browser, t), first = await collect(h, { query: "Первый поиск" });
  await h.page.locator('[data-offer-id="1001"] .price').evaluate(node => node.textContent = "¥200");
  const second = await collect(h, { query: "Второй поиск" });
  assert.equal(h.data.collection.products.length, 4);
  const state = (await h.command("STATE")).result; assert.equal(state.count, 4); assert.equal(state.current_task.product_count, 2);
  assert.equal((await h.command("TASK", { id: first })).result.products[0].price, "¥12.50");
  assert.equal((await h.command("TASK", { id: second })).result.products[0].price, "¥200");
  await h.command("DELETE_TASK", { id: first });
  assert.equal(h.data.collection.products.length, 2); assert.ok(h.data.collection.products.every(item => item.task_id === second));
  assert.equal(h.data.collection.products[0].price, "¥200"); assert.equal(h.data.collection.raw_cards.length, 2);
});

test("JSON imports keep repeated rows, including another import of the same file and shared scanned IDs", async t => {
  const h = await createHarness(browser, t);
  const input = { products: [1, 2].map(price => ({ observation_id: "copied", source: "1688", product_url: "https://detail.1688.com/offer/1001.html", title: "Импорт", price: `¥${price}` })) };
  input.raw_cards = input.products.map(record => ({ observation_id: "copied", source: "1688", product_id: "1001", source_page_url: h.initialUrl, html: "", record }));
  await h.command("IMPORT", { data: input }); await h.command("IMPORT", { data: input });
  assert.equal(h.data.collection.products.length, 4); assert.equal(new Set(h.data.collection.products.map(item => item.observation_id)).size, 4);
  assert.equal(h.data.collection.raw_cards.length, 4); assert.equal(new Set(h.data.collection.raw_cards.map(item => item.observation_id)).size, 4);
  const task = await collect(h); assert.equal(h.data.collection.products.length, 6);
  await h.command("DELETE_TASK", { id: task });
  assert.equal(h.data.collection.products.length, 4); assert.ok(h.data.collection.products.every(item => item.capture_status === "imported"));
  await h.command("EXPORT"); assert.equal(downloaded(h).products.length, 4);
});

test("data-only repeated list entries are retained without multiplying equivalent JSON readers", async t => {
  const h = await createHarness(browser, t);
  await h.page.evaluate(() => { document.body.innerHTML = '<script type="application/ld+json">' + JSON.stringify([1, 2].map(price => ({ '@type': 'Product', offerId: '123456', title: 'Одинаковый товар', offers: { price: String(price), priceCurrency: 'CNY' } }))) + '</script>'; });
  await collect(h);
  assert.equal(h.data.collection.products.length, 2);
  assert.deepEqual(h.data.collection.products.map(item => item.price).sort(), ["CNY 1", "CNY 2"]);
  assert.equal(h.data.collection.raw_cards.length, 2);
});

test("a DOM subset does not hide repeated entries in a complete structured list", async t => {
  const h = await createHarness(browser, t);
  await h.page.evaluate(html => { document.body.innerHTML = html + '<script type="application/ld+json">' + JSON.stringify([1, 2].map(price => ({ '@type': 'Product', offerId: '123456', title: 'Товар', offers: { price: String(price), priceCurrency: 'CNY' } }))) + '</script>'; }, row("123456", 1));
  await collect(h);
  assert.equal(h.data.collection.products.length, 2);
  assert.deepEqual(h.data.collection.products.map(item => item.price).sort(), ["CNY 2", "¥1"]);
});

test("observed JSON responses retain repeated entries from the same product list", async t => {
  const h = await createHarness(browser, t);
  await h.page.evaluate(() => document.body.replaceChildren());
  await h.page.route("**/api/duplicate-list", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ products: [1, 2].map(price => ({ offerId: "123456", title: "Сетевая карточка", price: String(price) })) }) }));
  await h.command("START", { max_pages: 1, scroll: false, observe_responses: true });
  await h.page.waitForFunction(() => window.__supplierResponseObservation?.enabled);
  await h.page.evaluate(async () => (await fetch('/api/duplicate-list')).json());
  await h.waitFor(data => data.run?.status === "finished"); await h.waitFor(() => h.idle());
  assert.equal(h.data.collection.products.length, 2);
  assert.deepEqual(h.data.collection.products.map(item => item.price).sort(), ["1", "2"]);
  assert.equal(h.data.collection.products[0].product_id, h.data.collection.products[1].product_id);
});

for (const [source, url, offer] of [
  ["alibaba", "https://www.alibaba.com/trade/search?SearchText=cup", "https://www.alibaba.com/product-detail/Cup_1600000012345.html"],
  ["made-in-china", "https://www.made-in-china.com/products-search/hot-china-products/Cup.html", "https://factory.en.made-in-china.com/product/abcdef/Test-Cup.html"]
]) test(`${source}: repeated DOM cards keep independent prices`, async t => {
  const h = await createHarness(browser, t);
  h.flags.routeHtml = () => [1, 2].map(price => `<article class="product-card"><a href="${offer}" title="Test cup">Test cup</a><span class="price">$${price}</span></article>`).join("");
  await h.page.goto(url); await collect(h);
  assert.equal(h.data.collection.products.length, 2); assert.equal(h.data.collection.products[0].source, source);
  assert.equal(h.data.collection.products[0].product_id, h.data.collection.products[1].product_id);
  assert.deepEqual(h.data.collection.products.map(item => item.price), ["$1", "$2"]);
});
