#!/usr/bin/env node
/**
 * TSLA Brief — JSON → home.html 빌드 스크립트
 *
 *   node build.mjs
 *
 * 입력: home-v1.html (템플릿, BLOCK 마커 포함) + data/*.json
 * 출력: dist/home.html (마커 영역 치환됨)
 *
 * 의존성 0. Node 20+ 권장.
 */

import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 활성 템플릿: home.html (mobile-first 정착본). home-v1/v2 는 디자인 보존용 백업.
const TEMPLATE_PATH = path.join(ROOT, "home.html");
const DATA_DIR = path.join(ROOT, "data");
const ASSETS_DIR = path.join(ROOT, "assets");
const OUT_DIR = path.join(ROOT, "dist");
// GitHub Pages 호환을 위해 index.html 로 출력. 템플릿은 home-v1.html 그대로.
const OUT_PATH = path.join(OUT_DIR, "index.html");
const OUT_ASSETS = path.join(OUT_DIR, "assets");
const SITE = "https://teslabriefing.com";  // canonical 도메인 (sitemap·canonical·JSON-LD·RSS)

const CATEGORY_CLASS = {
  stock: "is-stock",
  product: "is-product",
  fsd: "is-fsd",
  musk: "is-musk",
};

const VIDEO_THUMB_CLASS = {
  stock: "v-stock",
  product: "v-product",
  fsd: "v-fsd",
  musk: "v-musk",
};

// 영어 빌드용 카테고리 라벨 (raw-cards.json 의 한국어 categoryLabel 영문 대체)
const CATEGORY_LABEL_EN = {
  stock:   "STOCK · Stock & Earnings",
  product: "PRODUCT · Vehicles, Energy & Optimus",
  fsd:     "FSD · Autonomy & Robotaxi",
  musk:    "ELON · Elon News",
};

// 4단계 출처 표시 순서: 1차(green) → 공식(blue) → 외신(orange) → 추측(grey)
const SOURCE_ORDER = [
  { key: "sec",      dot: "d-sec",    label: "1차"  },
  { key: "official", dot: "d-off",    label: "공식" },
  { key: "press",    dot: "d-press",  label: "외신" },
  { key: "rumor",    dot: "d-rumor",  label: "추측" },
];

/**
 * BLOCK 마커 영역 치환.
 *  - 기본: 마커 보존 (idempotent — 두 번째 빌드에서도 다시 치환 가능)
 *  - keepMarkers=false: 마커까지 제거 (URL/attribute 안에 들어가는 값에 사용 — 주석이 속성을 깨뜨림)
 */
