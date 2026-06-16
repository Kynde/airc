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
    if (name === "airc_auth") {
      return rest.join("=");
    }
  }
  return "";
}

function isAuthorized(request, url, token) {
  return (
    tokenEquals(url.searchParams.get("k") || "", token) ||
    tokenEquals(cookieToken(request), token) ||
    tokenEquals(request.headers.authorization?.replace(/^Bearer\s+/i, "") || "", token) ||
    tokenEquals(request.headers["x-airc-auth"] || "", token)
  );
}

function authCookie(token) {
  return `airc_auth=${token}; Max-Age=15552000; Secure; HttpOnly; SameSite=Lax; Path=/`;
}

module.exports = { isAuthorized, authCookie, tokenEquals };
