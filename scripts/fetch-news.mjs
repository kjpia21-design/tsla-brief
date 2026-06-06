#!/usr/bin/env node
/**
 * TSLA Brief — RSS → data/raw-cards.json 페처 (v2)
 *
 *   node scripts/fetch-news.mjs
 *
 * v2 변경 (vs v1)
 *  - 카테고리당 1건 → top 5건 (총 ~20건 후보) — 한국어 정제 시 선택 폭 ↑
 *  - href 자동 변환: news.google.com/rss/articles/... → 매체 홈 (sourceUrl 기반)
 *  - 출력 스키마를 cards.json 과 통일 — 정제 단계에서 slug/summary/title `<em>` 만 채우면 됨
 *  - 중복 제거 (같은 host + 같은 prefix 4단어)
 *  - sources 카운트 필드 제거 (build.mjs 가 안 씀, sourceLabel 단일 값으로 충분)
 *
 * 의존성 0. Node 22+ 권장.
 *
 * 한계
 *  - 한국어 정제 없음 — 제목·요약은 RSS 영문 원문 그대로 (다음 단계에서 처리)
 *  - href 는 매체 홈 (개별 기사 URL 풀이는 별도 작업 — Google News redirect 추적 필요)
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// raw 영문 RSS 출력 — 매일 cron 으로 덮어씌워짐.
// 한국어 정제분(data/cards.json)은 별도 흐름으로 갱신 (Claude 구독 내 수동 정제).
// 환경변수 SEED_OUT 으로 다른 출력 파일 지정 가능 (수동 시드용).
const OUT_PATH = path.join(ROOT, "data", process.env.SEED_OUT || "raw-cards.json");

// ─────────────────────────────────────────────────────────
// RSS 소스 정의
// ─────────────────────────────────────────────────────────

// Google News RSS 는 hl=en-US&gl=US&ceid=US:en 로 영어 결과 받음
const GN = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

// ── 1차·공식 소스 설정 ──────────────────────────────────────
// SEC EDGAR Atom — 회사/인물 CIK + 공시 종류(type) 별 최신 공시.
//   · Tesla CIK = 0001318605 / Elon Musk CIK = 0001494730
//   · SEC 공정접근 정책상 연락처가 포함된 User-Agent 필수 (없으면 403).
const EDGAR = (cik, type) =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}` +
  `&type=${encodeURIComponent(type)}&dateb=&owner=include&count=20&output=atom`;
const SEC_HEADERS = {
  "User-Agent": "TESLA Briefing admin@teslabriefing.com",
  "Accept": "application/atom+xml, application/xml, text/xml, */*;q=0.8",
};
const EDGAR_RECENT_DAYS = 10;   // 이보다 오래된 공시는 "뉴스"가 아님 — 제외

// NHTSA 리콜 JSON API — make/model/modelYear 조합으로 조회. 최근 건만 통과.
const NHTSA_RECENT_DAYS = 21;
const NHTSA_VEHICLES = [
  ["Tesla", "Model 3", 2025], ["Tesla", "Model 3", 2026],
  ["Tesla", "Model Y", 2025], ["Tesla", "Model Y", 2026],
  ["Tesla", "Model S", 2025], ["Tesla", "Model S", 2026],
  ["Tesla", "Model X", 2025], ["Tesla", "Model X", 2026],
  ["Tesla", "Cybertruck", 2025], ["Tesla", "Cybertruck", 2026],
];

// ── X(트위터) 1차·공식 소스 설정 ─────────────────────────────
//   GET /2/tweets/search/recent — from:계정 OR ... 한 번에 묶어 1요청으로 수집(비용 절감).
//   Bearer 토큰은 GitHub Actions secret `X_BEARER_TOKEN` 으로 주입(코드/리포에 값 미포함).
//   PPU(종량제) 비용 통제: 매 2h 실행 전부가 아니라 하루 4회(아래 시각, UTC)만 호출.
const X_BEARER = process.env.X_BEARER_TOKEN || "";
const X_RECENT_HOURS = 18;             // 최근 N시간 내 게시물만
const X_MAX_RESULTS = 40;              // 1요청 최대 트윗 수
const X_FETCH_HOURS_UTC = [2, 8, 14, 20]; // 하루 4회. 20 UTC = 05시 KST → 07시 발송 직전 신선
// label: official(공식·1차 인사이더) / press(인플루언서·애널리스트)
// category: 본문 추론의 폴백값(null 이면 musk 폴백)
const X_ACCOUNTS = [
  // 공식 채널
  { username: "Tesla",         id: "13298072",            name: "Tesla",            label: "official", category: "product" },
  { username: "elonmusk",      id: "44196397",            name: "Elon Musk",        label: "official", category: "musk" },
  { username: "Tesla_AI",      id: "1659653864138612761", name: "Tesla AI",         label: "official", category: "fsd" },
  { username: "TeslaCharging", id: "1346535293449428992", name: "Tesla Charging",   label: "official", category: "product" },
  { username: "cybertruck",    id: "1686044379910131718", name: "Cybertruck",       label: "official", category: "product" },
  { username: "Tesla_Optimus", id: "1616163256413863943", name: "Tesla Optimus",    label: "official", category: "product" },
  // 테슬라 임원·엔지니어(1차 인사이더)
  { username: "aelluswamy",    id: "87657877",            name: "Ashok Elluswamy",  label: "official", category: "fsd" },
  { username: "larsmoravy",    id: "716024533363208192",  name: "Lars Moravy",      label: "official", category: "product" },
  { username: "yunta_tsai",    id: "1577705091737432070", name: "Yun-Ta Tsai",      label: "official", category: "fsd" },
  // 인플루언서·애널리스트(보도·의견 → press)
  // (SawyerMerritt 제외 — 비-테슬라 트윗(스포츠·SpaceX 등)이 오해 카드로 유입돼 2026-06 제거)
  { username: "DivesTech",     id: "1082353582228176896", name: "Dan Ives",         label: "press",    category: "stock" },
  { username: "JoeTegtmeyer",  id: "1288973134339739648", name: "Joe Tegtmeyer",    label: "press",    category: null },
  { username: "teslaownersSV", id: "1016059981907386368", name: "Tesla Owners SV",  label: "press",    category: null },
];