function replaceBlock(html, name, replacement, opts = {}) {
  const re = new RegExp(
    `<!--\\s*BLOCK:${name}\\s*-->[\\s\\S]*?<!--\\s*/BLOCK:${name}\\s*-->`,
    "g"
  );
  if (!re.test(html)) {
    throw new Error(`[build] BLOCK:${name} 마커가 템플릿에 없습니다.`);
  }
  const out = opts.keepMarkers === false
    ? replacement
    : `<!-- BLOCK:${name} -->${replacement}<!-- /BLOCK:${name} -->`;
  return html.replace(
    new RegExp(
      `<!--\\s*BLOCK:${name}\\s*-->[\\s\\S]*?<!--\\s*/BLOCK:${name}\\s*-->`,
      "g"
    ),
    () => out   // 함수 치환 — 값에 $·$& 가 있어도 안전(예: "주가 $500")
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 제목·바디에는 <em> 강조 마크업이 들어 있으므로 그대로 살림(이미 콘텐츠 작성자가 의도한 것).
// 나머지 텍스트 필드는 escapeHtml 적용.

/**
 * 가격 박스 한 줄 렌더링.
 * data/kpi.json 스키마(fetch-price.mjs 산출):
 *   { price, change, changePct, dayHigh, dayLow, marketState, marketStateLabel, marketStateShort, asOf, ... }
 * SSR 산출은 첫 페인트 fallback. 클라이언트 폴링(1분)이 이후 갱신.
 */
// asOf("2026-06-05 11:05 UTC") → 뉴욕시간 "요일 HH:MM ET" (클라이언트 fmtAsOf 와 동일)
function formatAsOfET(s) {
  if (!s) return "";
  const t = Date.parse(String(s).replace(" UTC", "Z").replace(" ", "T"));
  if (Number.isNaN(t)) return s;
  const d = new Date(t);
  const wd = d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
  const hm = d.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${wd} ${hm} ET`;
}

// 신선도 라벨 — 빌드 시점에 미리 계산해 SSR. (클라이언트 fmtFresh 와 동일 포맷, JS 가 이어서 갱신)
// "갱신 시각 계산 중…" 플레이스홀더가 첫 페인트·JS꺼짐·봇에 노출되지 않게.
function fmtFreshLabel(pubDate) {
  const t = Date.parse(pubDate);
  if (Number.isNaN(t)) return "";
  const min = Math.max(1, Math.round((Date.now() - t) / 60000));
  if (min < 60) return `최신 콘텐츠 ${min}분 전`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `최신 콘텐츠 ${hr}시간 전`;
  return `최신 콘텐츠 ${Math.round(hr / 24)}일 전`;
}

function renderKpi(kpi) {
  // 옛 5칸 스키마 (items 배열) → 빈 placeholder
  if (Array.isArray(kpi.items)) {
    return emptyPriceBar();
  }
  const up = (kpi.change || 0) >= 0;
  const dir = up ? "up" : "down";
  const arrow = up ? "▲" : "▼";
  const sign = up ? "+" : "";
  const price = typeof kpi.price === "number" ? `$${kpi.price.toFixed(2)}` : "$—";
  const changeFull = typeof kpi.change === "number"
    ? `${arrow} ${sign}${kpi.change.toFixed(2)} (${sign}${kpi.changePct.toFixed(2)}%)`
    : "—";
  // 모바일은 % 만 (절대값 생략)
  const changeShort = typeof kpi.changePct === "number"
    ? `${arrow} ${sign}${kpi.changePct.toFixed(2)}%`
    : "—";
  const rangeFull = (typeof kpi.dayLow === "number" && typeof kpi.dayHigh === "number")
    ? `${kpi.dayLow.toFixed(2)} – ${kpi.dayHigh.toFixed(2)}`
    : "— – —";
  // 모바일은 정수
  const rangeShort = (typeof kpi.dayLow === "number" && typeof kpi.dayHigh === "number")
    ? `${Math.round(kpi.dayLow)}–${Math.round(kpi.dayHigh)}`
    : "—–—";
  const stateShort = (kpi.marketStateShort || kpi.marketState || "").toLowerCase();
  const stateLabel = kpi.marketStateLabel || kpi.marketState || "—";
  // 초기 등락률(빌드 시점) — 라이브 fetch 실패해도 가격-방향 핫뉴스 모순 숨김에 사용.
  const changeInit = typeof kpi.changePct === "number" ? ` data-change-init="${kpi.changePct}"` : "";
  return `
      <span class="price-bar__price"><small>TSLA</small><span data-pb-price>${escapeHtml(price)}</span></span>
      <span class="price-bar__change ${dir}"${changeInit}>
        <span class="pb-full" data-pb-change-full>${escapeHtml(changeFull)}</span>
        <span class="pb-short" data-pb-change-short>${escapeHtml(changeShort)}</span>
      </span>
      <span class="price-bar__meta">
        <span class="price-bar__pill is-${escapeHtml(stateShort)}" data-pb-state>${escapeHtml(stateLabel)}</span>
        <span class="price-bar__range">
          <b>오늘</b>
          <span class="pb-full" data-pb-range-full>${escapeHtml(rangeFull)}</span>
          <span class="pb-short" data-pb-range-short>${escapeHtml(rangeShort)}</span>
        </span>
        <span class="price-bar__asof" data-pb-asof>${escapeHtml(formatAsOfET(kpi.asOf))}</span>
      </span>
      `;
}

function emptyPriceBar() {
  return `
      <span class="price-bar__price"><small>TSLA</small><span data-pb-price>$—</span></span>
      <span class="price-bar__change">
        <span class="pb-full" data-pb-change-full>—</span>
        <span class="pb-short" data-pb-change-short>—</span>
      </span>
      <span class="price-bar__meta">
        <span class="price-bar__pill" data-pb-state>—</span>
        <span class="price-bar__range">
          <b>오늘</b>
          <span class="pb-full" data-pb-range-full>— – —</span>
          <span class="pb-short" data-pb-range-short>— – —</span>
        </span>
        <span class="price-bar__asof" data-pb-asof>—</span>
      </span>
      `;
}

// 옛 스키마(`sources` 카운트 객체) 호환용. 신 스키마는 sourceName 단일.
function renderSources(sources) {
  const parts = SOURCE_ORDER
    .map(({ key, dot, label }) => {
      const n = sources[key] || 0;
      if (n <= 0) return null;
      return `<span><i class="d ${dot}"></i> ${label} ${n}</span>`;
    })
    .filter(Boolean)
    .join("\n            ");
  return parts;
}

const SOURCE_LABEL_DOT = {
  sec: "d-sec", official: "d-off", press: "d-press", rumor: "d-rumor",
};

// 출처 신뢰도 배지 — 1차 자료(SEC·규제기관) / 공식(테슬라·일론 직접) 만 강조.
// 외신·추측은 도트만(클러터 방지). 인라인 스타일이라 템플릿 CSS 변경 불필요.
const TIER_BADGE = {
  sec:      { kr: "1차 자료", bg: "#16A34A" },   // 초록 — 출처 팔레트(카테고리와 비충돌)
  official: { kr: "공식",     bg: "#8B5CF6" },   // 보라
};
function tierBadge(label) {
  const b = TIER_BADGE[label];
  if (!b) return "";
  return `<span style="display:inline-block;background:${b.bg};color:#fff;`
    + `font-size:10px;font-weight:700;letter-spacing:.02em;padding:1px 6px;`
    + `border-radius:4px;margin-right:6px;vertical-align:middle">${b.kr}</span>`;
}

// 교차검증 신호(#1): 같은 사건을 N개 매체가 보도 → 신뢰 신호(outlined 배지, CSS 변수로 테마 대응).
function confirmedBadge(c) {
  const n = typeof c.confirmedBy === "number" ? c.confirmedBy : 0;
  if (n < 2) return "";
  return `<span title="${n}개 매체가 같은 내용을 보도(교차확인)" style="display:inline-block;`
    + `border:1px solid var(--line);color:var(--ink-mute);font-size:10px;font-weight:600;`
    + `letter-spacing:.02em;padding:0 6px;border-radius:4px;margin-right:6px;vertical-align:middle">`
    + `✓ ${n}개 매체</span>`;
}

// 강세/약세 태그(#2) — sentiment(bull/bear)만 표시(중립·미지정은 생략해 클러터 방지). 색: 상승 초록 / 하락 빨강.
const SENTI_TIP = "원문 기사 논조 기반 자동 분류입니다 — 편집부 투자 의견이 아닙니다";
function sentiBadge(c) {
  if (c.sentiment === "bull") return `<span class="senti senti--bull" title="${SENTI_TIP}">▲ 강세</span>`;
  if (c.sentiment === "bear") return `<span class="senti senti--bear" title="${SENTI_TIP}">▼ 약세</span>`;
  return "";
}

/** 카드 메타: 신 스키마(sourceName) 우선, 없으면 옛 sources 카운트 폴백. */
function renderCardMeta(c) {
  if (c.sourceName) {
    const dot = SOURCE_LABEL_DOT[c.sourceLabel || "press"] || "d-press";
    const badge = tierBadge(c.sourceLabel);
    return `${badge}${confirmedBadge(c)}<span class="src-name"><i class="d ${dot}"></i>${escapeHtml(c.sourceName)}</span>`;
  }
  if (c.sources) return renderSources(c.sources);
  return "";
}

/** 카테고리 짧은 라벨 (핫 뉴스용) — STOCK/PRODUCT/FSD/ELON */
const CATEGORY_SHORT = {
  stock: "STOCK", product: "PRODUCT", fsd: "FSD", musk: "ELON",
};

/**
 * 핫 뉴스 — 제목 5건만 stack.
 * cards.items 의 첫 5개. 각 항목 클릭 시 상세 페이지로.
 */
/**
 * 핫뉴스 — hot 점수 (0~10) 기준 정렬, top 5.
 * - 1차 정렬: hot 점수 desc (LLM 정성 판단, Routine 이 부여)
 * - 2차 정렬 (동률): pubDate desc — 같은 hot 이면 최신 우선
 * - 폴백: hot 필드 없으면 기본 5 → 사실상 시간순
 */
const WEEKDAY_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
/** YYYY-MM-DD → "7/2 THU" (ko) / "Jul 2" (en). 연도 없이, 요일은 영어 약어. TZ 안전(UTC). */
function fmtCalDate(iso, lang = "ko") {
  const [y, m, d] = (iso || "").split("-").map(Number);
  if (!y || !m || !d) return iso || "";
  if (lang === "en") {
    const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${MON[m - 1]} ${d}`;
  }
  const wd = WEEKDAY_EN[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d} ${wd}`;
}

/**
 * 투자자 캘린더 — 핫뉴스 마지막 줄(가장 가까운 일정 + 📅), 클릭 시 향후 일정(3개월+) 펼침.
 * 데이터: data/calendar.json. 다가오는 일정이 없으면 빈 문자열(미표시).
 * 분기 일정은 잠정(tentative)이며 그 사실을 화면에 명시한다(추측을 사실처럼 표기 금지).
 */
/** 다가오는 일정 목록 + 가장 가까운 일정의 D-day. 캘린더 라인·티커 칩이 공용. */
function upcomingEvents(calendar, now = new Date()) {
  const events = (calendar?.events || [])
    .filter((e) => e && e.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const todayISO = now.toISOString().slice(0, 10);
  const upcoming = events.filter((e) => e.date >= todayISO);
  if (!upcoming.length) return null;
  const todayMs = Date.parse(todayISO + "T00:00:00Z");
  const dday = Math.max(0, Math.round((Date.parse(upcoming[0].date + "T00:00:00Z") - todayMs) / 86400000));
  return { upcoming, next: upcoming[0], dday };
}

function renderInvestorCalendar(calendar, lang = "ko", now = new Date()) {
  const up = upcomingEvents(calendar, now);
  if (!up) return "";   // 다가오는 일정 없음 → 줄 자체 미표시
  const { upcoming, next, dday } = up;
  const L = lang === "en"
    ? { lead: "Next", head: "Investor Calendar · Upcoming", tent: "TBD", today: "Today",
        foot: `Quarterly dates are estimates pending Tesla's official announcement — see <a href="https://ir.tesla.com" target="_blank" rel="noopener">ir.tesla.com</a>.` }
    : { lead: "다음 일정", head: "투자자 캘린더 · 향후 일정", tent: "잠정", today: "오늘",
        foot: `분기 실적·인도 일정은 공식 발표 전 과거 패턴 기반 <b>잠정</b>치 — 확정 일정은 <a href="https://ir.tesla.com" target="_blank" rel="noopener">ir.tesla.com</a> 참조.` };
  const ddayTxt = dday === 0 ? L.today : `D-${dday}`;
  // 메인 노출 제목에서 연도(20xx) 제거 — 데이터엔 연도 유지, 화면만 간결화.
  const stripYear = (t) => (t || "").replace(/\s*\b20\d{2}\b\s*/, " ").replace(/\s+/g, " ").trim();
  const tentChip = (e) => (e.tentative ? `<span class="ic__tent">${L.tent}</span>` : "");
  const rows = upcoming.map((e) =>
    `<li class="ic__row"><span class="ic__rdate">${escapeHtml(fmtCalDate(e.date, lang))}</span>`
    + `<span class="ic__rtitle">${escapeHtml(stripYear(e.title))}${tentChip(e)}</span></li>`
  ).join("\n          ");
  // Event 구조화 데이터 — 검색엔진이 투자자 일정을 이벤트로 인식 (잠정 일정은 description에 명시)
  const eventsLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: upcoming.map((e, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Event",
        name: `Tesla ${(e.title || "").replace(/\s+/g, " ").trim()}`,
        startDate: e.date,
        eventStatus: "https://schema.org/EventScheduled",
        eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
        location: { "@type": "VirtualLocation", url: "https://ir.tesla.com" },
        description: e.tentative ? "과거 패턴 기반 잠정 일정 — 공식 확정 전" : "공식 확정 일정",
        organizer: { "@type": "Organization", name: "Tesla, Inc.", url: "https://ir.tesla.com" },
      },
    })),
  });
  return `<script type="application/ld+json">${eventsLd}</script>
    <details class="ic">
      <summary class="ic__bar">
        <span class="ic__lead">${L.lead}</span>
        <span class="ic__title">${escapeHtml(stripYear(next.title))}</span>
        <span class="ic__date">${escapeHtml(fmtCalDate(next.date, lang))}</span>${tentChip(next)}
        <span class="ic__dday">${ddayTxt}</span>
        <span class="ic__cal" aria-hidden="true">📅</span>
      </summary>
      <div class="ic__panel">
        <div class="ic__panelhead">${L.head}</div>
        <ul class="ic__list">
          ${rows}
        </ul>
        <p class="ic__foot">${L.foot}</p>
      </div>
    </details>`;
}

