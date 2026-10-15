"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright-core");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
async function analyze(t, html, url = "https://catalog.example/catalog?page=1", profile = null) {
  const page = await browser.newPage(); t.after(() => page.close()); await page.route("**/*", route => route.abort());
  for (const name of ["shared.js", "navigation.js"]) await page.addScriptTag({ path: path.join(__dirname, "../extension", name) });
  return page.evaluate(({ html, url, profile }) => SupplierNavigator.publicResult(SupplierNavigator.analyze(new DOMParser().parseFromString(html, "text/html"), { url, snapshot: true, profile })), { html, url, profile });
}
test("1688's empty div.fui-next is recognised by paging context", async t => {
  const result = await analyze(t, '<div class="space-common-pagination"><div class="fui-paging-list"><div class="fui-arrow fui-next"></div></div></div>');
  assert.equal(result.decision, "automatic"); assert.match(result.chosen.selector, /fui-arrow|fui-next/); assert.equal(result.chosen.kind, "next");
});
test("Alibaba's accessible Go to next page icon is recognised", async t => {
  const result = await analyze(t, '<div class="next-pagination"><button aria-label="Go to next page"><svg></svg></button></div>');
  assert.equal(result.decision, "automatic"); assert.equal(result.chosen.label, "Go to next page");
});
test("a pagination wrapper never replaces the actual button it contains", async t => {
  const result = await analyze(t, '<div class="next-pagination"><button aria-label="Next page">Next page</button></div>');
  assert.equal(result.decision, "automatic"); assert.equal(result.candidates.length, 1);
  assert.match(result.chosen.selector, /aria-label/);
});
test("rel=next works in document metadata independently of classes", async t => {
  const result = await analyze(t, '<link rel="next" href="?page=2">');
  assert.equal(result.decision, "automatic"); assert.match(result.chosen.href, /page=2/);
});
test("numeric pagination uses aria-current and chooses the immediately following number", async t => {
  const result = await analyze(t, '<nav aria-label="Pagination"><a href="?page=1">1</a><span aria-current="page">2</span><a href="?page=3">3</a><a href="?page=4">4</a></nav>', "https://catalog.example/catalog?page=2");
  assert.equal(result.chosen.label, "3"); assert.equal(result.chosen.kind, "number");
});
test("Russian next-page text and target=_blank are preserved", async t => {
  const result = await analyze(t, '<a aria-label="Следующая страница" target="_blank" href="?page=2">→</a>');
  assert.equal(result.decision, "automatic"); assert.equal(result.chosen.target_blank, true);
});
test("load more is recognised as continuation without a new URL", async t => {
  const result = await analyze(t, '<button>Показать ещё товары</button>');
  assert.equal(result.decision, "automatic"); assert.equal(result.chosen.kind, "load-more"); assert.equal(result.chosen.href, null);
});
test("disabled next is terminal, while previous and last controls are ignored", async t => {
  const result = await analyze(t, '<nav class="pagination"><button>Previous</button><button disabled aria-label="Next page">Next</button><a href="?page=20">Last page</a></nav>');
  assert.equal(result.decision, "exhausted"); assert.equal(result.candidates.length, 0);
});
test("equally plausible independent pagers require a choice", async t => {
  const result = await analyze(t, '<nav class="pagination"><a href="?page=2&feed=a">Next page</a></nav><nav class="pagination"><a href="?page=2&feed=b">Next page</a></nav>');
  assert.equal(result.decision, "ambiguous"); assert.equal(result.chosen, null);
});
test("checkout actions and image-carousel arrows never win automatic page selection", async t => {
  const result = await analyze(t, '<a rel="next" href="/checkout">Next page</a><div class="carousel"><button class="next" aria-label="Next page">Next</button></div><a rel="next" href="?page=2">Next</a>');
  assert.equal(result.chosen.href, "https://catalog.example/catalog?page=2"); assert.equal(result.candidates.length, 1);
});
test("a learned control can be reused without a conventional label", async t => {
  const result = await analyze(t, '<form><button id="forward">Продолжение каталога</button></form>', undefined, { selector: "#forward", label: "Продолжение каталога" });
  assert.equal(result.decision, "automatic"); assert.ok(result.chosen.reasons.some(reason => /пользователем/.test(reason)));
});
test("a text-only div can be recognised without classes or accessibility attributes", async t => {
  const result = await analyze(t, '<div>Следующая страница</div>');
  assert.equal(result.decision, "automatic"); assert.equal(result.chosen.label, "Следующая страница");
});
test("aria-labelledby resolves the accessible name of an icon-only control", async t => {
  const result = await analyze(t, '<span id="next-name" hidden>Next page</span><button aria-labelledby="next-name"><svg></svg></button>');
  assert.equal(result.decision, "automatic"); assert.equal(result.chosen.label, "Next page");
});
test("a chevron SVG inside a pager is a supported next-page signal", async t => {
  const result = await analyze(t, '<nav class="pagination"><button><svg viewBox="0 0 24 24"><path d="M9 6 L15 12 L9 18"></path></svg></button></nav>');
  assert.equal(result.decision, "automatic"); assert.ok(result.chosen.reasons.some(reason => /SVG/.test(reason)));
});
test("numeric GET pagination forms expose a checked next value", async t => {
  const result = await analyze(t, '<form class="pagination" action="/catalog"><label for="page">Page</label><input id="page" name="page" type="number" value="2" max="3"><button type="submit">Go</button></form>');
  assert.equal(result.decision, "automatic"); assert.equal(result.chosen.action, "form-page"); assert.equal(result.chosen.next_value, "3");
});
test("select pagination at its final option is terminal", async t => {
  const result = await analyze(t, '<form class="pagination"><select name="page"><option value="1">1</option><option value="2" selected>2</option></select></form>');
  assert.equal(result.decision, "exhausted");
});
test("a final numbered page and a one-page pager can finish without a next button", async t => {
  const last = await analyze(t, '<nav class="pagination"><a href="?page=1">1</a><a href="?page=2">2</a><span aria-current="page">3</span></nav>', "https://catalog.example/catalog?page=3");
  assert.equal(last.decision, "exhausted"); assert.equal(last.candidates.length, 0);
  const one = await analyze(t, '<nav class="pagination" data-total-pages="1"><span aria-current="page">1</span></nav>');
  assert.equal(one.decision, "exhausted");
  const nested = await analyze(t, '<ul class="pagination"><li class="pagination-item"><a href="?page=1">1</a></li><li class="pagination-item active"><span aria-current="page">2</span></li></ul>', "https://catalog.example/catalog?page=2");
  assert.equal(nested.decision, "exhausted");
});
test("a disabled standalone load-more control confirms the end of results", async t => {
  assert.equal((await analyze(t, '<button disabled>Load more</button>')).decision, "exhausted");
});
test("missing navigation, ellipses and an active continuation are not mistaken for the last page", async t => {
  assert.equal((await analyze(t, '<p>Products</p>')).decision, "missing");
  assert.equal((await analyze(t, '<div class="gallery"><nav class="pagination"><span>1</span><span aria-current="page">2</span></nav></div>')).decision, "missing");
  assert.equal((await analyze(t, '<nav class="pagination"><a href="?page=1">1</a><span aria-current="page">3</span><span>…</span></nav>', "https://catalog.example/catalog?page=3")).decision, "missing");
  assert.equal((await analyze(t, '<nav class="pagination"><a href="?page=1">1</a><span aria-current="page">3</span><a rel="next" href="?page=4">Next page</a></nav>', "https://catalog.example/catalog?page=3")).decision, "automatic");
});
test("an exact window.open literal exposes its destination without running JavaScript", async t => {
  const result = await analyze(t, '<button aria-label="Next page" onclick="window.open(\'?page=2\', \'_blank\')">Next</button>');
  assert.equal(result.chosen.target_blank, true); assert.match(result.chosen.href, /page=2$/);
});
test("a saved numeric control cannot force navigation back to an old page", async t => {
  const result = await analyze(t, '<nav class="pagination"><a id="old" href="?page=2">2</a><a href="?page=4">4</a></nav>', "https://catalog.example/catalog?page=3", { selector: "#old", label: "2" });
  assert.equal(result.decision, "automatic"); assert.equal(result.chosen.label, "4");
});
