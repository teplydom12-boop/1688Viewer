"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
let browser;
const URL = "https://s.1688.com/selloffer/offer_search.htm?keywords=%E6%B0%B4%E6%9D%AF&page=1";
const fixture = fs.readFileSync(path.join(__dirname, "fixtures/results.html"), "utf8");

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});
after(async () => { await browser?.close(); });

async function pageFor(t, html = fixture, url = URL) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  t.after(() => page.close());
  await page.route("**/*", route => route.request().resourceType() === "document"
    ? route.fulfill({ contentType: "text/html; charset=utf-8", body: html }) : route.abort());
  await page.goto(url);
  await page.addScriptTag({ path: path.join(__dirname, "../extension/shared.js") });
  await page.addScriptTag({ path: path.join(__dirname, "../extension/navigation.js") });
  await page.addScriptTag({ path: path.join(__dirname, "../extension/generic.js") });
  await page.addScriptTag({ path: path.join(__dirname, "../extension/engine.js") });
  await page.addScriptTag({ path: path.join(__dirname, "../extension/content.js") });
  return page;
}

test("DOM extraction reads the required fields and ignores hidden cards", async t => {
  const page = await pageFor(t);
  const products = await page.evaluate(() => SupplierCollectorDOM.readPage());
  assert.equal(products.length, 2);
  assert.deepEqual(products.map(item => item.product_id), ["1001", "1002"]);
  const item = products[0];
  assert.equal(item.title, "透明水杯 500ml");
  assert.equal(item.product_url, "https://detail.1688.com/offer/1001.html");
  assert.equal(item.shop_name, "浙江水杯工厂");
  assert.equal(item.supplier_url, "https://cupfactory.1688.com/");
  assert.equal(item.price, "¥12.50");
  assert.equal(item.minimum_order, "2件起批");
  assert.equal(item.image_url, "https://cbu01.alicdn.com/img/ibank/cup.jpg");
  assert.equal(item.query, "水杯");
  assert.ok(!Number.isNaN(Date.parse(item.collected_at)));
  for (const field of ["price", "shop_name", "supplier_url", "minimum_order", "image_url"]) assert.equal(products[1][field], null);
});

test("unknown card wrappers do not mix fields from neighbouring products", async t => {
  const html = '<main><div class="grid"><div><a href="https://detail.1688.com/offer/1.html" title="Cup one">Cup one</a><span class="price">¥1</span></div><div><a href="https://detail.1688.com/offer/2.html" title="Cup two">Cup two</a><span class="price">¥2</span></div></div></main>';
  const page = await pageFor(t, html);
  const products = await page.evaluate(() => SupplierCollectorDOM.readPage());
  assert.deepEqual(products.map(item => [item.product_id, item.price]), [["1", "¥1"], ["2", "¥2"]]);
});

test("image search has a user label without inventing a text query", async t => {
  const page = await pageFor(t, fixture, "https://s.1688.com/youyuan/index.htm?imageAddress=example");
  const products = await page.evaluate(() => SupplierCollectorDOM.readPage("Фото термоса"));
  assert.equal(products[0].query, "Фото термоса");
  assert.equal(products[0].search_type, "image");
});

test("JS-navigation cards can expose an offer ID without a product anchor", async t => {
  const page = await pageFor(t, '<article class="offer-card" data-offer-id="1234567890123456789"><h3>Image-search cup</h3><span class="price">¥9.50</span></article>');
  const [product] = await page.evaluate(() => SupplierCollectorDOM.readPage());
  assert.equal(product.product_id, "1234567890123456789");
  assert.equal(product.product_url, "https://detail.1688.com/offer/1234567890123456789.html");
  assert.equal(product.title, "Image-search cup");
  assert.equal(product.price, "¥9.50");
});

test("login and captcha stop collection; a normal login link does not", async t => {
  const page = await pageFor(t);
  assert.equal(await page.evaluate(() => SupplierCollectorDOM.blockedReason()), null);
  await page.evaluate(() => {
    const captcha = document.createElement("div"); captcha.className = "nc-container"; captcha.textContent = "滑动验证"; document.body.prepend(captcha);
  });
  await assert.rejects(page.evaluate(() => SupplierCollectorDOM.collect({ scroll: false })), /проверку безопасности/);
});

test("pagination recognises next and refuses disabled controls", async t => {
  const page = await pageFor(t);
  assert.equal(await page.evaluate(() => SupplierCollectorDOM.nextPageElement()?.textContent), "下一页");
  await page.evaluate(() => document.querySelector(".next").setAttribute("aria-disabled", "true"));
  assert.equal(await page.evaluate(() => SupplierCollectorDOM.nextPageElement()), null);
});

test("rate-limit pages pause instead of issuing repeated page requests", async t => {
  const page = await pageFor(t, '<h1>429 Too Many Requests</h1>');
  await assert.rejects(page.evaluate(() => SupplierCollectorDOM.collect({ scroll: false })), /частоту запросов/);
});

test("scroll collection accumulates lazy and virtualised cards", async t => {
  const page = await pageFor(t, fixture.replace("</main>", '<div style="height:1200px"></div></main>'));
  await page.evaluate(() => {
    let replaced = false;
    window.addEventListener("scroll", () => {
      if (scrollY < 500 || replaced) return;
      replaced = true;
      document.querySelectorAll(".offer-card").forEach(card => card.remove());
      const card = document.createElement("article");
      card.className = "offer-card";
      card.innerHTML = '<a class="offer-title" href="https://detail.1688.com/offer/1004.html">Lazy-loaded cup</a><span class="price">¥4</span>';
      document.querySelector("main").append(card);
    });
  });
  const result = await page.evaluate(() => SupplierCollectorDOM.collect({ scroll: true }));
  assert.deepEqual(result.products.map(item => item.product_id), ["1001", "1002", "1004"]);
  assert.equal(result.page.product_count, 3);
});
