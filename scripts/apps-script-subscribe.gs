/**
 * TESLA Brief!ng — 뉴스레터 구독 수집 웹훅 (Google Apps Script)
 *
 * 배포 방법:
 *   1) script.google.com → 새 프로젝트 → 이 코드 전체 붙여넣기
 *   2) 아래 SHEET_ID 를 구독자 시트 ID 로 교체
 *      (시트 URL: docs.google.com/spreadsheets/d/<여기가 ID>/edit)
 *   3) (선택) TOKEN 을 임의 문자열로 채우고, Cloudflare Pages env
 *      SUBSCRIBE_TOKEN 에 같은 값을 넣으면 외부 무단 POST 차단
 *   4) 배포 > 새 배포 > 유형: 웹 앱
 *        - 실행: 나(admin@teslabriefing.com)
 *        - 액세스 권한: 모든 사용자
 *   5) 발급된 웹 앱 URL 을 Cloudflare Pages env SUBSCRIBE_WEBHOOK_URL 에 등록
 *
 * 코드 수정 후에는 반드시 "새 배포" 또는 "배포 관리 > 편집 > 버전: 새 버전" 해야 반영됩니다.
 */

const SHEET_ID = 'PASTE_YOUR_SHEET_ID_HERE';
const SHEET_NAME = 'subscribers';
const TOKEN = ''; // Pages SUBSCRIBE_TOKEN 와 동일 값. 비우면 토큰 검사 생략.

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

    const sh = sheet_();
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
      String(body.lang || ''),
      String(body.country || ''),
      String(body.source || ''),
    ]);
    return out({ ok: true });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

// 헬스 체크 — 브라우저에서 웹 앱 URL 열면 동작 확인.
function doGet() {
  return out({ ok: true, msg: 'tesla-briefing subscribe webhook alive' });
}

function sheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(['ts', 'email', 'lang', 'country', 'source']);
  }
  return sh;
}

function out(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
