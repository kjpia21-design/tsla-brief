/**
 * TESLA Brief!ng — 뉴스레터 구독 수집 + 명단 조회 웹훅 (Google Apps Script)
 *
 * 기능
 *   · doPost            : 구독 폼 접수 → Google Sheet 적재 (한국어 단일 운영)
 *   · doGet ?action=list: 구독자 이메일 배열 반환 (뉴스레터 발송용, 토큰 필수)
 *   · doGet ?action=tokchk: [임시 진단] 배포된 TOKEN 의 존재/길이만 반환 (점검 후 삭제 가능)
 *   · doGet (그 외)      : 헬스 체크
 *
 * 배포 방법
 *   1) script.google.com → 이 코드 전체 붙여넣기
 *   2) SHEET_ID 를 구독자 시트 ID 로 교체
 *      (시트 URL: docs.google.com/spreadsheets/d/<여기가 ID>/edit)
 *   3) TOKEN 을 임의 문자열로 채움.
 *      ⚠️ 같은 값을 3곳에 동일하게:
 *         - 이 TOKEN
 *         - Cloudflare Pages env  SUBSCRIBE_TOKEN      (구독 폼 → 쓰기)
 *         - news-brief/.env       SUBSCRIBER_LIST_TOKEN (뉴스레터 → 읽기)
 *      ❗ TOKEN 이 비어 있으면 list 조회는 보안상 거부됩니다.
 *   4) 💾 저장 후 → 배포 > 새 배포(또는 배포 관리 > 편집 > 버전: 새 버전)
 *        - 실행: 나 / 액세스 권한: 모든 사용자
 *   5) 발급된 /exec URL 을:
 *        - Cloudflare Pages env  SUBSCRIBE_WEBHOOK_URL
 *        - news-brief/.env       SUBSCRIBER_LIST_URL
 *      에 등록.
 *
 * ※ 코드 수정 후에는 반드시 "💾 저장 → 새 버전 배포" 해야 /exec 에 반영됩니다.
 */

const SHEET_ID = 'PASTE_YOUR_SHEET_ID_HERE';   // ← 본인 구독자 시트 ID
const SHEET_NAME_KO = 'subscribers-ko';
const SHEET_NAME_EN = 'subscribers-en';        // (영어 페이지 폐지 — 잔존, 미사용)
const TOKEN = '';                              // ← 본인 토큰 (위 ③ 참고). 비우면 list 거부.

// 신규 구독자 발생 시 텔레그램 알림 (선택). 두 값 비우면 알림 안 감.
//   · TG_BOT_TOKEN: BotFather 봇 토큰 (뉴스레터 발송에 쓰는 그 봇 그대로 가능)
//   · TG_CHAT_ID  : 알림 받을 챗 ID
//   ⚠️ 토큰은 여기(본인 Apps Script)에만 붙여넣기 — 외부에 노출 금지.
const TG_BOT_TOKEN = '';
const TG_CHAT_ID   = '';

// ── POST: 구독 접수 ───────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (TOKEN && body.token !== TOKEN) {
      return out({ ok: false, error: 'unauthorized' });
    }

    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return out({ ok: false, error: 'bad email' });
    }

    const lang = body.lang === 'en' ? 'en' : 'ko';
    const sh = sheet_(lang);

    // 중복 검사 (해당 언어 탭 안에서만)
    const lastRow = sh.getLastRow();
    if (lastRow >= 2) {
      const existing = sh.getRange(2, 2, lastRow - 1, 1).getValues();
      for (let i = 0; i < existing.length; i++) {
        if (String(existing[i][0]).trim().toLowerCase() === email) {
          return out({ ok: true, dup: true });
        }
      }
    }

    sh.appendRow([
      new Date(),
      email,
      lang,
      String(body.country || ''),
      String(body.source || ''),
    ]);
    // 신규 구독자(중복 아님)만 알림. 그 시점 해당 명단 총 구독자 수 = 행수 - 헤더.
    const count = Math.max(0, sh.getLastRow() - 1);
    notifyTelegram_(email, count);
    return out({ ok: true });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

// ── 신규 구독 텔레그램 알림 ────────────────────────
// 알림 실패가 구독 접수 자체를 막지 않도록 try/catch 로 감싼다.
function notifyTelegram_(email, count) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const text = '🎉 신규 뉴스레터 구독자\n\n'
      + '📧 ' + email + '\n'
      + '👥 현재 구독자 ' + count + '명';
    UrlFetchApp.fetch('https://api.telegram.org/bot' + TG_BOT_TOKEN + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: text,
        disable_web_page_preview: true,
      }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    // 무시 — 구독은 이미 정상 적재됨
  }
}

// ── GET: 명단 조회 / 진단 / 헬스 체크 ───────────────
function doGet(e) {
  const p = (e && e.parameter) || {};

  // [임시 진단] 배포된 TOKEN 의 존재/길이만 반환 (비밀값 자체는 노출 안 함). 점검 후 삭제 가능.
  if (p.action === 'tokchk') {
    return out({ ok: true, tokenSet: !!TOKEN, tokenLen: TOKEN ? String(TOKEN).length : 0 });
  }

  // 구독자 이메일 배열 — 토큰이 설정돼 있고 일치할 때만.
  if (p.action === 'list') {
    if (!TOKEN || p.token !== TOKEN) {
      return out({ ok: false, error: 'unauthorized' });
    }
    const lang = p.lang === 'en' ? 'en' : 'ko';
    const sh = sheet_(lang);
    const emails = [];
    const lastRow = sh.getLastRow();
    if (lastRow >= 2) {
      const rows = sh.getRange(2, 2, lastRow - 1, 1).getValues(); // B열 = email
      for (let i = 0; i < rows.length; i++) {
        const em = String(rows[i][0]).trim().toLowerCase();
        if (em) emails.push(em);
      }
    }
    return out({ ok: true, count: emails.length, emails: emails });
  }

  return out({ ok: true, msg: 'tesla-briefing subscribe webhook alive' });
}

// ── 언어별 탭 (없으면 헤더와 함께 생성) ─────────────
function sheet_(lang) {
  const name = lang === 'en' ? SHEET_NAME_EN : SHEET_NAME_KO;
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(['ts', 'email', 'lang', 'country', 'source']);
  }
  return sh;
}

function out(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
