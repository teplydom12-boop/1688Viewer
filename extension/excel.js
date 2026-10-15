"use strict";
// A local OOXML workbook writer. ZIP entries are stored without compression;
// all collected text is an inline string, never an executable Excel formula.
(() => {
  const encoder = new TextEncoder();
  const xml = value => String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
  function join(chunks) {
    const output = new Uint8Array(chunks.reduce((size, bytes) => size + bytes.length, 0));
    let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; } return output;
  }
  function zip(files) {
    const entries = [], directory = []; let offset = 0;
    for (const [name, text] of files) {
      const filename = encoder.encode(name), bytes = encoder.encode(text), crc = crc32(bytes);
      const header = new Uint8Array(30), view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true); view.setUint16(12, 0x21, true);
      view.setUint32(14, crc, true); view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true); view.setUint16(26, filename.length, true);
      const central = new Uint8Array(46), index = new DataView(central.buffer);
      index.setUint32(0, 0x02014b50, true); index.setUint16(4, 20, true); index.setUint16(6, 20, true); index.setUint16(8, 0x800, true); index.setUint16(14, 0x21, true);
      index.setUint32(16, crc, true); index.setUint32(20, bytes.length, true); index.setUint32(24, bytes.length, true); index.setUint16(28, filename.length, true); index.setUint32(42, offset, true);
      entries.push(header, filename, bytes); directory.push(central, filename); offset += header.length + filename.length + bytes.length;
    }
    const central = join(directory), end = new Uint8Array(22), view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true); view.setUint32(12, central.length, true); view.setUint32(16, offset, true);
    return join([...entries, central, end]);
  }
  function column(index) { let name = ""; for (index++; index > 0; index = Math.floor((index - 1) / 26)) name = String.fromCharCode(65 + (index - 1) % 26) + name; return name; }
  function sheet(rows) {
    if (rows.length > 1048576) throw new Error("В одном листе Excel может быть не больше 1 048 576 строк. Сохраните полный JSON.");
    const last = `${column(rows[0].length - 1)}${rows.length}`;
    return declaration + `<worksheet xmlns="${namespace}"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${rows[0].length}" width="25" customWidth="1"/></cols><sheetData>` + rows.map((row, r) => `<row r="${r + 1}">` + row.map((value, c) => {
      const ref = `${column(c)}${r + 1}`, style = r === 0 ? ' s="1"' : "";
      if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
      const text = Array.isArray(value) ? value.join("; ") : value;
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(String(text ?? "").slice(0, 32767))}</t></is></c>`;
    }).join("") + "</row>").join("") + `</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
  }
  function sourceSite(item) {
    const known = { "1688": "1688.com", "alibaba": "alibaba.com", "made-in-china": "made-in-china.com" };
    if (known[item.source]) return known[item.source];
    try { const url = new URL(item.source_page_url || item.source_url || item.product_url || item.supplier_url); return url.hostname; } catch { return String(item.source || "").replace(/^web:/, ""); }
  }
  function sourceOrigin(item) {
    try { return new URL(item.source_page_url || item.source_url || item.product_url).origin; } catch { return sourceSite(item) ? `https://${sourceSite(item)}/` : ""; }
  }
  function workbook(output) {
    const columns = [
      ["source_site", "Сайт-источник"], ["product_id", "ID товара"], ["title", "Название"], ["product_url", "Ссылка на товар"],
      ["supplier_id", "ID поставщика"], ["shop_name", "Магазин"], ["supplier_url", "Ссылка на поставщика"],
      ["price", "Цена"], ["minimum_order", "Минимальный заказ"], ["image_url", "Изображение"],
      ["query", "Запрос"], ["search_type", "Тип поиска"], ["collected_at", "Первый сбор (UTC)"], ["last_seen_at", "Последний сбор (UTC)"],
      ["source_page_url", "Страница выдачи"], ["task_ids", "ID заданий"], ["source_origin", "Адрес сайта-источника"]
    ];
    const value = (item, key) => key === "source_site" ? sourceSite(item) : key === "source_origin" ? sourceOrigin(item) : item[key];
    const tasks = output.tasks || [], taskProducts = tasks.flatMap(task => task.products.map(product => [task.id, task.query, ...columns.map(([key]) => value(product, key))]));
    const sheets = [
      ["Товары", [columns.map(([, title]) => title), ...output.products.map(product => columns.map(([key]) => value(product, key)))]],
      ["Поставщики", [["Сайт-источник", "ID поставщика", "Магазин", "Ссылка", "Найдено товаров"], ...output.suppliers.map(group => [sourceSite(group), group.supplier_id, group.shop_name, group.supplier_url, group.products.length])]],
      ["Задания", [["ID задания", "Запрос / метка", "Сайт-источник", "Адрес выдачи", "Статус", "Начало (UTC)", "Обновлено (UTC)", "Завершено (UTC)", "Собрано страниц", "Лимит страниц", "Товаров в задании", "Этап / сообщение"], ...tasks.map(task => [task.id, task.query, sourceSite(task), task.source_url, task.status, task.started_at, task.updated_at, task.finished_at, task.completed_pages, task.max_pages, task.products.length, task.message])]],
      ["Товары заданий", [["ID задания", "Запрос задания", ...columns.map(([, title]) => title)], ...taskProducts]]
    ];
    const files = [
      ["[Content_Types].xml", declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") + "</Types>"],
      ["_rels/.rels", declaration + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml", declaration + `<workbook xmlns="${namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` + sheets.map(([name], i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + "</sheets></workbook>"],
      ["xl/_rels/workbook.xml.rels", declaration + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ["xl/styles.xml", declaration + `<styleSheet xmlns="${namespace}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
      ...sheets.map(([, rows], i) => [`xl/worksheets/sheet${i + 1}.xml`, sheet(rows)])
    ];
    return zip(files);
  }
  function dataUrl(output) {
    const bytes = workbook(output); let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + btoa(binary);
  }
  const api = { workbook, dataUrl };
  globalThis.SupplierExcel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
