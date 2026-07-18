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
// 카드·기사 카테고리 칩 라벨 — 짧은 영어(KO·EN 공통, JP 요청 2026-06-12). 칩이라 1단어.
const CARD_CHIP = { stock: "Stock", product: "Product", fsd: "FSD/Robotaxi", musk: "Elon" };
const chipLabel = (cat) => CARD_CHIP[cat] || "News";

// 4단계 출처 표시 순서: 1차(green) → 공식(blue) → 외신(orange) → 추측(grey)
const SOURCE_ORDER = [
  { key: "sec",      dot: "d-sec",    label: "1차",  labelEn: "Primary"  },
  { key: "official", dot: "d-off",    label: "공식", labelEn: "Official" },
  { key: "press",    dot: "d-press",  label: "외신", labelEn: "Press"    },
  { key: "rumor",    dot: "d-rumor",  label: "추측", labelEn: "Rumor"    },
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

// em 태그를 살려야 하는 필드용 안전 렌더 — 전체 escape 후 <em>…</em> 경계만 복원.
// 그 외 태그·속성(<em onclick> 등)은 정확히 일치하지 않아 escape 유지 → XSS 안전.
function emSafeHtml(s) {
  return escapeHtml(s || "")
    .replace(/&lt;em&gt;/g, "<em>")
    .replace(/&lt;\/em&gt;/g, "</em>");
}

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
function fmtFreshLabel(pubDate, lang) {
  const t = Date.parse(pubDate);
  if (Number.isNaN(t)) return "";
  const en = lang === "en";
  const min = Math.max(1, Math.round((Date.now() - t) / 60000));
  if (min < 60) return en ? `updated ${min}m ago` : `최신 콘텐츠 ${min}분 전`;
  const hr = Math.round(min / 60);
  if (hr < 24) return en ? `updated ${hr}h ago` : `최신 콘텐츠 ${hr}시간 전`;
  const d = Math.round(hr / 24);
  return en ? `updated ${d}d ago` : `최신 콘텐츠 ${d}일 전`;
}

function renderKpi(kpi, lang) {
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
  const EN_STATE = { reg: "Market open", pre: "Pre-market", post: "After hours", closed: "Market closed" };
  const stateLabel = (lang === "en" ? EN_STATE[stateShort] : null) || kpi.marketStateLabel || kpi.marketState || "—";
  // 초기 등락률(빌드 시점) — 라이브 fetch 실패해도 가격-방향 핫뉴스 모순 숨김에 사용.
  const changeInit = typeof kpi.changePct === "number" ? ` data-change-init="${kpi.changePct}"` : "";
  // 레인지 바 초기 위치(빌드 시점) — 클라이언트 1분 폴링이 갱신. 저가=고가(개장 직후 등)면 숨김 유지.
  let barHtml = `<span class="pb-bar" data-pb-bar hidden aria-hidden="true"><i data-pb-bar-prev></i><b data-pb-bar-cur></b></span>`;
  if (typeof kpi.dayLow === "number" && typeof kpi.dayHigh === "number" && kpi.dayHigh > kpi.dayLow && typeof kpi.price === "number") {
    const pct = (v) => Math.max(0, Math.min(100, ((v - kpi.dayLow) / (kpi.dayHigh - kpi.dayLow)) * 100)).toFixed(1);
    const prevIn = typeof kpi.prevClose === "number" && kpi.prevClose >= kpi.dayLow && kpi.prevClose <= kpi.dayHigh;
    barHtml = `<span class="pb-bar" data-pb-bar aria-hidden="true" style="--cur:${pct(kpi.price)}%;--prev:${prevIn ? pct(kpi.prevClose) + "%" : "-999%"}"><i data-pb-bar-prev></i><b data-pb-bar-cur></b></span>`;
  }
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
          ${barHtml}
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
function renderSources(sources, lang = "ko") {
  const parts = SOURCE_ORDER
    .map(({ key, dot, label, labelEn }) => {
      const n = sources[key] || 0;
      if (n <= 0) return null;
      return `<span><i class="d ${dot}"></i> ${(lang === "en" ? labelEn : label)} ${n}</span>`;
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
  sec:      { kr: "1차 자료", en: "Primary",  bg: "#16A34A" },   // 초록 — 출처 팔레트(카테고리와 비충돌)
  official: { kr: "공식",     en: "Official", bg: "#8B5CF6" },   // 보라
};
function tierBadge(label, lang = "ko") {
  const b = TIER_BADGE[label];
  if (!b) return "";
  return `<span style="display:inline-block;background:${b.bg};color:#fff;`
    + `font-size:10px;font-weight:700;letter-spacing:.02em;padding:1px 6px;`
    + `border-radius:4px;margin-right:6px;vertical-align:middle">${lang === "en" ? b.en : b.kr}</span>`;
}

// 교차검증 신호(#1): 같은 사건을 N개 매체가 보도 → 신뢰 신호(outlined 배지, CSS 변수로 테마 대응).
function confirmedBadge(c, lang = "ko") {
  const n = typeof c.confirmedBy === "number" ? c.confirmedBy : 0;
  if (n < 2) return "";
  const title = lang === "en" ? `${n} outlets reported the same (cross-checked)` : `${n}개 매체가 같은 내용을 보도(교차확인)`;
  const text = lang === "en" ? `✓ ${n} outlets` : `✓ ${n}개 매체`;
  return `<span title="${title}" style="display:inline-block;`
    + `border:1px solid var(--line);color:var(--ink-mute);font-size:10px;font-weight:600;`
    + `letter-spacing:.02em;padding:0 6px;border-radius:4px;margin-right:6px;vertical-align:middle">`
    + `${text}</span>`;
}

// 강세/약세 태그(#2) — sentiment(bull/bear)만 표시(중립·미지정은 생략해 클러터 방지). 색: 상승 초록 / 하락 빨강.
const SENTI_TIP = "원문 기사 논조 기반 자동 분류입니다 — 편집부 투자 의견이 아닙니다";
const SENTI_TIP_EN = "Auto-classified from the source article's tone — not editorial investment advice";
function sentiBadge(c, lang = "ko") {
  const tip = lang === "en" ? SENTI_TIP_EN : SENTI_TIP;
  const bull = lang === "en" ? "▲ Bullish" : "▲ 강세";
  const bear = lang === "en" ? "▼ Bearish" : "▼ 약세";
  if (c.sentiment === "bull") return `<span class="senti senti--bull" title="${tip}">${bull}</span>`;
  if (c.sentiment === "bear") return `<span class="senti senti--bear" title="${tip}">${bear}</span>`;
  return "";
}

/** 카드 메타: 신 스키마(sourceName) 우선, 없으면 옛 sources 카운트 폴백. */
function renderCardMeta(c, lang = "ko") {
  if (c.sourceName) {
    const dot = SOURCE_LABEL_DOT[c.sourceLabel || "press"] || "d-press";
    const badge = tierBadge(c.sourceLabel, lang);
    return `${badge}${confirmedBadge(c, lang)}<span class="src-name"><i class="d ${dot}"></i>${escapeHtml(c.sourceName)}</span>`;
  }
  if (c.sources) return renderSources(c.sources, lang);
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
        foot: `✓ = officially confirmed by Tesla. Others are estimates from historical patterns — see <a href="https://ir.tesla.com" target="_blank" rel="noopener">ir.tesla.com</a>.` }
    : { lead: "다음 일정", head: "투자자 캘린더 · 향후 일정", tent: "잠정", today: "오늘",
        foot: `✓ = 테슬라 공식 확정. 그 외는 공식 발표 전 과거 패턴 기반 <b>잠정</b>치 — <a href="https://ir.tesla.com" target="_blank" rel="noopener">ir.tesla.com</a> 참조.` };
  const ddayTxt = dday === 0 ? L.today : `D-${dday}`;
  // 메인 노출 제목에서 연도(20xx) 제거 — 데이터엔 연도 유지, 화면만 간결화. en 은 title_en 우선.
  const stripYear = (t) => (t || "").replace(/\s*\b20\d{2}\b\s*/, " ").replace(/\s+/g, " ").trim();
  const evTitle = (e) => stripYear(lang === "en" ? (e.title_en || e.title) : e.title);
  // 토스형 카드 행 — 날짜(요일) | 이벤트명 | D-day 배지(최근접만 강조)
  const todayMs = Date.parse(now.toISOString().slice(0, 10) + "T00:00:00Z");
  const wdOf = (iso) => { const [y, m, d] = iso.split("-").map(Number); return WEEKDAY_EN[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
  const mdOf = (iso) => {
    const [, m, d] = iso.split("-").map(Number);
    if (lang === "en") { const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return `${MON[m - 1]} ${d}`; }
    return `${m}/${d}`;
  };
  const rows = upcoming.map((e) => {
    const dd = Math.max(0, Math.round((Date.parse(e.date + "T00:00:00Z") - todayMs) / 86400000));
    const txt = dd === 0 ? L.today : `D-${dd}`;
    const hot = e === next ? " dd--hot" : "";
    // 공식 확정(tentative:false) 일정엔 ✓ — 잠정치와 시각적으로 구분(footer 에 범례).
    const cfm = e.tentative === false ? ` <i class="cfm" title="${lang === "en" ? "Officially confirmed" : "공식 확정"}">✓</i>` : "";
    return `<div class="r"><span class="cd">${escapeHtml(mdOf(e.date))} <small>${escapeHtml(wdOf(e.date))}</small></span>`
      + `<span class="ttl">${escapeHtml(evTitle(e))}${cfm}</span><span class="dd${hot}">${txt}</span></div>`;
  }).join("\n      ");
  // Event 구조화 데이터 — 검색엔진이 투자자 일정을 이벤트로 인식 (잠정 일정은 description에 명시)
  const eventsLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: upcoming.map((e, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Event",
        name: `Tesla ${((lang === "en" ? (e.title_en || e.title) : e.title) || "").replace(/\s+/g, " ").trim()}`,
        startDate: e.date,
        eventStatus: "https://schema.org/EventScheduled",
        eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
        location: { "@type": "VirtualLocation", url: "https://ir.tesla.com" },
        description: e.tentative
          ? (lang === "en" ? "Estimated from historical pattern — pending official confirmation" : "과거 패턴 기반 잠정 일정 — 공식 확정 전")
          : (lang === "en" ? "Officially confirmed" : "공식 확정 일정"),
        organizer: { "@type": "Organization", name: "Tesla, Inc.", url: "https://ir.tesla.com" },
      },
    })),
  });
  return `<script type="application/ld+json">${eventsLd}</script>
    <div class="calcard">
      ${rows}
    </div>
    <p class="calnote">${L.foot}</p>`;
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
  // 월누적/이달 하락% 프레임("이달 -14% 마감")은 당일 하락 동사가 없어도 하락 방향으로 — 급등일엔 시세모순 숨김 대상.
  if (/(?:이달|누적|월간|연간|올해|year-to-date|ytd|this month)[^.。]{0,12}-\s?\d/i.test(txt)) return "down";
  const up = PRICE_UP_CTX_RE.test(txt), down = PRICE_DOWN_CTX_RE.test(txt);
  if (up === down) return null;                          // 둘 다(급락 딛고 반등 등)거나 둘 다 아님 → 모호, 태그 안 함
  return up ? "up" : "down";
}
const STALE_PRICE_HOURS = 24;

// 카드 텍스트 필드 선택 — 영어 빌드(lang="en")면 `<base>_en` 사용(없으면 한글 폴백). ko 면 항상 한글.
function fld(c, base, lang) { return (lang === "en" ? (c[base + "_en"] || c[base]) : c[base]) || ""; }

// 핫뉴스 동일사건 dedup — 제목 핵심 토큰이 3개+ 겹치면 같은 사건으로 보고 1건만 노출.
//   LLM 클러스터링이 놓치거나(다른 slug·날짜) 수동 카드가 겹쳐도, 핫뉴스엔 같은 사건이 2개 안 뜨게 하는 최종 안전망.
const HOT_STOP = new Set(["테슬라","tesla","tesla's","fsd","시작","공식","발표","및","속","의","를","이","가","에","로","the","a","an","to","of","on","in","for","begins","starts","new"]);
const titleKeyToks = (s) => new Set(((s || "").replace(/<[^>]+>/g, "").toLowerCase().match(/[가-힣a-z0-9.]{2,}/g) || []).filter((t) => !HOT_STOP.has(t)));
const sameStory = (a, b) => { let n = 0; a.forEach((t) => { if (b.has(t)) n++; }); return n >= 3; };

// 헤드라인이 TSLA/주가를 주체로 명확한 방향(급등·급락·±N%·이달 -N%)을 말하는지 — 라이브 주가와 모순되는 핫뉴스 제외용.
//   주체를 'TSLA/주가/종가/시총'으로 한정해 '버라이즌 급락'·'테슬라 판매 부진' 같은 타사·비주가 뉴스는 건드리지 않는다.
const HL_SUBJ = "(?:TSLA|주가|종가|시총|시가총액)";
const HL_DOWN_RE = new RegExp(HL_SUBJ + "[^.。]{0,15}(?:급락|폭락|하락|약세|추락|-\\s?\\d+(?:\\.\\d+)?%)|(?:이달|누적|월간|연간|올해)[^.。]{0,10}-\\s?\\d", "i");
const HL_UP_RE = new RegExp(HL_SUBJ + "[^.。]{0,15}(?:급등|폭등|반등|상승|강세|치솟|\\+\\s?\\d+(?:\\.\\d+)?%)", "i");
const headlineDir = (c) => {
  const t = ((c.title || "") + " " + (c.hotShort || "")).replace(/<[^>]+>/g, "").replace(/(\d)\.(\d)/g, "$1$2");
  const down = HL_DOWN_RE.test(t), up = HL_UP_RE.test(t);
  return up === down ? null : (up ? "up" : "down");
};

function renderHotNews(cards, lang = "ko", livePriceDir = null) {
  const hotOf = (c) => (typeof c.hot === "number" ? c.hot : 5);
  const byHot = (a, b) => (hotOf(b) - hotOf(a)) || (Date.parse(b.pubDate || 0) - Date.parse(a.pubDate || 0));
  // 핫뉴스 신선도 윈도우 — 발행 후 24시간 이내(경과시간 기준)만. (JP 요청 2026-07-11 — 이전의
  //   "당일+전일 KST 달력일"(최대 48h) + 3일 폴백을 대체. 어떤 경우에도 24h 초과 카드는 노출 안 함
  //   (2026-07-05: 폴백이 9일 전 카드를 끌어온 사고 이후, 아예 "초과 시 폴백 없음"으로 강화).
  const nowMs = Date.now();
  const freshCutoff = nowMs - 24 * 3600000;
  const inWindow = (c) => (Date.parse(c.pubDate || 0) || 0) >= freshCutoff;
  // 가격-방향 카드는 추가로 STALE_PRICE_HOURS 가드(기존).
  const baseEligible = cards.items.filter((c) => {
    // 핫뉴스 헤드라인은 종가만 — 장중·실시간·잠정 가격을 제목에 단정한 카드는 핫뉴스 제외.
    //   (본문 맥락 설명은 허용 — 제목만 검사. 장중 고점을 "급등" 헤드라인으로 쓰면 종가 소폭 상승일 때 오도.)
    if (/장중|장 중|장초반|장중반|장후반|intraday|pre-?market|after-?hours/i.test((c.title || "") + " " + (c.title_en || ""))) return false;
    // 라이브 주가와 명백히 반대 방향인 헤드라인 카드 제외 — 급등일의 '급락/이달 -N%' 프레임 등(주주 혼란 방지).
    if (livePriceDir) { const hd = headlineDir(c); if (hd && hd !== livePriceDir) return false; }
    if (!priceDirection(c)) return true;
    return (nowMs - Date.parse(c.pubDate || 0)) / 3600000 <= STALE_PRICE_HOURS;
  });
  // 24h 이내 후보만 — 이 경계를 넘어 옛 카드를 끌어오는 폴백은 없다(가짜 신선도보다 적은 건수가 낫다).
  //   대신 이 24h 풀 안에서는 아래 카테고리/부정론 다양성 캡을 spill 로 자동 완화해 최대한(최소 3건 목표) 채운다.
  const eligible = baseEligible.filter(inWindow);
  const ranked = [...eligible].sort(byHot);

  // 톤 균형(주주·팬 배려) — 핫뉴스가 부정 일색이 되지 않게 부정(sentiment="bear") 카드를 최대 MAX_NEG 개로 제한.
  //   중요한 악재는 숨기지 않되, 비부정(강세·중립)이 있으면 우선 채워 균형을 맞춘다.
  //   sentiment 미지정 카드는 중립 취급(영향 없음) → 필드 채워지기 전엔 기존 동작.
  // 카테고리 다양성 — 한 카테고리 최대 MAX_PER_CAT 개(최소 2개+ 카테고리 보장, JP 요청 2026-06-15).
  //   부정(bear) 도 MAX_NEG 로 제한. 둘 다 cap 초과분은 spill 로 빠졌다가, 카드가 부족할 때만 보충(억지 다양성 X).
  const TOP = 5, MAX_NEG = 3, MAX_PER_CAT = 3;
  const top = [], spill = [], topToks = [];   // topToks: 선정 카드 제목 핵심토큰(동일사건 dedup)
  let neg = 0;
  const catCount = {};
  // 같은 사건이면 null, 새 사건이면 그 제목 토큰 Set 반환.
  const freshToks = (c) => { const ct = titleKeyToks(fld(c, "title", lang)); return topToks.some((st) => sameStory(ct, st)) ? null : ct; };
  for (const c of ranked) {
    if (top.length >= TOP) break;
    const cat = c.category || "stock";
    const overCat = (catCount[cat] || 0) >= MAX_PER_CAT;
    const overNeg = c.sentiment === "bear" && neg >= MAX_NEG;
    const ct = freshToks(c);                   // 이미 선정된 것과 같은 사건이면 null
    if (overCat || overNeg || !ct) { spill.push(c); continue; }
    top.push(c); topToks.push(ct); catCount[cat] = (catCount[cat] || 0) + 1;
    if (c.sentiment === "bear") neg += 1;
  }
  for (const c of spill) {                      // 카드 부족 시 보충 — 단 동일사건은 계속 건너뜀
    if (top.length >= TOP) break;
    const ct = freshToks(c);
    if (!ct) continue;
    top.push(c); topToks.push(ct);
  }
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

// hotShort 안전 렌더(카테고리색 italic 강조) — emSafeHtml 참고.
function hotShortHtml(c, lang = "ko") {
  const raw = (lang === "en" ? c.hotShort_en : c.hotShort) || shortHotTitle(fld(c, "title", lang));
  return emSafeHtml(raw);
}

// 카드 본문 — 완결된 사실 한 문장만 노출(왜-중요 상술은 기사 상세에 유지, 카드는 중간 절단 방지).
//   1) ' — [왜 중요]' 대시 꼬리 제거  2) 여러 문장이면 첫 문장만.
//   소수점("3.5%")·약어 내부 점은 종결로 오인하지 않게 종결부호 뒤가 공백/끝일 때만 자른다.
function cardBody(body) {
  let t = (body || "").replace(/<\/?em>/g, "").replace(/\s+/g, " ").trim();  // em 은 카드 본문에선 평문(강조는 title·hotShort 만)
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
  const items = cards.items.slice(0, 10).map((c) => {
    const cls = CATEGORY_CLASS[c.category] || "is-stock";
    const href = c.slug ? `articles/${c.slug}.html` : (c.href || "#");
    const pubAttr = c.pubDate ? ` data-pubdate="${escapeHtml(c.pubDate)}"` : "";
    // 토스형 칩 — "STOCK · 주가·실적" → "주가·실적" (접두사는 색·아이콘이 아닌 텍스트 중복이라 제거)
    const catLabel = chipLabel(c.category);   // 카테고리 칩 = 짧은 영어(KO·EN 공통)
    return `      <a class="ccard ${cls}" href="${escapeHtml(href)}">
        <div class="ccard__top">
          <span class="ccard__cat">${escapeHtml(catLabel)}</span>${sentiBadge(c, lang)}
          <span class="ccard__time"${pubAttr}>${escapeHtml(c.time)}</span>
        </div>
        <h3>${fld(c, "title", lang)}</h3>
        <p class="ccard__body">${escapeHtml(cardBody(fld(c, "body", lang)))}</p>
        <div class="ccard__meta">
          <div class="src">${renderCardMeta(c, lang)}</div>
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
    const catLabel = chipLabel(c.category);   // 카테고리 칩 = 짧은 영어(KO·EN 공통)
    return `      <a class="ccard ${cls}" href="${escapeHtml(href)}">
        <div class="ccard__top">
          <span class="ccard__cat">${escapeHtml(catLabel)}</span>${sentiBadge(c, lang)}
          <span class="ccard__time"${pubAttr}>${escapeHtml(c.time)}</span>
        </div>
        <h3>${fld(c, "title", lang)}</h3>
        <p class="ccard__body">${escapeHtml(cardBody(fld(c, "body", lang)))}</p>
        <div class="ccard__meta">
          <div class="src">${renderCardMeta(c, lang)}</div>
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
  const catLabel = chipLabel(c.category);   // 카테고리 칩 = 짧은 영어(KO·EN 공통)
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
    src: renderCardMeta(c, lang),
    senti: sentiBadge(c, lang),
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

// 빌드 후처리 — EN_FONTS 마커 채우기(en=Newsreader/Inter 링크, ko=제거) + en 페이지 lang·canonical·자산 절대경로.
const EN_FONT_LINKS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;0,6..72,700;1,6..72,400;1,6..72,500&family=Inter:wght@400;500;600;700&display=swap">`;
// 정적 UI 문구 한→영 (en 페이지 chrome). 긴 문자열을 앞에 둬 부분치환 방지. 카드 본문은 _en 으로 이미 영어.
const UI_EN = [
  // 긴 문자열을 최상단에(부분치환 방지)
  // 기사 상세 disclaimer (영어판 — 한국어판 '번역·요약' 문구의 영어 대응)
  ["번역·요약은 <b>Tesla Briefing</b> 편집부가 한국어로 정리한 것이며, 원문의 모든 뉘앙스를 담지 않을 수 있습니다.", "Summaries are prepared by the <b>Tesla Briefing</b> editorial team and may not capture every nuance of the original reporting."],
  ["투자 결정의 책임은 본인에게 있습니다.", "You are solely responsible for your own investment decisions."],
  ["뉴스 검색", "Search news"],
  // 토스형 홈(B′) 신규 문자열 — 긴 것 먼저
  ["실적·제품·FSD·일론까지, 흩어진 뉴스를 정리해 보내드립니다 · 평일 발행 · 무료", "Earnings, products, FSD and Elon — the scattered news, distilled · weekdays · free"],
  ["매일 아침 7시, 한 통의 브리핑 📨", "One briefing, every morning at 7 📨"],
  ["ir.tesla.com 기준", "per ir.tesla.com"],
  ["투자자 캘린더", "Investor Calendar"],
  ["전체뉴스", "News"],
  ["구독하기", "Subscribe"],
  ["하단 메뉴", "Bottom menu"],
  // leaked chrome: 폼 메시지(JS) · JSON-LD · a11y 속성 · 빈 결과
  ["일치하는 뉴스가 없습니다. 다른 키워드나 카테고리를 시도해 보세요.", "No matching news — try a different keyword or category."],
  ["네트워크 오류입니다. 잠시 후 다시 시도해 주세요.", "Network error. Please try again shortly."],
  ["이미 구독 중인 이메일이에요. 곧 브리핑을 받아보세요.", "You're already subscribed — your briefing is on the way."],
  ["구독 신청 완료! 첫 브리핑을 기대해 주세요.", "Subscribed! Watch for your first briefing."],
  ["개인정보 수집·이용에 동의해 주세요.", "Please agree to the collection and use of your personal data."],
  ["테슬라 주주를 위한, 노이즈 없는 일일 브리핑", "A daily Tesla brief for shareholders, without the noise."],
  ["잠시 후 다시 시도해 주세요.", "Please try again shortly."],
  ["YouTube 채널 (새 창)", "YouTube channel (new window)"],
  ["유튜브 채널 바로가기", "Open YouTube channel"],
  ["Tesla Briefing — 홈", "Tesla Briefing — Home"],
  ["큐레이션 기준 설명", "How we curate"],
  ['aria-label="영상 1"', 'aria-label="Video 1"'],
  ["신청 중…", "Submitting…"],
  ["테슬라 주주에게 의미 있는 4개 주제(주가·실적 / 차량·에너지·옵티머스 / 자율·로보택시 / 일론)만 다룹니다. 매 2시간 RSS를 모아 ① 신선도(최근 24시간 가산점)와 ② 출처 신뢰도(증권·공식·전문매체 가산, 익명 커뮤니티·블로그 감점)로 점수를 매겨 카테고리당 상위 항목을 자동 선별합니다. 점 색은 출처 등급을 뜻합니다 — 사람의 의견이 아니라 출처 자체의 성격입니다.",
   "We cover only the four topics that matter to Tesla shareholders (stock & earnings / vehicles, energy & Optimus / autonomy & robotaxi / Elon). Every 2 hours we gather RSS and score each item by ① freshness (a recency bonus for the past 24 hours) and ② source reliability (credit for brokerages, official channels and specialist press; penalties for anonymous communities and blogs), then auto-select the top items per category. Dot colors mark the source tier — the nature of the source itself, not anyone's opinion."],
  ["실적, 제품, 서비스, 머스크 관련 소식까지, 흩어진 뉴스를 한데 보아 매일 아침 한 통의 뉴스레터로 정리합니다.",
   "Earnings, products, services and Elon — we gather the scattered news and distill it into one email every morning."],
  ["본 사이트는 정보 제공을 목적으로 하며, 투자 권유가 아닙니다. 모든 거래 결정의 책임은 본인에게 있습니다.",
   "This site is for information only and is not investment advice. All trading decisions are your own responsibility."],
  ["첫 영상 준비 중 · 매일 한 편", "First video coming soon · one a day"],
  ["매일 한 편 · 구독 + 알림 설정", "One a day · subscribe + alerts"],
  ["· 구독 + 알림 설정으로 첫 발행 받아보기", "· subscribe + alerts to get the first issue"],
  ["유튜브 채널 구독", "Subscribe on YouTube"], ["유튜브 — 최신 영상", "YouTube — latest"], ["유튜브 채널", "YouTube channel"],
  ["정규장", "Market open"], ["프리장", "Pre-market"], ["애프터장", "After hours"], ["장마감", "Market closed"],
  ["매일 한 편", "One a day"], ["준비 중", "Coming soon"], ["오늘", "Today"],
  ["테슬라 주주를 위한 일일 브리핑. 주가·실적, 차량·에너지·옵티머스, FSD/로보택시, 일론 소식을 한 페이지에서.", "A daily Tesla brief for shareholders — stock & earnings, vehicles, energy & Optimus, FSD & robotaxi, and Elon, all on one page."],
  ["테슬라 주주를 위한 일일 브리핑. 주가·실적, 차량·에너지·옵티머스, FSD/로보택시, 머스크 발언을 한 페이지에서.", "A daily Tesla brief for shareholders — stock & earnings, vehicles, energy & Optimus, FSD & robotaxi, and Elon, all on one page."],
  ["테슬라 주주를 위한 일일 브리핑.", "A daily Tesla brief for shareholders."],
  ["TESLA Brief!ng — 노이즈 없는 테슬라 브리핑", "TESLA Brief!ng — the signal, without the noise"],
  ["소개 · 큐레이션 기준 보기 →", "About · how we curate →"],
  ["매일 아침 7시, 최신 테슬라 소식", "Every morning at 7 — the latest on Tesla"],
  ["이메일 수집·이용에 동의합니다", "I agree to the collection and use of my email"],
  ["샘플 뉴스레터 보기 (PDF)", "View sample newsletter (PDF)"],
  ["개인정보처리방침 보기", "Privacy policy"],
  ["평일 오전 7시 KST", "Weekdays · 7am KST"],
  ["문의 · ", "Contact · "],
  ["HOT · 핫 뉴스", "HOT NEWS"],
  ["뉴스 전체보기", "All news"], ["최신 뉴스", "Latest"],
  ["뉴스레터 구독", "Subscribe"],
  ["차량·에너지·옵티머스", "Vehicles, Energy & Optimus"], ["자율·로보택시", "Autonomy & Robotaxi"], ["머스크 발언", "Elon"],
  ["1차 자료", "Primary"], ["외신·전문", "Press"], ["추측·커뮤니티", "Community"],
  ["개인정보처리방침", "Privacy policy"], ["이메일 주소", "Email address"],
  ["테슬라 브리핑", "Tesla Brief!ng"],
  ["주가·실적", "Stock"], ["FSD/로보택시", "FSD"], ["제품", "Product"],
  ["일론 소식", "Elon news"], ["일론", "Elon"], ["소개", "About"],
  ["뉴스레터", "Newsletter"], ["발송", "Sent"], ["(필수)", "(required)"], ["공식", "Official"],
  // news.html / article.html chrome
  ["키워드 검색 (예: 인도량, 옵티머스, 로보택시)", "Search (e.g. deliveries, Optimus, robotaxi)"],
  ["← 홈으로 돌아가기", "← Back to home"], ["← 홈으로", "← Home"],
  ["← 이전", "← Prev"], ["다음 →", "Next →"],
  ["발행 매체로 이동", "Read on publisher"], ["관련 기사", "Related"], ["원본", "Original"],
  ["FSD·로보택시", "FSD"], ["최신순", "latest first"], ["전체", "All"],
  // 공유 버튼 (기사)
  ["X에 공유", "Share on X"], ["텔레그램에 공유", "Share on Telegram"],
  ["링크 복사", "Copy link"], ["공유하기", "Share"],
  // 짧은 단어는 맨 끝(긴 문자열 치환 후) — 탭바·푸터 라벨
  ["캘린더", "Calendar"], ["유튜브", "YouTube"], ["홈", "Home"], ["문의", "Contact"],
];
function langFinalize(html, lang) {
  if (html.includes("BLOCK:EN_FONTS")) html = replaceBlock(html, "EN_FONTS", lang === "en" ? EN_FONT_LINKS : "");
  if (lang !== "en") return html;
  html = html
    .replace('<html lang="ko">', '<html lang="en">')
    .replace('<link rel="canonical" href="https://teslabriefing.com/">', '<link rel="canonical" href="https://teslabriefing.com/en/">')
    .replace('<meta property="og:url" content="https://teslabriefing.com/">', '<meta property="og:url" content="https://teslabriefing.com/en/">')
    .replace('href="/en/" hreflang="en" aria-label="English">EN<', 'href="/" hreflang="ko" aria-label="한국어">KO<')   // 언어 토글 EN→KO
    .replace(/(href|src)="assets\//g, '$1="/assets/')    // 상대 자산 → 루트 절대(/en/ 하위경로 대응)
    .replace(/href="(about|privacy)\.html"/g, 'href="/$1.html"')    // 영문 about/privacy 미생성 → 한국어 루트로(404 방지)
    .replace(/teslabriefing\.com\/articles\//g, 'teslabriefing.com/en/articles/')   // 기사 canonical·og:url → /en/
    .replace(/teslabriefing\.com\/earnings\//g, 'teslabriefing.com/en/earnings/')   // 어닝 특별페이지 canonical·og:url → /en/
    .replace('<link rel="canonical" href="https://teslabriefing.com/news">', '<link rel="canonical" href="https://teslabriefing.com/en/news">');
  // 등락색은 KO·EN 모두 미국식(템플릿 토큰) — JP 확정 2026-06-12, 로케일 치환 불필요.
  for (const [ko, en] of UI_EN) html = html.split(ko).join(en);
  return html;
}

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
  const catLabel = chipLabel(card.category);   // 카테고리 칩 = 짧은 영어(KO·EN 공통)
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
  const summaryHtml = paras.map((p) => `<p>${emSafeHtml(p)}</p>`).join("\n    ");

  const titleTxt = titleHtml.replace(/<\/?em>/g, "");
  const desc = (summaryRaw || bodyRaw || "").replace(/<\/?em>/g, "").slice(0, 120).replace(/\n+/g, " ").trim() + "…";

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
  out = replaceBlock(out, "A_LEAD",         emSafeHtml(leadText), opts);
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
  const senti = sentiBadge(card, lang);
  out = replaceBlock(out, "A_SENTI", senti ? ` <span aria-hidden="true">·</span> ${senti}` : "", opts);
  out = replaceBlock(out, "A_RELATED", relatedArticles(card, pool, lang), opts);  // 관련 기사(같은 카테고리)
  out = replaceBlock(out, "A_OG_IMG", escapeHtml(ogImageUrl(card)), opts);        // 기사별 OG (og:image + twitter:image)
  const pubIso = new Date(Date.parse(card.pubDate || 0) || Date.now()).toISOString();
  out = replaceBlock(out, "A_PUB_ISO", pubIso, opts);                             // og article:published_time
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
    ? `${escapeHtml(`${totalLabel} · ${sortLabel}`)} · <span class="cats__fresh" data-fresh-since="${escapeHtml(freshSince)}">${escapeHtml(fmtFreshLabel(freshSince, lang) || freshLabel)}</span>`
    : escapeHtml(`${totalLabel} · ${sortLabel}`);
  out = replaceBlock(out, "NEWS_TIME", newsAsOf);
  // SSR 은 1페이지(10건)만 — 나머지는 클라이언트가 news-index.json 으로 페이지네이션.
  const seed = { items: cards.items.slice(0, 10) };
  out = replaceBlock(out, "NEWS_GRID", `\n      ${renderAllCards(seed, { lang })}\n      `);
  await writeFile(path.join(outDir, "news.html"), langFinalize(out, lang), "utf8");

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
    await writeFile(path.join(articlesDir, `${card.slug}.html`), langFinalize(html, lang), "utf8");
    generated++;
  }
  return generated;
}

// ─────────────────────────────────────────────────────────────
// 어닝콜 특별 페이지 (data/earnings/*.json → {outDir}/earnings/<slug>.html)
//  상태 머신: draft(비공개, 페이지·핀·sitemap 전부 미생성) → upcoming(프리뷰) → live(전체 리캡).
// ─────────────────────────────────────────────────────────────
async function loadEarningsEntries() {
  const dir = path.join(DATA_DIR, "earnings");
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); }
  catch { return []; }   // 디렉토리 없음/읽기 실패 → 조용히 skip
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      if (j && typeof j === "object" && j.slug) out.push(j);
    } catch (e) {
      console.warn(`[build] ⚠ data/earnings/${f} 파싱 실패: ${e.message}`);
    }
  }
  return out;
}

const byCallDateDesc = (a, b) => (a.callDate < b.callDate ? 1 : a.callDate > b.callDate ? -1 : 0);

// YYYY-MM-DD 기준 UTC 날짜 diff(오늘=0). renderInvestorCalendar 의 dday 계산과 동일한 방식.
function ddayForDate(dateISO, now) {
  const t = Date.parse(String(dateISO || "") + "T00:00:00Z");
  if (Number.isNaN(t)) return null;
  const todayMs = Date.parse(now.toISOString().slice(0, 10) + "T00:00:00Z");
  return Math.round((t - todayMs) / 86400000);
}

const EA_VERDICT_MAP = {
  beat:  { ko: "어닝 비트 · 컨센서스 상회", en: "Beat — above consensus", cls: "is-beat" },
  miss:  { ko: "어닝 미스 · 컨센서스 하회", en: "Miss — below consensus", cls: "is-miss" },
  mixed: { ko: "혼조 실적",                 en: "Mixed results",          cls: "is-mixed" },
};
function renderEaVerdict(verdict, lang) {
  const m = EA_VERDICT_MAP[verdict];
  if (!m) return "";
  return `<span class="ea-verdict ${m.cls}">${escapeHtml(lang === "en" ? m.en : m.ko)}</span>`;
}

function renderEaEyebrow(data) {
  return escapeHtml(`${(data.quarter || "").trim()} EARNINGS`.trim());
}

// live 면 prTitle(발표 후 헤드라인), upcoming 이면 "{quarter} 어닝콜 D-N" 류(calendar dday 표기와 동일 관례).
function renderEaTitle(data, lang, now) {
  const QN = (data.quarter || "").trim() || "Q?";
  if (data.status === "live") {
    const t = lang === "en" ? (data.prTitle_en || data.prTitle) : data.prTitle;
    return escapeHtml(t || (lang === "en" ? `${QN} Earnings` : `${QN} 실적 발표`));
  }
  const dday = ddayForDate(data.callDate, now);
  const ddayN = Math.max(0, dday === null ? 0 : dday);
  const ddayTxt = ddayN === 0 ? (lang === "en" ? "Today" : "오늘") : `D-${ddayN}`;
  const t = lang === "en" ? `${QN} Earnings Call ${ddayTxt}` : `${QN} 어닝콜 ${ddayTxt}`;
  return escapeHtml(t);
}

// 발표일시 — 미국 발표일(fmtCalDate 재사용, calendar 표기와 동일 관례: ko="M/D WED", en="Mon D") + 한국시간 병기.
//  Intl 로케일(ko-KR) 기본 구분자("7. 23.")가 아닌, home.html 클라이언트 fmtRel 과 동일한 수동 M/D HH:MM 포맷 사용.
function renderEaSchedule(data, lang) {
  const usTxt = fmtCalDate(data.callDate, lang);
  if (!usTxt) return "";
  let kstPart = "";
  const kstMs = data.callTimeKst ? Date.parse(data.callTimeKst) : NaN;
  if (!Number.isNaN(kstMs)) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(kstMs));
    const g = (ty) => (parts.find((x) => x.type === ty) || {}).value || "";
    const kstTxt = `${g("month")}/${g("day")} ${g("hour")}:${g("minute")}`;
    kstPart = lang === "en" ? ` · KST ${kstTxt}` : ` · 한국시간 ${kstTxt}`;
  }
  const label = lang === "en" ? "Earnings call" : "발표일시";
  const usQualifier = lang === "en" ? " (US)" : " (미국)";
  return `<p class="ea__schedule">${escapeHtml(`${label} · ${usTxt}${usQualifier}${kstPart}`)}</p>`;
}