// 주가 "방향성" 카드 — stock(주가·실적) 카테고리에서 "주가의" 급등/급락을 다루는 카드의 방향(up/down).
//   ① 신선도 가드: 24h 지난 가격-방향 뉴스는 핫뉴스 후보에서 제외(장 상황이 바뀐 '이전 뉴스').
//   ② data-price-dir 태그: 라이브 주가와 방향이 모순되면 클라이언트(home.html)가 핫뉴스에서 숨김.
//   ⚠️ 방향어 단독 매칭 금지 — "중국 판매 22% 급반등"(판매) 같은 비주가 뉴스 오인 방지.
//      가격 주체(주가·주식·시총·종가·TSLA 티커) 바로 뒤 12자 이내에 방향어가 있어야 주가 방향 뉴스로 간주.
const PRICE_UP_WORDS   = "급등|폭등|반등|상승|강세|신고가|치솟|뛰|랠리|오름세|surg|soar|rall(?:y|ie)|jump|rebound|gain|climb|rocket|rise|spike";
const PRICE_DOWN_WORDS = "급락|폭락|하락|약세|추락|떨어|미끄러|내림세|폭삭|매도세|plunge|drop|tumbl|slump|slide|sink|fall|decline";
const PRICE_SUBJ = "(?:(?<!목표)주가|주식|시총|시가총액|종가|TSLA)";   // '목표주가'(애널리스트 목표가)는 주체 제외
const PRICE_NEAR = "[^.。!?\\n]{0,20}?";
const PRICE_UP_CTX_RE   = new RegExp(PRICE_SUBJ + PRICE_NEAR + "(?:" + PRICE_UP_WORDS + ")", "i");
const PRICE_DOWN_CTX_RE = new RegExp(PRICE_SUBJ + PRICE_NEAR + "(?:" + PRICE_DOWN_WORDS + ")", "i");
function priceDirection(c) {
  if (!c || c.category !== "stock") return null;        // 주가·실적 카테고리만
  const txt = `${c.title || ""} ${c.hotShort || ""} ${c.body || ""}`
    .replace(/<[^>]+>/g, "")
    .replace(/(\d)\.(\d)/g, "$1$2");                     // 소수점(4.6%, $408.95)이 문장 경계로 오인되지 않게
  const up = PRICE_UP_CTX_RE.test(txt), down = PRICE_DOWN_CTX_RE.test(txt);
  if (up === down) return null;                          // 둘 다(급락 딛고 반등 등)거나 둘 다 아님 → 모호, 태그 안 함
  return up ? "up" : "down";
}
const STALE_PRICE_HOURS = 24;

// 카드 텍스트 필드 선택 — 영어 빌드(lang="en")면 `<base>_en` 사용(없으면 한글 폴백). ko 면 항상 한글.
function fld(c, base, lang) { return (lang === "en" ? (c[base + "_en"] || c[base]) : c[base]) || ""; }

function renderHotNews(cards, lang = "ko") {
  const hotOf = (c) => (typeof c.hot === "number" ? c.hot : 5);
  const byHot = (a, b) => (hotOf(b) - hotOf(a)) || (Date.parse(b.pubDate || 0) - Date.parse(a.pubDate || 0));
  // 신선도 가드 — 오래된 가격-방향 뉴스는 핫 후보에서 제외(최신 뉴스 목록엔 그대로 남음).
  const nowMs = Date.now();
  const eligible = cards.items.filter((c) => {
    if (!priceDirection(c)) return true;
    return (nowMs - Date.parse(c.pubDate || 0)) / 3600000 <= STALE_PRICE_HOURS;
  });
  const ranked = [...eligible].sort(byHot);

  // 톤 균형(주주·팬 배려) — 핫뉴스가 부정 일색이 되지 않게 부정(sentiment="bear") 카드를 최대 MAX_NEG 개로 제한.
  //   중요한 악재는 숨기지 않되, 비부정(강세·중립)이 있으면 우선 채워 균형을 맞춘다.
  //   sentiment 미지정 카드는 중립 취급(영향 없음) → 필드 채워지기 전엔 기존 동작.
  const TOP = 5, MAX_NEG = 3;
  const top = [], spillNeg = [];
  let neg = 0;
  for (const c of ranked) {
    if (top.length >= TOP) break;
    if (c.sentiment === "bear") {
      if (neg < MAX_NEG) { top.push(c); neg += 1; } else { spillNeg.push(c); }
    } else {
      top.push(c);
    }
  }
  for (const c of spillNeg) { if (top.length >= TOP) break; top.push(c); }  // 비부정 부족 시 보충(억지 X)
  top.sort(byHot);  // 선정된 5건을 hot 순으로 표시
  const items = top.map((c) => {
    const cls = CATEGORY_CLASS[c.category] || "is-stock";
    const href = c.slug ? `articles/${c.slug}.html` : (c.href || "#");
    const dir = priceDirection(c);
    const dirAttr = dir ? ` data-price-dir="${dir}"` : "";   // 라이브 주가와 모순 시 클라이언트가 숨김
    // 모바일 1줄용 축약 — <em> 제거 후 단어 경계로 잘라 "잘린 듯" 보이지 않게.
    return `      <li><a class="hot-news__item ${cls}"${dirAttr} href="${escapeHtml(href)}">
        <span class="hot-news__title"><span class="hn-full">${fld(c, "title", lang)}</span><span class="hn-short">${hotShortHtml(c, lang)}</span></span>
      </a></li>`;
  }).join("\n");
  return `\n${items}\n      `;
}

