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
  function scopes(doc) {
    const roots = [doc];
    if (doc.shadowRoot) roots.push(doc.shadowRoot);
    for (let index = 0; index < roots.length && index < 50; index++) for (const node of roots[index].querySelectorAll("*")) if (node.shadowRoot && !roots.includes(node.shadowRoot)) roots.push(node.shadowRoot);
    return roots;
  }
  function visible(node, snapshot) {
    if (node.closest('[hidden], [aria-hidden="true"]')) return false;
    if (snapshot) return !node.closest('[style*="display:none"], [style*="display: none"]');
    const view = node.ownerDocument.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && node.getClientRects().length > 0;
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
    const wrap = selector => scope.host ? `${selectorFor(scope.host)} >>> ${selector}` : selector;
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
      const parts = selector.split(" >>> "); let scope = doc;
      for (const part of parts.slice(0, -1)) { scope = scope.querySelector(part)?.shadowRoot; if (!scope) return []; }
      return [...scope.querySelectorAll(parts.at(-1))];
    } catch { return []; }
  }
  function contextFor(node) {
    for (let current = node.parentElement, depth = 0; current && depth < 7; current = current.parentElement, depth++) {
      const classes = current.getAttribute("class") || "";
      const label = `${current.getAttribute("aria-label") || ""} ${current.getAttribute("role") || ""}`;
      if (pagingClass.test(classes) || /pagination|пагинац|страниц/i.test(label)) return current;
      if (current.tagName === "NAV" || current.getAttribute("role") === "navigation") {
        const numbers = [...current.querySelectorAll('a,button,[role="button"]')].filter(item => /^\d+$/.test((item.textContent || "").trim()));
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
    for (const [key, value] of url.searchParams) if (pageKeys.test(key) && /^\d+$/.test(value)) return Number(value);
    return Number(url.pathname.match(/\/page\/(\d+)/i)?.[1] || 1);
  }
  function advances(href, base) {
    if (!href) return false;
    const before = new URL(base), after = new URL(href);
    if (after.origin !== before.origin) return false;
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
        const label = S.text(node.getAttribute("aria-label") || node.getAttribute("title") || ownText) || "Кнопка со стрелкой";
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
        const rel = (node.getAttribute("rel") || "").split(/\s+/).includes("next");
        const rawHref = node.getAttribute("href");
        const href = rawHref && !/^(?:javascript:|#(?!!?\/))/i.test(rawHref) ? S.httpUrl(rawHref, base) : null;
        if (href && (S.dangerousUrl(href) || S.productUrl(href))) continue;
        const reasons = []; let score = 0, kind = "next";
        const add = (value, reason) => { score += value; reasons.push(reason); };
        if (rel) add(115, "Ссылка помечена rel=next");
        if (NEXT_PAGE.test(accessible)) add(90, "Подпись означает следующую страницу");
        else if (NEXT.test(label)) add(60, "Подпись означает переход вперёд");
        if (MORE.test(label)) { kind = "load-more"; add(95, "Кнопка загрузки следующих товаров"); }
        if (/(?:^|[\s_-])next(?:$|[\s_-])|nextpage|pagenext|paginationnext/i.test(classes)) add(55, "Класс указывает на следующую страницу");
        if (context) add(35, "Элемент внутри пагинации");
        if (context && /^\d+$/.test(ownText) && Number(ownText) === currentPage(context, base) + 1) { add(70, "Номер на один больше текущей страницы"); kind = "number"; }
        if (href && advances(href, base)) add(35, "Номер страницы в URL увеличивается на один");
        if (/^[›»>→➜➔]+$/.test(ownText) || /chevron.?right|arrow.?right/i.test(classes + " " + [...node.querySelectorAll("use")].map(item => item.getAttribute("href") || item.getAttribute("xlink:href") || "").join(" "))) add(15, "Стрелка вправо");
        let selector;
        try { selector = selectorFor(node); } catch { continue; }
        const learned = options.profile;
        if (learned?.selector === selector && (!learned.label || learned.label === label)) add(110, "Ранее выбрана пользователем для этого сайта");
        if (score < 45 || context && score === 35) continue;
        const item = { id: S.digest(selector + label + (href || "")), selector, label, href, target_blank: node.getAttribute("target") === "_blank", kind, score, confidence: Math.min(100, score), reasons, node };
        if (disabled(node)) { if (context && (NEXT_PAGE.test(accessible) || NEXT.test(label) || /next/i.test(classes))) disabledNext.push(item); continue; }
        if (node.getAttribute("aria-current") === "page") continue;
        candidates.push(item);
      }
      for (const node of scope.querySelectorAll('link[rel~="next"][href]')) {
        const href = S.httpUrl(node.getAttribute("href"), base);
        if (href && !S.dangerousUrl(href) && !S.productUrl(href)) candidates.push({ id: S.digest(href), selector: 'link[rel~="next"]', label: "Следующая страница из метаданных", href, target_blank: false, kind: "next", score: 120, confidence: 100, reasons: ["Метаданные страницы содержат rel=next"], node });
      }
    }
    const filtered = candidates.filter(item => !candidates.some(other => other !== item && other.node.contains(item.node) && other.score >= item.score && other.node.tagName !== "LINK"));
    const unique = [...new Map(filtered.sort((a, b) => a.score - b.score).map(item => [item.selector + "|" + (item.href || ""), item])).values()].sort((a, b) => b.score - a.score);
    const first = unique[0], second = unique[1];
    const sameDestination = first?.href && first.href === second?.href;
    const automatic = first && first.score >= 85 && (!second || first.score - second.score >= 15 || sameDestination);
    return { decision: automatic ? "automatic" : unique.length ? "ambiguous" : disabledNext.length ? "exhausted" : "missing", candidates: unique.slice(0, 12), chosen: automatic ? first : null };
  }
  const publicResult = result => ({ ...result, candidates: result.candidates.map(({ node, ...item }) => item), chosen: result.chosen ? (({ node, ...item }) => item)(result.chosen) : null });
  root.SupplierNavigator = { analyze, publicResult, selectorFor, resolve, scopes, visible, disabled };
})(globalThis);