// kpis: [{key,label,label_en,value,consensus,vsConsensus,yoy,beat}] — value 없는 항목은 스킵(빈 카드 방지).
function renderEaKpis(kpis, lang) {
  const items = (Array.isArray(kpis) ? kpis : []).filter((k) => k && k.value);
  if (!items.length) return "";
  const heading = lang === "en" ? "Key Metrics" : "핵심 지표";
  const L = lang === "en" ? { cons: "Consensus" } : { cons: "컨센서스" };
  const cards = items.map((k) => {
    const label = escapeHtml((lang === "en" ? (k.label_en || k.label) : k.label) || "");
    const value = escapeHtml(k.value || "—");
    const beatCls = k.beat === true ? "is-beat" : k.beat === false ? "is-miss" : "";
    const cons = k.consensus ? `<span class="ea-kpi__cons">${escapeHtml(L.cons)} ${escapeHtml(k.consensus)}</span>` : "";
    const delta = k.vsConsensus ? `<span class="ea-kpi__delta ${beatCls}">${escapeHtml(k.vsConsensus)}</span>` : "";
    const yoy = k.yoy ? `<span class="ea-kpi__yoy">YoY ${escapeHtml(k.yoy)}</span>` : "";
    return `<div class="ea-kpi">
        <span class="ea-kpi__label">${label}</span>
        <span class="ea-kpi__value">${value}</span>
        ${(cons || delta) ? `<div class="ea-kpi__row">${cons}${delta}</div>` : ""}
        ${yoy}
      </div>`;
  }).join("\n      ");
  return `<section class="ea-sec ea-kpis">
    <h2 class="ea-sec__h">${escapeHtml(heading)}</h2>
    <div class="ea-kpi-grid">
      ${cards}
    </div>
  </section>`;
}

