"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { chromium } = require("playwright-core");
const { createHarness } = require("./helpers/background-harness.cjs");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
const settings = [
  { source: "1688", url: "https://s.1688.com/selloffer/offer_search.htm?keywords=cup&page=1", supplier: "https://cups.1688.com/", product: id => `https://detail.1688.com/offer/${812345670000 + id}.html`, control: '<div id="next" class="fui-arrow fui-next" style="width:40px;height:28px"></div>' },
  { source: "alibaba", url: "https://www.alibaba.com/trade/search?SearchText=cup&page=1", supplier: "https://cups.en.alibaba.com/", product: id => `https://www.alibaba.com/product-detail/Cup_${1600000000000 + id}.html`, control: '<button id="next" aria-labelledby="next-label"><svg><path d="M9 6 L15 12 L9 18"></path></svg></button><span id="next-label" hidden>Go to next page</span>' },
  { source: "made-in-china", url: "https://www.made-in-china.com/products-search/hot-china-products/Cup.html?page=1", supplier: "https://cups.en.made-in-china.com/", product: id => `https://cups.en.made-in-china.com/product/Aa${id}Bb/China-Cup-${id}.html`, control: '<button id="next"><svg><path d="M9 6 L15 12 L9 18"></path></svg></button>' }
];
function tiles(config, page) { return [1, 2].map(index => { const id = page * 10 + index; return `<article class="changed-wrapper-${page}-${index}"><a href="${config.product(id)}" aria-label="${config.source} cup ${id}"><img src="https://cdn.example/${id}.jpg" alt="${config.source} cup ${id}"></a><h3>${config.source} cup ${id}</h3><p>$${id}.50</p><a class="company-name" href="${config.supplier}">Fixture cup factory</a></article>`; }).join(""); }
async function popup(h) {
  const ui = await h.context.newPage();
  await ui.setViewportSize({ width: 420, height: 900 });
  await ui.exposeFunction("__backgroundCommand", ({ type, options }) => h.command(type, options));
  await ui.addInitScript(() => { globalThis.__storageListeners = []; globalThis.chrome = { runtime: { sendMessage: message => __backgroundCommand(message) }, storage: { onChanged: { addListener: listener => __storageListeners.push(listener) } } }; });
  h.observers.push((changes, area) => { if (!ui.isClosed()) void ui.evaluate(({ changes, area }) => (globalThis.__storageListeners || []).forEach(listener => listener(changes, area)), { changes, area }).catch(() => {}); });
  await ui.route("https://collector.test/**", route => {
    const file = new URL(route.request().url()).pathname.slice(1), contentType = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8";
    return route.fulfill({ body: fs.readFileSync(path.join(__dirname, "../extension", file)), contentType });
  });
  await ui.goto("https://collector.test/popup.html"); return ui;
}
for (const config of settings) test(`${config.source}: captcha at an unchanged URL survives restart and one popup click resumes the correct transition`, async t => {
  const h = await createHarness(browser, t);
  h.flags.routeHtml = url => {
    const page = Number(url.searchParams.get("page") || 1);
    return `<!doctype html><main><section>${tiles(config, page)}</section><nav class="pagination">${page === 1 ? config.control : '<button disabled aria-label="Next page">Next</button>'}</nav></main>${page === 1 ? '<script>window.clicks=0; document.getElementById("next").addEventListener("click",()=>{clicks++;if(!window.challengePassed){document.body.insertAdjacentHTML("beforeend",\'<div class="captcha">Verify you are human</div>\');return;}location.href=location.href.replace("page=1","page=2");});</script>' : ''}`;
  };
  await h.page.goto(config.url); assert.equal((await h.command("START", { max_pages: 2, scroll: false, interval_seconds: 1 })).ok, true);
  await h.waitFor(data => data.run?.status === "paused"); await h.waitFor(() => h.idle());
  assert.equal(h.data.run.pause_reason, "challenge"); assert.equal(h.data.collection.products.length, 2);
  assert.equal(h.data.run.completed_pages, 1); assert.ok(h.data.run.challenge_navigation);
  assert.equal(await h.page.evaluate(() => clicks), 1);
  h.resume();
  const rejected = await h.command("RESUME"); assert.equal(rejected.ok, false);
  assert.equal(h.data.run.status, "paused"); assert.equal(await h.page.evaluate(() => clicks), 1);
  const ui = await popup(h); assert.equal(await ui.locator("#show-tab").isVisible(), true);
  // Fixture-only simulation of the user completing the challenge.
  await h.page.evaluate(() => { document.querySelector(".captcha").remove(); window.challengePassed = true; });
  await ui.locator("#resume").click();
  await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.run.completed_pages, 2); assert.equal(h.data.collection.products.length, 4);
  assert.equal(h.data.run.challenge_navigation, null); assert.match(h.page.url(), /page=2/);
  assert.ok(h.data.collection.products.every(item => item.source === config.source));
  assert.equal((await h.command("DATA")).result.supplier_count, 1);
  await ui.waitForFunction(() => document.getElementById("count").textContent === "4");
  assert.equal(await ui.locator("#error").isVisible(), false);
  if (config.source === "1688") { fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true }); await ui.screenshot({ path: path.join(__dirname, "../test-results/recovery-popup.png"), fullPage: true }); }
});

