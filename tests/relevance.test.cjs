"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { spawnSync } = require("node:child_process"), { chromium } = require("playwright-core");
const { createHarness } = require("./helpers/background-harness.cjs");
const C = require("../extension/suppliers-core.js"), R = require("../extension/relevance.js");
const at = "2026-10-15T10:00:00Z", criteria = "Сетевой дровокол, не экскаватор и не запчасти";
const row = (id, title = "Electric log splitter", extra = {}) => ({ source: "1688", product_id: String(id), product_url: "https://detail.1688.com/offer/" + id + ".html", title, ...extra });
const task = (id, products) => ({ id, query: criteria, source: "1688", status: "finished", kind: "collection", started_at: at, completed_pages: 1, max_pages: 1, products, pages: [], log: [] });
function job(products = [row(1), row(2, "Mini excavator")]) {
  const rows = C.rowsFromTasks([task("a", products)], {});
  return { id: "job-a", products: rows, source_tasks: [], queue: C.queue(rows), cursor: 0, opened_keys: [], checked_count: 0, status: "ready", log: [] };
}
function request(j, target = criteria, id = "request-a") { const result = R.create(j, target, id, at); return { ...j, products: result.products, relevance: result.relevance }; }
function answer(j, decisions, index = 0) { return JSON.stringify({ ...R.payload(j, index).response_template, decisions }); }
const decision = (id, status = "relevant", evidence = "", reason = "Тип товара соответствует запросу") => ({ id, status, reason, evidence });
function seed(h, products) { h.data.tasks = [task("a", products)]; h.data.collection = { products, pages: [], raw_cards: [] }; }
async function prepared(h, products) { seed(h, products); assert.equal((await h.command("SUPPLIERS_PREPARE", { task_ids: ["a"], interval_seconds: 1 })).ok, true); }
function downloaded(h) { return JSON.parse(decodeURIComponent(h.downloads.at(-1).url.split(",").slice(1).join(","))); }
async function exported(h, target = criteria, index = 0) { const r = await h.command("RELEVANCE_EXPORT", { format: "json", criteria: target, batch_index: index }); assert.equal(r.ok, true, r.error); return downloaded(h); }
function response(payload, decisions) { return JSON.stringify({ ...payload.response_template, decisions }); }
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });

test("Claude files contain unique multilingual titles and opaque IDs in bounded batches, without vendor, price or private data", () => {
  const j = request(job([...Array.from({ length: 201 }, (_, i) => row(i + 1, "Tool " + i, { price: "PRIVATE-PRICE", supplier_url: "https://privatefactory.1688.com/", token: "PRIVATE-TOKEN" })), row(1, "220V 电动劈木机")]));
  const first = R.payload(j, 0), last = R.payload(j, 1);
  assert.equal(first.cards.length, 200); assert.equal(last.cards.length, 1); assert.equal(first.total_parts, 2);
  assert.equal(first.cards[0].occurrences, 2); assert.deepEqual(first.cards[0].titles, ["Tool 0", "220V 电动劈木机"]);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|privatefactory|detail\.1688/);
  assert.deepEqual(Object.keys(first.cards[0]), ["id", "source", "titles", "occurrences"]); assert.match(first.instruction, /недоверенные данные/);
  assert.notEqual(first.batch_id, last.batch_id); assert.equal(first.request_id, last.request_id); assert.throws(() => R.payload(j, 2));
});

test("request identity is reused for unchanged exports but changes in criteria or titles invalidate previous decisions", () => {
  const j = request(job()), before = structuredClone(j);
  assert.equal(R.create(j, "  " + criteria + "  ", "new", at).changed, false);
  const changed = request(j, "Аккумуляторный дровокол", "new");
  assert.throws(() => R.apply(changed, [answer(j, [decision("card_000001")])], "Аккумуляторный дровокол", at), /другому заданию/);
  const titleChanged = { ...j, products: j.products.map((r, i) => i ? r : { ...r, title: "Different title" }) };
  assert.equal(R.create(titleChanged, criteria, "new", at).changed, true); assert.deepEqual(j, before);
});