// segments: [{title,title_en,body,body_en}]
function renderEaSegments(segments, lang) {
  const items = (Array.isArray(segments) ? segments : []).filter((s) => s && (s.body || s.body_en));
  if (!items.length) return "";
  const heading = lang === "en" ? "Segment Highlights" : "세그먼트 하이라이트";
  const blocks = items.map((s) => {
    const title = escapeHtml((lang === "en" ? (s.title_en || s.title) : s.title) || "");
    const body = escapeHtml((lang === "en" ? (s.body_en || s.body) : s.body) || "");
    return `<div class="ea-seg">
        ${title ? `<h3 class="ea-seg__h">${title}</h3>` : ""}
        <p class="ea-seg__body">${body}</p>
      </div>`;
  }).join("\n      ");
  return `<section class="ea-sec ea-segments">
    <h2 class="ea-sec__h">${escapeHtml(heading)}</h2>
    ${blocks}
  </section>`;
}

// quotes: [{who,who_en,topic,topic_en,text,text_en}]
function renderEaQuotes(quotes, lang) {
  const items = (Array.isArray(quotes) ? quotes : []).filter((q) => q && (q.text || q.text_en));
  if (!items.length) return "";
  const heading = lang === "en" ? "Key Quotes from the Call" : "콜 핵심 발언";
  const blocks = items.map((q) => {
    const who = lang === "en" ? (q.who_en || q.who) : q.who;
    const topic = lang === "en" ? (q.topic_en || q.topic) : q.topic;
    const text = escapeHtml((lang === "en" ? (q.text_en || q.text) : q.text) || "");
    const meta = [who, topic].filter(Boolean).map(escapeHtml).join(" · ");
    return `<blockquote class="ea-quote">
        <p class="ea-quote__text">"${text}"</p>
        ${meta ? `<cite class="ea-quote__meta">${meta}</cite>` : ""}
      </blockquote>`;
  }).join("\n      ");
  return `<section class="ea-sec ea-quotes">
    <h2 class="ea-sec__h">${escapeHtml(heading)}</h2>
    ${blocks}
  </section>`;
}

