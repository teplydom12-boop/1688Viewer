"use strict";
// UI and image decoding run in real Chromium; extension APIs use a test bridge.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium } = require("playwright-core");
const Excel = require("../extension/excel.js");
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
after(async () => { await browser?.close(); });
const root = path.resolve(__dirname, "../extension");
const png = fs.readFileSync(path.join(__dirname, "fixtures/thumbnail.png"));
const product = (id, image) => ({ product_id: id, source: "1688", title: '=HYPERLINK("https://example.test","товар")', image_url: image, source_page_url: "https://s.1688.com/search" });
function snapshot(products) { return { products, suppliers: [], tasks: [{ id: "first", query: "杯子", products }, { id: "second", products: [products[0]] }], total_products: products.length, total_tasks: 2, exported_at: "2026-10-15T12:00:00Z" }; }
async function openExport(t, options = {}) {
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await context.newPage(), downloads = [], permissions = [], requests = [], preferences = [];
  page.setDefaultTimeout(10000);
  let output = options.output || snapshot([product("1001", "https://images.test/ok.png"), product("1002", "https://images.test/missing.png"), product("1003", "https://images.test/ok.png"), product("1004", null)]);
  await page.exposeFunction("__snapshot", message => { if (message.type === "SET_VIEW") { preferences.push(message.options); return { ok: true, result: {} }; } return { ok: true, result: output }; });
  await page.exposeFunction("__permission", origins => { permissions.push(origins); return options.permission !== false; });
  await page.exposeFunction("__download", value => downloads.push({ ...value, bytes: Buffer.from(value.bytes) }));
  await page.addInitScript(() => {
    const blobs = new Map(), create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); blobs.set(url, blob); return url; };
    window.chrome = {
      runtime: { sendMessage: message => __snapshot(message) },
      permissions: { contains: async () => false, request: ({ origins }) => __permission(origins) },
      downloads: { download: async info => { const bytes = Array.from(new Uint8Array(await blobs.get(info.url).arrayBuffer())); await __download({ ...info, bytes }); return 1; } }
    };
  });
  const csp = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"))).content_security_policy.extension_pages;
  await context.route("https://collector.test/**", route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    return route.fulfill({ body: fs.readFileSync(path.join(root, file)), headers: { "Content-Security-Policy": csp }, contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8" });
  });
  await context.route("https://images.test/**", async route => {
    requests.push(route.request());
    if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
    try { await route.fulfill({ status: route.request().url().includes("missing") ? 404 : 200, body: options.image || png, contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" } }); } catch { /* cancellation may close the request */ }
  });
  await page.goto("https://collector.test/export.html"); await page.waitForFunction(() => !document.getElementById("download").disabled);
  return { page, downloads, permissions, requests, preferences, replaceOutput(value) { output = value; } };
}
function inspectWorkbook(bytes, code) {
  const result = spawnSync("python3", ["-c", `import io,sys,zipfile,xml.etree.ElementTree as ET,posixpath\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nassert z.testzip() is None\nns={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','d':'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'}\n${code}`], { input: bytes, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("Excel export embeds deduplicated thumbnails with grouped cell anchors, safe text and no external links", async t => {
  const { page, downloads, permissions, requests } = await openExport(t);
  await page.locator("#download").click(); await page.waitForFunction(() => document.getElementById("status").textContent.includes("Файл передан"));
  assert.equal(downloads.length, 1); assert.equal(permissions.length, 1); assert.deepEqual(permissions[0], ["https://images.test/*"]);
  assert.equal(requests.length, 2, "shared images are downloaded once across cumulative and per-task sheets");
  for (const request of requests) assert.equal(request.headers().referer, undefined);
  assert.match(await page.locator("#status").textContent(), /картинок: 1\. Недоступно: 1/);
  const bytes = downloads[0].bytes;
  inspectWorkbook(bytes, `media=[n for n in z.namelist() if n.startswith('xl/media/')]\nassert len(media)==1 and z.read(media[0]).startswith(b'\\xff\\xd8')\nfor i,col,count in [(1,1,2),(4,3,3)]:\n s=ET.fromstring(z.read(f'xl/worksheets/sheet{i}.xml'))\n c=s.find('x:cols',ns)[col]\n assert c.attrib['outlineLevel']=='1' and c.attrib['width']=='9'\n assert s.find('x:sheetViews/x:sheetView',ns).attrib['showOutlineSymbols']=='1'\n assert s.find('x:sheetData/x:row',ns).attrib['ht']=='36'\n assert s.find('x:autoFilter',ns) is not None\n d=ET.fromstring(z.read(f'xl/drawings/drawing{i}.xml'))\n anchors=d.findall('d:twoCellAnchor',ns)\n assert len(anchors)==count\n for a in anchors:\n  assert 'editAs' not in a.attrib or a.attrib['editAs']=='twoCell'\n  start,end=a.find('d:from',ns),a.find('d:to',ns)\n  assert start.find('d:col',ns).text==end.find('d:col',ns).text==str(col)\n  assert start.find('d:row',ns).text==end.find('d:row',ns).text\n  assert int(start.find('d:colOff',ns).text)<int(end.find('d:colOff',ns).text)\nfor n in z.namelist():\n if n.endswith('.rels'): assert b'TargetMode="External"' not in z.read(n)\n if n.startswith('xl/worksheets/sheet') and n.endswith('.xml'): assert not ET.fromstring(z.read(n)).findall('.//x:f',ns)\ns=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))\ncells={c.attrib['r']:c for c in s.findall('.//x:c',ns)}\nassert cells['A2'].find('x:is/x:t',ns).text=='1688.com'\nassert cells['D2'].attrib['t']=='inlineStr' and cells['D2'].find('x:is/x:t',ns).text.startswith('=HYPERLINK(')\nassert cells['B3'].find('x:is/x:t',ns).text=='Нет миниатюры'\nassert cells['B5'].find('x:is/x:t',ns).text is None`);
  fs.mkdirSync(path.resolve(__dirname, "../test-results"), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, "../test-results/excel-with-images.xlsx"), bytes);
  await page.screenshot({ path: path.resolve(__dirname, "../test-results/excel-export.png"), fullPage: true });
});

test("permission denial explains how to export without photos; unchecked export makes no image requests", async t => {
  const { page, downloads, permissions, requests } = await openExport(t, { permission: false });
  await page.locator("#download").click(); await page.waitForFunction(() => !document.getElementById("error").hidden);
  assert.match(await page.locator("#error").textContent(), /снять галочку/); assert.equal(downloads.length, 0); assert.equal(requests.length, 0);
  await page.locator("#include-images").uncheck(); await page.locator("#download").click();
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Файл передан"));
  assert.equal(downloads.length, 1); assert.equal(permissions.length, 1); assert.equal(requests.length, 0);
  inspectWorkbook(downloads[0].bytes, `assert not any(n.startswith('xl/media/') for n in z.namelist())\ns=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))\nassert not any(c.attrib.get('outlineLevel') for c in s.find('x:cols',ns))`);
});

test("cancelling image preparation stops the download and permits a fresh export", async t => {
  const { page, downloads } = await openExport(t, { delay: 250 });
  await page.locator("#download").click(); await page.locator("#cancel").click();
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("отменена"));
  assert.equal(downloads.length, 0); assert.equal(await page.locator("#download").isEnabled(), true);
  await page.locator("#include-images").uncheck(); await page.locator("#download").click();
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Файл передан")); assert.equal(downloads.length, 1);
});

test("image URLs are limited to HTTP(S) without credentials; exports with no pictures still work", async t => {
  const output = snapshot([product("1", "javascript:alert(1)"), product("2", "file:///etc/passwd"), product("3", "https://user:pass@images.test/a.png"), product("4", null)]);
  const { page, downloads, permissions, requests } = await openExport(t, { output });
  assert.match(await page.locator("#summary").textContent(), /0 разных изображений/);
  await page.locator("#download").click(); await page.waitForFunction(() => document.getElementById("status").textContent.includes("Файл передан"));
  assert.equal(downloads.length, 1); assert.equal(permissions.length, 0); assert.equal(requests.length, 0);
  assert.ok(Excel.workbook(output).length > 0);
});

// Parse the embedded JPEG with Python's standard library; test dependencies stay
// unchanged. A declared large size alone would not prove that the JPEG is large.
function expectJpegEdge(bytes, edge) {
  inspectWorkbook(bytes, `data=z.read(next(n for n in z.namelist() if n.startswith('xl/media/')))
assert data[:2]==b'\\xff\\xd8'
assert ET.fromstring(z.read('xl/workbook.xml')).find('x:workbookPr',ns).attrib['autoCompressPictures']=='0'
i=2; dimensions=None; quantization=None
while i<len(data):
 assert data[i]==255
 while data[i]==255:i+=1
 marker=data[i];i+=1
 if marker in (0xD9,0xDA):break
 length=int.from_bytes(data[i:i+2],'big');segment=data[i+2:i+length]
 if marker in (0xC0,0xC1,0xC2):dimensions=(int.from_bytes(segment[3:5],'big'),int.from_bytes(segment[1:3],'big'))
 if marker==0xDB and quantization is None:quantization=segment[1]
 i+=length
assert dimensions==(${edge},${edge}),dimensions
assert quantization is not None and quantization<=4,quantization`);
}

for (const [quality, edge] of [["standard", 384], ["high", 768], ["maximum", 1280]]) test(`Excel ${quality} embeds ${edge}px detail in compact cells`, async t => {
  const output = snapshot([product("1", "https://images.test/large.png")]); output.export_image_quality = quality;
  const { page, downloads } = await openExport(t, { output, image: fs.readFileSync(path.join(__dirname, "fixtures/detailed-product.png")) });
  assert.equal(await page.locator("#image-quality").inputValue(), quality);
  await page.locator("#download").click(); await page.waitForFunction(() => document.getElementById("status").textContent.includes("Файл передан"));
  expectJpegEdge(downloads[0].bytes, edge);
  inspectWorkbook(downloads[0].bytes, `s=ET.fromstring(z.read('xl/worksheets/sheet1.xml'));assert s.find('x:sheetData/x:row',ns).attrib['ht']=='36'
d=ET.fromstring(z.read('xl/drawings/drawing1.xml'));a=d.find('d:twoCellAnchor',ns);assert a.find('d:to/d:colOff',ns).text=='419100'`);
  if (quality === "high") { fs.mkdirSync(path.resolve(__dirname, "../test-results"), { recursive: true }); fs.writeFileSync(path.resolve(__dirname, "../test-results/excel-high-quality.xlsx"), downloads[0].bytes); }
});

test("quality selection is saved and disabling pictures disables its control; small originals are not upscaled", async t => {
  const { page, downloads, preferences } = await openExport(t);
  assert.equal(await page.locator("#image-quality").inputValue(), "high");
  await page.locator("#image-quality").selectOption("maximum");
  await page.waitForFunction(() => document.getElementById("image-quality").value === "maximum");
  await page.locator("#include-images").uncheck(); assert.equal(await page.locator("#image-quality").isDisabled(), true);
  await page.locator("#include-images").check(); assert.equal(await page.locator("#image-quality").isEnabled(), true);
  await page.locator("#download").click(); await page.waitForFunction(() => document.getElementById("status").textContent.includes("Файл передан"));
  assert.deepEqual(preferences, [{ excel_image_quality: "maximum" }]); expectJpegEdge(downloads[0].bytes, 100);
  assert.match(await page.locator("#status").textContent(), /меньше 256 px: 1/);
});

for (const fallback of [false, true]) test(`Alibaba CDN original replaces a tiny thumbnail with safe fallback: ${fallback}`, async t => {
  const saved = "https://cbu01.alicdn.com/img/ibank/item.jpg_80x80q90.jpg_.webp", requested = [];
  const { page, downloads, permissions } = await openExport(t, { output: snapshot([product("1", saved)]) });
  await page.context().route("https://cbu01.alicdn.com/**", route => {
    requested.push(route.request().url()); const original = route.request().url().endsWith("/item.jpg");
    return route.fulfill({ status: original && fallback ? 404 : 200, contentType: "image/png", body: original ? fs.readFileSync(path.join(__dirname, "fixtures/detailed-product.png")) : png, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.locator("#download").click(); await page.waitForFunction(() => document.getElementById("status").textContent.includes("Файл передан"));
  assert.deepEqual(requested, fallback ? ["https://cbu01.alicdn.com/img/ibank/item.jpg", saved] : ["https://cbu01.alicdn.com/img/ibank/item.jpg"]);
  assert.deepEqual(permissions[0], ["https://cbu01.alicdn.com/*"]); expectJpegEdge(downloads[0].bytes, fallback ? 100 : 768);
  inspectWorkbook(downloads[0].bytes, `assert b'80x80q90' in z.read('xl/worksheets/sheet1.xml')`);
});

test("original URL recovery preserves signed URLs and unrelated hosts and rejects non-web URLs", async t => {
  const { page } = await openExport(t);
  const values = ["https://img.example/item.jpg_80x80.jpg", "https://cbu01.alicdn.com.evil.test/item.jpg_80x80.jpg", "https://cbu01.alicdn.com/item.jpg_80x80.jpg?signature=keep", "https://cbu01.alicdn.com/item.jpg_300x300xzq90.jpg_.webp", "file:///etc/passwd", "https://user:pass@cbu01.alicdn.com/a.jpg"];
  const result = await page.evaluate(values => values.map(value => SupplierImages.candidates(value)), values);
  assert.deepEqual(result.slice(0, 3), values.slice(0, 3).map(value => [value]));
  assert.deepEqual(result[3], ["https://cbu01.alicdn.com/item.jpg", values[3]]); assert.deepEqual(result.slice(4), [[], []]);
});
