export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Formato de ruta: /p/<host>/<resto de la ruta>
    const m = url.pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
    if (!m) return env.ASSETS.fetch(request);

    const host = m[1];
    const origin = "https://" + host;
    const target = origin + (m[2] || "/") + url.search;

    // Reenviamos las cabeceras importantes (Range es clave para el vídeo)
    const fwd = new Headers();
    for (const h of ["range", "accept", "accept-language", "cookie"]) {
      const v = request.headers.get(h);
      if (v) fwd.set(h, v);
    }
    fwd.set("Referer", origin);
    fwd.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0");

    const resp = await fetch(target, { headers: fwd, redirect: "follow" });

    const headers = new Headers(resp.headers);
    headers.delete("x-frame-options");
    headers.delete("content-security-policy");
    headers.delete("content-security-policy-report-only");
    headers.set("access-control-allow-origin", "*");

    const ct = resp.headers.get("content-type") || "";

    // 1) HTML: reescribir enlaces para que no se salgan del proxy
    if (ct.includes("text/html")) {
      return new HTMLRewriter()
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

    // 2) Listas .m3u8: reescribir también
    if (url.pathname.endsWith(".m3u8") || ct.includes("mpegurl")) {
      let txt = await resp.text();
      txt = txt.replaceAll(origin, "/p/" + host);
      txt = txt.split("\n").map((l) => (l.startsWith("/") ? "/p/" + host + l : l)).join("\n");
      return new Response(txt, { status: resp.status, headers });
    }

    return new Response(resp.body, { status: resp.status, headers });
  },
};