// 핫뉴스 모바일 축약 — <em> 제거, 단어 경계 기준 ~MAX 자 이내로. 말줄임표 없이 깔끔하게 끝.
function shortHotTitle(htmlTitle, MAX = 26) {
  const plain = (htmlTitle || "").replace(/<\/?em>/g, "").trim();
  if ([...plain].length <= MAX) return plain;
  let out = "";
  for (const part of plain.split(/(\s+)/)) {
    if ([...(out + part)].length > MAX) break;
    out += part;
  }
  out = out.trim();
  if (!out) out = [...plain].slice(0, MAX).join("");
  return out;
}

// hotShort 안전 렌더 — 전체 escape 후 <em>…</em> 만 복원(카테고리색 italic 강조).
// 그 외 태그·속성(<em onclick> 등)은 정확히 일치하지 않아 escape 유지 → XSS 안전.
function hotShortHtml(c, lang = "ko") {
  const raw = (lang === "en" ? c.hotShort_en : c.hotShort) || shortHotTitle(fld(c, "title", lang));
  return escapeHtml(raw)
    .replace(/&lt;em&gt;/g, "<em>")
    .replace(/&lt;\/em&gt;/g, "</em>");
}

// 카드 본문 — 완결된 사실 한 문장만 노출(왜-중요 상술은 기사 상세에 유지, 카드는 중간 절단 방지).
//   1) ' — [왜 중요]' 대시 꼬리 제거  2) 여러 문장이면 첫 문장만.
//   소수점("3.5%")·약어 내부 점은 종결로 오인하지 않게 종결부호 뒤가 공백/끝일 때만 자른다.
function cardBody(body) {
  let t = (body || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const d = t.search(/\s[—–]\s/);
  if (d >= 16) t = t.slice(0, d).trim();
  const m = t.match(/^[\s\S]*?[.!?。](?=\s|$)/);
  if (m && [...m[0]].length >= 24 && m[0].length < t.length) t = m[0].trim();
  return t;
}

/**
 * 메인 카드 그리드 — cards.items 의 첫 5개 (최신순).
 * 전체 보기는 news.html 로 이동.
 */
function renderCards(cards, { lang = "ko" } = {}) {
  const ctaLabel = lang === "en" ? "More" : "자세히";
  const items = cards.items.slice(0, 5).map((c) => {
    const cls = CATEGORY_CLASS[c.category] || "is-stock";
    const href = c.slug ? `articles/${c.slug}.html` : (c.href || "#");
    const pubAttr = c.pubDate ? ` data-pubdate="${escapeHtml(c.pubDate)}"` : "";
    const catLabel = lang === "en" ? (CATEGORY_LABEL_EN[c.category] || c.categoryLabel) : c.categoryLabel;
    return `      <a class="ccard ${cls}" href="${escapeHtml(href)}">
        <div class="ccard__top">
          <span class="ccard__cat">${escapeHtml(catLabel)}</span>${sentiBadge(c)}
          <span class="ccard__time"${pubAttr}>${escapeHtml(c.time)}</span>
        </div>
        <h3>${fld(c, "title", lang)}</h3>
        <p class="ccard__body">${escapeHtml(cardBody(fld(c, "body", lang)))}</p>
        <div class="ccard__meta">
          <div class="src">${renderCardMeta(c)}</div>
          <span class="ccard__cta">${ctaLabel}</span>
        </div>
      </a>`;
  }).join("\n");
  return `\n${items}\n      `;
}

/** 전체 카드 (news.html 용) — 시간순으로 전부. */
function renderAllCards(cards, { lang = "ko" } = {}) {
  const ctaLabel = lang === "en" ? "More" : "자세히";
  const items = cards.items.map((c) => {
    const cls = CATEGORY_CLASS[c.category] || "is-stock";
    const href = c.slug ? `articles/${c.slug}.html` : (c.href || "#");
    const pubAttr = c.pubDate ? ` data-pubdate="${escapeHtml(c.pubDate)}"` : "";
    const catLabel = lang === "en" ? (CATEGORY_LABEL_EN[c.category] || c.categoryLabel) : c.categoryLabel;
    return `      <a class="ccard ${cls}" href="${escapeHtml(href)}">
        <div class="ccard__top">
          <span class="ccard__cat">${escapeHtml(catLabel)}</span>${sentiBadge(c)}
          <span class="ccard__time"${pubAttr}>${escapeHtml(c.time)}</span>
        </div>
        <h3>${fld(c, "title", lang)}</h3>
        <p class="ccard__body">${escapeHtml(cardBody(fld(c, "body", lang)))}</p>
        <div class="ccard__meta">
          <div class="src">${renderCardMeta(c)}</div>
          <span class="ccard__cta">${ctaLabel}</span>
        </div>
      </a>`;
  }).join("\n");
  return items;
}

// 클라이언트 필터/검색용 압축 인덱스 1건 — news-index.json 에 들어감.
//  title/src 는 파이프라인이 생성한 신뢰 HTML, body 는 평문(클라이언트가 escape).
//  q 는 검색용 소문자 평문(제목+본문+출처).
function newsIndexEntry(c, lang = "ko") {
  const cls = CATEGORY_CLASS[c.category] || "is-stock";
  const href = c.slug ? `articles/${c.slug}.html` : (c.href || "#");
  const catLabel = lang === "en" ? (CATEGORY_LABEL_EN[c.category] || c.categoryLabel) : c.categoryLabel;
  const titleF = fld(c, "title", lang), bodyF = fld(c, "body", lang);
  const titlePlain = titleF.replace(/<\/?em>/g, "");
  return {
    category: c.category || "stock",
    cls,
    catLabel,
    title: titleF,
    body: cardBody(bodyF),
    time: c.time || "",
    pubDate: c.pubDate || "",
    href,
    src: renderCardMeta(c),
    senti: sentiBadge(c),
    q: `${titlePlain} ${bodyF} ${c.sourceName || ""}`.toLowerCase(),
  };
}

function renderVideos(videos) {
  // 메인 페이지에는 최신 영상 1개만 노출 (채널 CTA 박스로 유도).
  const items = videos.items.slice(0, 1).map((v, idx) => {
    const thumbCls = VIDEO_THUMB_CLASS[v.category] || "v-stock";
    return `      <a class="vcard" href="${escapeHtml(v.href || "#")}" aria-label="영상 ${idx + 1}">
        <div class="vthumb ${thumbCls}">
          <span class="vthumb__series">${escapeHtml(v.series)}</span>
          <span class="vthumb__num">${escapeHtml(v.thumbnailLabel)}</span>
          <span class="vthumb__dur">${escapeHtml(v.duration)}</span>
        </div>
        <div class="vbody">
          <h4>${escapeHtml(v.title)}</h4>
          <div class="vmeta"><span>${escapeHtml(v.date)}</span><span>· ${escapeHtml(v.views)}</span></div>
        </div>
      </a>`;
  }).join("\n");
  return `\n${items}\n      `;
}

async function readJson(name) {
  const p = path.join(DATA_DIR, name);
  const raw = await readFile(p, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`[build] ${name} 파싱 실패: ${e.message}`);
  }
}

// 재발행 옛 기사 등 영구 차단 — data/blocklist.json 의 substring 이 카드 어디든 포함되면 제외.
// fetch(영문)·정제(한국어) 어느 경로로 들어왔든 빌드 단계에서 최종 차단(보증).
let _blockSubs = null;
async function blockSubs() {
  if (_blockSubs) return _blockSubs;
  try { _blockSubs = (await readJson("blocklist.json")).substrings.map((s) => s.toLowerCase()); }
  catch { _blockSubs = []; }
  return _blockSubs;
}
function isBlockedCard(c, subs) {
  const hay = `${c.title || ""} ${c.slug || ""} ${c.href || ""} ${c.summary || ""} ${c.body || ""}`.toLowerCase();
  return subs.some((s) => hay.includes(s));
}
async function filterBlocked(items) {
  const subs = await blockSubs();
  if (!subs.length) return items;
  const before = items.length;
  const out = items.filter((c) => !isBlockedCard(c, subs));
  if (out.length < before) console.log(`[build] 차단 목록으로 ${before - out.length}건 제외`);
  return out;
}