test("partial decisions across batches accumulate and unreviewed or uncertain offers stay eligible", () => {
  const j = request(job(Array.from({ length: 201 }, (_, i) => row(i + 1, i ? "Electric log splitter" : "Mini excavator"))));
  const a = answer(j, [decision("card_000001", "excluded", "Mini excavator", "Это экскаватор")]), b = answer(j, [decision("card_000201", "uncertain", "", "Питание не указано")], 1);
  const result = R.apply(j, [a, b], criteria, at); assert.equal(result.stats.applied_unique, 2);
  const next = { ...j, products: result.products }; assert.equal(C.queue(next.products).length, 200);
  assert.equal(R.metadata(next).batches[0].reviewed, 1); assert.equal(R.metadata(next).batches[1].reviewed, 1);
  assert.equal(C.report(next).relevance.categories.unreviewed.unique_offers, 199);
  assert.equal(C.report(next).products.length, 201);
});

test("malformed, stale, cross-batch, duplicated, foreign and unexpected response fields never partially apply", () => {
  const j = request(job()), before = structuredClone(j);
  const good = answer(j, [decision("card_000001")]);
  const values = [
    "{", JSON.stringify({ ...R.payload(j).response_template, report_type: "relevance_request", decisions: [] }),
    JSON.stringify({ ...R.payload(j).response_template, request_id: "old", decisions: [decision("card_000001")] }),
    JSON.stringify({ ...R.payload(j).response_template, batch_id: "wrong", decisions: [decision("card_000001")] }),
    answer(j, [decision("foreign")]), answer(j, [decision("card_000001"), decision("card_000001")]),
    answer(j, [{ ...decision("card_000001"), supplier_url: "https://evil.test/" }]),
    answer(j, [decision("card_000001", "delete")]),
    JSON.stringify({ ...R.payload(j).response_template, "__proto__": {}, decisions: [] })
  ];
  for (const bad of values) { assert.throws(() => R.apply(j, [good, bad], criteria, at)); assert.deepEqual(j, before); }
  assert.throws(() => R.apply(j, [good], "Другой товар", at), /Описание товара/);
  assert.throws(() => R.apply(j, [answer(j, [decision("card_000002", "excluded", "Mini excavator")]), answer(j, [decision("card_000002")])], criteria, at), /противоречивые/);
  const fenced = "\u0060\u0060\u0060json\n" + good + "\n\u0060\u0060\u0060"; assert.equal(R.apply(j, [fenced], criteria, at).stats.applied_unique, 1);
});

test("an unsupported exclusion becomes uncertain, including missing titles and invented evidence", () => {
  const j = request(job([row(1, "Electric log splitter"), row(2, null), row(3, "小型挖掘机")]));
  const result = R.apply(j, [answer(j, [decision("card_000001", "excluded", "battery", "Аккумуляторный"), decision("card_000002", "excluded", "", "Нет названия"), decision("card_000003", "excluded", "挖掘机", "Это экскаватор")])], criteria, at);
  assert.deepEqual(result.products.map(p => p.relevance.status), ["uncertain", "uncertain", "excluded"]); assert.equal(result.stats.downgraded_unique, 2);
  assert.equal(C.queue(result.products).length, 2);
});

test("manual categories apply to every appearance, survive imports and can reset without deleting rows or the file binding", () => {
  let j = request(job([row(1), row(1, "电动劈木机"), row(2, "Mini excavator")]));
  const text = answer(j, [decision("card_000001", "uncertain"), decision("card_000002", "excluded", "Mini excavator")]);
  j.products = R.override(j, "card_000001", "excluded", at);
  const result = R.apply(j, [text, text], criteria, at);
  assert.equal(result.stats.preserved_manual, 1); assert.equal(result.products.filter(C.excluded).length, 3);
  j.products = R.reset({ ...j, products: result.products }); assert.equal(j.products.length, 3); assert.equal(C.queue(j.products).length, 2);
  const again = R.apply(j, [text], criteria, at); assert.equal(again.stats.preserved_manual, 0); assert.equal(again.products.filter(C.excluded).length, 1);
  assert.throws(() => R.override(j, "foreign", "excluded", at));
});

test("supplier reports and detail propagation retain excluded rows separately without grouping them as suppliers", () => {
  let j = request(job([row(1, "Electric log splitter", { supplier_id: "owner" }), row(2, "Mini excavator", { supplier_id: "owner" })]));
  j.products = R.apply(j, [answer(j, [decision("card_000002", "excluded", "Mini excavator")])], criteria, at).products;
  const entry = C.queue(j.products)[0]; C.applyDetail(j.products, entry, { source: "1688", supplier_id: "owner", supplier_url: "https://maker.1688.com/", shop_name: "Maker" }, at);
  const result = C.report(j); assert.equal(result.products.length, 2); assert.equal(result.excluded_products.length, 1); assert.equal(result.included_cards, 1);
  assert.equal(result.suppliers[0].products.length, 1); assert.equal(result.excluded_products[0].supplier.supplier_url, null);
  assert.equal(result.excluded_products[0].supplier_check, undefined); assert.equal(result.unknown_cards, 0);
});

