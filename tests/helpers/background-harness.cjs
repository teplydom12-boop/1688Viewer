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
  t.after(async () => { for (const timer of timers) clearTimeout(timer); await context.close(); });
  const first = fs.readFileSync(path.join(__dirname, "../fixtures/results.html"), "utf8");
  const second = fs.readFileSync(path.join(__dirname, "../fixtures/results-page2.html"), "utf8");
  const page = await context.newPage();
  async function preparePage(target) {
  await target.addInitScript(() => {
    globalThis.__contentMessages = [];
    globalThis.chrome = { runtime: { onMessage: { addListener: listener => __contentMessages.push(listener) } } };
  });
  await target.addInitScript({ path: path.join(extensionPath, "shared.js") });
  await target.addInitScript({ path: path.join(extensionPath, "engine.js") });
  await target.addInitScript({ path: path.join(extensionPath, "content.js") });
  }
  const flags = { detailChallenge: false };
  const detailHtml = '<!doctype html><h1>Detail cup</h1><a class="company-name" href="https://cupfactory.1688.com/">浙江水杯工厂</a><span class="price">¥15</span>';
  await preparePage(page);
  await context.route("**/*", route => {
    if (route.request().resourceType() !== "document") return route.abort();
    if (/\/offer\/\d+\.html/.test(route.request().url())) return route.fulfill({ contentType: "text/html; charset=utf-8", body: flags.detailChallenge ? '<div class="nc-container">滑动验证</div>' : detailHtml });
    const isSecond = new URL(route.request().url()).searchParams.get("page") === "2";
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: isSecond ? second : first });
  });
  const initialUrl = "https://s.1688.com/selloffer/offer_search.htm?keywords=%E6%B0%B4%E6%9D%AF&page=1";
  await page.goto(initialUrl);
  const tabs = new Map([[1, page]]);
  let nextTabId = 2;
  const data = {};
  const downloads = [];
  const observers = [];
  const alarms = new Map();
  let runtimeHandlers = [];
  let startupHandlers = [];
  let alarmHandlers = [];
  let sandbox;
  const event = array => ({ addListener: listener => array.push(listener) });
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
      async remove(keys) { for (const key of keys) delete data[key]; }
    } },
    tabs: {
      async get(id) { const target = tabs.get(id); if (!target) throw new Error("Tab closed"); return { id, url: target.url(), status: "complete" }; },
      async query() { return [{ id: 1, url: page.url(), status: "complete" }]; },
      async create({ url }) { const target = await context.newPage(); const id = nextTabId++; tabs.set(id, target); await preparePage(target); await target.goto(url); return { id, url, status: "complete" }; },
      async update(id, options) { const target = tabs.get(id); if (options.url) await target.goto(options.url); if (options.active) await target.bringToFront(); return { id, url: target.url(), status: "complete" }; },
      async sendMessage(id, message) {
        return tabs.get(id).evaluate(message => new Promise((resolve, reject) => {
          if (!globalThis.__contentMessages?.length) return reject(new Error("Receiving end does not exist"));
          for (const listener of __contentMessages) listener(message, {}, resolve);
        }), message);
      },
      onRemoved: event([])
    },
    scripting: {
      async executeScript({ files }) { for (const file of files) await page.addScriptTag({ path: path.join(extensionPath, file) }); }
    },
    alarms: {
      async create(name, options) { alarms.set(name, options); },
      async clear(name) { return alarms.delete(name); },
      get onAlarm() { return event(alarmHandlers); }
    },
    downloads: { async download(options) { downloads.push(options); return downloads.length; } }
  };

  function restart() {
    runtimeHandlers = []; startupHandlers = []; alarmHandlers = [];
    sandbox = vm.createContext({
      chrome, URL, Date, crypto, console,
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
      if (predicate(data)) return structuredClone(data);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Background harness timed out: ${JSON.stringify(data.run)}`);
  }
  return {
    context, page, command, waitFor, data, downloads, observers, initialUrl, flags, tabs, detailHtml,
    idle: () => !vm.runInContext("processing || starting", sandbox),
    resume() { restart(); startupHandlers[0](); }
  };
}
module.exports = { createHarness };
