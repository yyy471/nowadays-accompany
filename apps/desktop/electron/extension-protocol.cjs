"use strict";

const csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

function assetUrl(raw) {
  if (!URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.protocol !== "nd-ext:" || url.username || url.password || url.port ||
      !/^[a-z][a-z0-9-]{0,23}$/.test(url.hostname) || !url.pathname.startsWith("/ui/") ||
      !url.pathname.slice(1).split("/").every(part => /^[a-z0-9][a-z0-9._-]*$/i.test(part))) return null;
  return url;
}

function extensionHandler(backend, fetchAsset) {
  return async request => {
    const headers = { "content-security-policy": csp, "x-content-type-options": "nosniff", "cache-control": "no-store" };
    const url = assetUrl(request.url);
    if (!url || request.method !== "GET") return new Response(null, { status: 404, headers });
    if (!backend) return new Response(null, { status: 503, headers });
    const target = new URL("/v1/extensions/" + url.hostname + url.pathname, backend);
    if (url.searchParams.has("v")) target.searchParams.set("v", url.searchParams.get("v"));
    const result = await fetchAsset(target.href, { redirect: "manual" });
    if (result.status !== 200) return new Response(null, { status: result.status === 403 ? 403 : 404, headers });
    headers["content-type"] = result.headers.get("content-type") || "application/octet-stream";
    return new Response(result.body, { headers });
  };
}

function allowSlotNavigation(event, mainFrame) {
  const target = assetUrl(event.url);
  if (!target || event.isMainFrame || !event.frame || event.frame.parent !== mainFrame) return false;
  if (event.initiator === mainFrame) return true;
  return event.initiator === event.frame && assetUrl(event.frame.url)?.hostname === target.hostname;
}

module.exports = { extensionHandler, allowSlotNavigation };