test("exporting files alone keeps every card eligible and makes no detail-page visits", async t => {
  const h = await createHarness(browser, t); await prepared(h, [row(1001), row(1002, "Mini excavator")]); const original = structuredClone(h.data.tasks);
  const payload = await exported(h); assert.equal(h.tabs.size, 1); assert.equal(h.data.supplier_search.queue.length, 2);
  assert.equal((await h.command("RELEVANCE_EXPORT", { format: "instructions", criteria })).ok, true);
  assert.match(decodeURIComponent(h.downloads.at(-1).url), /response_template/); assert.equal((await exported(h)).request_id, payload.request_id); assert.deepEqual(h.data.tasks, original);
});

test("imports reject a different job and atomically reject a mixed valid/invalid file set", async t => {
  const h = await createHarness(browser, t); await prepared(h, [row(1001), row(1002, "Mini excavator")]); const payload = await exported(h), text = response(payload, [decision(payload.cards[1].id, "excluded", "Mini excavator")]);
  const original = structuredClone(h.data.supplier_search);
  assert.equal((await h.command("RELEVANCE_IMPORT", { criteria, files: [text, "{"] })).ok, false); assert.deepEqual(h.data.supplier_search, original);
  await prepared(h, [row(1001), row(1002, "Mini excavator")]); await exported(h);
  assert.equal((await h.command("RELEVANCE_IMPORT", { criteria, files: [text] })).ok, false); assert.equal(h.data.supplier_search.queue.length, 2);
  assert.equal((await h.command("RELEVANCE_IMPORT", { criteria, files: [text] }, { id: "testextension", url: "https://s.1688.com/", tab: { id: 1 } })).ok, false);
});

test("the worker visits only relevant, uncertain and unreviewed unique offers while retaining every excluded appearance", async t => {
  const h = await createHarness(browser, t), products = [row(1001), row(1002, "Mini excavator"), row(1002, "Mini excavator"), row(1003), row(1004)];
  await prepared(h, products); const original = structuredClone(h.data.tasks), payload = await exported(h), ids = new Map(payload.cards.map(card => [card.titles[0], card.id]));
  const files = [response(payload, [decision(payload.cards[0].id), decision(ids.get("Mini excavator"), "excluded", "Mini excavator"), decision(payload.cards[2].id, "uncertain")])];
  assert.equal((await h.command("RELEVANCE_IMPORT", { criteria, files })).ok, true);
  const visits = []; h.flags.routeHtml = url => { if (url.hostname === "detail.1688.com") { visits.push(url.pathname); return h.detailHtml; } };
  assert.equal((await h.command("SUPPLIERS_START")).ok, true); await h.waitFor(d => d.supplier_search?.status === "finished"); await h.waitFor(() => h.stage2Idle());
  const result = (await h.command("SUPPLIERS_STATE")).result.result;
  assert.deepEqual(visits, ["/offer/1001.html", "/offer/1003.html", "/offer/1004.html"]); assert.equal(result.total_cards, 5); assert.equal(result.excluded_products.length, 2); assert.equal(result.included_cards, 3);
  assert.equal(result.suppliers.flatMap(s => s.products).length, 3); assert.deepEqual(h.data.tasks, original);
  h.resume(); await h.waitFor(() => h.stage2Idle()); assert.equal((await h.command("SUPPLIERS_STATE")).result.result.excluded_products.length, 2);
});

test("filter edits are refused in flight and a paused captcha remains actionable after excluding its card", async t => {
  const h = await createHarness(browser, t); h.flags.detailChallenge = true; await prepared(h, [row(1001, "Mini excavator"), row(1002)]); const payload = await exported(h);
  await h.command("SUPPLIERS_START"); await h.waitFor(d => d.supplier_search?.status === "paused"); await h.waitFor(() => h.stage2Idle()); await h.attentionIdle();
  const text = response(payload, [decision(payload.cards[0].id, "excluded", "Mini excavator")]);
  assert.equal((await h.command("RELEVANCE_IMPORT", { criteria, files: [text] })).ok, true); await h.attentionIdle();
  assert.equal(h.data.supplier_search.status, "paused"); assert.equal(h.data.supplier_search.pause_reason, "challenge"); assert.equal(h.badge.text, "!");
  h.flags.detailChallenge = false; await h.tabs.get(h.data.supplier_search.tab_id).setContent(h.detailHtml);
  await h.command("SUPPLIERS_START"); assert.equal((await h.command("RELEVANCE_RESET")).ok, false);
  await h.waitFor(d => d.supplier_search?.status === "finished"); await h.waitFor(() => h.stage2Idle()); await h.attentionIdle();
  assert.equal(h.data.supplier_search.checked_count, 1); assert.equal(h.data.supplier_search.products[0].supplier_check, undefined); assert.equal(h.badge.text, "");
});