// 검증 게이트(#9) 기계적 백스톱 — 진짜 원문 링크(href)가 없는 카드는 제외.
// 출처 없는 카드 = 신뢰성·추적성 위반(환각·날조 의심) → "출처 기반" 사이트 원칙에 어긋남.
function dropSourceless(items, label = "") {
  const out = items.filter((c) => /^https?:\/\//.test((c.href || "").trim()));
  const dropped = items.length - out.length;
  if (dropped) {
    console.warn(`[build] ⚠ 출처(href) 없는 카드 ${dropped}건 제외${label ? ` (${label})` : ""}`);
    for (const c of items) {
      if (!/^https?:\/\//.test((c.href || "").trim())) {
        console.warn(`        · ${(c.title || "").replace(/<\/?em>/g, "").slice(0, 50)}`);
      }
    }
  }
  return out;
}

// 빌드 시 라이브 시세 — Worker API(api.teslabriefing.com)에서 가져와 초기 렌더를 신선하게.
// (JS 안 도는 공유 봇·스크래퍼도 최신 시세를 보게 함. JS 사용자는 클라이언트 폴링이 추가 갱신.)
// 실패하면 data/kpi.json 폴백 — 네트워크 없는 환경/Worker 다운 대비. 빌드는 절대 실패하지 않음.
async function loadLivePrice() {
  try {
    const res = await fetch("https://api.teslabriefing.com/?ts=" + Date.now(), {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = await res.json();
    if (typeof d.price !== "number") throw new Error("no price field");
    console.log(`[build] 라이브 시세 사용 · $${d.price.toFixed(2)} (${d.asOf})`);
    return d;
  } catch (e) {
    console.warn(`[build] 라이브 시세 실패(${e.message}) → kpi.json 폴백`);
    return await readJson("kpi.json");
  }
}

const SOURCE_LABEL_KR = {
  sec: "1차 자료", official: "공식", press: "외신", rumor: "추측",
};
const SOURCE_LABEL_EN = {
  sec: "Primary source", official: "Official", press: "Press", rumor: "Unconfirmed",
};

/**
 * pubDate(ISO) → 실제 게재 날짜 문자열. 상세 페이지에서 "1h ago" 대신 사용.
 * 기준 시간대 Asia/Seoul. ko: "2026년 6월 1일", en: "Jun 1, 2026".
 * pubDate 없거나 파싱 실패 시 빈 문자열.
 */
function formatArticleDate(pubDate, lang = "ko") {
  const t = Date.parse(pubDate || "");
  if (!pubDate || Number.isNaN(t)) return "";
  const d = new Date(t);
  const locale = lang === "en" ? "en-US" : "ko-KR";
  const opts = {
    year: "numeric",
    month: lang === "en" ? "short" : "long",
    day: "numeric",
    timeZone: "Asia/Seoul",
  };
  return new Intl.DateTimeFormat(locale, opts).format(d);
}

/**
 * cards.items 의 카드 하나 → 상세 페이지 HTML 1개 생성.
 * article-template.html 의 BLOCK 마커를 카드 데이터로 치환.
 */
/** 같은 카테고리 최근 기사 최대 4개(자기 제외) — 기사 하단 내부 링크(체류·SEO·탐색). */
function relatedArticles(card, pool, lang = "ko") {
  if (!Array.isArray(pool) || pool.length < 2) return "";
  const rel = pool
    .filter((c) => c.slug && c.slug !== card.slug && c.category === card.category)
    .sort((a, b) => (Date.parse(b.pubDate || 0) || 0) - (Date.parse(a.pubDate || 0) || 0))
    .slice(0, 4);
  if (rel.length < 2) return "";   // 1개뿐이면 빈약 → 섹션 생략
  const heading = lang === "en" ? "Related" : "관련 기사";
  const items = rel.map((c) => {
    const t = escapeHtml(fld(c, "title", lang).replace(/<\/?em>/g, ""));
    const time = escapeHtml(formatArticleDate(c.pubDate, lang) || c.time || "");
    return `<a class="art__rel__item" href="${escapeHtml(c.slug)}.html">`
      + `<span class="art__rel__t">${t}</span>`
      + `<span class="art__rel__time">${time}</span></a>`;
  }).join("\n      ");
  return `<nav class="art__related" aria-label="${heading}">\n      <h2 class="art__related__h">${heading}</h2>\n      ${items}\n    </nav>`;
}

function renderArticle(template, card, lang = "ko", pool = []) {
  const catCls = CATEGORY_CLASS[card.category] || "is-stock";
  const srcLabel = card.sourceLabel || "press";
  const srcDot = SOURCE_LABEL_DOT[srcLabel] || "d-press";
  const srcKr = SOURCE_LABEL_KR[srcLabel] || "외신";
  const sourceName = card.sourceName || "외신";
  // 영어 빌드용 필드/라벨 (ko 면 한글 그대로)
  const titleHtml = fld(card, "title", lang);
  const bodyRaw = fld(card, "body", lang);
  const summaryRaw = fld(card, "summary", lang);
  const catLabel = lang === "en" ? (CATEGORY_LABEL_EN[card.category] || card.categoryLabel) : card.categoryLabel;
  const srcText = lang === "en" ? (SOURCE_LABEL_EN[srcLabel] || "Press") : srcKr;

  // 리드/본문 중복 제거:
  //  - 리드(art__lead)는 짧은 도입(card.body), 본문(art__summary)은 상술(card.summary).
  //  - body 가 summary 첫 단락과 거의 같으면 본문에서 그 단락을 빼 중복을 막는다.
  //  - body 가 없으면 summary 첫 단락을 리드로 승격.
  const normTxt = (s) => (s || "").replace(/<\/?em>/g, "").replace(/[\s\p{P}]+/gu, "").toLowerCase();
  let paras = (summaryRaw || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const bodyText = (bodyRaw || "").trim();
  let leadText;
  if (bodyText) {
    leadText = bodyText;
    if (paras.length) {
      const a = normTxt(bodyText), b = normTxt(paras[0]);
      const sh = a.length <= b.length ? a : b, lo = a.length <= b.length ? b : a;
      const prefixDup = sh.length >= 20 && lo.startsWith(sh);        // 한쪽이 다른쪽의 접두
      const headDup = a.length >= 24 && b.length >= 24 && a.slice(0, 24) === b.slice(0, 24); // 도입 24자 동일
      if (prefixDup || headDup) paras.shift();                       // 첫 단락이 리드와 (거의) 중복 → 제거
    }
  } else {
    leadText = paras.length ? paras.shift() : "";
  }
  // 휴리스틱을 빠져나간 리드-첫문단 중복 감시 — 어절 자카드 유사도 > 0.5 면 경고(빌드는 계속).
  if (leadText && paras[0]) {
    const words = (s) => new Set(s.replace(/<\/?em>/g, "").split(/\s+/).filter((w) => w.length > 1));
    const A = words(leadText), B = words(paras[0]);
    const inter = [...A].filter((w) => B.has(w)).length;
    const union = new Set([...A, ...B]).size || 1;
    if (inter / union > 0.5) console.warn(`[build] ⚠ 리드-본문 중복 의심(자카드 ${(inter / union).toFixed(2)}): ${card.slug || card.title}`);
  }
  const summaryHtml = paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n    ");

  const titleTxt = titleHtml.replace(/<\/?em>/g, "");
  const desc = (summaryRaw || bodyRaw || "").slice(0, 120).replace(/\n+/g, " ").trim() + "…";

  // article 은 카드 데이터에서 매번 새로 생성되므로 idempotent 필요 없음 →
  // 모든 마커를 keepMarkers: false 로 제거 (attribute 값 안에 들어가도 안전).
  const opts = { keepMarkers: false };
  let out = template;
  out = replaceBlock(out, "A_TITLE_TXT",    escapeHtml(titleTxt + " — Tesla Briefing"), opts);
  out = replaceBlock(out, "A_DESC",         escapeHtml(desc), opts);
  out = replaceBlock(out, "A_CAT_CLASS",    catCls, opts);
  out = replaceBlock(out, "A_CAT_LABEL",    escapeHtml(catLabel), opts);
  out = replaceBlock(out, "A_TITLE",        titleHtml, opts);  // <em> 살림
  out = replaceBlock(out, "A_TIME",         escapeHtml(formatArticleDate(card.pubDate, lang) || card.time || ""), opts);
  out = replaceBlock(out, "A_SRC_DOT",      srcDot, opts);
  out = replaceBlock(out, "A_SRC_DOT2",     srcDot, opts);
  out = replaceBlock(out, "A_SRC_NAME",     escapeHtml(sourceName), opts);
  out = replaceBlock(out, "A_SRC_NAME2",    escapeHtml(sourceName), opts);
  out = replaceBlock(out, "A_SRC_LABEL_KR", escapeHtml(srcText), opts);
  out = replaceBlock(out, "A_LEAD",         escapeHtml(leadText), opts);
  out = replaceBlock(out, "A_SUMMARY",      summaryHtml, opts);
  out = replaceBlock(out, "A_HREF",         escapeHtml(card.href || "#"), opts);
  out = replaceBlock(out, "A_CANON",        escapeHtml(card.slug || ""), opts);   // canonical·og:url 슬러그
  out = replaceBlock(out, "A_JSONLD",       articleJsonLd(card, lang), opts);       // NewsArticle 구조화 데이터
  // 교차검증(#1): N개 매체 확인 신호 + 확인 매체 목록
  const confirmedTxt = (typeof card.confirmedBy === "number" && card.confirmedBy >= 2)
    ? ` <span aria-hidden="true">·</span> <span class="art__confirmed">✓ ${lang === "en" ? `Confirmed by ${card.confirmedBy} outlets` : `${card.confirmedBy}개 매체 교차확인`}</span>`
    : "";
  out = replaceBlock(out, "A_CONFIRMED", confirmedTxt, opts);
  const csrc = Array.isArray(card.confirmingSources) && card.confirmingSources.length
    ? `<div class="art__source__also">${lang === "en" ? "Confirmed by" : "교차확인"} · ${card.confirmingSources.map(escapeHtml).join(" · ")}</div>`
    : "";
  out = replaceBlock(out, "A_CONFIRM_SRCS", csrc, opts);
  const senti = sentiBadge(card);
  out = replaceBlock(out, "A_SENTI", senti ? ` <span aria-hidden="true">·</span> ${senti}` : "", opts);
  out = replaceBlock(out, "A_RELATED", relatedArticles(card, pool, lang), opts);  // 관련 기사(같은 카테고리)
  out = replaceBlock(out, "A_OG_IMG", escapeHtml(ogImageUrl(card)), opts);        // 기사별 OG (og:image + twitter:image)
  return out;
}

/** {outDir}/news.html — 모든 카드 최신순 그리드. lang 으로 한국어/영어 라벨 분기. */
async function generateNewsPage(cards, { newsTemplateName = "news-template.html", outDir = OUT_DIR, lang = "ko", fullArchive = null } = {}) {
  const tplPath = path.join(ROOT, newsTemplateName);
  let template;
  try {
    template = await readFile(tplPath, "utf8");
  } catch {
    console.warn(`[build] ${newsTemplateName} 없음 — news.html 생성 건너뜀`);
    return false;
  }
  // 총건수 라벨 — 표시(롤링 100)가 아니라 검색 가능한 전체 이력 기준.
  const totalCount = (fullArchive && fullArchive.items?.length) ? fullArchive.items.length : cards.items.length;
  const totalLabel = lang === "en" ? `total ${totalCount} items` : `총 ${totalCount}건`;
  const freshLabel = lang === "en" ? "calculating freshness…" : "갱신 시각 계산 중…";
  // 영어 빌드 시 cards.asOf 의 한국어 텍스트 영문화 (raw 폴백 호환)
  const hasKorean = /[가-힯]/.test(cards.asOf || "");
  const localizedAsOf = (lang === "en" && hasKorean)
    ? `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · sorted by latest`
    : cards.asOf;
  let out = template;
  const freshSince = cards.items[0]?.pubDate || "";
  // 사용자용 부제목 — archive.json 내부 asOf 잡텍스트("최신 100건 (slug dedup…)") 노출 금지.
  const sortLabel = lang === "en" ? "latest first" : "최신순";
  const newsAsOf = freshSince
    ? `${escapeHtml(`${totalLabel} · ${sortLabel}`)} · <span class="cats__fresh" data-fresh-since="${escapeHtml(freshSince)}">${escapeHtml(fmtFreshLabel(freshSince) || freshLabel)}</span>`
    : escapeHtml(`${totalLabel} · ${sortLabel}`);
  out = replaceBlock(out, "NEWS_TIME", newsAsOf);
  // SSR 은 1페이지(10건)만 — 나머지는 클라이언트가 news-index.json 으로 페이지네이션.
  const seed = { items: cards.items.slice(0, 10) };
  out = replaceBlock(out, "NEWS_GRID", `\n      ${renderAllCards(seed, { lang })}\n      `);
  await writeFile(path.join(outDir, "news.html"), out, "utf8");

  // 클라이언트 필터/검색용 인덱스 — 최신(archive)이 항상 포함되도록 archive ∪ archive-full 합집합.
  //  archive-full 은 별도 GitHub Action 이 다른 주기로 갱신 → 최신 카드가 잠시 빠질 수 있다.
  //  신선한 archive(cards 인자) 를 먼저 넣어 우선시하고, archive-full 로 과거 이력을 보충한다.
  const idxMap = new Map();
  for (const c of cards.items) { const k = c.slug || c.title; if (k && !idxMap.has(k)) idxMap.set(k, c); }
  for (const c of (fullArchive?.items || [])) { const k = c.slug || c.title; if (k && !idxMap.has(k)) idxMap.set(k, c); }
  const idxItems = [...idxMap.values()].sort(
    (a, b) => (Date.parse(b.pubDate || 0) || 0) - (Date.parse(a.pubDate || 0) || 0)
  );
  const idx = idxItems.map((c) => newsIndexEntry(c, lang));
  await mkdir(path.join(outDir, "data"), { recursive: true });
  await writeFile(path.join(outDir, "data", "news-index.json"), JSON.stringify(idx), "utf8");
  return true;
}

async function generateArticles(cards, { outDir = OUT_DIR, lang = "ko" } = {}) {
  const tplPath = path.join(ROOT, "article-template.html");
  let template;
  try {
    template = await readFile(tplPath, "utf8");
  } catch (e) {
    console.warn(`[build] article-template.html 없음 — 상세 페이지 생성 건너뜀`);
    return 0;
  }
  const articlesDir = path.join(outDir, "articles");
  // 매 빌드마다 청소 — 아카이브에서 밀려난 옛 슬러그 기사(잔재)가 남지 않게.
  // (Cloudflare 는 매 배포가 fresh 라 무관하지만, 로컬-프로덕션 일치 + 위생)
  await rm(articlesDir, { recursive: true, force: true });
  await mkdir(articlesDir, { recursive: true });
  let generated = 0;
  for (const card of cards.items) {
    if (!card.slug) continue;
    const html = renderArticle(template, card, lang, cards.items);
    await writeFile(path.join(articlesDir, `${card.slug}.html`), html, "utf8");
    generated++;
  }
  return generated;
}

/**
 * 한 언어 빌드. 한국어/영어 각각 호출.
 * @param {Object} opts
 * @param {string} opts.templateName - "home.html" or "home-en.html"
 * @param {string} opts.cardsName    - "cards.json" or "cards-en.json"
 * @param {string} opts.archiveName  - "archive.json" or "archive-en.json"
 * @param {string} opts.newsTemplateName - "news-template.html" or "news-template-en.html"
 * @param {string} opts.outDir
 * @param {string} opts.lang         - "ko" or "en"
 * @param {string} opts.cardsFallback - 폴백 데이터 파일명 (영어가 cards-en.json 없을 때)
 */
async function buildOneLang(opts) {
  const { templateName, cardsName, archiveName, newsTemplateName, outDir, lang, cardsFallback } = opts;
  const templatePath = path.join(ROOT, templateName);

  // 데이터 읽기. cards-en.json 없으면 폴백 (raw-cards.json).
  const template = await readFile(templatePath, "utf8");
  const kpi = await loadLivePrice();
  const videos = await readJson("videos.json");
  let cards;
  try {
    cards = await readJson(cardsName);
  } catch {
    if (!cardsFallback) throw new Error(`${cardsName} not found`);
    cards = await readJson(cardsFallback);
    console.log(`[build:${lang}] ${cardsName} 없음 → ${cardsFallback} 폴백`);
  }
  let archive;
  try {
    archive = await readJson(archiveName);
    if (Array.isArray(archive)) archive = { items: archive, asOf: cards.asOf };  // bare 배열 방어(Routine 구조 슬립)
    if (!archive.items || archive.items.length === 0) {
      archive = { ...cards, asOf: cards.asOf };
    }
  } catch {
    archive = { ...cards, asOf: cards.asOf };
  }

  // 차단 목록 필터 — 재발행 옛 기사 등이 데이터에 남아 있어도 사이트엔 절대 노출 안 되게(최종 보증).
  cards.items = dropSourceless(await filterBlocked(cards.items), "cards");
  archive.items = dropSourceless(await filterBlocked(archive.items), "archive");

  const now = new Date();
  const buildIso = now.toISOString();

  // 타임스탬프 위생 — ① 미래 pubDate(애그리게이터 재발행 시각 등) 는 빌드 시각으로 클램프
  //                  ② "최신순" 보증: 데이터가 어떤 순서로 와도 pubDate desc 강제 정렬
  const clampFuture = (items, label) => {
    const limit = now.getTime() + 10 * 60 * 1000;   // +10분 허용(시계 오차)
    for (const c of items) {
      const t = Date.parse(c.pubDate || "");
      if (!Number.isNaN(t) && t > limit) {
        console.warn(`[build] ⚠ 미래 pubDate 클램프(${label}): ${c.slug || c.title} ${c.pubDate} → ${buildIso}`);
        c.pubDate = buildIso;
      }
    }
  };
  const sortDesc = (items) => items.sort((a, b) => (Date.parse(b.pubDate || 0) || 0) - (Date.parse(a.pubDate || 0) || 0));
  clampFuture(cards.items, "cards");
  clampFuture(archive.items, "archive");
  sortDesc(archive.items);   // 최신 뉴스·news.html 은 시간순이 계약
  // cards(핫뉴스 소스)는 hot 점수 정렬이 따로 있으므로 카드 그리드용만 시간 검증
  const cardsSorted = [...cards.items].map((c) => Date.parse(c.pubDate || 0) || 0);
  if (cardsSorted.some((t, i) => i > 0 && t > cardsSorted[i - 1])) {
    console.warn("[build] ⚠ cards.json 이 최신순이 아님 — 카드 그리드 표시용으로 정렬 보정");
    sortDesc(cards.items);
  }

  // 라벨 lang 분기
  const hotCountLabel = lang === "en"
    ? `${Math.min(5, cards.items.length)} items`
    : `총 ${Math.min(5, cards.items.length)}건`;
  const freshLabel = lang === "en" ? "calculating freshness…" : "갱신 시각 계산 중…";

  // 영어 빌드에서 cards.asOf 에 한글이 섞여 있으면 (raw 폴백 등) 영문으로 재생성.
  // raw-cards.json 의 asOf 는 한국어("...UTC 기준 · 카테고리당 top 5건") 이라 영어 사이트에 어색.
  const hasKorean = /[가-힯]/.test(cards.asOf || "");
  const localizedCardsAsOf = (lang === "en" && hasKorean)
    ? `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · sorted by latest`
    : cards.asOf;

  // 투자자 캘린더 데이터 (없거나 깨져도 무시 — 줄 미표시)
  let calendar = { events: [] };
  try { calendar = JSON.parse(await readFile(path.join(DATA_DIR, "calendar.json"), "utf8")); }
  catch { calendar = { events: [] }; }

  let out = template;
  out = replaceBlock(out, "KPI_GRID",    renderKpi(kpi));
  out = replaceBlock(out, "HOT_NEWS",    renderHotNews(cards, lang));
  out = replaceBlock(out, "INVESTOR_CAL", renderInvestorCalendar(calendar, lang, now));
  out = replaceBlock(out, "HOT_COUNT",   hotCountLabel);
  const cardsFreshSince = cards.items[0]?.pubDate || "";
  const cardsAsOf = cardsFreshSince
    ? `${escapeHtml(localizedCardsAsOf)} · <span class="cats__fresh" data-fresh-since="${escapeHtml(cardsFreshSince)}">${escapeHtml(fmtFreshLabel(cardsFreshSince) || freshLabel)}</span>`
    : escapeHtml(localizedCardsAsOf);
  out = replaceBlock(out, "CARDS_TIME",  cardsAsOf);
  out = replaceBlock(out, "CARDS_GRID",  renderCards(cards, { lang }));
  out = replaceBlock(out, "VIDEOS_GRID", renderVideos(videos));
  out = replaceBlock(out, "BUILD_INFO",  `<!-- build: ${buildIso} -->`);

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "index.html"), out, "utf8");

  // 장기 아카이브(Phase B) — 필터/검색 인덱스 + 전체 기사 페이지 생성 소스.
  let fullArchive = { items: [] };
  try { fullArchive = await readJson("archive-full.json"); } catch { /* 없으면 archive 로 폴백 */ }
  if (Array.isArray(fullArchive)) fullArchive = { items: fullArchive };   // bare 배열 방어
  if (!Array.isArray(fullArchive.items)) fullArchive.items = [];
  fullArchive.items = dropSourceless(await filterBlocked(fullArchive.items), "archive-full");

  // 상세 페이지는 cards + archive + 장기아카이브 합집합(slug dedup)으로 생성.
  // 100개 cap 에서 밀려난 카드도, 검색 결과에서 클릭 시 404 가 안 나도록 기사 파일을 갖게 한다.
  const articleSeen = new Set();
  const articleItems = [];
  for (const card of [...cards.items, ...archive.items, ...fullArchive.items]) {
    if (!card.slug || articleSeen.has(card.slug)) continue;
    articleSeen.add(card.slug);
    articleItems.push(card);
  }
  const numArticles = await generateArticles({ items: articleItems }, { outDir, lang });
  await generateNewsPage(archive, { newsTemplateName, outDir, lang, fullArchive });

  return { numCards: cards.items.length, numArchive: archive.items.length, numArticles, bytes: out.length, articles: articleItems };
}

// ─────────────────────────────────────────────────────────────
// SEO: 구조화 데이터(JSON-LD) · sitemap.xml · robots.txt · rss.xml
// ─────────────────────────────────────────────────────────────
// 기사별 OG 이미지 — scripts/make_og_articles.py 가 생성한 assets/og/{slug}.png.
// 생성 실패·미존재 시 브랜드 공용 이미지 폴백 (공유 미리보기 404 방지).
let OG_SLUGS = new Set();
function ogImageUrl(card) {
  return card.slug && OG_SLUGS.has(card.slug)
    ? `${SITE}/assets/og/${card.slug}.png`
    : `${SITE}/assets/og-image.png`;
}
/** 기사 OG PNG 생성 (Python PIL). CI 에 Pillow 없으면 설치 시도, 그래도 실패면 건너뜀(논페이탈). */
function generateOgImages() {
  const run = () => execSync("python3 scripts/make_og_articles.py", { cwd: ROOT, stdio: "inherit", timeout: 180000 });
  try { run(); } catch {
    try {
      console.warn("[build] Pillow 미설치 추정 — pip install 후 재시도");
      execSync("python3 -m pip install --quiet Pillow", { cwd: ROOT, stdio: "inherit", timeout: 240000 });
      run();
    } catch (e) { console.warn(`[build] ⚠ 기사 OG 생성 건너뜀(브랜드 이미지 폴백): ${e.message.split("\n")[0]}`); }
  }
  try {
    OG_SLUGS = new Set(readdirSync(path.join(ASSETS_DIR, "og")).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4)));
  } catch { OG_SLUGS = new Set(); }
  console.log(`[build] 기사 OG 이미지 ${OG_SLUGS.size}건 사용 가능`);
}