// guidance: [{text,text_en}]
function renderEaGuidance(guidance, lang) {
  const items = (Array.isArray(guidance) ? guidance : []).filter((g) => g && (g.text || g.text_en));
  if (!items.length) return "";
  const heading = lang === "en" ? "Guidance & Outlook" : "가이던스·전망";
  const lis = items.map((g) => `<li>${escapeHtml((lang === "en" ? (g.text_en || g.text) : g.text) || "")}</li>`).join("\n        ");
  return `<section class="ea-sec ea-guidance">
    <h2 class="ea-sec__h">${escapeHtml(heading)}</h2>
    <ul class="ea-list">
      ${lis}
    </ul>
  </section>`;
}

// marketReaction: { afterHours, nextClose, body, body_en }
function renderEaMarket(mr, lang) {
  if (!mr) return "";
  const body = (lang === "en" ? (mr.body_en || mr.body) : mr.body) || "";
  if (!mr.afterHours && !mr.nextClose && !body) return "";
  const heading = lang === "en" ? "Market Reaction" : "시장 반응";
  const L = lang === "en" ? { ah: "After-hours", nc: "Next close" } : { ah: "애프터장", nc: "다음날 종가" };
  const stats = [
    mr.afterHours ? `<div class="ea-stat"><span class="ea-stat__l">${escapeHtml(L.ah)}</span><span class="ea-stat__v">${escapeHtml(mr.afterHours)}</span></div>` : "",
    mr.nextClose  ? `<div class="ea-stat"><span class="ea-stat__l">${escapeHtml(L.nc)}</span><span class="ea-stat__v">${escapeHtml(mr.nextClose)}</span></div>` : "",
  ].filter(Boolean).join("\n      ");
  return `<section class="ea-sec ea-market">
    <h2 class="ea-sec__h">${escapeHtml(heading)}</h2>
    ${stats ? `<div class="ea-stats">${stats}</div>` : ""}
    ${body ? `<p class="ea-market__body">${escapeHtml(body)}</p>` : ""}
  </section>`;
}

