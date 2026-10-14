"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { createHarness } = require("./helpers/background-harness.cjs");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });

const origin = "https://catalog.example";
function cards(page = 1) { return [1, 2].map(index => {
  const id = page * 10 + index;
  return `<article class="tile"><a href="/items/cup-${id}"><img src="https://cdn.example/${id}.jpg" alt="Cup ${id}"></a><h3>Cup ${id}</h3><p>€ ${id}.50</p><p>Sold by: <a href="/vendors/cups">Cup factory</a></p></article>`;
}).join(""); }
function html(page, control = '<nav class="pagination"><button disabled aria-label="Next page">Next</button></nav>') { return `<!doctype html><main><section id="tiles">${cards(page)}</section>${control}</main>`; }
async function setup(t, routeHtml) {
  const h = await createHarness(browser, t); h.flags.routeHtml = routeHtml;
  h.granted.add(`${origin}/*`); await h.page.goto(`${origin}/catalog?page=1`);
  return h;
}
const start = { max_pages: 2, interval_seconds: 1, scroll: false };

test("a generic catalogue follows target=_blank and continues in the created tab", async t => {
  const h = await setup(t, url => html(Number(url.searchParams.get("page") || 1), url.searchParams.get("page") === "2" ? undefined : '<nav class="pagination"><a href="?page=2" target="_blank" aria-label="Next page">Next</a></nav>'));
  assert.equal((await h.command("START", start)).ok, true);
  await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.run.completed_pages, 2); assert.equal(h.data.collection.products.length, 4);
  assert.notEqual(h.data.run.tab_id, 1); assert.match(h.page.url(), /page=1/);
  assert.ok(h.data.run.log.some(entry => /новой вкладке/.test(entry.message)));
  const grouped = (await h.command("DATA")).result;
  assert.equal(grouped.supplier_count, 1); assert.equal(grouped.suppliers[0].shop_name, "Cup factory");
});

test("a JavaScript window.open continuation is attributed to the original tab", async t => {
  const h = await setup(t, url => html(Number(url.searchParams.get("page") || 1), url.searchParams.get("page") === "2" ? undefined : '<button aria-label="Next page" onclick="window.open(\'?page=2\', \'_blank\')">Next page</button>'));
  await h.command("START", start); await h.waitFor(data => data.run?.status === "finished");
  assert.notEqual(h.data.run.tab_id, 1); assert.equal(h.data.collection.products.length, 4);
  assert.equal(h.data.run.pending_navigation, null);
});
test("a captcha in a new result tab pauses there and resumes after manual completion", async t => {
  const h = await setup(t, url => url.searchParams.get("page") === "2" ? '<div class="captcha">Verify you are human</div>' : html(1, '<a aria-label="Next page" href="?page=2" target="_blank">Next</a>'));
  await h.command("START", start); await h.waitFor(data => data.run?.status === "paused"); await h.waitFor(() => h.idle());
  assert.equal(h.data.run.pause_reason, "challenge"); assert.notEqual(h.data.run.tab_id, 1);
  assert.equal(h.data.collection.products.length, 2); assert.equal(h.data.run.phase, "search");
  await h.tabs.get(h.data.run.tab_id).setContent(html(2));
  assert.equal((await h.command("RESUME")).ok, true); await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.collection.products.length, 4);
});

test("load more confirms newly added products even when the URL stays unchanged", async t => {
  const control = `<button id="more" onclick="document.getElementById('tiles').insertAdjacentHTML('beforeend', document.getElementById('extra').innerHTML); this.disabled=true">Показать ещё товары</button><template id="extra">${cards(2)}</template>`;
  const h = await setup(t, () => html(1, control));
  await h.command("START", start); await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.collection.products.length, 4); assert.equal(h.data.run.completed_pages, 2);
  assert.equal(h.data.run.tab_id, 1); assert.match(h.page.url(), /page=1/);
});
test("a captcha raised by load more pauses immediately on the same URL", async t => {
  const h = await setup(t, () => html(1, '<button onclick="this.insertAdjacentHTML(\'afterend\', \'<div class=captcha>Verify you are human</div>\')">Load more</button>'));
  const began = Date.now(); await h.command("START", start);
  await h.waitFor(data => data.run?.status === "paused");
  assert.equal(h.data.run.pause_reason, "challenge"); assert.equal(h.data.collection.products.length, 2);
  assert.ok(Date.now() - began < 10000, "challenge must pause before the unchanged-navigation timeout");
});

test("ambiguous pagination pauses without clicking and resumes with the chosen candidate", async t => {
  const controls = '<nav class="pagination"><a href="?page=2&feed=a">Next page</a></nav><nav class="pagination"><a href="?page=2&feed=b">Next page</a></nav>';
  const h = await setup(t, url => html(Number(url.searchParams.get("page") || 1), url.searchParams.get("page") === "2" ? undefined : controls));
  await h.command("START", start); await h.waitFor(data => data.run?.status === "paused"); await h.waitFor(() => h.idle());
  assert.equal(h.data.run.pause_reason, "navigation-choice"); assert.equal(h.data.run.completed_pages, 1);
  assert.match(h.page.url(), /page=1/); assert.equal(h.tabs.size, 1);
  const navigation = (await h.command("NAV_SCAN", { tab_id: 1 })).result;
  assert.equal(navigation.decision, "ambiguous");
  assert.equal((await h.command("NAV_CHOOSE", { tab_id: 1, candidate_id: navigation.candidates[1].id })).ok, true);
  assert.equal((await h.command("RESUME")).ok, true); await h.waitFor(data => data.run?.status === "finished");
  assert.match(h.page.url(), /feed=b/); assert.equal(h.data.collection.products.length, 4);
  assert.ok(h.data.profiles[origin].navigation.selector);
});

