// Cloudflare Pages Function — 뉴스레터 구독 접수 프록시.
// 폼 → POST /api/subscribe → (검증·허니팟) → Apps Script 웹훅 → Google Sheet.
//
// 필요한 환경변수 (Pages 프로젝트 설정 · manager@honeylife.co.kr account):
//   SUBSCRIBE_WEBHOOK_URL  — Apps Script 웹 앱 URL (필수)
//   SUBSCRIBE_TOKEN        — Apps Script TOKEN 과 동일 값 (선택, 권장)

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "잘못된 요청입니다." }, 400);
  }

  // 허니팟: 봇이 채우면 조용히 성공 처리하고 무시.
  if (body.hp) return json({ ok: true });

  if (!body.consent) {
    return json({ ok: false, error: "개인정보 수집·이용 동의가 필요합니다." }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ ok: false, error: "이메일 형식을 확인해 주세요." }, 400);
  }

  const webhook = env.SUBSCRIBE_WEBHOOK_URL;
  if (!webhook) {
    return json({ ok: false, error: "서버 설정 오류입니다." }, 500);
  }

  try {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        lang: body.lang === "en" ? "en" : "ko",
        country: request.headers.get("CF-IPCountry") || "",
        source: request.headers.get("Referer") || "",
        token: env.SUBSCRIBE_TOKEN || "",
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const data = await r.json().catch(() => ({}));
    if (data && data.ok === false) {
      return json({ ok: false, error: "구독 처리에 실패했습니다." }, 502);
    }
    return json({ ok: true, dup: !!(data && data.dup) });
  } catch {
    return json({ ok: false, error: "잠시 후 다시 시도해 주세요." }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
