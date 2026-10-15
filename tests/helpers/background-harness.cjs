"use strict";
// Chrome APIs are simulated here; DOM extraction and navigation run in Chromium.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const extensionPath = path.resolve(__dirname, "../../extension");

async function createHarness(browser, t) {
  const context = await browser.newContext();
  const timers = new Set();
  const tabs = new Map(); let nextTabId = 2, runtimeHandlers = [], createdHandlers = [], updatedHandlers = [], removedHandlers = [];
  const prepared = new WeakSet();
  const popupErrors = [];
  function dispatch(message, sender) { return new Promise(resolve => { const result = runtimeHandlers[0]?.(message, sender, resolve); if (result !== true) resolve({ ok: true }); }); }
  t.after(async () => { for (const timer of timers) clearTimeout(timer); await context.close(); });
  const first = fs.readFileSync(path.join(__dirname, "../fixtures/results.html"), "utf8");
  const second = fs.readFileSync(path.join(__dirname, "../fixtures/results-page2.html"), "utf8");
  const page = await context.newPage();
  tabs.set(1, page);
  async function preparePage(target) {
  if (prepared.has(target)) return; prepared.add(target);
  await target.exposeFunction("__backgroundFromContent", message => {
    const id = [...tabs].find(([, item]) => item === target)?.[0];
    return dispatch(message, { id: "testextension", url: target.url(), tab: { id } });
  });
  await target.addInitScript(() => {
    globalThis.__contentMessages = [];
    globalThis.chrome = { runtime: { onMessage: { addListener: listener => __contentMessages.push(listener) }, sendMessage: message => __backgroundFromContent(message) } };
  });
  await target.addInitScript({ path: path.join(extensionPath, "shared.js") });
  await target.addInitScript({ path: path.join(extensionPath, "navigation.js") });
  await target.addInitScript({ path: path.join(extensionPath, "generic.js") });
  await target.addInitScript({ path: path.join(extensionPath, "data-sources.js") });
  await target.addInitScript({ path: path.join(extensionPath, "engine.js") });
  await target.addInitScript({ path: path.join(extensionPath, "observer.js") });
  await target.addInitScript({ path: path.join(extensionPath, "content.js") });
  target.on("popup", async child => {
    const parentId = [...tabs].find(([, item]) => item === target)?.[0]; const id = nextTabId++; tabs.set(id, child);
    for (const listener of createdHandlers) listener({ id, openerTabId: parentId, url: child.url() });
    try {
      await preparePage(child); await child.waitForLoadState("domcontentloaded");
      for (const listener of updatedHandlers) listener(id, { status: "complete", url: child.url() }, { id, openerTabId: parentId, url: child.url() });
    } catch (error) { if (!child.isClosed()) popupErrors.push(error); }
  });
  }
  const flags = { detailChallenge: false, routeHtml: null };
  const detailHtml = '<!doctype html><h1>Detail cup</h1><a class="company-name" href="https://cupfactory.1688.com/">浙江水杯工厂</a><span class="price">¥15</span>';
  await preparePage(page);
  await context.route("**/*", route => {
    if (route.request().resourceType() !== "document") return route.abort();
    const custom = flags.routeHtml?.(new URL(route.request().url()));
    if (custom !== undefined && custom !== null) return route.fulfill({ contentType: "text/html; charset=utf-8", body: custom });
    if (/\/offer\/\d+\.html/.test(route.request().url())) return route.fulfill({ contentType: "text/html; charset=utf-8", body: flags.detailChallenge ? '<div class="nc-container">滑动验证</div>' : detailHtml });
    const isSecond = new URL(route.request().url()).searchParams.get("page") === "2";
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: isSecond ? second : first });
  });
  const initialUrl = "https://s.1688.com/selloffer/offer_search.htm?keywords=%E6%B0%B4%E6%9D%AF&page=1";
  await page.goto(initialUrl);
  const data = {};
  const downloads = [];
  const openedUi = [];
  const observers = [];
  const alarms = new Map();
  let startupHandlers = [];
  let alarmHandlers = [];
  let sandbox;
  const event = array => ({ addListener: listener => array.push(listener) });
  const granted = new Set();
  const shared = require("../../extension/shared.js");
  const chrome = {
    runtime: {
      id: "testextension",
      getURL: file => `chrome-extension://testextension/${file}`,
      get onMessage() { return event(runtimeHandlers); },
      get onStartup() { return event(startupHandlers); }
    },
    storage: { local: {
      async get(keys) {
        const selected = typeof keys === "string" ? [keys] : keys;
        return structuredClone(Object.fromEntries(selected.map(key => [key, data[key]])));
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: structuredClone(data[key]), newValue: structuredClone(value) };
          data[key] = structuredClone(value);
        }
        for (const observer of observers) observer(changes, "local");
      },
      async remove(keys) {
        const changes = {};
        for (const key of typeof keys === "string" ? [keys] : keys) { if (data[key] !== undefined) changes[key] = { oldValue: structuredClone(data[key]) }; delete data[key]; }
        for (const observer of observers) observer(changes, "local");
      }
    } },
    tabs: {
      async get(id) { const target = tabs.get(id); if (!target) throw new Error("Tab closed"); return { id, url: target.url(), status: "complete" }; },
      async query(options) { return options?.active ? [{ id: 1, url: page.url(), status: "complete" }] : [...tabs].map(([id, target]) => ({ id, url: target.url(), status: "complete" })); },
      async create({ url }) { if (url.startsWith(chrome.runtime.getURL(""))) { openedUi.push(url); return { id: nextTabId++, url, status: "complete" }; } const target = await context.newPage(); const id = nextTabId++; tabs.set(id, target); await preparePage(target); await target.goto(url); return { id, url, status: "complete" }; },
      async update(id, options) { const target = tabs.get(id); if (options.url) await target.goto(options.url); if (options.active) await target.bringToFront(); return { id, url: target.url(), status: "complete" }; },
      async sendMessage(id, message) {
        if (!await tabs.get(id).evaluate(() => Boolean(globalThis.__contentMessages))) await tabs.get(id).evaluate(() => {
          globalThis.__contentMessages = []; globalThis.chrome = { runtime: { onMessage: { addListener: listener => __contentMessages.push(listener) }, sendMessage: message => __backgroundFromContent(message) } };
        });
        return tabs.get(id).evaluate(message => new Promise((resolve, reject) => {
          if (!globalThis.__contentMessages?.length) return reject(new Error("Receiving end does not exist"));
          for (const listener of __contentMessages) listener(message, {}, resolve);
        }), message);
      },
      get onRemoved() { return event(removedHandlers); }, get onCreated() { return event(createdHandlers); }, get onUpdated() { return event(updatedHandlers); }
    },
    permissions: { async contains({ origins }) { return origins.every(pattern => shared.isMarketplaceUrl(pattern.replace("*", "")) || granted.has(pattern)); }, async request({ origins }) { origins.forEach(pattern => granted.add(pattern)); return true; } },
    scripting: {
      async executeScript({ target, files, func, args = [] }) { if (func) return [{ frameId: 0, result: await tabs.get(target.tabId).evaluate(func, args[0]) }]; for (const file of files) await tabs.get(target.tabId).addScriptTag({ path: path.join(extensionPath, file) }); }
    },
    alarms: {
      async create(name, options) { alarms.set(name, options); },
      async clear(name) { return alarms.delete(name); },
      get onAlarm() { return event(alarmHandlers); }
    },
    downloads: { async download(options) { downloads.push(options); return downloads.length; } }
  };

  function restart() {
    for (const timer of timers) clearTimeout(timer); timers.clear();
    runtimeHandlers = []; startupHandlers = []; alarmHandlers = []; createdHandlers = []; updatedHandlers = []; removedHandlers = [];
    sandbox = vm.createContext({
      chrome, URL, Date, crypto, console, TextEncoder, btoa,
      setTimeout(callback, delay) {
        const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
        timers.add(timer);
        return timer;
      },
      importScripts(file) { vm.runInContext(fs.readFileSync(path.join(extensionPath, file), "utf8"), sandbox); }
    });
    vm.runInContext(fs.readFileSync(path.join(extensionPath, "background.js"), "utf8"), sandbox);
  }
  restart();
  async function command(type, options, sender = { id: "testextension", url: chrome.runtime.getURL("popup.html") }) {
    return new Promise(resolve => {
      const result = runtimeHandlers[0]({ target: "1688-background", type, options }, sender, resolve);
      if (result !== true) resolve({ ok: false, error: "Sender rejected" });
    });
  }
  async function waitFor(predicate, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (popupErrors.length) throw popupErrors[0];
      if (predicate(data)) return structuredClone(data);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Background harness timed out: ${JSON.stringify(data.run)}`);
  }
  return {
    context, page, command, waitFor, data, downloads, openedUi, observers, initialUrl, flags, tabs, detailHtml, granted,
    idle: () => !vm.runInContext("processing || starting", sandbox),
    stage2Idle: () => !vm.runInContext("SupplierStage.busy()", sandbox),
    alarm: name => { for (const handler of alarmHandlers) handler({ name }); },
    async closeTab(id) { await tabs.get(id).close(); tabs.delete(id); for (const handler of removedHandlers) await handler(id); },
    resume() { restart(); startupHandlers[0](); }
  };
}
module.exports = { createHarness };