// analysis: [{title,title_en,body,body_en}] — 에디토리얼 상세 분석(live 전용). body 는 "\n\n" 로 문단 분리.
function renderEaAnalysis(analysis, lang) {
  const items = (Array.isArray(analysis) ? analysis : []).filter((a) => a && (a.body || a.body_en));
  if (!items.length) return "";
  const heading = lang === "en" ? "Deep Dive" : "상세 분석";
  const blocks = items.map((a) => {
    const title = escapeHtml((lang === "en" ? (a.title_en || a.title) : a.title) || "");
    const bodyRaw = (lang === "en" ? (a.body_en || a.body) : a.body) || "";
    const paras = bodyRaw.split(/\n\n+/).map((p) => p.trim()).filter(Boolean)
      .map((p) => `<p>${escapeHtml(p)}</p>`).join("\n        ");
    return `<div class="ea-an">
        ${title ? `<h3 class="ea-an__h">${title}</h3>` : ""}
        <div class="ea-an__body">${paras}</div>
      </div>`;
  }).join("\n      ");
  return `<section class="ea-sec ea-analysis">
    <h2 class="ea-sec__h">${escapeHtml(heading)}</h2>
    ${blocks}
  </section>`;
}

// watchPoints: [{text,text_en}] — upcoming 이면 메인(관전 포인트), live 이면 회고("발표 전 관전 포인트였던 것").
function renderEaWatch(watchPoints, lang, status) {
  const items = (Array.isArray(watchPoints) ? watchPoints : []).filter((w) => w && (w.text || w.text_en));
  if (!items.length) return "";
  const heading = status === "live"
    ? (lang === "en" ? "What We Were Watching For" : "발표 전 관전 포인트였던 것")
    : (lang === "en" ? "What to Watch" : "관전 포인트");
  const lis = items.map((w) => `<li>${escapeHtml((lang === "en" ? (w.text_en || w.text) : w.text) || "")}</li>`).join("\n        ");
  return `<section class="ea-sec ea-watch">
    <h2 class="ea-sec__h">${escapeHtml(heading)}</h2>
    <ul class="ea-list">
      ${lis}
    </ul>
  </section>`;
}

