// Cloudflare Pages Function — middleware for all requests.
// Korean is the canonical site (`/`); English mirror at `/en/`.
//
// Auto-routing rules (only on root `/`):
//   1) If user has cookie `lang=ko|en`, respect their explicit choice — NO auto-redirect.
//   2) Otherwise, look at CF-IPCountry:
//        - KR → serve Korean root (no redirect, fall through)
//        - any other country → 302 redirect to /en/
//
// All other paths (/en/, /news.html, /articles/..., /assets/...) pass through unchanged.

export async function onRequest({ request, next }) {
  const url = new URL(request.url);

  // 1. Only intercept the exact root path.
  if (url.pathname !== "/") return next();

  // 2. Honor user's explicit language preference (cookie set by toggle button).
  const cookie = request.headers.get("Cookie") || "";
  if (/(?:^|;\s*)lang=ko(?:;|$)/.test(cookie)) return next();              // serve Korean
  if (/(?:^|;\s*)lang=en(?:;|$)/.test(cookie)) {
    return Response.redirect(`${url.origin}/en/`, 302);
  }

  // 3. First visit: route by IP country.
  const country = request.headers.get("CF-IPCountry") || "";
  if (country && country !== "KR") {
    return Response.redirect(`${url.origin}/en/`, 302);
  }

  // KR or unknown → serve Korean (canonical default).
  return next();
}
