// Cloudflare Pages Function — 모든 요청 미들웨어.
// 한국어(`/`) + 영어(`/en/`) 이중언어. 지오 기본 언어 분기:
//   • 한국(KR) → 한국어(`/`)        • 그 외 국가 → 영어(`/en/`)
// 단, 사용자가 네비 토글로 고른 언어(`lang` 쿠키)가 지오보다 항상 우선한다.
// 지오 분기는 홈(`/`) 진입 시에만 적용 — 그 외 경로는 사용자가 보던 언어를 유지.

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

  return next();
}
