"use strict";

const crypto = require("node:crypto");

function tokenEquals(candidate, token) {
  if (typeof candidate !== "string" || candidate === "" || token === "") {
    return false;
  }
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieToken(request) {
  const header = request.headers.cookie;
  if (!header) {
    return "";
  }
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "airc_auth" || name === "swyd_auth") {
      return rest.join("=");
    }
  }
  return "";
}

function presentedToken(request, url) {
  return (
    url.searchParams.get("k") ||
    cookieToken(request) ||
    request.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    request.headers["x-airc-auth"] ||
    request.headers["x-swyd-auth"] ||
    ""
  );
}

function authLevel(request, url, config) {
  const token = presentedToken(request, url);
  if (tokenEquals(token, config.controlToken || "")) {
    return { level: "control", token };
  }
  if (tokenEquals(token, config.viewToken || "")) {
    return { level: "view", token };
  }
  return { level: "none", token: "" };
}

function authCookie(token) {
  return `airc_auth=${token}; Max-Age=15552000; Secure; HttpOnly; SameSite=Lax; Path=/`;
}

module.exports = { authLevel, authCookie, tokenEquals };
