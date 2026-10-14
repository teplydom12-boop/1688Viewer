"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const extension = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Chrome Manifest V3 required");
for (const file of fs.readdirSync(extension).filter(file => file.endsWith(".js"))) {
  execFileSync(process.execPath, ["--check", path.join(extension, file)], { stdio: "inherit" });
}
for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons || {}), ...manifest.content_scripts.flatMap(item => item.js)]) {
  if (!fs.existsSync(path.join(extension, file))) throw new Error(`Missing manifest resource: ${file}`);
}
for (const html of [manifest.action.default_popup, "dashboard.html"]) {
  const source = fs.readFileSync(path.join(extension, html), "utf8");
  for (const match of source.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css))"/g)) {
    if (!fs.existsSync(path.join(extension, match[1]))) throw new Error(`Missing UI resource: ${match[1]}`);
  }
}
console.log("Manifest resources and JavaScript syntax OK");