test("store-only search uses actual pagination metadata and preserves whitelisted records through export/import/reparse", async t => {
  const h = await createHarness(browser, t), config = settings[1];
  h.flags.routeHtml = url => {
    const page = Number(url.searchParams.get("page") || 1);
    const state = { products: [1, 2].map(index => ({ productId: String(1600000000000 + page * 10 + index), title: `Store cup ${page * 10 + index}`, productUrl: config.product(page * 10 + index), price: "9", companyName: "Store factory", companyUrl: config.supplier })), pagination: { nextPageUrl: page === 1 ? config.url.replace("page=1", "page=2") : null, hasNextPage: page === 1, currentPage: page }, auth: { token: "must-not-export" } };
    return `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};</script><main><p>Rendered by components</p></main>`;
  };
  await h.page.goto(config.url); await h.command("START", { max_pages: 3, scroll: false, interval_seconds: 1 });
  await h.waitFor(data => data.run?.status === "finished"); await h.waitFor(() => h.idle());
  assert.equal(h.data.collection.products.length, 4); assert.equal(h.data.run.completed_pages, 2);
  assert.ok(h.data.collection.products.every(item => item.field_sources.title === "page-state"));
  await h.command("EXPORT", { format: "raw" });
  const exported = JSON.parse(decodeURIComponent(h.downloads[0].url.split(",").slice(1).join(",")));
  assert.doesNotMatch(JSON.stringify(exported), /must-not-export/); assert.equal(exported.raw_cards.length, 4);
  await h.command("CLEAR"); assert.equal((await h.command("IMPORT", { data: exported })).ok, true);
  const raw = (await h.command("RAW")).result;
  const reparse = await h.page.evaluate(cards => SupplierCollectorEngine.reparse(cards), raw);
  assert.equal(reparse.length, 4); assert.ok(reparse.every(item => item.shop_name === "Store factory"));
});

test("GET form pagination advances a bounded page value and preserves the search query", async t => {
  const h = await createHarness(browser, t); h.granted.add("https://catalog.example/*");
  h.flags.routeHtml = url => {
    const page = Number(url.searchParams.get("page") || 1);
    const cards = [1, 2].map(index => `<article><a href="/items/${page * 10 + index}"><img src="https://cdn.example/a.jpg" alt="Form cup ${page * 10 + index}"></a><h3>Form cup ${page * 10 + index}</h3><p>$10</p></article>`).join("");
    return `<main><section>${cards}</section><form class="pagination" action="/search" method="get"><input name="q" value="cup"><input name="page" type="number" value="${page}" max="2"><button type="submit">Go</button></form></main>`;
  };
  await h.page.goto("https://catalog.example/search?q=cup&page=1"); await h.command("START", { max_pages: 3, scroll: false, interval_seconds: 1 });
  await h.waitFor(data => data.run?.status === "finished");
  assert.equal(h.data.run.completed_pages, 2); assert.equal(h.data.collection.products.length, 4);
  assert.equal(new URL(h.page.url()).searchParams.get("q"), "cup");
});

test("dynamic window.open without an inline destination still adopts the attributed result tab", async t => {
  const h = await createHarness(browser, t), config = settings[0];
  h.flags.routeHtml = url => {
    const page = Number(url.searchParams.get("page") || 1);
    return `<section>${tiles(config, page)}</section>${page === 1 ? '<button id="next" aria-label="Next page">Next</button><script>document.getElementById("next").addEventListener("click",()=>window.open(location.href.replace("page=1","page=2"),"_blank"));</script>' : '<button disabled aria-label="Next page">Next</button>'}`;
  };
  await h.page.goto(config.url); await h.command("START", { max_pages: 2, scroll: false, interval_seconds: 1 });
  await h.waitFor(data => data.run?.status === "finished");
  assert.notEqual(h.data.run.tab_id, 1); assert.equal(h.data.collection.products.length, 4);
});
