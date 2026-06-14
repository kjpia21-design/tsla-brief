// Cloudflare Pages Function — 모든 요청 미들웨어.
// ① 한국어(`/`) + 영어(`/en/`) 이중언어 지오 분기:
//     • 한국(KR) → 한국어(`/`)  • 그 외 국가 → 영어(`/en/`)  • lang 쿠키(토글) 우선
//     지오 분기는 홈(`/`) 진입 시에만 적용.
// ② soft-404 교정: Pages Functions 가 존재하면 없는 경로에 홈(index.html)을 200 으로
//     SPA 폴백한다. 홈 경로가 아닌데 홈 HTML(og:url=루트 마커)이 반환되면 진짜 404 페이지로 교체.

const NOT_FOUND = (en) => `<!doctype html>
<html lang="${en ? "en" : "ko"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>404 — ${en ? "Page not found" : "페이지를 찾을 수 없어요"} · TESLA Brief!ng</title>
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#e9ebee;color:#191f28;font-family:"Pretendard Variable",Pretendard,-apple-system,sans-serif;letter-spacing:-.02em;-webkit-font-smoothing:antialiased}
.page{max-width:440px;margin:0 auto;min-height:100vh;background:#f2f4f6;display:flex;flex-direction:column;box-shadow:0 0 32px rgba(0,0,0,.06)}
.nav{height:57px;display:flex;align-items:center;padding:0 16px;background:#f2f4f6;border-bottom:1px solid #eef1f4}
.brand{font-weight:800;font-size:18px;color:#E31937;text-decoration:none}
.brand b{color:#191f28;font-weight:800}.brand em{font-style:normal;color:#E31937}
.nf{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 28px 90px}
.code{font-size:64px;font-weight:800;color:#c4cad2;line-height:1;letter-spacing:-.04em}
.nf h1{font-size:20px;font-weight:800;margin:14px 0 8px}
.nf p{font-size:14px;color:#4e5968;line-height:1.6;max-width:30ch}
.btns{display:flex;gap:10px;margin-top:24px}
.btns a{font-size:14px;font-weight:700;text-decoration:none;border-radius:12px;padding:12px 18px}
.btns .p{background:#191f28;color:#fff}
.btns .s{background:#fff;color:#4e5968;box-shadow:0 1px 3px rgba(0,0,0,.06)}
</style>
</head>
<body><div class="page">
<header class="nav"><a class="brand" href="${en ? "/en/" : "/"}">Tesla <b>Brief<em>!</em>ng</b></a></header>
<main class="nf">
<div class="code">404</div>
<h1>${en ? "Page not found" : "페이지를 찾을 수 없어요"}</h1>
<p>${en ? "This page may have been removed or its address may have changed." : "삭제됐거나 주소가 바뀐 페이지일 수 있어요."}</p>
<div class="btns">
<a class="p" href="${en ? "/en/" : "/"}">${en ? "Home" : "홈으로"}</a>
<a class="s" href="${en ? "/en/news" : "/news"}">${en ? "All news" : "전체 뉴스"}</a>
</div>
</main>
</div></body></html>`;

export async function onRequest({ request, next }) {
  const url = new URL(request.url);

  // 토글로 명시 선택한 언어 (쿠키) — 지오보다 우선
  const lang = (((request.headers.get("cookie") || "").match(/(?:^|;\s*)lang=(ko|en)/)) || [])[1];

  if (url.pathname === "/") {
    if (lang === "en") return Response.redirect(`${url.origin}/en/`, 302);   // 영어 선택자
    if (!lang) {
      const country = request.cf && request.cf.country;                       // Cloudflare 지오 (로컬·프리뷰면 undefined)
      if (country && country !== "KR") return Response.redirect(`${url.origin}/en/`, 302);
    }
    // lang=ko 또는 한국(KR) 또는 지오 미상 → 한국어 홈 그대로
  }

  const res = await next();

  // soft-404 교정 — 홈/en홈 경로가 아닌데 홈 HTML 이 200 으로 폴백된 경우만 404 로 교체.
  const p = url.pathname;
  const homePath = p === "/" || p === "/en/" || p === "/index.html" || p === "/en/index.html";
  if (!homePath && res.status === 200 && (res.headers.get("content-type") || "").includes("text/html")) {
    const body = await res.clone().text();
    const isHomeFallback =
      body.includes('og:url" content="https://teslabriefing.com/">') ||
      body.includes('og:url" content="https://teslabriefing.com/en/">');
    if (isHomeFallback) {
      return new Response(NOT_FOUND(p.startsWith("/en/")), {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
  }
  return res;
}