function articleJsonLd(card, lang = "ko") {
  const headline = fld(card, "title", lang).replace(/<\/?em>/g, "").trim();
  const base = lang === "en" ? `${SITE}/en` : SITE;
  const url = `${base}/articles/${card.slug}`;
  const desc = (fld(card, "summary", lang) || fld(card, "body", lang) || "")
    .replace(/<\/?em>/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  const obj = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline,
    description: desc,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    image: [ogImageUrl(card)],
    inLanguage: lang === "en" ? "en" : "ko",
    author: { "@type": "Organization", name: "Tesla Brief!ng", url: `${SITE}/` },
    publisher: {
      "@type": "Organization",
      name: "Tesla Brief!ng",
      logo: { "@type": "ImageObject", url: `${SITE}/assets/og-image.png` },
    },
  };
  if (card.pubDate) { obj.datePublished = card.pubDate; obj.dateModified = card.pubDate; }
  return JSON.stringify(obj);
}

function buildSitemap(entries) {
  const body = entries.map((e) => {
    const t = [`    <loc>${escapeHtml(e.loc)}</loc>`];
    if (e.lastmod)    t.push(`    <lastmod>${e.lastmod}</lastmod>`);
    if (e.changefreq) t.push(`    <changefreq>${e.changefreq}</changefreq>`);
    if (e.priority)   t.push(`    <priority>${e.priority}</priority>`);
    return `  <url>\n${t.join("\n")}\n  </url>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function buildRobots() {
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`;
}

function buildRss(items) {
  const now = new Date().toUTCString();
  const entries = items.slice(0, 30).map((c) => {
    const title = escapeHtml((c.title || "").replace(/<\/?em>/g, "").trim());
    const link = `${SITE}/articles/${c.slug}`;
    const desc = escapeHtml((c.body || c.summary || "")
      .replace(/<\/?em>/g, "").replace(/\s+/g, " ").trim().slice(0, 280));
    const pub = c.pubDate ? new Date(c.pubDate).toUTCString() : now;
    const cat = escapeHtml(c.categoryLabel || c.category || "");
    return `    <item>\n      <title>${title}</title>\n      <link>${link}</link>\n` +
           `      <guid isPermaLink="true">${link}</guid>\n      <pubDate>${pub}</pubDate>\n` +
           `      <category>${cat}</category>\n      <description>${desc}</description>\n    </item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n` +
         `    <title>Tesla Brief!ng — 테슬라 브리핑</title>\n    <link>${SITE}/</link>\n` +
         `    <description>테슬라 주주를 위한, 노이즈 없는 일일 브리핑</description>\n` +
         `    <language>ko</language>\n    <lastBuildDate>${now}</lastBuildDate>\n${entries}\n  </channel>\n</rss>\n`;
}

async function main() {
  generateOgImages();   // 기사별 OG PNG (renderArticle 이 OG_SLUGS 를 참조하므로 빌드 전에)

  // ─── Korean (메인) ─────────────────────────────────────────
  const ko = await buildOneLang({
    templateName: "home.html",
    cardsName: "cards.json",
    archiveName: "archive.json",
    newsTemplateName: "news-template.html",
    outDir: OUT_DIR,
    lang: "ko",
  });

  // 정적 자원/페이지/JSON 데이터 — 한 번만 복사 (한·영 공유)
  await cp(ASSETS_DIR, OUT_ASSETS, { recursive: true });
  for (const name of ["article-sample.html", "privacy.html", "about.html"]) {
    try { await cp(path.join(ROOT, name), path.join(OUT_DIR, name)); }
    catch (e) { console.warn(`[build] skip ${name}: ${e.message}`); }
  }
  await mkdir(path.join(OUT_DIR, "data"), { recursive: true });
  for (const name of ["kpi.json", "musk-live.json"]) {
    try { await cp(path.join(DATA_DIR, name), path.join(OUT_DIR, "data", name)); }
    catch (e) { console.warn(`[build] skip data/${name}: ${e.message}`); }
  }

  // ── SEO: sitemap.xml · robots.txt · rss.xml (clean URL 기준) ──
  const todayDate = new Date().toISOString().slice(0, 10);
  const staticPages = [
    { loc: `${SITE}/`,        lastmod: todayDate, changefreq: "hourly",  priority: "1.0" },
    { loc: `${SITE}/news`,    lastmod: todayDate, changefreq: "hourly",  priority: "0.8" },
    { loc: `${SITE}/about`,                       changefreq: "monthly", priority: "0.5" },
    { loc: `${SITE}/privacy`,                     changefreq: "yearly",  priority: "0.3" },
  ];
  const arts = (ko.articles || []).filter((c) => c.slug);
  const artEntries = arts.map((c) => ({
    loc: `${SITE}/articles/${c.slug}`,
    lastmod: c.pubDate ? c.pubDate.slice(0, 10) : todayDate,
    changefreq: "weekly",
    priority: "0.6",
  }));
  await writeFile(path.join(OUT_DIR, "sitemap.xml"), buildSitemap([...staticPages, ...artEntries]), "utf8");
  await writeFile(path.join(OUT_DIR, "robots.txt"), buildRobots(), "utf8");
  const rssSorted = [...arts].sort((a, b) => (Date.parse(b.pubDate || 0) || 0) - (Date.parse(a.pubDate || 0) || 0));
  await writeFile(path.join(OUT_DIR, "rss.xml"), buildRss(rssSorted), "utf8");
  console.log(`[build] SEO · sitemap ${staticPages.length + artEntries.length} urls · robots · rss ${Math.min(30, rssSorted.length)}`);

  // 출력 요약 (한국어 단일 언어)
  const kpiData = await readJson("kpi.json");
  const priceStr = typeof kpiData.price === "number"
    ? `$${kpiData.price.toFixed(2)} (${kpiData.marketStateLabel || kpiData.marketState || "?"})`
    : "(no price)";
  console.log(`[build] OK · price ${priceStr}`);
  console.log(`[build] KO: ${ko.numCards} cards · ${ko.numArchive} archive · ${ko.numArticles} articles · ${ko.bytes} bytes`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
