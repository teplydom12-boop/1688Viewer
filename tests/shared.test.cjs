"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../extension/shared.js");

test("canonical product links retain the ID but remove tracking", () => {
  assert.deepEqual(S.productUrl("//detail.1688.com/offer/123456.html?spm=tracking", "https://s.1688.com/"), {
    id: "123456", url: "https://detail.1688.com/offer/123456.html"
  });
  assert.equal(S.productUrl("https://detail.1688.com.evil.example/offer/123.html"), null);
  assert.equal(S.productUrl("javascript:alert(1)"), null);
  assert.equal(S.isMarketplaceUrl("https://1688.com.evil.example/"), false);
  assert.equal(S.isMarketplaceUrl("https://s.1688.com/"), true);
});

test("supplier links exclude search, login and product hosts", () => {
  assert.equal(S.supplierUrl("https://factory.1688.com/page/offerlist.htm?spm=x"), "https://factory.1688.com/");
  assert.equal(S.supplierUrl("https://detail.1688.com/offer/12.html"), null);
  assert.equal(S.supplierUrl("https://login.1688.com/"), null);
  assert.equal(S.supplierUrl("https://factory.example/"), null);
});

test("search metadata supports text, image labels and legacy query encodings", () => {
  assert.deepEqual(S.detectSearch("https://s.1688.com/?keywords=%E6%B0%B4%E6%9D%AF"), { query: "水杯", search_type: "text" });
  assert.deepEqual(S.detectSearch("https://s.1688.com/?imageAddress=abc", "Фото 1"), { query: "Фото 1", search_type: "image" });
  assert.deepEqual(S.detectSearch("https://s.1688.com/?imageAddress=abc"), { query: null, search_type: "image" });
  assert.deepEqual(S.detectSearch("https://s.1688.com/?keywords=%B1%A3", null, "保温杯"), { query: "保温杯", search_type: "text" });
});

test("merge preserves known fields, first collection time and search provenance", () => {
  const first = { source: "1688", product_id: "12", price: "¥10", title: "Cup", query: "cup", search_type: "text", source_page_url: "page1", collected_at: "2026-01-01T00:00:00.000Z" };
  const second = { ...first, price: null, title: null, query: "Фото 1", search_type: "image", source_page_url: "page2", collected_at: "2026-02-01T00:00:00.000Z" };
  const merged = S.mergeProducts([first], [second, second]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].price, "¥10");
  assert.equal(merged[0].title, "Cup");
  assert.equal(merged[0].collected_at, first.collected_at);
  assert.equal(merged[0].last_seen_at, second.collected_at);
  // Also retain a legacy record's initial sighting if it has no sightings array.
  assert.equal(merged[0].sightings.at(-1).query, "Фото 1");
  assert.equal(merged[0].sightings.length, 2);
  assert.equal(merged[0].sightings[0].query, "cup");
});

test("supplier grouping joins stable IDs and store URLs, but never equal names or different marketplaces", () => {
  const products = [
    { source: "1688", product_id: "1", supplier_id: "b2b-one", shop_name: "Same name" },
    { source: "1688", product_id: "2", supplier_id: "b2b-one", supplier_url: "https://one.1688.com/", shop_name: "Same name" },
    { source: "1688", product_id: "3", supplier_url: "https://one.1688.com/", shop_name: "Same name" },
    { source: "alibaba", product_id: "4", supplier_id: "b2b-one", shop_name: "Same name" },
    { source: "1688", product_id: "5", shop_name: "Same name" }
  ];
  const groups = S.supplierGroups(products);
  assert.equal(groups.suppliers.length, 2); assert.equal(groups.suppliers[0].products.length, 3); assert.equal(groups.unresolved.length, 1);
});

test("import accepts old exports, rejects spoofed destinations and CSV protects spreadsheet formulas", () => {
  const imported = S.importProducts({ products: [{ source: "1688", product_url: "https://detail.1688.com/offer/123.html?spm=x", title: "=1+1", supplier_url: "javascript:alert(1)" }] });
  assert.equal(imported[0].product_id, "123"); assert.equal(imported[0].supplier_url, null);
  assert.match(S.csv(imported), /'=1\+1/);
  assert.throws(() => S.importProducts({ products: [{ product_url: "https://detail.1688.com.evil.example/offer/123.html" }] }), /неверная ссылка/);
});
