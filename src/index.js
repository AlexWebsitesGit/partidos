function getCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

// Script que se inyecta en la página para reescribir las llamadas del JavaScript
const shim = (host) => `<script>
(function(){
  var HOST = ${JSON.stringify(host)};
  var P = "/p/" + HOST;
  function fix(u){
    try{
      var abs = new URL(u, location.href);
      if (abs.hostname === HOST || abs.hostname === location.hostname){
        if (abs.pathname.indexOf("/p/") !== 0) return P + abs.pathname + abs.search + abs.hash;
      }
    }catch(e){}
    return null;
  }
  var _fetch = window.fetch;
  window.fetch = function(input, init){
    try{
      if (typeof input === "string"){ var f = fix(input); if (f) input = f; }
      else if (input && input.url){ var f2 = fix(input.url); if (f2) input = new Request(f2, input); }
    }catch(e){}
    return _fetch.call(this, input, init);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url){
    try{ var f = fix(url); if (f) url = f; }catch(e){}
    var rest = [].slice.call(arguments, 2);
    return _open.apply(this, [method, url].concat(rest));
  };
})();
</script>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    let host = null;
    let rest = url.pathname;

    const m = url.pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
    if (m) {
      host = m[1];
      rest = m[2] || "/";
    } else {
      // Sin /p/: puede ser tu index.html o una llamada interna del reproductor
      const recordado = getCookie(request, "phost");
      if (recordado) {
        const asset = await env.ASSETS.fetch(request.clone());
        if (asset.status !== 404) return asset;
        host = recordado;
        rest = url.pathname;
      } else {
        return env.ASSETS.fetch(request);
      }
    }

    const origin = "https://" + host;
    const target = origin + rest + url.search;

    const fwd = new Headers();
    for (const h of ["range", "accept", "accept-language", "cookie"]) {
      const v = request.headers.get(h);
      if (v) fwd.set(h, v);
    }
    fwd.set("Referer", origin);
    fwd.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0");

    const init = { method: request.method, headers: fwd, redirect: "follow" };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

    const resp = await fetch(target, init);

    const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    const headers = new Headers(resp.headers);
    headers.delete("set-cookie");
    headers.delete("x-frame-options");
    headers.delete("content-security-policy");
    headers.delete("content-security-policy-report-only");
    headers.set("access-control-allow-origin", "*");
    headers.set("vary", "Cookie");
    for (const c of setCookies) headers.append("Set-Cookie", c);
    headers.append("Set-Cookie", "phost=" + encodeURIComponent(host) + "; Path=/; SameSite=Lax");

    const ct = resp.headers.get("content-type") || "";

    if (ct.includes("text/html")) {
      return new HTMLRewriter()
        .on("head", { element(el) { el.prepend(shim(host), { html: true }); } })
        .on("[href],[src]", {
          element(el) {
            for (const a of ["href", "src"]) {
              const v = el.getAttribute(a);
              if (!v) continue;
              if (v.startsWith(origin)) el.setAttribute(a, v.replace(origin, "/p/" + host));
              else if (v.startsWith("/") && !v.startsWith("//")) el.setAttribute(a, "/p/" + host + v);
            }
          },
        })
        .transform(new Response(resp.body, { status: resp.status, headers }));
    }

    if (url.pathname.endsWith(".m3u8") || ct.includes("mpegurl")) {
      let txt = await resp.text();
      txt = txt.replaceAll(origin, "/p/" + host);
      txt = txt.split("\n").map((l) => (l.startsWith("/") ? "/p/" + host + l : l)).join("\n");
      return new Response(txt, { status: resp.status, headers });
    }

    return new Response(resp.body, { status: resp.status, headers });
  },
};
