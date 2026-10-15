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
      const filename = encoder.encode(name), bytes = text instanceof Uint8Array ? text : encoder.encode(text), crc = crc32(bytes);
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
  function sheet(rows, photoColumn = null, drawing = false) {
    if (rows.length > 1048576) throw new Error("В одном листе Excel может быть не больше 1 048 576 строк. Сохраните полный JSON.");
    const last = `${column(rows[0].length - 1)}${rows.length}`, photos = photoColumn != null;
    const cols = rows[0].map((_, c) => `<col min="${c + 1}" max="${c + 1}" width="${c === photoColumn ? 9 : 25}" customWidth="1"${c === photoColumn ? ' outlineLevel="1"' : ""}/>`).join("");
    return declaration + `<worksheet xmlns="${namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${photos ? '<sheetPr><outlinePr summaryRight="1"/></sheetPr>' : ""}<dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0" showOutlineSymbols="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"${photos ? ' outlineLevelCol="1"' : ""}/><cols>${cols}</cols><sheetData>` + rows.map((row, r) => `<row r="${r + 1}"${photos ? ' ht="36" customHeight="1"' : ""}>` + row.map((value, c) => {
      const ref = `${column(c)}${r + 1}`, style = r === 0 ? ' s="1"' : photos ? ' s="2"' : "";
      if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
      const text = Array.isArray(value) ? value.join("; ") : value;
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(String(text ?? "").slice(0, 32767))}</t></is></c>`;
    }).join("") + "</row>").join("") + `</sheetData><autoFilter ref="A1:${last}"/>${drawing ? '<drawing r:id="rId1"/>' : ""}</worksheet>`;
  }
  const relationships = "http://schemas.openxmlformats.org/package/2006/relationships";
  function drawingXml(pictures, photoColumn) {
    return declaration + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' + pictures.map(({ row, media }, i) => {
      const marker = offset => `<xdr:col>${photoColumn}</xdr:col><xdr:colOff>${offset}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${offset}</xdr:rowOff>`;
      // Both anchors stay inside the same cell. Excel moves and sizes the picture
      // with that cell, including when its grouped column is collapsed.
      return `<xdr:twoCellAnchor><xdr:from>${marker(38100)}</xdr:from><xdr:to>${marker(419100)}</xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="Фото ${i + 1}" descr="Миниатюра товара"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId${media}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="${(photoColumn * 175 + 4) * 9525}" y="${(row * 48 + 4) * 9525}"/><a:ext cx="381000" cy="381000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`;
    }).join("") + '</xdr:wsDr>';
  }
  function sourceSite(item) {
    const known = { "1688": "1688.com", "alibaba": "alibaba.com", "made-in-china": "made-in-china.com" };
    if (known[item.source]) return known[item.source];
    try { const url = new URL(item.source_page_url || item.source_url || item.product_url || item.supplier_url); return url.hostname; } catch { return String(item.source || "").replace(/^web:/, ""); }
  }
  function sourceOrigin(item) {
    try { return new URL(item.source_page_url || item.source_url || item.product_url).origin; } catch { return sourceSite(item) ? `https://${sourceSite(item)}/` : ""; }
  }
  function workbook(output, options = {}) {
    const columns = [
      ["source_site", "Сайт-источник"], ["product_id", "ID товара"], ["title", "Название"], ["product_url", "Ссылка на товар"],
      ["supplier_id", "ID поставщика"], ["shop_name", "Магазин"], ["supplier_url", "Ссылка на поставщика"],
      ["price", "Цена"], ["minimum_order", "Минимальный заказ"], ["image_url", "Изображение"],
      ["query", "Запрос"], ["search_type", "Тип поиска"], ["collected_at", "Первый сбор (UTC)"], ["last_seen_at", "Последний сбор (UTC)"],
      ["source_page_url", "Страница выдачи"], ["task_ids", "ID заданий"], ["source_origin", "Адрес сайта-источника"],
      ["observation_id", "ID записи"], ["task_id", "ID задания"], ["page_index", "Страница задания"], ["card_index", "Позиция карточки"], ["capture_status", "Статус записи"]
    ];
    const value = (item, key) => key === "source_site" ? sourceSite(item) : key === "source_origin" ? sourceOrigin(item) : item[key];
    const tasks = output.tasks || [], thumbnails = options.thumbnails instanceof Map ? options.thumbnails : new Map();
    const photos = options.includeImages === true;
    const media = new Map();
    const photo = product => {
      const bytes = thumbnails.get(product.image_url);
      if (!bytes?.length) return product.image_url ? "Нет миниатюры" : "";
      if (!media.has(product.image_url)) media.set(product.image_url, { id: media.size + 1, bytes });
      return "";
    };
    const productRow = product => {
      const cells = columns.map(([key]) => value(product, key));
      if (photos) cells.splice(1, 0, photo(product));
      return cells;
    };
    const titles = columns.map(([, title]) => title);
    if (photos) titles.splice(1, 0, "Фото: + / − сверху");
    const taskProducts = tasks.flatMap(task => task.products.map(product => [task.id, task.query, ...productRow(product)]));
    const sheets = [
      ["Товары", [titles, ...output.products.map(productRow)], photos ? 1 : null, output.products],
      ["Поставщики", [["Сайт-источник", "ID поставщика", "Магазин", "Ссылка", "Найдено товаров"], ...output.suppliers.map(group => [sourceSite(group), group.supplier_id, group.shop_name, group.supplier_url, group.products.length])]],
      ["Задания", [["ID задания", "Запрос / метка", "Сайт-источник", "Адрес выдачи", "Статус", "Начало (UTC)", "Обновлено (UTC)", "Завершено (UTC)", "Собрано страниц", "Лимит страниц", "Товаров в задании", "Этап / сообщение"], ...tasks.map(task => [task.id, task.query, sourceSite(task), task.source_url, task.status, task.started_at, task.updated_at, task.finished_at, task.completed_pages, task.max_pages, task.products.length, task.message])]],
      ["Товары заданий", [["ID задания", "Запрос задания", ...titles], ...taskProducts], photos ? 3 : null, tasks.flatMap(task => task.products)]
    ];
    const pictures = sheets.map(([, , photoColumn, products]) => photoColumn == null ? [] : products.flatMap((product, i) => {
      const item = media.get(product.image_url); return item ? [{ row: i + 1, media: item.id }] : [];
    }));
    const drawings = pictures.flatMap((items, i) => items.length ? [
      [`xl/drawings/drawing${i + 1}.xml`, drawingXml(items, sheets[i][2])],
      [`xl/drawings/_rels/drawing${i + 1}.xml.rels`, declaration + `<Relationships xmlns="${relationships}">` + [...new Set(items.map(item => item.media))].map(id => `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${id}.jpeg"/>`).join("") + '</Relationships>'],
      [`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, declaration + `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${i + 1}.xml"/></Relationships>`]
    ] : []);
    const files = [
      ["[Content_Types].xml", declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") + pictures.map((items, i) => items.length ? `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : "").join("") + "</Types>"],
      ["_rels/.rels", declaration + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml", declaration + `<workbook xmlns="${namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` + sheets.map(([name], i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + "</sheets></workbook>"],
      ["xl/_rels/workbook.xml.rels", declaration + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ["xl/styles.xml", declaration + `<styleSheet xmlns="${namespace}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
      ...sheets.map(([, rows, photoColumn], i) => [`xl/worksheets/sheet${i + 1}.xml`, sheet(rows, photoColumn, pictures[i].length > 0)]),
      ...drawings, ...[...media.values()].map(item => [`xl/media/image${item.id}.jpeg`, item.bytes])
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
