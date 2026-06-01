// Cloudflare Pages Function — middleware for all requests.
// 한국어 단일 언어 사이트. 영어 미러(`/en/`)는 폐지됨.
//
// 유일한 역할: 옛 `/en/...` 북마크·외부 링크·검색엔진 인덱스를
// 한국어 홈(`/`)으로 301 영구 리다이렉트. 그 외 경로는 그대로 통과.

export async function onRequest({ request, next }) {
  const url = new URL(request.url);

  // 옛 영어 경로(/en, /en/, /en/...) → 한국어 홈으로 영구 이동.
  if (url.pathname === "/en" || url.pathname.startsWith("/en/")) {
    return Response.redirect(`${url.origin}/`, 301);
  }

  return next();
}
