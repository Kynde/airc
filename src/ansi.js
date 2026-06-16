"use strict";

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function rgbCss(r, g, b) {
  const clip = (x) => Math.max(0, Math.min(255, Number(x) || 0));
  return `rgb(${clip(r)},${clip(g)},${clip(b)})`;
}

function color256(n) {
  if (n < 232) {
    const i = n - 16;
    return rgbCss(
      CUBE_LEVELS[Math.floor(i / 36)],
      CUBE_LEVELS[Math.floor(i / 6) % 6],
      CUBE_LEVELS[i % 6]);
  }
  const v = 8 + (n - 232) * 10;
  return rgbCss(v, v, v);
}

function parseExtendedColor(spec) {
  if (spec[0] === 5) {
    const n = spec[1];
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    return n < 16 ? { idx: n } : { css: color256(n) };
  }
  if (spec[0] === 2) {
    const rgb = spec.length >= 5 ? spec.slice(2, 5) : spec.slice(1, 4);
    return rgb.length < 3 ? null : { css: rgbCss(rgb[0], rgb[1], rgb[2]) };
  }
  return null;
}

function applyCodes(style, params) {
  const tokens = params === "" ? ["0"] : params.split(";");
  for (let i = 0; i < tokens.length; i += 1) {
    const sub = tokens[i].split(":").map((s) => (s === "" ? -1 : Number(s)));
    const code = sub[0] === -1 ? 0 : sub[0];

    if (code === 38 || code === 48) {
      let spec;
      if (sub.length > 1) {
        spec = sub.slice(1);
      } else if (Number(tokens[i + 1]) === 5) {
        spec = [5, Number(tokens[i + 2])];
        i += 2;
      } else if (Number(tokens[i + 1]) === 2) {
        spec = [2, Number(tokens[i + 2]), Number(tokens[i + 3]), Number(tokens[i + 4])];
        i += 4;
      } else {
        continue;
      }
      const color = parseExtendedColor(spec);
      if (color) {
        style[code === 38 ? "fg" : "bg"] = color;
      }
      continue;
    }

    if (code === 0) {
      for (const key of Object.keys(style)) {
        delete style[key];
      }
    } else if (code === 1) {
      style.bold = true;
    } else if (code === 2) {
      style.dim = true;
    } else if (code === 3) {
      style.italic = true;
    } else if (code === 4) {
      style.underline = true;
    } else if (code === 7) {
      style.reverse = true;
    } else if (code === 22) {
      delete style.bold;
      delete style.dim;
    } else if (code === 23) {
      delete style.italic;
    } else if (code === 24) {
      delete style.underline;
    } else if (code === 27) {
      delete style.reverse;
    } else if (code === 39) {
      delete style.fg;
    } else if (code === 49) {
      delete style.bg;
    } else if (code >= 30 && code <= 37) {
      style.fg = { idx: code - 30 };
    } else if (code >= 90 && code <= 97) {
      style.fg = { idx: code - 82 };
    } else if (code >= 40 && code <= 47) {
      style.bg = { idx: code - 40 };
    } else if (code >= 100 && code <= 107) {
      style.bg = { idx: code - 92 };
    }
  }
}

function spanAttrs(style) {
  const classes = [];
  const rules = [];
  let fg = style.fg;
  let bg = style.bg;
  if (style.reverse) {
    [fg, bg] = [bg, fg];
  }

  if (fg) {
    if (fg.idx !== undefined) {
      classes.push(`fg-${fg.idx}`);
    } else {
      rules.push(`color:${fg.css}`);
    }
  } else if (style.reverse) {
    classes.push("fg-inv");
  }
  if (bg) {
    if (bg.idx !== undefined) {
      classes.push(`bg-${bg.idx}`);
    } else {
      rules.push(`background:${bg.css}`);
    }
  } else if (style.reverse) {
    classes.push("bg-inv");
  }
  if (style.bold) classes.push("b");
  if (style.dim) classes.push("dim");
  if (style.italic) classes.push("i");
  if (style.underline) classes.push("u");

  if (classes.length === 0 && rules.length === 0) {
    return "";
  }
  return `${classes.length ? ` class="${classes.join(" ")}"` : ""}${rules.length ? ` style="${rules.join(";")}"` : ""}`;
}

const SGR = /\x1b\[([0-9;:]*)m/g;
const OTHER_ESCAPES = /\x1b(?:\[[0-9;:?]*[A-LN-Za-ln-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][AB0]|.)/g;

function ansiToHtml(input) {
  let html = "";
  const style = {};

  function emit(text) {
    const clean = escapeHtml(text.replace(OTHER_ESCAPES, ""));
    if (clean === "") {
      return;
    }
    const attrs = spanAttrs(style);
    html += attrs === "" ? clean : `<span${attrs}>${clean}</span>`;
  }

  SGR.lastIndex = 0;
  let last = 0;
  let match;
  while ((match = SGR.exec(input))) {
    emit(input.slice(last, match.index));
    applyCodes(style, match[1]);
    last = SGR.lastIndex;
  }
  emit(input.slice(last));
  return html;
}

module.exports = { ansiToHtml, escapeHtml };