test("reincluding a card after completion creates only its remaining work and does not reopen completed offers", async t => {
  const h = await createHarness(browser, t); await prepared(h, [row(1001), row(1002, "Mini excavator")]); const payload = await exported(h);
  await h.command("RELEVANCE_IMPORT", { criteria, files: [response(payload, [decision(payload.cards[1].id, "excluded", "Mini excavator")])] });
  const visits = []; h.flags.routeHtml = url => { if (url.hostname === "detail.1688.com") { visits.push(url.pathname); return h.detailHtml; } };
  await h.command("SUPPLIERS_START"); await h.waitFor(d => d.supplier_search?.status === "finished"); await h.waitFor(() => h.stage2Idle());
  assert.equal((await h.command("RELEVANCE_OVERRIDE", { card_id: payload.cards[1].id, status: "relevant" })).ok, true);
  assert.equal(h.data.supplier_search.cursor, 1); assert.equal(h.data.supplier_search.queue.length, 2);
  await h.command("SUPPLIERS_START"); await h.waitFor(d => d.supplier_search?.status === "finished"); await h.waitFor(() => h.stage2Idle()); assert.deepEqual(visits, ["/offer/1001.html", "/offer/1002.html"]);
  await h.command("CLEAR"); h.resume(); await h.attentionIdle(); assert.equal(h.data.supplier_search, undefined);
});

