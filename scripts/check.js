"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function files(dir, suffix) {
  const out = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      out.push(...files(full, suffix));
    } else if (item.name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

const jsFiles = [...files(path.join(__dirname, "..", "src"), ".js"), ...files(path.join(__dirname, "..", "public"), ".js")];
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status);
  }
}
console.log(`checked ${jsFiles.length} JavaScript files`);
