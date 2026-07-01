"use strict";

// Deliberately minimal: no shared config or `globals` package, just enough to
// catch dead code and typos (unused vars, undefined references) without adding
// framework-y tooling. ES built-ins (Math, JSON, Date, …) come from
// ecmaVersion; environment globals are listed per file group below.
const NODE_GLOBALS = {
  require: "readonly",
  module: "writable",
  exports: "writable",
  process: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  console: "readonly",
  setTimeout: "readonly",
  setInterval: "readonly",
  clearTimeout: "readonly",
  clearInterval: "readonly",
  fetch: "readonly",
  URL: "readonly",
};

const BROWSER_GLOBALS = {
  document: "readonly",
  window: "readonly",
  location: "readonly",
  history: "readonly",
  localStorage: "readonly",
  navigator: "readonly",
  fetch: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  WebSocket: "readonly",
  matchMedia: "readonly",
  setTimeout: "readonly",
  setInterval: "readonly",
  clearTimeout: "readonly",
  clearInterval: "readonly",
  console: "readonly",
};

const rules = {
  "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
  "no-undef": "error",
};

module.exports = [
  { ignores: ["node_modules/**", "android-app/**"] },
  {
    files: ["src/**/*.js", "scripts/**/*.js", "test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: NODE_GLOBALS,
    },
    rules,
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: BROWSER_GLOBALS,
    },
    rules,
  },
];