// preQuestions: [{who,who_en,text,text_en}] — Say 플랫폼 투자자 상위 추천 질문 + 언론·애널리스트 주목 질문.
//  upcoming/live 공통 노출(발표 전 제출된 질문은 발표 후에도 회고 가치가 있음).
function renderEaPreQuestions(preQuestions, lang) {
  const items = (Array.isArray(preQuestions) ? preQuestions : []).filter((q) => q && (q.text || q.text_en));
  if (!items.length) return "";
  const heading = lang === "en" ? "Investor & Press Questions" : "투자자·언론 사전 질문";
  const blocks = items.map((q, i) => {
    const text = escapeHtml((lang === "en" ? (q.text_en || q.text) : q.text) || "");
    const who = (lang === "en" ? (q.who_en || q.who) : q.who) || "";
    return `<div class="ea-q">
        <span class="ea-q__n">Q${i + 1}</span>
        <p class="ea-q__text">${text}</p>
        ${who ? `<span class="ea-q__who">${escapeHtml(who)}</span>` : ""}
      </div>`;
  }).join("\n      ");
  return `<section class="ea-sec ea-questions">
    <h2 class="ea-sec__h">${escapeHtml(heading)}</h2>
    ${blocks}
  </section>`;
}

// consensus: { eps, revenue, note, note_en } — upcoming 프리뷰용(라이브 전환 후에도 값이 남아있으면 계속 표시).
function renderEaConsensus(consensus, lang) {
  if (!consensus) return "";
  const note = (lang === "en" ? (consensus.note_en || consensus.note) : consensus.note) || "";
  if (!consensus.eps && !consensus.revenue && !note) return "";
  const heading = lang === "en" ? "Consensus Estimates" : "컨센서스";
  const L = lang === "en" ? { eps: "EPS (adj.)", rev: "Revenue" } : { eps: "EPS (조정)", rev: "매출" };
  const rows = [
    consensus.eps     ? `<div class="ea-stat"><span class="ea-stat__l">${escapeHtml(L.eps)}</span><span class="ea-stat__v">${escapeHtml(consensus.eps)}</span></div>` : "",
    consensus.revenue ? `<div class="ea-stat"><span class="ea-stat__l">${escapeHtml(L.rev)}</span><span class="ea-stat__v">${escapeHtml(consensus.revenue)}</span></div>` : "",
  ].filter(Boolean).join("\n      ");
  return `<section class="ea-sec ea-consensus">
    <h2 class="ea-sec__h">${escapeHtml(heading)}</h2>
    ${rows ? `<div class="ea-stats">${rows}</div>` : ""}
    ${note ? `<p class="ea-consensus__note">${escapeHtml(note)}</p>` : ""}
  </section>`;
}

// sources 링크 + webcast/deckUrl 버튼 — upcoming 상태에서도 노출 허용(일정/webcast 는 프리뷰 범위).
function renderEaSources(data, lang) {
  const sources = (Array.isArray(data.sources) ? data.sources : []).filter((s) => s && s.href);
  const hasWebcast = !!data.webcast;
  const hasDeck = !!data.deckUrl;
  if (!sources.length && !hasWebcast && !hasDeck) return "";
  const heading = lang === "en" ? "Sources" : "원문 소스";
  const L = lang === "en" ? { webcast: "Watch webcast", deck: "Shareholder deck (PDF)" } : { webcast: "웹캐스트 보기", deck: "주주서한 PDF" };
  const list = sources.map((s) => {
    const nm = (lang === "en" ? (s.name_en || s.name) : s.name) || s.href;
    return `<a class="ea-src__item" href="${escapeHtml(s.href)}" target="_blank" rel="noopener nofollow">${escapeHtml(nm)}</a>`;
  }).join("\n      ");
  const buttons = [
    hasWebcast ? `<a class="art__source__cta" href="${escapeHtml(data.webcast)}" target="_blank" rel="noopener nofollow">${escapeHtml(L.webcast)}</a>` : "",
    hasDeck    ? `<a class="art__source__cta" href="${escapeHtml(data.deckUrl)}" target="_blank" rel="noopener nofollow">${escapeHtml(L.deck)}</a>` : "",
  ].filter(Boolean).join("\n      ");
  return `<section class="ea-sec ea-sources">
    <h2 class="ea-sec__h">${escapeHtml(heading)}</h2>
    ${list ? `<div class="ea-src__list">${list}</div>` : ""}
    ${buttons ? `<div class="ea-src__btns">${buttons}</div>` : ""}
  </section>`;
}

// 어닝콜 아카이브 — 같은 디렉토리의 다른 발행(비draft) 어닝 페이지로 상호 링크.
//  현재 페이지 제외, callDate 최신순. live 는 발표일+판정, upcoming 은 프리뷰 표기.
const EA_VERDICT_SHORT = {
  beat: { ko: "어닝 비트", en: "Beat" },
  miss: { ko: "어닝 미스", en: "Miss" },
  mixed: { ko: "혼조", en: "Mixed" },
};
function renderEaPastCalls(data, allEntries, lang) {
  const others = (Array.isArray(allEntries) ? allEntries : [])
    .filter((e) => e && e.slug && e.slug !== data.slug && e.status && e.status !== "draft")
    .sort(byCallDateDesc);
  if (!others.length) return "";
  const heading = lang === "en" ? "Earnings Archive" : "지난 어닝콜";
  const rows = others.map((e) => {
    const QN = (e.quarter || "").trim();
    const dateTxt = fmtCalDate(e.callDate, lang);
    let meta;
    if (e.status === "upcoming") {
      meta = lang === "en" ? `${dateTxt} · Preview` : `${dateTxt} 예정 · 프리뷰`;
    } else {
      const v = EA_VERDICT_SHORT[e.verdict];
      const vTxt = v ? ` · ${lang === "en" ? v.en : v.ko}` : "";
      meta = lang === "en" ? `Reported ${dateTxt}${vTxt}` : `${dateTxt} 발표${vTxt}`;
    }
    return `<a class="ea-past" href="${escapeHtml(`${e.slug}.html`)}">
        <span class="ea-past__q">${escapeHtml(QN)}</span>
        <span class="ea-past__meta">${escapeHtml(meta)}</span>
        <span class="ea-past__arrow" aria-hidden="true">→</span>
      </a>`;
  }).join("\n      ");
  return `<section class="ea-sec ea-past-calls">
    <h2 class="ea-sec__h">${escapeHtml(heading)}</h2>
    ${rows}
  </section>`;
}