async function ui(h) {
  const page = await h.context.newPage({ viewport: { width: 1450, height: 1100 } });
  await page.exposeFunction("__command", ({ type, options }) => h.command(type, options, { id: "testextension", url: "chrome-extension://testextension/suppliers.html" }));
  await page.addInitScript(() => { globalThis.chrome = { runtime: { sendMessage: message => __command(message) }, storage: { onChanged: { addListener: listener => { window.__changed = listener; } } }, permissions: { request: async () => true } }; });
  h.observers.push((changes, area) => { if (!page.isClosed()) void page.evaluate(({ changes, area }) => window.__changed?.(changes, area), { changes, area }).catch(() => {}); });
  await page.route("https://collector.test/**", route => { const file = new URL(route.request().url()).pathname.slice(1); return route.fulfill({ body: fs.readFileSync(path.join(__dirname, "../extension", file)), contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8" }); });
  await page.goto("https://collector.test/suppliers.html"); return page;
}

test("file UI downloads instructions/JSON, imports partial answers, shows excluded rows and preserves manual decisions", async t => {
  const h = await createHarness(browser, t); await prepared(h, [row(1001), row(1001), row(1002, "Mini excavator <img src=x onerror=alert(1)>")]);
  const original = structuredClone(h.data.tasks), page = await ui(h);
  await page.locator("#relevance-criteria").fill(criteria); await page.locator("#claude-instructions").click(); await h.waitFor(() => h.downloads.length === 1);
  await page.locator("#claude-json").click(); await h.waitFor(() => h.downloads.length === 2); const payload = downloaded(h);
  const text = response(payload, [decision(payload.cards[1].id, "excluded", "Mini excavator", "Другой товар")]);
  const load = async data => { await page.waitForFunction(() => !document.getElementById("import-relevance").disabled && !document.getElementById("relevance-file").value); await page.locator("#relevance-file").setInputFiles({ name: "claude.json", mimeType: "application/json", buffer: Buffer.from(data) }); };
  await load(text); await h.waitFor(d => d.supplier_search.products[2].relevance.status === "excluded");
  await page.waitForFunction(() => document.getElementById("relevance-progress").value === 1);
  await page.locator("#category-filter").selectOption("excluded"); assert.match(await page.locator("#suppliers").textContent(), /Mini excavator <img/); assert.equal(await page.locator("#suppliers img").count(), 0);
  await page.locator("#suppliers > .excluded-category button").click(); assert.equal(await page.locator(".relevance-choice").count(), 0); await page.locator("#suppliers > .excluded-category button").click();
  await page.locator(".relevance-choice").selectOption("relevant"); await h.waitFor(d => d.supplier_search.products[2].relevance.status === "relevant");
  await load(text); await page.waitForFunction(() => document.getElementById("status").textContent.includes("Ручных решений сохранено: 1")); assert.equal(h.data.supplier_search.products[2].relevance.status, "relevant");
  await page.locator("#reset-relevance").click(); await h.waitFor(d => d.supplier_search.products.every(p => p.relevance.status === "unreviewed")); assert.equal(h.data.supplier_search.queue.length, 2);
  await load(text); await h.waitFor(d => d.supplier_search.products[2].relevance.status === "excluded");
  await page.locator("#relevance-criteria").fill("Ищем другой товар"); assert.equal(await page.locator("#start").isDisabled(), true); assert.equal(await page.locator("#import-relevance").isDisabled(), true);
  await page.locator("#relevance-criteria").fill(criteria); await load("{bad"); await page.locator("#error").waitFor({ state: "visible" }); assert.match(await page.locator("#error").textContent(), /целым JSON/);
  await page.locator("#category-filter").selectOption(""); await page.locator("#expand-all").click(); fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true }); await page.screenshot({ path: path.join(__dirname, "../test-results/relevance.png"), fullPage: true });
  await page.reload(); await page.waitForFunction(() => document.getElementById("relevance-progress").value === 1); assert.equal(await page.locator("#relevance-criteria").inputValue(), criteria); assert.deepEqual(h.data.tasks, original);
});

test("JSON, CSV and Excel retain all selected rows, categories/reasons, excluded sheets and literal model text", async t => {
  const h = await createHarness(browser, t); await prepared(h, [row(1001), row(1002, "Mini excavator"), row(1002, "Mini excavator")]); const payload = await exported(h);
  const text = response(payload, [decision(payload.cards[1].id, "excluded", "Mini excavator", '=HYPERLINK("https://evil.test","wrong product")')]);
  await h.command("RELEVANCE_IMPORT", { criteria, files: [text] }); await h.command("SUPPLIERS_SKIP"); await h.command("SUPPLIERS_EXPORT", { format: "json" });
  const report = downloaded(h); assert.equal(report.products.length, 3); assert.equal(report.excluded_products.length, 2); assert.equal(report.suppliers.flatMap(s => s.products).length, 1);
  await h.command("SUPPLIERS_EXPORT", { format: "csv" }); const csv = decodeURIComponent(h.downloads.at(-1).url); assert.match(csv, /Категория/); assert.match(csv, /Не подходит/); assert.match(csv, /'=HYPERLINK/);
  const snapshot = (await h.command("EXCEL_DATA", { stage: 2 })).result, Excel = require("../extension/excel.js");
  const file = path.join(__dirname, "../test-results/relevance.xlsx"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Excel.workbook(snapshot));
  const check = spawnSync("python3", ["-c", [
    "import sys,zipfile,xml.etree.ElementTree as E", "z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None", "n={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}",
    "book=E.fromstring(z.read('xl/workbook.xml')); assert [s.attrib['name'] for s in book.find('x:sheets',n)][-1]=='Исключённые карточки'",
    "def rows(i):", " return [[c.find('x:is/x:t',n).text if c.find('x:is/x:t',n) is not None else c.findtext('x:v','',n) for c in r.findall('x:c',n)] for r in E.fromstring(z.read('xl/worksheets/sheet%d.xml'%i)).findall('x:sheetData/x:row',n)]",
    "p,s,t,tp,summary,excluded=[rows(i) for i in range(1,7)]", "assert len(p)==4 and len(excluded)==3 and len(tp)==4 and len(s)==2",
    "ci=p[0].index('Категория релевантности'); ri=p[0].index('Причина отбора'); assert [r[ci] for r in p[1:]]==['Не оценивалась','Не подходит','Не подходит']",
    "assert excluded[1][ri].startswith('=HYPERLINK')", "assert dict(summary[1:])['Не подходит: уникальных']=='1'",
    "assert not any(E.fromstring(z.read(f)).findall('.//x:f',n) for f in z.namelist() if f.startswith('xl/worksheets/sheet') and f.endswith('.xml'))"
  ].join("\n"), file], { encoding: "utf8" }); assert.equal(check.status, 0, check.stderr);
});
