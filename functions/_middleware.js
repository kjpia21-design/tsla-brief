// Cloudflare Pages Function — middleware for all requests.
// 한국어(`/`) + 영어(`/en/`) 이중언어 — 영어 미러 인프라는 빌드 완료.
//
// ⚠️ 공개 게이트: 영어 정제 데이터(_en)가 충분히 쌓이기 전까지 /en/* 는 한국어 홈으로 리다이렉트.
//    이중언어 Routine 재붙여넣기 + (선택)과거 기사 _en 백필 후, 아래 블록만 제거하면 즉시 공개.
//    (영어 빌드 산출물은 dist/en/ 에 이미 생성됨 — 플립 즉시 서빙)

export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  if (url.pathname === "/en" || url.pathname.startsWith("/en/")) {
    return Response.redirect(`${url.origin}/`, 302);   // 임시(302) — 데이터 준비 후 제거
  }
  return next();
}