function earningsJsonLd(data, lang, titlePlain) {
  const base = lang === "en" ? `${SITE}/en` : SITE;
  const url = `${base}/earnings/${data.slug}`;
  const headline = ((lang === "en" ? (data.prTitle_en || data.prTitle) : data.prTitle) || titlePlain || "")
    .replace(/\s+/g, " ").trim();
  const desc = ((lang === "en" ? (data.lead_en || data.lead) : data.lead) || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const obj = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline,
    description: desc,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    image: [`${SITE}/assets/og-image.png`],
    inLanguage: lang === "en" ? "en" : "ko",
    author: { "@type": "Organization", name: "Tesla Brief!ng", url: `${SITE}/` },
    publisher: {
      "@type": "Organization",
      name: "Tesla Brief!ng",
      logo: { "@type": "ImageObject", url: `${SITE}/assets/og-image.png` },
    },
  };
  const pubSrc = data.updatedAt || data.callDate;
  if (pubSrc && !Number.isNaN(Date.parse(pubSrc))) {
    obj.datePublished = new Date(Date.parse(pubSrc)).toISOString();
    obj.dateModified = obj.datePublished;
  }
  return JSON.stringify(obj);
}

/**
 * data/earnings/<slug>.json 카드 하나 → 어닝콜 특별 페이지 HTML.
 * status "upcoming": 히어로+관전포인트+컨센서스+일정/webcast 만(데이터가 있어도 kpi·세그먼트 등은 하드 게이트로 숨김).
 * 그 외("live"): 전체 섹션 — 각 섹션은 데이터 없으면 렌더러가 통째로 생략(빈 껍데기 금지).
 */
function renderEarningsPage(template, data, lang = "ko", now = new Date(), allEntries = []) {
  const status = data.status === "live" ? "live" : "upcoming";
  const QN = (data.quarter || "").trim();
  const titleTxt = renderEaTitle(data, lang, now);   // 이미 escape 됨
  const eyebrowTxt = renderEaEyebrow(data);          // 이미 escape 됨
  const verdictHtml = status === "live" ? renderEaVerdict(data.verdict, lang) : "";
  const leadRaw = lang === "en" ? (data.lead_en || data.lead) : data.lead;
  const leadHtml = leadRaw ? `<p class="ea__lead">${escapeHtml(leadRaw)}</p>` : "";
  const scheduleHtml = renderEaSchedule(data, lang);

  // live 전용 — upcoming 은 값이 채워져 있어도 하드 게이트로 숨김(사전 유출 방지)
  const kpisHtml     = status === "live" ? renderEaKpis(data.kpis, lang) : "";
  const segmentsHtml = status === "live" ? renderEaSegments(data.segments, lang) : "";
  const quotesHtml   = status === "live" ? renderEaQuotes(data.quotes, lang) : "";
  const guidanceHtml = status === "live" ? renderEaGuidance(data.guidance, lang) : "";
  const marketHtml   = status === "live" ? renderEaMarket(data.marketReaction, lang) : "";
  const analysisHtml = status === "live" ? renderEaAnalysis(data.analysis, lang) : "";

  // 두 상태 공통(데이터 있으면 노출) — 관전포인트·사전질문·컨센서스·소스/webcast
  const watchHtml     = renderEaWatch(data.watchPoints, lang, status);
  const questionsHtml = renderEaPreQuestions(data.preQuestions, lang);
  const consensusHtml = renderEaConsensus(data.consensus, lang);
  const sourcesHtml   = renderEaSources(data, lang);
  const pastHtml      = renderEaPastCalls(data, allEntries, lang);

  const pageTitle = status === "live"
    ? (lang === "en" ? `Tesla ${QN} Earnings — full breakdown` : `${QN} 테슬라 어닝콜 총정리 — Tesla Briefing`)
    : (lang === "en" ? `Tesla ${QN} Earnings Preview — Tesla Briefing` : `${QN} 어닝콜 프리뷰 — Tesla Briefing`);
  const descFallback = lang === "en"
    ? `Everything from Tesla's ${QN} earnings call — numbers, quotes, and guidance in one page.`
    : `${QN} 테슬라 실적 발표 총정리 — 지표·발언·가이던스를 한 페이지에서.`;
  const desc = (leadRaw || descFallback).replace(/\s+/g, " ").trim().slice(0, 150);

  const opts = { keepMarkers: false };
  let out = template;
  out = replaceBlock(out, "EA_TITLE_TXT", escapeHtml(pageTitle), opts);
  out = replaceBlock(out, "EA_DESC",      escapeHtml(desc), opts);
  out = replaceBlock(out, "EA_CANON",     escapeHtml(data.slug || ""), opts);
  out = replaceBlock(out, "EA_JSONLD",    earningsJsonLd(data, lang, titleTxt), opts);
  const pubSrc = data.updatedAt || data.callDate;
  const pubIso = new Date((pubSrc && Date.parse(pubSrc)) || Date.now()).toISOString();
  out = replaceBlock(out, "EA_PUB_ISO",   pubIso, opts);

  out = replaceBlock(out, "EA_EYEBROW",   eyebrowTxt, opts);
  out = replaceBlock(out, "EA_TITLE",     titleTxt, opts);
  out = replaceBlock(out, "EA_VERDICT",   verdictHtml, opts);
  out = replaceBlock(out, "EA_LEAD",      leadHtml, opts);
  out = replaceBlock(out, "EA_SCHEDULE",  scheduleHtml, opts);
  out = replaceBlock(out, "EA_KPIS",      kpisHtml, opts);
  out = replaceBlock(out, "EA_SEGMENTS",  segmentsHtml, opts);
  out = replaceBlock(out, "EA_QUOTES",    quotesHtml, opts);
  out = replaceBlock(out, "EA_GUIDANCE",  guidanceHtml, opts);
  out = replaceBlock(out, "EA_MARKET",    marketHtml, opts);
  out = replaceBlock(out, "EA_ANALYSIS",  analysisHtml, opts);
  out = replaceBlock(out, "EA_WATCH",     watchHtml, opts);
  out = replaceBlock(out, "EA_QUESTIONS", questionsHtml, opts);
  out = replaceBlock(out, "EA_CONSENSUS", consensusHtml, opts);
  out = replaceBlock(out, "EA_SOURCES",   sourcesHtml, opts);
  out = replaceBlock(out, "EA_PAST",      pastHtml, opts);
  return out;
}

/** {outDir}/earnings/<slug>.html 생성 — entries 는 이미 status!=="draft" 로 필터된 목록. */
async function writeEarningsPages(entries, { outDir = OUT_DIR, lang = "ko" } = {}) {
  const dir = path.join(outDir, "earnings");
  // 매 빌드마다 청소 — generateArticles 와 동일 원칙. draft 로 되돌아가거나 슬러그가 사라진 옛 어닝
  // 페이지가 dist 에 잔재로 남지 않게(그렇지 않으면 "draft=흔적 0" 보증이 깨짐).
  await rm(dir, { recursive: true, force: true });
  if (!entries.length) return 0;
  const tplPath = path.join(ROOT, "earnings-template.html");
  let template;
  try { template = await readFile(tplPath, "utf8"); }
  catch { console.warn("[build] earnings-template.html 없음 — 어닝 페이지 생성 건너뜀"); return 0; }
  await mkdir(dir, { recursive: true });
  let n = 0;
  for (const data of entries) {
    if (!data.slug) continue;
    const html = renderEarningsPage(template, data, lang, new Date(), entries);
    await writeFile(path.join(dir, `${data.slug}.html`), langFinalize(html, lang), "utf8");
    n++;
  }
  return n;
}

/**
 * 홈 핫뉴스 박스 상단 핀 — 어닝 파일이 여럿이면 callDate 최신 1건만 대상.
 *  upcoming: 오늘 ≤ callDate 이면 표시("D-N — 관전 포인트·컨센서스").
 *  live: 발표 후 8일 이내만 표시(아래 상수 참고). 기간 지나면 핀만 자동 소멸, 페이지·sitemap 은 영구 유지.
 */
