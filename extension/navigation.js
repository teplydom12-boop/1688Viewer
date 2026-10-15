(function (root) {
  "use strict";
  const S = root.SupplierCollector;
  const NEXT_PAGE = /(?:next\s*page|go\s+to\s+(?:the\s+)?next|следующ[\p{L}]*\s*страниц|下一[页頁]|下页|suivant|siguiente|nächste\s*seite|pagina\s*successiva)/iu;
  const NEXT = /^(?:next|далее|следующая|впер[её]д|weiter|avanti|suivant|siguiente)[\s›»>→]*$/iu;
  const MORE = /^(?:load\s+more(?:\s+\w+){0,3}|show\s+more\s+(?:products|items|results)|показать\s+(?:ещ[её]|больше)(?:\s+товар[\p{L}]*)?|загрузить\s+ещ[её]|加载更多|更多商品)$/iu;
  const BAD = /(?:checkout|add\s*to\s*cart|buy\s*now|delete|remove|log\s*out|sign\s*out|оформить|купить|корзин|удалить|выйти|立即购买|加入购物车|退出)/iu;
  const PREVIOUS = /(?:previous|prev\b|上一[页頁]|предыдущ|назад|first\s*page|last\s*page)/iu;
  const pagingClass = /pagin|paging|pager|pages?nav/i;
  const pageKeys = /^(?:page|p|pageNo|pageIndex|pageNum|page_number|currentPage|current|start|offset)$/i;
  let sampleCache = null;
  function memo(node, key, read) {
    if (!sampleCache || !node) return read();
    let values = sampleCache.get(node); if (!values) { values = new Map(); sampleCache.set(node, values); }
    if (!values.has(key)) values.set(key, read());
    return values.get(key);
  }
  function withSample(read) {
    if (sampleCache) return read();
    sampleCache = new WeakMap(); try { return read(); } finally { sampleCache = null; }
  }
  function scopes(doc) {
    return memo(doc, "scopes", () => discoverScopes(doc));
  }
  function discoverScopes(doc) {
    const roots = [doc];
    if (doc.shadowRoot) roots.push(doc.shadowRoot);
    for (let index = 0; index < roots.length && index < 50; index++) for (const node of roots[index].querySelectorAll("*")) {
      if (roots.length >= 50) break;
      if (node.shadowRoot && !roots.includes(node.shadowRoot)) roots.push(node.shadowRoot);
      if (node.tagName === "IFRAME") try { if (node.contentDocument && !roots.includes(node.contentDocument)) roots.push(node.contentDocument); } catch { /* cross-origin frames require separate access */ }
    }
    return roots;
  }
  function visible(node, snapshot) {
    if (node.closest('[hidden], [aria-hidden="true"]')) return false;
    if (snapshot) return !node.closest('[style*="display:none"], [style*="display: none"]');
    const view = node.ownerDocument.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || !node.getClientRects().length) return false;
    const host = node.getRootNode().host, frame = view.frameElement;
    return (!host || visible(host, false)) && (!frame || visible(frame, false));
  }
  function disabled(node) {
    if (node.disabled || node.hasAttribute("disabled")) return true;
    for (let current = node, depth = 0; current && depth < 3; current = current.parentElement, depth++) {
      if (current.getAttribute("aria-disabled") === "true" || /(?:^|[\s_-])disabled(?:$|[\s_-])/i.test(current.getAttribute("class") || "")) return true;
    }
    return false;
  }
  function selectorFor(node, multiple = false) {
    const scope = node.getRootNode();
    const frame = node.ownerDocument.defaultView?.frameElement;
    const wrap = selector => scope.host ? `${selectorFor(scope.host)} >>> ${selector}` : frame ? `${selectorFor(frame)} ::: ${selector}` : selector;
    if (multiple) {
      const firstClass = (node.getAttribute("class") || "").split(/\s+/).find(Boolean);
      if (firstClass) return wrap(firstClass.includes("--") ? `${node.localName}[class*="${CSS.escape(firstClass.split("--")[0])}--"]` : `${node.localName}.${CSS.escape(firstClass)}`);
      if (node.parentElement) return `${selectorFor(node.parentElement)} > ${node.localName}`;
      return wrap(node.localName);
    }
    if (node.id && scope.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) return wrap(`#${CSS.escape(node.id)}`);
    for (const attribute of ["data-testid", "data-test", "aria-label", "title"]) {
      const value = node.getAttribute(attribute);
      if (value && scope.querySelectorAll(`[${attribute}="${CSS.escape(value)}"]`).length === 1) return wrap(`[${attribute}="${CSS.escape(value)}"]`);
    }
    const classes = (node.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    for (const value of classes) {
      const base = value.split("--")[0];
      const selector = value.includes("--") ? `${node.localName}[class*="${CSS.escape(base)}--"]` : `${node.localName}.${CSS.escape(value)}`;
      if (multiple || scope.querySelectorAll(selector).length === 1) return wrap(selector);
    }
    const chain = [];
    for (let current = node, depth = 0; current && depth < 5; current = current.parentElement, depth++) {
      const siblings = current.parentElement ? [...current.parentElement.children].filter(item => item.localName === current.localName) : [current];
      chain.unshift(`${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})`);
      if (scope.querySelectorAll(chain.join(" > ")).length === 1) break;
    }
    return wrap(chain.join(" > "));
  }
  function resolve(doc, selector) {
    try {
      const parts = selector.split(/ (>>>|:::) /); let scope = doc;
      for (let index = 0; index < parts.length - 1; index += 2) { const node = scope.querySelector(parts[index]); scope = parts[index + 1] === ":::" ? node?.contentDocument : node?.shadowRoot; if (!scope) return []; }
      return [...scope.querySelectorAll(parts.at(-1))];
    } catch { return []; }
  }
  function accessibleName(node) {
    const labels = (node.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map(id => {
      try { return node.getRootNode().querySelector(`#${CSS.escape(id)}`)?.textContent || ""; } catch { return ""; }
    }).join(" ");
    return S.text(node.getAttribute("aria-label") || labels || node.getAttribute("title") || [...(node.labels || [])].map(label => label.textContent).join(" ") || node.textContent || node.value);
  }
  function rightArrow(node, snapshot) {
    if (!snapshot) for (const pseudo of ["::before", "::after"]) {
      const content = node.ownerDocument.defaultView.getComputedStyle(node, pseudo).content.replace(/^["']|["']$/g, "");
      if (/^[›>→➜➔]$/.test(content)) return true;
    }
    for (const graphic of node.querySelectorAll("svg path,svg polyline,svg polygon")) {
      const raw = graphic.getAttribute("points") || graphic.getAttribute("d") || "";
      if (/[a-kno-z]/i.test(raw)) continue;
      const numbers = raw.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
      if (numbers.length === 6 && numbers[2] > Math.max(numbers[0], numbers[4]) && numbers[1] < numbers[3] && numbers[3] < numbers[5]) return true;
    }
    return false;
  }
  function scrollTargets(doc) {
    const targets = [];
    for (const scope of scopes(doc)) {
      if (scope.scrollingElement && visible(scope.documentElement, false)) targets.push({ node: scope.scrollingElement, type: "document" });
      for (const node of [...scope.querySelectorAll("main,section,div,ul,[role=list]")].slice(0, 1800)) {
        if (node.clientHeight < 140 || node.scrollHeight <= node.clientHeight + 30 || !visible(node, false) || node.closest('header,footer,nav,[class*="carousel"],[class*="gallery"],[class*="captcha"]')) continue;
        if (!/auto|scroll/.test(node.ownerDocument.defaultView.getComputedStyle(node).overflowY)) continue;
        if (node.querySelectorAll('a[href], [data-product-id], [data-renderkey]').length < 2 || node.querySelectorAll('img,[role="img"]').length < 2) continue;
        targets.push({ node, type: "container" });
      }
    }
    return targets.filter(target => target.type === "document" || !targets.some(other => other !== target && other.type === "container" && target.node.contains(other.node))).slice(0, 6);
  }
  function contextFor(node) {
    for (let current = node.parentElement, depth = 0; current && depth < 7; current = current.parentElement, depth++) {
      const classes = current.getAttribute("class") || "";
      const label = `${current.getAttribute("aria-label") || ""} ${current.getAttribute("role") || ""}`;
      if (pagingClass.test(classes) || /pagination|пагинац|страниц/i.test(label)) return current;
      if (current.tagName === "NAV" || current.getAttribute("role") === "navigation") {
        const numbers = [...current.querySelectorAll('a,button,[role="button"],span,li')].filter(item => !item.children.length && /^\d+$/.test((item.textContent || "").trim()));
        if (numbers.length >= 2) return current;
      }
    }
    return null;
  }
  function currentPage(context, base) {
    if (context) for (const node of context.querySelectorAll('[aria-current="page"], [aria-selected="true"], [class*="active"], [class*="current"], [class*="selected"]')) {
      const number = (node.textContent || "").trim(); if (/^\d+$/.test(number)) return Number(number);
    }
    const url = new URL(base);
    for (const [key, value] of url.searchParams) if (pageKeys.test(key) && !/^(start|offset)$/i.test(key) && /^\d+$/.test(value)) return Number(value);
    const route = url.pathname.match(/\/page\/(\d+)/i); if (route) return Number(route[1]);
    if (context) {
      const plain = [...context.querySelectorAll("span,div,li")].filter(node => !node.children.length && !node.closest('a,button,[role="button"]') && /^\d+$/.test((node.textContent || "").trim()));
      if (plain.length === 1) return Number(plain[0].textContent.trim());
    }
    return null;
  }
  function advances(href, base) {
    if (!href) return false;
    const before = new URL(base), after = new URL(href);
    if (after.origin !== before.origin) return false;
    const filters = url => [...url.searchParams].filter(([key]) => !pageKeys.test(key) && !/^(utm_.*|spm|ref|tracking)$/i.test(key)).sort().map(pair => pair.join("=")).join("&");
    if (filters(before) !== filters(after)) return false;
    for (const [key, value] of after.searchParams) if (pageKeys.test(key) && /^\d+$/.test(value)) {
      const initial = before.searchParams.get(key);
      if (initial != null && /^\d+$/.test(initial) && Number(value) === Number(initial) + 1) return true;
    }
    const old = before.pathname.match(/\/page\/(\d+)/i), next = after.pathname.match(/\/page\/(\d+)/i);
    return Boolean(next && Number(next[1]) === Number(old?.[1] || 1) + 1);
  }
  function analyze(doc, options = {}) {
    const base = options.url || doc.location.href;
    const candidates = [], disabledNext = [];
    const learnedNodes = new Set(options.profile?.selector ? resolve(doc, options.profile.selector) : []);
    for (const scope of scopes(doc)) {
      for (const node of scope.querySelectorAll('a,button,div,span,li,input[type="button"],input[type="submit"],[role="button"],[aria-label],[title],[class]')) {
        if (!visible(node, options.snapshot) || node.closest("form") && !contextFor(node) && !learnedNodes.has(node)) continue;
        const ownText = S.text(node.textContent || node.value) || "";
        if (ownText.length > 160) continue;
        const accessible = [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("data-title"), node.value, ownText].filter(Boolean).join(" ");
        const label = accessibleName(node) || "Кнопка со стрелкой";
        const classes = node.getAttribute("class") || "";
        const clickable = node.closest('a,button,input,[role="button"]');
        if (clickable && clickable !== node) continue;
        const native = node.matches('a,button,input,[role="button"]');
        const explicit = learnedNodes.has(node) || node.hasAttribute("aria-label") || node.hasAttribute("title") || node.hasAttribute("onclick") || /next|arrow|chevron|more/i.test(classes);
        if (!native && !explicit && node.children.length > 0) continue;
        if (!native && !learnedNodes.has(node) && node.querySelector('a,button,input,[role="button"]')) continue;
        if (BAD.test(accessible) || PREVIOUS.test(accessible) || /(?:^|[-_\s])prev(?:ious)?(?:$|[-_\s])/i.test(classes)) continue;
        if (!learnedNodes.has(node) && node.closest('[aria-roledescription="carousel"], [class*="carousel"], [class*="slider"], [class*="gallery"]')) continue;
        const context = contextFor(node);
        const nodeBase = S.webUrl(node.ownerDocument.URL) ? node.ownerDocument.URL : base;
        const rel = (node.getAttribute("rel") || "").split(/\s+/).includes("next");
        const rawHref = node.getAttribute("href") || node.getAttribute("data-next-url") || node.getAttribute("data-page-url") || node.getAttribute("data-href");
        let href = rawHref && !/^(?:javascript:|#(?!!?\/))/i.test(rawHref) ? S.httpUrl(rawHref, nodeBase) : null;
        const opener = (node.getAttribute("onclick") || "").match(/^\s*(?:return\s+)?window\.open\(\s*(['"])([^'"]+)\1\s*(?:,\s*(['"])(_blank)\3\s*)?\)\s*;?\s*$/);
        if (!href && opener) href = S.httpUrl(opener[2], nodeBase);
        if (href && (S.dangerousUrl(href) || S.productUrl(href))) continue;
        const reasons = []; let score = 0, kind = "next";
        const add = (value, reason) => { score += value; reasons.push(reason); };
        if (rel) add(115, "Ссылка помечена rel=next");
        if (NEXT_PAGE.test(accessible + " " + label)) add(90, "Подпись означает следующую страницу");
        else if (NEXT.test(label)) add(60, "Подпись означает переход вперёд");
        if (MORE.test(label)) { kind = "load-more"; add(95, "Кнопка загрузки следующих товаров"); }
        if (/(?:^|[\s_-])next(?:$|[\s_-])|nextpage|pagenext|paginationnext/i.test(classes)) add(55, "Класс указывает на следующую страницу");
        if (context) add(35, "Элемент внутри пагинации");
        const current = currentPage(context, nodeBase);
        if (current !== null && (context || href && advances(href, nodeBase)) && /^\d+$/.test(ownText) && Number(ownText) === current + 1) { add(70, "Номер на один больше текущей страницы"); kind = "number"; }
        if (href && advances(href, nodeBase)) add(35, "Номер страницы в URL увеличивается на один");
        if (/^[›»>→➜➔]+$/.test(ownText) || /chevron.?right|arrow.?right/i.test(classes + " " + [...node.querySelectorAll("use")].map(item => item.getAttribute("href") || item.getAttribute("xlink:href") || "").join(" "))) add(15, "Стрелка вправо");
        if (context && rightArrow(node, options.snapshot)) add(50, "Правая стрелка в SVG или CSS внутри пагинации");
        let selector;
        try { selector = selectorFor(node); } catch { continue; }
        const learned = options.profile;
        if (learned?.selector === selector && (!learned.label || learned.label === label) && (!/^\d+$/.test(ownText) || current === null || Number(ownText) === current + 1)) add(110, "Ранее выбрана пользователем для этого сайта");
        if (score < 45 || context && score === 35) continue;
        const item = { id: S.digest(selector + label + (href || "")), selector, label, href, target_blank: node.getAttribute("target") === "_blank" || Boolean(opener), kind, score, confidence: Math.min(100, score), reasons, node, context_url: nodeBase };
        if (disabled(node)) { if (context && (NEXT_PAGE.test(accessible) || NEXT.test(label) || /next/i.test(classes))) disabledNext.push(item); continue; }
        if (node.getAttribute("aria-current") === "page") continue;
        candidates.push(item);
      }
      for (const control of scope.querySelectorAll('input[name],select[name]')) {
        if (!/^(?:page|p|pageNo|pageNum|pageIndex|page_number|currentPage)$/i.test(control.name) || !control.form || disabled(control)) continue;
        const form = control.form, context = contextFor(control);
        if (!visible(form, options.snapshot) || !context && !/page|страниц|页/i.test(accessibleName(control) || "") || BAD.test(form.textContent) || S.dangerousUrl(S.httpUrl(form.getAttribute("action") || base, base))) continue;
        const value = Number(control.value); if (!/^\d+$/.test(control.value.trim()) || !Number.isSafeInteger(value) || value < 0) continue;
        const next = control.tagName === "SELECT" ? [...control.options].find(option => !option.disabled && Number(option.value) === value + 1)?.value ?? null : !control.max || value + 1 <= Number(control.max) ? String(value + 1) : null;
        const selector = selectorFor(control), score = 105 + (options.profile?.selector === selector ? 110 : 0);
        const item = { id: S.digest("form:" + selector + next), selector, label: `Страница ${value + 1} через форму`, action: "form-page", form_selector: selectorFor(form), next_value: next, href: null, target_blank: form.target === "_blank", kind: "number", score, confidence: 100, reasons: ["Поле номера страницы и форма пагинации"], node: control };
        if (next === null) { disabledNext.push(item); continue; }
        candidates.push(item);
      }
      for (const node of scope.querySelectorAll('link[rel~="next"][href]')) {
        const href = S.httpUrl(node.getAttribute("href"), S.webUrl(node.ownerDocument.URL) ? node.ownerDocument.URL : base);
        if (href && !S.dangerousUrl(href) && !S.productUrl(href)) candidates.push({ id: S.digest(href), selector: selectorFor(node), label: "Следующая страница из метаданных", href, action: "open-url", target_blank: false, kind: "next", score: 120, confidence: 100, reasons: ["Метаданные страницы содержат rel=next"], node });
      }
    }
    for (const item of options.pagination || []) if (item.nextPageUrl && !S.dangerousUrl(item.nextPageUrl)) candidates.push({ id: S.digest("page-state:" + item.nextPageUrl), selector: "@page-data-next", label: "Следующая страница из данных приложения", action: "open-url", href: item.nextPageUrl, target_blank: false, kind: "next", score: 105, confidence: 100, reasons: ["Явный nextPageUrl в данных приложения"], node: doc });
    const filtered = candidates.filter(item => !candidates.some(other => other !== item && other.node !== doc && other.node.contains(item.node) && other.score >= item.score && other.node.tagName !== "LINK"));
    const unique = [...new Map(filtered.sort((a, b) => a.score - b.score).map(item => [item.selector + "|" + (item.href || ""), item])).values()].sort((a, b) => b.score - a.score);
    const first = unique[0], second = unique[1];
    const sameDestination = first?.href && first.href === second?.href;
    const automatic = first && first.score >= 85 && (!second || first.score - second.score >= 15 || sameDestination);
    const flags = (options.pagination || []).map(item => item.hasNextPage).filter(value => typeof value === "boolean");
    const terminal = disabledNext.length || flags.length && flags.every(value => value === false);
    return { decision: automatic ? "automatic" : unique.length ? "ambiguous" : terminal ? "exhausted" : "missing", candidates: unique.slice(0, 12), chosen: automatic ? first : null };
  }
  const publicResult = result => ({ ...result, candidates: result.candidates.map(({ node, ...item }) => item), chosen: result.chosen ? (({ node, ...item }) => item)(result.chosen) : null });
  root.SupplierNavigator = { analyze, publicResult, selectorFor, resolve, scopes, visible, disabled, accessibleName, scrollTargets, memo, withSample };
})(globalThis);