test("several JavaScript destination tabs pause for manual selection without mixing their products", async t => {
  const control = '<button aria-label="Next page" onclick="window.open(\'?page=2&feed=a\', \'_blank\');window.open(\'?page=3&feed=b\', \'_blank\')">Next page</button>';
  const h = await setup(t, url => html(Number(url.searchParams.get("page") || 1), url.searchParams.get("page") !== "1" ? undefined : control));
  await h.command("START", start); await h.waitFor(data => data.run?.status === "paused"); await h.waitFor(() => h.idle());
  assert.equal(h.data.run.pause_reason, "new-tabs"); assert.equal(h.data.collection.products.length, 2);
  const selected = [...h.tabs].find(([, page]) => page.url().includes("feed=a"))[0];
  assert.equal((await h.command("RESUME", { tab_id: selected })).ok, true);
  await h.waitFor(data => data.run?.status === "finished"); assert.equal(h.data.collection.products.length, 4);
  assert.ok(h.data.collection.products.every(item => !item.title.includes("31") && !item.title.includes("32")));
});

test("a cross-origin continuation pauses for site access and resumes after it is granted", async t => {
  const destination = "https://other.example";
  const h = await setup(t, url => html(url.hostname === "other.example" ? 2 : 1, url.hostname === "other.example" ? undefined : `<a rel="next" href="${destination}/catalog?page=2">Next page</a>`));
  await h.command("START", start); await h.waitFor(data => data.run?.status === "paused"); await h.waitFor(() => h.idle());
  assert.equal(h.data.run.pause_reason, "permission"); assert.equal(h.data.run.required_origin, `${destination}/*`);
  assert.equal(h.data.collection.products.length, 2); assert.match(h.page.url(), /catalog.example/);
  h.granted.add(`${destination}/*`); assert.equal((await h.command("RESUME")).ok, true);
  await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.collection.products.length, 4); assert.equal(h.data.run.required_origin, null);
  assert.equal(h.data.collection.products.filter(item => item.source === "web:other.example").length, 2);
});

test("the on-page picker learns an unconventional button without activating it", async t => {
  const h = await setup(t, url => html(Number(url.searchParams.get("page") || 1), url.searchParams.get("page") === "2" ? undefined : '<button id="forward" onclick="location.href=\'?page=2\'">Продолжение каталога</button>'));
  await h.command("START", start); await h.waitFor(data => data.run?.status === "paused"); await h.waitFor(() => h.idle());
  assert.equal((await h.command("PICK", { tab_id: 1, mode: "next" })).ok, true);
  await h.page.locator("#forward").click(); await h.waitFor(data => Boolean(data.profiles?.[origin]?.navigation));
  assert.match(h.page.url(), /page=1/); assert.equal(await h.page.locator('[data-supplier-picker]').count(), 0);
  await h.command("RESUME"); await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.collection.products.length, 4);
  await h.waitFor(() => h.idle());
  await h.command("PICK", { tab_id: 1, mode: "card" }); await h.page.locator("h3").first().click();
  await h.waitFor(data => Boolean(data.profiles?.[origin]?.card_selector));
  assert.match(h.data.profiles[origin].card_selector, /tile/);
});

test("the dashboard requests only the selected site's access and shows explained navigation choices", async t => {
  const h = await setup(t, () => html(1, '<a aria-label="Next page" href="?page=2" target="_blank">Next</a>'));
  h.granted.clear();
  assert.equal((await h.command("START", start)).ok, false);
  const requested = [], ui = await h.context.newPage();
  await ui.setViewportSize({ width: 1440, height: 1100 });
  await ui.exposeFunction("__backgroundCommand", ({ type, options }) => h.command(type, options));
  await ui.exposeFunction("__requestPermission", ({ origins }) => { requested.push(...origins); origins.forEach(pattern => h.granted.add(pattern)); return true; });
  await ui.addInitScript(() => { globalThis.chrome = { runtime: { sendMessage: message => __backgroundCommand(message) }, permissions: { request: options => __requestPermission(options) }, storage: { onChanged: { addListener() {} } } }; });
  await ui.route("https://collector.test/**", route => {
    const file = new URL(route.request().url()).pathname.slice(1), contentType = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8";
    return route.fulfill({ body: fs.readFileSync(path.join(__dirname, "../extension", file)), contentType });
  });
  await ui.goto("https://collector.test/dashboard.html"); await ui.locator("#scan-nav").click();
  await ui.waitForFunction(() => document.querySelectorAll(".nav-option").length === 1);
  assert.deepEqual(requested, [`${origin}/*`]);
  assert.match(await ui.locator("#nav-summary").textContent(), /Автоматический выбор/);
  assert.match(await ui.locator(".nav-option").textContent(), /новая вкладка/);
  await ui.locator(".nav-option button").click(); await h.waitFor(data => Boolean(data.profiles?.[origin]?.navigation));
  fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true });
  await ui.screenshot({ path: path.join(__dirname, "../test-results/navigation-dashboard.png"), fullPage: true });
});