// 8일 = 미국날짜 기준 발표 후 만 7일 + KST 시차 여유 포함(미국 발표일 기준으로 하루 더 여유를 둠).
const EARNINGS_PIN_EXPIRE_MS = 8 * 86400000;
function renderEarningsPin(data, lang = "ko", now = new Date()) {
  if (!data || !data.slug || !data.callDate) return "";
  const todayISO = now.toISOString().slice(0, 10);
  const QN = (data.quarter || "").trim().split(/\s+/)[0] || "Q2";   // "Q2 2026" → "Q2"
  const href = `earnings/${data.slug}.html`;
  if (data.status === "upcoming") {
    if (todayISO > data.callDate) return "";   // 콜데이트 지났는데 아직 live 전환 전 → 핀 숨김(안전)
    const dday = Math.max(0, ddayForDate(data.callDate, now) ?? 0);
    const ddayTxt = dday === 0 ? (lang === "en" ? "Today" : "오늘") : `D-${dday}`;
    const phrase = lang === "en" ? `${QN} earnings ${ddayTxt} — what to watch` : `${QN} 어닝콜 ${ddayTxt} — 관전 포인트·컨센서스`;
    return `<a class="hot-pin" href="${escapeHtml(href)}"><span class="hot-pin__badge">EARNINGS</span><span class="hot-pin__txt">${escapeHtml(phrase)}</span></a>`;
  }
  if (data.status === "live") {
    const callMs = Date.parse(data.callDate);
    if (Number.isNaN(callMs) || now.getTime() >= callMs + EARNINGS_PIN_EXPIRE_MS) return "";
    const phrase = lang === "en" ? `${QN} earnings special — numbers, quotes & guidance` : `${QN} 실적 특별 페이지 — 지표·발언·가이던스 총정리`;
    return `<a class="hot-pin" href="${escapeHtml(href)}"><span class="hot-pin__badge">EARNINGS</span><span class="hot-pin__txt">${escapeHtml(phrase)}</span></a>`;
  }
  return "";
}

/**
 * 홈 뉴스레터 자리(gnl 그리드 영역) 어닝콜 링크 카드 — 최신 발행(비draft) 어닝 페이지로 상시 연결.
 *  핀(renderEarningsPin)과 달리 만료 없음(페이지는 영구 유지되므로 카드도 상시).
 *  발행된 어닝 페이지가 하나도 없으면 카드 자체 미출력(깨진 링크 방지).
 */
function renderEarningsCta(data, lang = "ko", now = new Date()) {
  if (!data || !data.slug) return "";
  const QN = (data.quarter || "").trim() || "";
  const href = `earnings/${data.slug}.html`;
  let title, sub;
  if (data.status === "upcoming") {
    const dday = Math.max(0, ddayForDate(data.callDate, now) ?? 0);
    const ddayTxt = dday === 0 ? (lang === "en" ? "today" : "오늘") : `D-${dday}`;
    title = lang === "en" ? `${QN} Earnings Call — ${ddayTxt}` : `${QN} 어닝콜 ${ddayTxt}`;
    sub = lang === "en" ? "Preview — what to watch · consensus · investor questions" : "프리뷰 — 관전 포인트 · 컨센서스 · 투자자 사전 질문";
  } else {
    title = lang === "en" ? `${QN} Earnings — full breakdown` : `${QN} 실적 특별 페이지`;
    sub = lang === "en" ? "Numbers · quotes · guidance, all in one page" : "지표 · 발언 · 가이던스 총정리";
  }
  const label = lang === "en" ? "Earnings special page" : "어닝콜 특별 페이지";
  return `<a class="ea-cta" id="earnings-cta" href="${escapeHtml(href)}" aria-label="${escapeHtml(label)}">
  <span class="ea-cta__body">
    <span class="ea-cta__badge">EARNINGS</span>
    <span class="ea-cta__title">${escapeHtml(title)}</span>
    <span class="ea-cta__sub">${escapeHtml(sub)}</span>
  </span>
  <span class="ea-cta__arrow" aria-hidden="true">→</span>
</a>`;
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
  // 핫뉴스·피드 풀 — archive(최신 100, dedup)에서. cards.json(2~6건)이 적어도 핫뉴스 최소 개수 확보.
  let feedCards = cards;
  try {
    const arcRaw = JSON.parse(await readFile(path.join(DATA_DIR, "archive.json"), "utf8"));
    if (Array.isArray(arcRaw.items) && arcRaw.items.length) feedCards = { items: arcRaw.items };
  } catch { /* archive 없으면 cards.json 폴백 */ }
  const hotCountLabel = lang === "en"
    ? `${Math.min(5, feedCards.items.length)} items`
    : `총 ${Math.min(5, feedCards.items.length)}건`;
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

  // 어닝콜 특별 페이지 데이터 — draft 는 페이지·핀·sitemap 전부 제외(스키마 초기 상태 = 안전 배포).
  const earningsAll = await loadEarningsEntries();
  const earningsPublished = earningsAll.filter((e) => e.status && e.status !== "draft");
  const earningsPinTarget = earningsPublished.length ? [...earningsPublished].sort(byCallDateDesc)[0] : null;

  let out = template;
  out = replaceBlock(out, "KPI_GRID",    renderKpi(kpi, lang));
  // 라이브 주가 방향(전일 종가 대비) — 핫뉴스에서 시세와 모순되는 헤드라인 제외에 사용.
  const livePriceDir = (kpi && kpi.price && kpi.prevClose)
    ? (kpi.price > kpi.prevClose ? "up" : kpi.price < kpi.prevClose ? "down" : null) : null;
  out = replaceBlock(out, "HOT_NEWS",    renderHotNews(feedCards, lang, livePriceDir));
  out = replaceBlock(out, "INVESTOR_CAL", renderInvestorCalendar(calendar, lang, now));
  out = replaceBlock(out, "HOT_COUNT",   hotCountLabel);
  const cardsFreshSince = cards.items[0]?.pubDate || "";
  const cardsAsOf = cardsFreshSince
    ? `${escapeHtml(localizedCardsAsOf)} · <span class="cats__fresh" data-fresh-since="${escapeHtml(cardsFreshSince)}">${escapeHtml(fmtFreshLabel(cardsFreshSince, lang) || freshLabel)}</span>`
    : escapeHtml(localizedCardsAsOf);
  out = replaceBlock(out, "CARDS_TIME",  cardsAsOf);
  // 홈 피드 — archive 상위 10건(위 feedCards 재사용).
  out = replaceBlock(out, "CARDS_GRID",  renderCards(feedCards, { lang }));
  out = replaceBlock(out, "BUILD_INFO",  `<!-- build: ${buildIso} -->`);
  out = replaceBlock(out, "EARNINGS_PIN", renderEarningsPin(earningsPinTarget, lang, now));
  out = replaceBlock(out, "EARNINGS_CTA", renderEarningsCta(earningsPinTarget, lang, now));

  out = langFinalize(out, lang);
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
  const numEarnings = await writeEarningsPages(earningsPublished, { outDir, lang });

  return { numCards: cards.items.length, numArchive: archive.items.length, numArticles, numEarnings, bytes: out.length, articles: articleItems, earnings: earningsPublished };
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

  // ─── English (/en/) — 같은 cards.json 의 _en 필드로 미러 빌드 (자산은 /assets 절대참조로 공유) ──
  const en = await buildOneLang({
    templateName: "home.html",
    cardsName: "cards.json",
    archiveName: "archive.json",
    newsTemplateName: "news-template.html",
    outDir: path.join(OUT_DIR, "en"),
    lang: "en",
  });
  console.log(`[build] EN: ${en.numCards} cards · ${en.numArchive} archive · ${en.numArticles} articles · ${en.numEarnings} earnings → /en/`);

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
  // 어닝콜 특별 페이지(비draft만) — ko.earnings 는 buildOneLang 이 이미 draft 제외 필터링한 목록.
  const earningsForSitemap = (ko.earnings || []).filter((e) => e.slug);
  const earningsEntries = earningsForSitemap.map((e) => ({
    loc: `${SITE}/earnings/${e.slug}`,
    lastmod: (e.updatedAt && e.updatedAt.slice(0, 10)) || todayDate,
    changefreq: "daily",
    priority: "0.8",
  }));
  await writeFile(path.join(OUT_DIR, "sitemap.xml"), buildSitemap([...staticPages, ...artEntries, ...earningsEntries]), "utf8");
  await writeFile(path.join(OUT_DIR, "robots.txt"), buildRobots(), "utf8");
  const rssSorted = [...arts].sort((a, b) => (Date.parse(b.pubDate || 0) || 0) - (Date.parse(a.pubDate || 0) || 0));
  await writeFile(path.join(OUT_DIR, "rss.xml"), buildRss(rssSorted), "utf8");
  console.log(`[build] SEO · sitemap ${staticPages.length + artEntries.length + earningsEntries.length} urls · robots · rss ${Math.min(30, rssSorted.length)}`);

  // 출력 요약 (한국어 단일 언어)
  const kpiData = await readJson("kpi.json");
  const priceStr = typeof kpiData.price === "number"
    ? `$${kpiData.price.toFixed(2)} (${kpiData.marketStateLabel || kpiData.marketState || "?"})`
    : "(no price)";
  console.log(`[build] OK · price ${priceStr}`);
  console.log(`[build] KO: ${ko.numCards} cards · ${ko.numArchive} archive · ${ko.numArticles} articles · ${ko.numEarnings} earnings · ${ko.bytes} bytes`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