const SOURCES = [
  // ── 1차·공식 (SEC / 규제기관) ────────────────────────────
  // Tesla IR(ir.tesla.com)은 SPA(공개 RSS 없음 — 확인) + tesla.com 피드 403.
  // → SEC EDGAR 직결을 Tesla 1차 채널로 사용: 8-K(실적·중대공시) · 10-Q/10-K(재무) · DEF 14A(주총·임원보수·의결).
  { type: "edgar", category: "stock",   url: EDGAR("0001318605", "8-K"),     sourceName: "SEC · Tesla 8-K",        defaultLabel: "sec", headers: SEC_HEADERS },
  { type: "edgar", category: "stock",   url: EDGAR("0001318605", "10-Q"),    sourceName: "SEC · Tesla 10-Q",       defaultLabel: "sec", headers: SEC_HEADERS },
  { type: "edgar", category: "stock",   url: EDGAR("0001318605", "10-K"),    sourceName: "SEC · Tesla 10-K",       defaultLabel: "sec", headers: SEC_HEADERS },
  { type: "edgar", category: "stock",   url: EDGAR("0001318605", "DEF 14A"), sourceName: "SEC · Tesla 주주총회(DEF 14A)", defaultLabel: "sec", headers: SEC_HEADERS },
  // 일론 머스크 본인 CIK → 테슬라 내부자(Form 4) 거래만 깨끗하게 수집.
  { type: "edgar", category: "musk",    url: EDGAR("0001494730", "4"),    sourceName: "SEC · 머스크 Form 4", defaultLabel: "sec", headers: SEC_HEADERS },
  // NHTSA 리콜 (규제기관 1차) — 차량 안전/소프트웨어 결함.
  { type: "nhtsa", category: "product", sourceName: "NHTSA", defaultLabel: "sec" },
  // X(트위터) — 테슬라/일론/제품 공식 + 임원 + 큐레이터. label/category 는 항목별 자체 판별.
  { type: "x", sourceName: "X" },

  // ── STOCK ───────────────────────────
  { category: "stock",   url: GN(`Tesla TSLA stock when:${process.env.SEED_WINDOW || "1d"}`), defaultLabel: "press" },
  { category: "stock",   url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=TSLA&region=US&lang=en-US", defaultLabel: "press" },

  // ── PRODUCT ─────────────────────────
  { category: "product", url: "https://electrek.co/guides/tesla/feed/", defaultLabel: "press" },
  { category: "product", url: "https://www.teslarati.com/category/news/feed/", defaultLabel: "press" },

  // ── FSD ─────────────────────────────
  { category: "fsd",     url: "https://electrek.co/guides/tesla-autopilot/feed/", defaultLabel: "press" },
  { category: "fsd",     url: GN(`Tesla FSD OR "Full Self-Driving" OR robotaxi when:${process.env.SEED_WINDOW || "2d"}`), defaultLabel: "press" },

  // ── MUSK ────────────────────────────
  { category: "musk",    url: GN(`Elon Musk Tesla when:${process.env.SEED_WINDOW || "1d"}`), defaultLabel: "press" },
];

// ─────────────────────────────────────────────────────────
// 도메인 → 출처 4단계 라벨링
// ─────────────────────────────────────────────────────────

const DOMAIN_LABEL = [
  // sec — 1차 자료 (정부·증권·테슬라 IR·규제기관). 진짜 1차 자료만.
  [/(^|\.)sec\.gov$/i,           "sec"],
  [/(^|\.)nhtsa\.gov$/i,         "sec"],   // NHTSA 리콜 (규제기관 1차)
  [/(^|\.)ir\.tesla\.com$/i,     "sec"],

  // official — 공식 발언·테슬라 PR·일론 X
  [/(^|\.)tesla\.com$/i,         "official"],
  [/(^|\.)x\.com$/i,             "official"],
  [/(^|\.)twitter\.com$/i,       "official"],

  // press — 외신·전문매체 (재배포·애그리게이터 포함 — Yahoo/Nasdaq 는 1차 아님)
  [/finance\.yahoo\.com/i,       "press"],
  [/(^|\.)nasdaq\.com$/i,        "press"],
  [/(^|\.)reuters\.com$/i,       "press"],
  [/(^|\.)bloomberg\.com$/i,     "press"],
  [/(^|\.)cnbc\.com$/i,          "press"],
  [/(^|\.)wsj\.com$/i,           "press"],
  [/(^|\.)ft\.com$/i,            "press"],
  [/(^|\.)nytimes\.com$/i,       "press"],
  [/(^|\.)theverge\.com$/i,      "press"],
  [/(^|\.)electrek\.co$/i,       "press"],
  [/(^|\.)teslarati\.com$/i,     "press"],
  [/(^|\.)insideevs\.com$/i,     "press"],
  [/(^|\.)cnet\.com$/i,          "press"],
  [/(^|\.)engadget\.com$/i,      "press"],
  [/(^|\.)barrons\.com$/i,       "press"],

  // rumor — 커뮤니티·익명·블로그
  [/(^|\.)reddit\.com$/i,        "rumor"],
  [/(^|\.)medium\.com$/i,        "rumor"],
  [/(^|\.)substack\.com$/i,      "rumor"],
];

function labelForUrl(link) {
  try {
    const host = new URL(link).hostname.toLowerCase();
    for (const [re, label] of DOMAIN_LABEL) {
      if (re.test(host)) return label;
    }
  } catch {}
  return null; // 분류 안 됨 — defaultLabel 로 폴백
}

// ─────────────────────────────────────────────────────────
// 화이트리스트 (가산점 방식)
//   하드 제외가 아니라 "선별 순위"만 조정한다. 카드가 부족해지는 일이 없도록
//   모든 후보를 남기되, 신뢰도 높은 출처를 위로 끌어올린다.
//   최종 점수 = 신선도 점수(recency) + 출처 가산점(tier).
//   (노출 순서는 선별 후 다시 시간순으로 정렬되므로 여기 점수는 "어떤 카드를 고르냐"에만 영향)
// ─────────────────────────────────────────────────────────

// 도메인 → tier 가산점. 위에서부터 먼저 매칭. 미분류는 DEFAULT_TIER 로 폴백.
const DOMAIN_TIER = [
  // 1차·공식 자료 — 가장 신뢰
  [/(^|\.)sec\.gov$/i,        7],
  [/(^|\.)nhtsa\.gov$/i,      6],
  [/(^|\.)ir\.tesla\.com$/i,  7],
  [/(^|\.)tesla\.com$/i,      7],

  // tier-1 통신사·주요 경제지
  [/(^|\.)reuters\.com$/i,    8],
  [/(^|\.)bloomberg\.com$/i,  8],
  [/(^|\.)cnbc\.com$/i,       8],
  [/(^|\.)wsj\.com$/i,        8],
  [/(^|\.)ft\.com$/i,         8],
  [/(^|\.)nytimes\.com$/i,    7],
  [/(^|\.)barrons\.com$/i,    7],

  // tier-2 전문·트레이드 매체
  [/(^|\.)electrek\.co$/i,    4],
  [/(^|\.)teslarati\.com$/i,  4],
  [/(^|\.)insideevs\.com$/i,  4],
  [/(^|\.)theverge\.com$/i,   4],
  [/(^|\.)cnet\.com$/i,       3],
  [/(^|\.)engadget\.com$/i,   3],
  [/finance\.yahoo\.com/i,    3],   // 재배포 애그리게이터 — 1차 아님
  [/(^|\.)nasdaq\.com$/i,     3],

  // 일론 직접 발언(소셜) — 가치 있지만 검증 약함
  [/(^|\.)x\.com$/i,          3],
  [/(^|\.)twitter\.com$/i,    3],

  // 저품질·SEO 금융 애그리게이터 — 카드 채울 게 없을 때만 통과하도록 강한 감점.
  // (tier-1 통신사가 같은 사안을 다루면 항상 그쪽이 채택되게)
  [/(^|\.)marketbeat\.com$/i,    -5],
  [/(^|\.)tipranks\.com$/i,      -5],
  [/(^|\.)tradersunion\.com$/i,  -6],
  [/(^|\.)meyka\.com$/i,         -6],
  [/(^|\.)simplywall\.st$/i,     -5],
  [/(^|\.)stocktitan\.net$/i,    -5],
  [/(^|\.)insidermonkey\.com$/i, -5],
  [/(^|\.)zacks\.com$/i,         -4],
  [/(^|\.)fool\.com$/i,          -4],
  [/(^|\.)benzinga\.com$/i,      -4],
  [/(^|\.)gurufocus\.com$/i,     -4],
  [/(^|\.)investing\.com$/i,     -3],

  // rumor — 커뮤니티·블로그. 강한 감점
  [/(^|\.)reddit\.com$/i,    -8],
  [/(^|\.)medium\.com$/i,    -8],
  [/(^|\.)substack\.com$/i,  -8],
];
const DEFAULT_TIER = -3; // 분류 안 된 도메인 (무명 매체 포함) — 약한 감점

// 비영어권 ccTLD — 영어 1차 매체 우선 원칙상 사실상 제외(카드 부족 시에만 통과).
// 영어권(.uk/.au/.ca/.ie/.nz/.in/.sg/.za)과 일반 .co(electrek.co 등은 위에서 이미 분류)는 제외.
const NONENG_TLD = /\.(kr|jp|cn|tw|hk|de|fr|es|it|nl|se|no|fi|dk|pl|ru|br|pt|tr|gr|cz|hu|ro|vn|th|id|sa|ae|il|ir|mx|ar)$/i;

function tierBonus(host) {
  if (!host) return DEFAULT_TIER;
  for (const [re, score] of DOMAIN_TIER) {
    if (re.test(host)) return score;
  }
  if (NONENG_TLD.test(host)) return -9; // 비영어권 — 사실상 제외
  return DEFAULT_TIER;
}

// 신선도 점수 — 일일 브리핑이라 24시간 내는 거의 동급으로 본다.
function recencyBonus(ts) {
  if (!ts) return -2;
  const ageHr = (Date.now() - ts) / 3_600_000;
  if (ageHr < 3)  return 10;
  if (ageHr < 6)  return 8;
  if (ageHr < 12) return 6;
  if (ageHr < 24) return 4;
  if (ageHr < 48) return 1;
  return -2;
}

// 라벨(출처 등급) 가산점 — 호스트 tier 로 구분 안 되는 1차·공식을 위로 끌어올린다.
//   특히 x.com 은 공식 계정·인플루언서가 같은 호스트(+3)라, 라벨로 공식을 우대해야
//   공식 트윗이 인플루언서 잡담에 밀려 raw 선별에서 탈락하지 않는다.
const LABEL_BONUS = { sec: 5, official: 4, press: 0, rumor: -6 };
function labelBonus(label) {
  return LABEL_BONUS[label] ?? 0;
}

// 선별용 종합 점수 (높을수록 우선 채택)
function selectionScore(it) {
  return recencyBonus(it.ts) + tierBonus(it.host) + labelBonus(it.label);
}

// ─────────────────────────────────────────────────────────
// 카테고리 자동 추론 (Google News 등 일반 소스에서)
// ─────────────────────────────────────────────────────────

const KEYWORDS = {
  fsd:     [/\bFSD\b/i, /full[\s-]?self[\s-]?driving/i, /autopilot/i, /robotaxi\b/i, /robo[\s-]?taxi/i, /cybercab/i, /\bv1[3-5]\b/i, /autonom/i],
  // ELON 카테고리 — Musk 직접 발언 + SpaceX/X/xAI/Neuralink/Boring Co 등 타사 + 경영 관련 발언
  musk:    [/\bElon\b/i, /\bMusk\b/i, /\bSpaceX\b/i, /\bStarship\b/i, /\bStarlink\b/i, /\bxAI\b/i, /\bGrok\b/i, /\bNeuralink\b/i, /\bBoring (Co|Company)\b/i, /@elonmusk/i],
  stock:   [/\bstock\b/i, /\bshares?\b/i, /\bvaluation\b/i, /\bearnings?\b/i, /\bdeliveries\b/i, /\b(Q[1-4]|quarter)\b/i, /\banalyst/i, /\bprice target/i, /\bmarket cap/i, /\bdividend/i, /\bbuyback/i],
  // PRODUCT — 차량 + 에너지(Powerwall/Megapack/Solar) + 옵티머스
  product: [/\bModel [SX3Y]\b/i, /\bCybertruck\b/i, /\bRoadster\b/i, /\bSemi\b/i, /\bOptimus\b/i, /\bPowerwall\b/i, /\bMegapack\b/i, /\bSolar Roof\b/i, /\bsupercharger/i, /\b(price cut|trim|refresh|juniper|highland)\b/i, /\bbattery (factory|plant|cell)/i],
};

function inferCategory(title, summary, fallback) {
  const text = `${title} ${summary || ""}`;
  // FSD > musk > stock > product 우선순위 — FSD 키워드가 강하게 식별됨
  for (const cat of ["fsd", "musk", "stock", "product"]) {
    if (KEYWORDS[cat].some((re) => re.test(text))) return cat;
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────
// RSS 파싱 (의존성 0, 단순 정규식)
// ─────────────────────────────────────────────────────────

function decodeEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripHtml(s) {
  return decodeEntities(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function extract(tag, xml) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(xml);
  return m ? decodeEntities(m[1]).trim() : "";
}

function parseRss(xml) {
  // <item> 블록 추출 (RSS 2.0)
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    // Google News RSS 는 <source url="https://realdomain.com">매체명</source> 으로 원본 매체 URL 을 별도로 줌
    const sourceUrlMatch = /<source[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/i.exec(block);
    items.push({
      title:       stripHtml(extract("title", block)),
      link:        extract("link", block).replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
      description: stripHtml(extract("description", block)),
      pubDate:     extract("pubDate", block),
      sourceUrl:   sourceUrlMatch ? sourceUrlMatch[1] : "",
      sourceName:  sourceUrlMatch ? stripHtml(sourceUrlMatch[2]) : stripHtml(extract("source", block)),
    });
  }
  // Atom <entry> 도 시도
  if (items.length === 0) {
    const entryRe = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    while ((m = entryRe.exec(xml)) !== null) {
      const block = m[1];
      const linkMatch = /<link[^>]*href="([^"]+)"/i.exec(block);
      items.push({
        title:       stripHtml(extract("title", block)),
        link:        linkMatch ? linkMatch[1] : "",
        description: stripHtml(extract("summary", block) || extract("content", block)),
        pubDate:     extract("updated", block) || extract("published", block),
        source:      "",
      });
    }
  }
  return items;
}

// 출처 라벨링용 호스트 결정.
//  - Google News 의 <source url="..."> 가 있으면 그 도메인 사용 (실제 매체)
//  - 없으면 link 의 도메인
// 사용자 클릭 시 link 는 그대로 사용 (Google News 가 자동 redirect 처리)
function hostForLabel(item) {
  try {
    if (item.sourceUrl) return new URL(item.sourceUrl).hostname.toLowerCase();
    return new URL(item.link).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// 제목 끝 " - 매체명" 제거 (Google News RSS 자동 부가)
function cleanTitle(title, sourceName) {
  if (!title) return title;
  if (sourceName) {
    const re = new RegExp(`\\s*[-–—]\\s*${sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
    title = title.replace(re, "");
  }
  // 일반화: 마지막 " - 단어" 패턴 — 보수적으로 1~3 단어만
  title = title.replace(/\s+[-–—]\s+([A-Za-z][\w&.'\s]{0,30})$/, (full, tail) => {
    const words = tail.trim().split(/\s+/);
    return words.length <= 3 ? "" : full;
  });
  return title.trim();
}

// ─────────────────────────────────────────────────────────
// 시간 표시 ("3h ago")
// ─────────────────────────────────────────────────────────

function timeAgo(pubDateStr) {
  if (!pubDateStr) return "";
  const t = Date.parse(pubDateStr);
  if (Number.isNaN(t)) return "";
  const diffMin = Math.max(1, Math.round((Date.now() - t) / 60000));
  if (diffMin < 60)      return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24)       return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

// ─────────────────────────────────────────────────────────
// SEC EDGAR Atom 파싱 (browse-edgar output=atom)
//   각 <entry> 의 <content> 안에 filing-type / filing-date / filing-href / items-desc 가 들어 있음.
//   8-K 의 item 코드는 사람이 읽을 수 있는 설명으로 변환해 영문 제목을 합성한다.
//   (한국어 정제 단계가 이 영문 제목을 받아 다듬는다.)
// ─────────────────────────────────────────────────────────

// 8-K Item 코드 → 설명 (자주 쓰이는 것만; 실적은 2.02)
const EDGAR_8K_ITEMS = {
  "1.01": "Entry into a Material Definitive Agreement",
  "1.02": "Termination of a Material Definitive Agreement",
  "2.01": "Completion of Acquisition or Disposition of Assets",
  "2.02": "Results of Operations and Financial Condition",
  "2.03": "Creation of a Direct Financial Obligation",
  "3.02": "Unregistered Sales of Equity Securities",
  "5.02": "Departure/Appointment of Directors or Officers",
  "5.07": "Submission of Matters to a Vote of Security Holders",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
  "9.01": "Financial Statements and Exhibits",
};

function daysAgo(dateStr) {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 86_400_000;
}

function parseEdgar(xml, src) {
  const out = [];
  const isMusk = /1494730/.test(src.url);  // 머스크 CIK → Form 4 (내부자 거래)
  const entryRe = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const filingType = extract("filing-type", block) || extract("category", block);
    const filingDate = extract("filing-date", block);
    const updated    = extract("updated", block) || filingDate;
    const hrefMatch  = /<filing-href>([\s\S]*?)<\/filing-href>/i.exec(block);
    const href       = hrefMatch ? decodeEntities(hrefMatch[1]).trim() : "";

    // 최근 공시만 — 오래된 건 "뉴스"가 아님.
    if (daysAgo(filingDate || updated) > EDGAR_RECENT_DAYS) continue;

    // items-desc 는 "items 2.02 and 9.01" 처럼 한 줄로 옴 — 코드(N.NN)만 추출.
    const itemsRaw = (block.match(/<items-desc>([\s\S]*?)<\/items-desc>/gi) || [])
      .map((s) => decodeEntities(s)).join(" ");
    const items = (itemsRaw.match(/\d\.\d{2}/g) || []);

    let title, description;
    if (isMusk || filingType.trim() === "4") {
      title = `Elon Musk Form 4 — Tesla insider transaction (filed ${filingDate})`;
      description = "SEC Form 4: Statement of changes in beneficial ownership (Tesla insider transaction by Elon Musk).";
    } else if (/8-K/i.test(filingType)) {
      const descs = items.map((c) => EDGAR_8K_ITEMS[c] || `Item ${c}`).filter(Boolean);
      const tail = descs.length ? ` — ${descs.join("; ")}` : "";
      title = `Tesla 8-K (${filingDate})${tail}`;
      description = `SEC 8-K current report filed ${filingDate}.` + (descs.length ? ` Items: ${descs.join("; ")}.` : "");
    } else if (/10-Q/i.test(filingType)) {
      title = `Tesla 10-Q quarterly report filed ${filingDate}`;
      description = `SEC 10-Q: quarterly financial report filed ${filingDate}.`;
    } else if (/10-K/i.test(filingType)) {
      title = `Tesla 10-K annual report filed ${filingDate}`;
      description = `SEC 10-K: annual financial report filed ${filingDate}.`;
    } else if (/DEFA?\s*14A/i.test(filingType)) {
      title = `Tesla proxy statement (DEF 14A) filed ${filingDate} — annual meeting, executive compensation & shareholder votes`;
      description = `SEC DEF 14A proxy statement filed ${filingDate}: annual meeting agenda, executive compensation, board nominations and shareholder proposals.`;
    } else {
      title = `Tesla SEC ${filingType} filed ${filingDate}`;
      description = `SEC ${filingType} filing dated ${filingDate}.`;
    }

    out.push({
      title,
      link: href,
      sourceUrl: "https://www.sec.gov/",
      description,
      pubDate: updated,
      sourceName: src.sourceName,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// NHTSA 리콜 JSON API
//   GET api.nhtsa.gov/recalls/recallsByVehicle?make=&model=&modelYear=
//   ReportReceivedDate 는 "DD/MM/YYYY". NHTSACampaignNumber 로 중복 제거.
//   Autopilot/FSD/software 키워드면 fsd, 그 외 product 로 분류.
// ─────────────────────────────────────────────────────────

function nhtsaDateToIso(s) {
  // "DD/MM/YYYY" → ISO
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || "").trim());
  if (!m) return "";
  return `${m[3]}-${m[2]}-${m[1]}T00:00:00Z`;
}

async function fetchNhtsa(vehicles) {
  const seen = new Set();
  const out = [];
  for (const [make, model, modelYear] of vehicles) {
    const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}` +
      `&model=${encodeURIComponent(model)}&modelYear=${modelYear}`;
    let json;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "TESLA Briefing admin@teslabriefing.com", "Accept": "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } catch (e) {
      console.warn(`[fetch-news] NHTSA ${make} ${model} ${modelYear} ← FAIL · ${e.message}`);
      continue;
    }
    for (const r of (json.results || [])) {
      const camp = r.NHTSACampaignNumber;
      if (!camp || seen.has(camp)) continue;
      const iso = nhtsaDateToIso(r.ReportReceivedDate);
      if (iso && daysAgo(iso) > NHTSA_RECENT_DAYS) continue;
      seen.add(camp);
      const comp = `${r.Component || ""} ${r.Summary || ""}`;
      const isFsd = /autopilot|full self|fsd|software|autonom/i.test(comp);
      out.push({
        category: isFsd ? "fsd" : "product",
        title: `NHTSA recall ${camp} — ${r.Component || "Tesla vehicles"} (${model})`,
        link: `https://www.nhtsa.gov/recalls?nhtsaId=${encodeURIComponent(camp)}`,
        sourceUrl: "https://www.nhtsa.gov/",
        description: (r.Summary || "").slice(0, 220),
        pubDate: iso,
        sourceName: "NHTSA",
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// X(트위터) 최근 게시물 — search/recent 로 여러 계정을 1요청에 묶음
//   · Bearer 토큰 없으면 조용히 건너뜀(로컬에서 토큰 없이 RSS만 돌릴 때).
//   · 지정 시각(UTC)이 아니면 건너뜀(PPU 비용 통제). X_FORCE=1 로 강제 가능.
//   · 리트윗/답글 제외, 순수 링크·초단문 제외(노이즈).
//   · author_id → 계정 설정 매핑으로 label(official/press)·카테고리 폴백 결정.
// ─────────────────────────────────────────────────────────

async function fetchX(accounts) {
  if (!X_BEARER) {
    console.warn("[fetch-news] X 건너뜀 — X_BEARER_TOKEN 미설정");
    return [];
  }
  const hourNow = new Date().getUTCHours();
  if (!process.env.X_FORCE && !X_FETCH_HOURS_UTC.includes(hourNow)) {
    console.log(`[fetch-news] X 건너뜀 — ${hourNow}시 UTC 는 폴링 시각 아님 (${X_FETCH_HOURS_UTC.join(",")}). X_FORCE=1 로 강제 가능`);
    return [];
  }

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const query = `(${accounts.map((a) => `from:${a.username}`).join(" OR ")}) -is:retweet -is:reply`;
  const startTime = new Date(Date.now() - X_RECENT_HOURS * 3_600_000).toISOString();
  const url = "https://api.x.com/2/tweets/search/recent"
    + `?query=${encodeURIComponent(query)}`
    + `&max_results=${X_MAX_RESULTS}`
    + `&start_time=${encodeURIComponent(startTime)}`
    + "&tweet.fields=created_at,public_metrics,lang,author_id";

  let json;
  try {
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${X_BEARER}`, "Accept": "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    json = await res.json();
  } catch (e) {
    console.warn(`[fetch-news] X ← FAIL · ${e.message}`);
    return [];
  }

  const out = [];
  for (const t of (json.data || [])) {
    const acct = byId.get(t.author_id);
    if (!acct) continue;
    const text = (t.text || "").replace(/\s+/g, " ").trim();
    // 순수 링크/초단문 제외 (URL 제거 후 15자 미만이면 노이즈)
    const noUrl = text.replace(/https?:\/\/\S+/g, "").trim();
    if (noUrl.length < 15) continue;
    const link = `https://x.com/${acct.username}/status/${t.id}`;
    out.push({
      category: acct.category,           // inferCategory 폴백
      label: acct.label,                 // official | press (강제)
      title: noUrl.length > 120 ? noUrl.slice(0, 117) + "…" : noUrl,
      description: text,
      link,
      sourceUrl: link,
      pubDate: t.created_at || "",
      sourceName: `${acct.name} (X)`,
    });
  }
  console.log(`[fetch-news] X ← ${out.length} posts (검색 ${(json.data || []).length}건 중)`);
  return out;
}

// X 지속성 — 직전 raw-cards.json 의 최근 X 카드를 후보로 되살린다.
//   X 는 하루 4회만 호출하므로, 그 사이 비-X 페치가 raw 를 덮어써도 X 가 사라지지 않게 한다.
//   sourceName 끝의 "(X)" 로 X 카드 식별, X_RECENT_HOURS 이내만 유지.
//   반환: { category, item(버킷 형태) } 배열. (OUT_PATH 가 아직 이번 실행으로 덮이기 전에 호출)
async function loadPrevXCards() {
  try {
    const prev = JSON.parse(await readFile(OUT_PATH, "utf8"));
    const cutoff = Date.now() - X_RECENT_HOURS * 3_600_000;
    const out = [];
    for (const c of (prev.items || [])) {
      if (!/\(X\)\s*$/.test(c.sourceName || "")) continue;
      const ts = Date.parse(c.pubDate) || 0;
      if (ts < cutoff) continue;               // 18h 초과 → 폐기
      const href = c.href || "";
      out.push({
        category: c.category,
        item: {
          title: c.title,
          link: href,
          sourceUrl: href,
          description: c.body || c.summary || c.title || "",
          pubDate: c.pubDate || "",
          ts,
          label: c.sourceLabel || "press",
          host: "x.com",
          sourceName: c.sourceName,
        },
      });
    }
    return out;
  } catch {
    return [];   // 파일 없음/파싱 실패 → 무시
  }
}

// ─────────────────────────────────────────────────────────
// 메인 페치 루프
// ─────────────────────────────────────────────────────────

const CATEGORY_LABELS = {
  stock:   "STOCK · 주가·실적",
  product: "PRODUCT · 차량·에너지·옵티머스",
  fsd:     "FSD · 자율·로보택시",
  musk:    "ELON · 일론 소식",
};

// 일반 브라우저로 위장 — Anthropic Cloud Routine IP 가 봇으로 차단되는 케이스 회피용.
// (로컬 macOS 환경에서는 어떤 UA 든 통과하지만, 클라우드 IP 차단을 우회하려면 가장 일반적인 UA 가 안전.)
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/rss+xml, application/xml, application/atom+xml, text/xml, */*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

async function fetchRss(url, headers) {
  const res = await fetch(url, {
    headers: headers ? { ...BROWSER_HEADERS, ...headers } : BROWSER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// ─────────────────────────────────────────────────────────
// href 정규화 — 직접 피드는 link 가 곧 원문, Google News 만 토큰 해석
// ─────────────────────────────────────────────────────────

// 매체 홈 fallback (토큰 해석 실패 시).
function mediaHome(it) {
  const link = it.link || "";
  try {
    const u = new URL(it.sourceUrl || link);
    return `${u.protocol}//${u.hostname}/`;
  } catch {
    return link;
  }
}

// Google News /rss/articles/<TOKEN> 를 실제 원문 URL 로 2-step 해석.
//  1) 기사 페이지 GET → data-n-a-sg (서명) + data-n-a-ts (타임스탬프) 추출
//  2) batchexecute POST (garturlreq) → 응답에서 원문 URL 추출
// 실패하면 null 반환 → 호출부가 mediaHome 으로 fallback.
async function decodeGoogleNews(link) {
  const m = /\/rss\/articles\/([^?/]+)/.exec(link);
  if (!m) return null;
  const tok = m[1];

  const page = await fetch(link, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  }).then((r) => (r.ok ? r.text() : ""));
  if (!page) return null;

  const sg = /data-n-a-sg="([^"]+)"/.exec(page)?.[1];
  const ts = /data-n-a-ts="([^"]+)"/.exec(page)?.[1];
  if (!sg || !ts) return null;

  const inner = JSON.stringify([
    "garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
      "en-US", "US", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    tok, Number(ts), sg,
  ]);
  const freq = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);

  const res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "f.req=" + encodeURIComponent(freq),
    signal: AbortSignal.timeout(15000),
  }).then((r) => (r.ok ? r.text() : ""));
  if (!res) return null;

  const url = /https?:\/\/(?!news\.google|www\.google)[^\s"'\\]+/.exec(res)?.[0];
  return url || null;
}

// 카드 1건의 최종 href 결정. 직접 피드면 link 그대로, Google News 면 해석.
async function resolveArticleUrl(it) {
  const link = it.link || "";
  if (!/news\.google\.com\/rss/i.test(link)) return link;
  try {
    const real = await decodeGoogleNews(link);
    if (real) return real;
  } catch { /* 아래 fallback */ }
  return mediaHome(it);
}

// 재발행된 옛 기사 차단 목록.
// RSS 매체가 오래된 글을 새 pubDate 로 재발행하면 날짜만으로는 구분 불가 →
// link / sourceUrl / title 에 아래 문자열이 포함되면 수집 단계에서 제외한다.
// (예: Teslarati 가 2014년 'Model E'(모델3 옛 코드명) 기사를 2026 날짜로 재발행한 사고)
// 주의: Google News RSS 경유 시 수집 시점의 link 는 토큰 URL 이고 실제 원문 URL 은
// 선별 후에야 해석된다(resolveArticleUrl). 따라서 URL 뿐 아니라 **제목** 으로도 막는다.
// 공유 차단 목록(data/blocklist.json)을 모듈 로드시 읽어 병합. 빌드·정제·누적과 한 소스.
let BLOCKLIST = [
  "tuned-third-generation-tesla-model-e-will-utilize-steel-construction",
  "will utilize steel construction",
];
try {
  const extra = JSON.parse(await readFile(path.join(ROOT, "data", "blocklist.json"), "utf8")).substrings || [];
  BLOCKLIST = [...new Set([...BLOCKLIST, ...extra].map((s) => s.toLowerCase()))];
} catch { /* 파일 없으면 인라인만 사용 */ }
function isBlocked(it) {
  const hay = `${it.link || ""} ${it.sourceUrl || ""} ${it.title || ""} ${it.href || ""}`.toLowerCase();
  return BLOCKLIST.some((b) => hay.includes(b));
}

// 카테고리당 최대 N건 (한국어 정제 시 선택 폭). 환경변수 SEED_N 으로 override.
const N_PER_CATEGORY = Number(process.env.SEED_N || 5);

async function main() {
  console.log(`[fetch-news] starting · ${SOURCES.length} sources · top ${N_PER_CATEGORY} per category`);

  // 카테고리별로 후보 모음
  const buckets = { stock: [], product: [], fsd: [], musk: [] };

  await Promise.all(SOURCES.map(async (src) => {
    // ── 1차·공식: SEC EDGAR / NHTSA / X — inferCategory/cleanTitle 생략, 라벨 강제 ──
    if (src.type === "edgar" || src.type === "nhtsa" || src.type === "x") {
      try {
        let items;
        if (src.type === "edgar") {
          const xml = await fetchRss(src.url, src.headers);
          items = parseEdgar(xml, src);
        } else if (src.type === "nhtsa") {
          items = await fetchNhtsa(NHTSA_VEHICLES);
        } else {
          items = await fetchX(X_ACCOUNTS);
        }
        for (const it of items) {
          if (!it.title) continue;
          if (isBlocked({ link: it.link, sourceUrl: it.sourceUrl, title: it.title })) continue;
          // X 는 본문 기반 카테고리 추론(계정 카테고리 폴백), edgar/nhtsa 는 명시값.
          const cat = (src.type === "x")
            ? inferCategory(it.title, it.description, it.category || "musk")
            : (it.category || src.category);
          // X 는 항목별 label(official/press), edgar/nhtsa 는 sec 강제.
          const label = (src.type === "x") ? it.label : src.defaultLabel;
          const host = hostForLabel(it);
          buckets[cat].push({
            title: it.title,
            link: it.link,
            sourceUrl: it.sourceUrl,
            description: it.description,
            pubDate: it.pubDate,
            ts: Date.parse(it.pubDate) || 0,
            label,
            host,
            sourceName: it.sourceName || src.sourceName,
          });
        }
        console.log(`[fetch-news] ${(src.sourceName || src.type).padEnd(16)} ← ${items.length.toString().padStart(3)} items (1차·공식)`);
      } catch (e) {
        console.warn(`[fetch-news] ${(src.sourceName || src.type).padEnd(16)} ← FAIL · ${e.message}`);
      }
      return;
    }

    // ── 일반 RSS ──
    try {
      const xml = await fetchRss(src.url);
      const items = parseRss(xml);
      for (const it of items) {
        const host = hostForLabel(it);
        const label = (host && labelForUrl(`https://${host}/`)) || src.defaultLabel;
        const title = cleanTitle(it.title, it.sourceName);
        if (!title) continue;
        if (isBlocked({ link: it.link, sourceUrl: it.sourceUrl, title })) {
          console.log(`  · BLOCKED ${it.link || title}`);
          continue;
        }
        const cat = inferCategory(title, it.description, src.category);
        buckets[cat].push({
          title,
          link: it.link,
          sourceUrl: it.sourceUrl,
          description: it.description,
          pubDate: it.pubDate,
          ts: Date.parse(it.pubDate) || 0,
          label,
          host,
          sourceName: it.sourceName || host,
        });
      }
      console.log(`[fetch-news] ${src.category.padEnd(8)} ← ${items.length.toString().padStart(3)} items · ${new URL(src.url).hostname}`);
    } catch (e) {
      console.warn(`[fetch-news] ${src.category.padEnd(8)} ← FAIL · ${e.message} · ${src.url}`);
    }
  }));

  // X 지속성 — 이번 실행에서 X 를 안 불렀어도(시각 가드/토큰 부재) 직전 raw 의 최근 X 카드를
  // 후보로 되살린다. 비-X 페치가 X 를 덮어써 사라지던 문제 해결. 중복은 아래 prefix dedup 이 처리.
  const prevX = await loadPrevXCards();
  let carried = 0;
  for (const { category, item } of prevX) {
    if (buckets[category]) { buckets[category].push(item); carried += 1; }
  }
  if (carried) console.log(`[fetch-news] X 지속성 — 직전 raw 의 최근 X 카드 ${carried}건 후보 유지`);

  // 카테고리당 top N건 + 중복 제거 (같은 host + 같은 prefix 4단어)
  const picks = [];
  for (const [cat, items] of Object.entries(buckets)) {
    if (items.length === 0) continue;
    // 선별 정렬: 신선도 + 출처 가산점 (동점이면 최신 우선)
    items.sort((a, b) => (selectionScore(b) - selectionScore(a)) || (b.ts - a.ts));
    const seen = new Set();
    let picked = 0;
    for (const it of items) {
      if (picked >= N_PER_CATEGORY) break;
      const prefKey = `${it.host}|${it.title.split(/\s+/).slice(0, 4).join(" ").toLowerCase()}`;
      if (seen.has(prefKey)) continue;
      seen.add(prefKey);
      picked += 1;
      console.log(`  · pick ${cat.padEnd(8)} score ${String(selectionScore(it)).padStart(3)} (tier ${String(tierBonus(it.host)).padStart(2)}) ${it.host || "?"}`);
      picks.push({ cat, it });
    }
  }

  // 원문 URL 해석 (Google News 토큰 → 실제 기사). 동시 4건 제한.
  const cards = new Array(picks.length);
  let resolved = 0, gnews = 0, gnewsOk = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (true) {
        const i = resolved++;
        if (i >= picks.length) break;
        const { cat, it } = picks[i];
        const isGnews = /news\.google\.com\/rss/i.test(it.link || "");
        if (isGnews) gnews += 1;
        const href = await resolveArticleUrl(it);
        if (isGnews && !/news\.google\.com/i.test(href) && !href.endsWith("/")) gnewsOk += 1;
        // 해석된 실제 URL 기준 최종 차단 (Google News 토큰이 풀린 뒤). cards[i] 미할당 → 뒤에서 filter.
        if (isBlocked({ href, title: it.title, link: it.link })) {
          console.log(`  · BLOCKED(url) ${href}`);
          continue;
        }
        const pubIso = it.ts ? new Date(it.ts).toISOString() : "";
        cards[i] = {
          category: cat,
          categoryLabel: CATEGORY_LABELS[cat],
          time: timeAgo(it.pubDate),
          pubDate: pubIso,
          title: it.title,
          body: it.description.slice(0, 220) + (it.description.length > 220 ? "…" : ""),
          sourceName: it.sourceName,
          sourceLabel: it.label,
          slug: "",         // 정제 단계에서 채움
          summary: "",      // 정제 단계에서 채움
          href,
        };
      }
    })
  );
  console.log(`[fetch-news] href 해석 · Google News ${gnews}건 중 ${gnewsOk}건 원문 연결 성공`);

  // 차단되어 미할당된 슬롯(undefined) 제거.
  const liveCards = cards.filter(Boolean);
  if (liveCards.length === 0) {
    console.warn("[fetch-news] 카드를 한 건도 못 가져왔습니다. 기존 raw-cards.json 유지.");
    process.exit(0);
  }

  // 정렬: 최신순 (라이브 사이트 표시 순)
  liveCards.sort((a, b) => Date.parse(b.pubDate || 0) - Date.parse(a.pubDate || 0));

  const out = {
    asOf: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC 기준 · 카테고리당 top ${N_PER_CATEGORY}건`,
    items: liveCards,
  };

  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`[fetch-news] OK → ${path.relative(ROOT, OUT_PATH)} · ${liveCards.length} cards`);
  // 카테고리별 요약 로그
  const byCat = liveCards.reduce((acc, c) => ((acc[c.category] = (acc[c.category] || 0) + 1), acc), {});
  for (const cat of ["stock", "product", "fsd", "musk"]) {
    console.log(`  · ${cat.padEnd(8)} ${(byCat[cat] || 0).toString().padStart(2)}건`);
  }
}

main().catch((err) => {
  console.error(`[fetch-news] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
